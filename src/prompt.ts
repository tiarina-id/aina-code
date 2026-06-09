import readline from 'node:readline';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { getPrettyModelName, loadConfig } from './config.js';
import { cycleMode, footerRight } from './mode.js';
import { loadIgnore } from './gitignore.js';


interface SlashCommand {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show interactive command help' },
  { name: '/model', description: 'Show the active model or switch models' },
  { name: '/init', description: 'Auto-create/update AINA.md (project context)' },
  { name: '/undo', description: 'Undo the last file change' },
  { name: '/check', description: 'Run validation (typecheck/lint) now' },
  { name: '/diff', description: 'Show the git diff of changes' },
  { name: '/commit', description: 'Stage all & commit (with confirmation)' },
  { name: '/resume', description: 'Resume the conversation from a previous session' },
  { name: '/compact', description: 'Summarize & shrink the conversation context' },
  { name: '/usage', description: 'Show session token usage & context size' },
  { name: '/status', description: 'Show model, mode, directory, session & usage' },
  { name: '/config', description: 'Show or set configuration (model, autoValidate, …)' },
  { name: '/auto', description: 'Toggle auto-approve mode (skip confirmations)' },
  { name: '/plan', description: 'Toggle plan mode (read-only, plan only)' },
  { name: '/clear', description: 'Reset conversation history and clear the screen' },
  { name: '/exit', description: 'Exit the interactive session' }
];

const AVAILABLE_MODELS: SlashCommand[] = [
  { name: 'aina-1-flash', description: 'Aina 1 Flash (Default, Fast & Balanced)' },
  { name: 'aina-1-mini', description: 'Aina 1 Mini (Lightweight & Super Fast)' },
  { name: 'aina-1-pro', description: 'Aina 1 Pro (Advanced Reasoning & Coding)' },
  { name: 'aina-1-ultra', description: 'Aina 1 Ultra (Maximum Intelligence)' }
];

// Submitted prompts, kept for the whole session so ↑/↓ can recall them.
const promptHistory: string[] = [];

// Render the user's submitted prompt in scrollback: white text on a gray block
// (replaces the old plain cyan look) so it stands out as the user's turn.
export function renderUserEcho(text: string): string {
  return chalk.bgBlackBright.whiteBright(` > ${text} `);
}

export function askCustomPrompt(modelName: string): Promise<string> {
  return new Promise<string>((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('> ', (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    readline.emitKeypressEvents(process.stdin);

    let inputBuffer = '';
    let cursorOffset = 0; // Number of characters the cursor is from the end of the text
    let selectedIndex = 0;
    let lastLineCount = 0;
    let lastPromptLineIndexFromBottom = 0;
    let menuState: 'none' | 'commands' | 'models' | 'help' | 'files' = 'none';
    // History navigation: index into promptHistory (== length means "new line")
    let historyIndex = promptHistory.length;
    let pendingBuffer = ''; // in-progress text saved when navigating into history
    let exitArmed = false;  // true after one Ctrl+C on an empty line; second Ctrl+C exits

    // Matcher .gitignore dibangun sekali per prompt (bukan tiap keystroke) agar
    // file-picker tidak menampilkan build artifacts / file ber-secret.
    const ignore = loadIgnore();
    const cwd = process.cwd();
    const isIgnored = (full: string, isDir: boolean): boolean =>
      ignore(path.relative(cwd, full).split(path.sep).join('/'), isDir);

    // List immediate children of a directory, prefix-matching on the basename.
    function listDir(query: string): { name: string; isDir: boolean }[] {
      const lastSlashIdx = query.lastIndexOf('/');
      const dirPath = lastSlashIdx !== -1 ? query.slice(0, lastSlashIdx + 1) : '.';
      const filePrefix = lastSlashIdx !== -1 ? query.slice(lastSlashIdx + 1) : query;

      const targetDir = path.resolve(dirPath);
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return [];
      }

      return fs.readdirSync(targetDir)
        .filter(f => f.toLowerCase().startsWith(filePrefix.toLowerCase()))
        .map(f => {
          const relPath = lastSlashIdx !== -1 ? path.join(dirPath, f) : f;
          let isDir = false;
          try {
            isDir = fs.statSync(path.join(targetDir, f)).isDirectory();
          } catch {}
          return { name: relPath + (isDir ? '/' : ''), isDir };
        })
        .filter(({ name, isDir }) => !isIgnored(path.resolve(name), isDir));
    }

    // Recursively find files/dirs whose NAME contains the query (case-insensitive),
    // so nested files like "test/text.txt" surface when typing just "text".
    function searchFilesRecursive(query: string): { name: string; isDir: boolean }[] {
      const q = query.toLowerCase();
      const matches: { name: string; isDir: boolean; depth: number; starts: boolean }[] = [];
      const MAX = 200;

      function walk(dir: string) {
        let entries: string[];
        try {
          entries = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= MAX) return;
          const full = path.join(dir, entry);
          let isDir = false;
          try {
            isDir = fs.statSync(full).isDirectory();
          } catch {
            continue;
          }
          if (isIgnored(full, isDir)) continue;
          const lower = entry.toLowerCase();
          if (lower.includes(q)) {
            const rel = path.relative('.', full).split(path.sep).join('/');
            matches.push({
              name: rel + (isDir ? '/' : ''),
              isDir,
              depth: rel.split('/').length,
              starts: lower.startsWith(q)
            });
          }
          if (isDir) walk(full);
        }
      }
      walk('.');

      // Rank: prefix matches first, then shallower paths, then alphabetical.
      matches.sort((a, b) => {
        if (a.starts !== b.starts) return a.starts ? -1 : 1;
        if (a.depth !== b.depth) return a.depth - b.depth;
        return a.name.localeCompare(b.name);
      });
      return matches.slice(0, 10).map(({ name, isDir }) => ({ name, isDir }));
    }

    function getFilesList(query: string): { name: string; isDir: boolean }[] {
      try {
        // Empty query or explicit path (contains "/") -> navigate a directory.
        if (query === '' || query.includes('/')) {
          return listDir(query);
        }
        // Bare query -> search the whole project so nested files surface too.
        return searchFilesRecursive(query);
      } catch {
        return [];
      }
    }

    function getFiltered(): SlashCommand[] {
      const isCommandMode = inputBuffer.startsWith('/');
      const words = inputBuffer.split(/\s+/);
      const firstWord = words[0].toLowerCase();

      if (menuState === 'commands') {
        const query = inputBuffer.slice(1).toLowerCase();
        const matches = SLASH_COMMANDS.filter(cmd => cmd.name.slice(1).startsWith(query));
        if (matches.length === 1 && matches[0].name.slice(1) === query) {
          return [];
        }
        return matches;
      }

      if (menuState === 'models') {
        const query = inputBuffer.toLowerCase();
        const matches = AVAILABLE_MODELS.filter(m => m.name.includes(query));
        if (matches.length === 1 && matches[0].name === query) {
          return [];
        }
        return matches;
      }

      if (menuState === 'help') {
        return [
          { name: '/model (ctrl+m)', description: 'Show the active model or switch models' },
          { name: '/clear (ctrl+l)', description: 'Reset conversation history and clear the screen' },
          { name: '/exit (ctrl+q)', description: 'Exit the interactive session' },
          { name: '/help (ctrl+h, ?)', description: 'Show this help' }
        ];
      }

      if (menuState === 'files') {
        const cursorIdx = inputBuffer.length - cursorOffset;
        const textBeforeCursor = inputBuffer.slice(0, cursorIdx);
        const lastAtIdx = textBeforeCursor.lastIndexOf('@');
        const fileQuery = lastAtIdx !== -1 ? textBeforeCursor.slice(lastAtIdx + 1) : '';
        
        const matches = getFilesList(fileQuery);
        return matches.map(m => ({
          name: `@${m.name}`,
          description: m.isDir ? 'Directory' : 'File'
        }));
      }

      return [];
    }

    // Returns the ANSI sequence string to erase the previously drawn prompt block
    function getClearSeq(): string {
      let clearSeq = '';
      if (lastLineCount > 0) {
        // Move cursor down from the prompt line to the bottom line first
        if (lastPromptLineIndexFromBottom > 0) {
          clearSeq += `\x1B[${lastPromptLineIndexFromBottom}B`;
        }
        // Clear all lines from bottom to top
        for (let i = 0; i < lastLineCount; i++) {
          clearSeq += '\x1B[2K\x1B[1A'; // clear entire line and move cursor up
        }
        clearSeq += '\x1B[2K\r'; // clear top line and carriage return
      }
      return clearSeq;
    }

    function draw() {
      // Transition from none to commands if user types slash
      if (inputBuffer.startsWith('/') && menuState === 'none') {
        menuState = 'commands';
        selectedIndex = 0;
      }

      // Check if typing a file tag
      const cursorIdx = inputBuffer.length - cursorOffset;
      const textBeforeCursor = inputBuffer.slice(0, cursorIdx);
      const lastAtIdx = textBeforeCursor.lastIndexOf('@');
      let isAtWord = false;
      if (lastAtIdx !== -1) {
        const textSinceAt = textBeforeCursor.slice(lastAtIdx + 1);
        if (!textSinceAt.includes(' ')) {
          isAtWord = true;
        }
      }

      if (isAtWord && (menuState === 'none' || menuState === 'commands')) {
        menuState = 'files';
        selectedIndex = 0;
      } else if (!isAtWord && menuState === 'files') {
        menuState = 'none';
      }

      const filtered = getFiltered();
      if (selectedIndex >= filtered.length) {
        selectedIndex = Math.max(0, filtered.length - 1);
      }

      // Generate the clearing sequence string
      const clearSeq = getClearSeq();
      
      // Reset counters before rebuilding the prompt output
      lastLineCount = 0;
      lastPromptLineIndexFromBottom = 0;

      const cols = process.stdout.columns || 80;
      const horizontalLine = chalk.gray('─'.repeat(cols));

      const lines: string[] = [];
      lines.push(horizontalLine);

      // Shell mode is active when input starts with "!": give visual feedback.
      const isShellMode = inputBuffer.startsWith('!');

      const promptPrefix = '> ';
      lines.push(isShellMode
        ? chalk.magenta(promptPrefix + inputBuffer)
        : promptPrefix + inputBuffer);

      lines.push(horizontalLine);

      if (menuState !== 'none' && filtered.length > 0) {
        if (menuState === 'help') {
          // Render help details as a static list (no selection indicator)
          filtered.forEach((cmd) => {
            const cmdName = chalk.bold.gray(cmd.name.padEnd(25));
            const desc = chalk.gray(cmd.description);
            lines.push(`  ${cmdName}${desc}`);
          });
          lines.push('');
          lines.push(chalk.gray('  Press enter or esc to go back'));
        } else {
          // Render commands/models list with cursor highlight and arrows instruction
          filtered.forEach((cmd, idx) => {
            const isSelected = idx === selectedIndex;
            const indicator = isSelected ? chalk.bold.cyan('> ') : '  ';
            const cmdName = isSelected ? chalk.bold.cyan(cmd.name.padEnd(25)) : cmd.name.padEnd(25);
            const desc = isSelected ? chalk.cyan(cmd.description) : chalk.gray(cmd.description);
            lines.push(`${indicator}${cmdName}${desc}`);
          });
          lines.push('');
          lines.push(chalk.gray('  ↑/↓ Navigate · enter Select · esc Back/Cancel'));
        }
      } else {
        const right = footerRight(modelName);
        if (isShellMode) {
          const leftText = '! bash mode (esc to cancel)';
          const padding = Math.max(0, cols - leftText.length - right.raw.length);
          lines.push(chalk.magenta(leftText) + ' '.repeat(padding) + right.colored);
        } else {
          const leftText = '? for shortcuts · tab: mode (esc to interrupt)';
          const padding = Math.max(0, cols - leftText.length - right.raw.length);
          lines.push(chalk.gray(leftText) + ' '.repeat(padding) + right.colored);
          if (exitArmed) {
            lines.push(chalk.yellow('ctrl+c again to exit'));
          }
        }

      }

      // Count PHYSICAL rows, not logical lines: a long prompt wraps across
      // multiple terminal rows, so logical-line counting under-clears and leaves
      // stale lines stacking up. Measure each line's visible width / cols.
      const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');
      const rowsOf = (s: string) => Math.max(1, Math.ceil(stripAnsi(s).length / cols));
      let totalRows = 0;
      for (const ln of lines) totalRows += rowsOf(ln);

      // Cursor position within the (possibly wrapped) prompt line, which is lines[1].
      const cursorCharIndex = promptPrefix.length + (inputBuffer.length - cursorOffset);
      let cursorRowInPrompt: number;
      let cursorCol: number;
      if (cursorCharIndex > 0 && cursorCharIndex % cols === 0) {
        // Exact width boundary: cursor sits at the end of the previous row.
        cursorRowInPrompt = cursorCharIndex / cols - 1;
        cursorCol = cols;
      } else {
        cursorRowInPrompt = Math.floor(cursorCharIndex / cols);
        cursorCol = (cursorCharIndex % cols) + 1;
      }
      const rowsAbovePrompt = rowsOf(lines[0]); // top horizontal line (1 row)
      const cursorRowFromTop = rowsAbovePrompt + cursorRowInPrompt;
      const rowsBelowCursor = Math.max(0, totalRows - 1 - cursorRowFromTop);

      let posSeq = '';
      if (rowsBelowCursor > 0) {
        posSeq += `\x1B[${rowsBelowCursor}A`; // move cursor back up to the prompt line
      }
      posSeq += `\x1B[${cursorCol}G`; // move to correct column

      // Draw all in a SINGLE stdout write operation (completely removes rendering flicker!)
      process.stdout.write(clearSeq + lines.join('\n') + posSeq);

      // Save physical-row stats for next draw cycle
      lastLineCount = totalRows - 1;
      lastPromptLineIndexFromBottom = rowsBelowCursor;
    }

    // Initial draw
    draw();

    const onKeypress = (str: string, key: any) => {
      const filtered = getFiltered();

      if (key?.ctrl && key.name === 'c') {
        if (inputBuffer.length > 0 || menuState !== 'none') {
          // First clear the in-progress line / menu, like before.
          inputBuffer = '';
          cursorOffset = 0;
          menuState = 'none';
          selectedIndex = 0;
          exitArmed = false;
          draw();
          return;
        }
        if (!exitArmed) {
          // Empty line: arm exit and show the hint below the prompt.
          exitArmed = true;
          draw();
          return;
        }
        // Second consecutive Ctrl+C on an empty line: exit via /exit so the REPL
        // runs its normal exit path (prints goodbye + resume command).
        inputBuffer = '/exit';
        cleanup(false);
        resolve(inputBuffer);
        return;
      }

      // Any other key disarms the "press again to exit" hint.
      if (exitArmed) {
        exitArmed = false;
        draw();
      }

      // Handle custom ctrl key shortcuts
      if (key?.ctrl) {
        if (key.name === 'h') {
          menuState = 'help';
          inputBuffer = '';
          cursorOffset = 0;
          selectedIndex = 0;
          draw();
          return;
        }
        if (key.name === 'm') {
          menuState = 'models';
          inputBuffer = '';
          cursorOffset = 0;
          selectedIndex = 0;
          draw();
          return;
        }
        if (key.name === 'l') {
          inputBuffer = '/clear';
          cleanup(true);
          resolve(inputBuffer);
          return;
        }
        if (key.name === 'q') {
          inputBuffer = '/exit';
          cleanup(true);
          resolve(inputBuffer);
          return;
        }
      }

      if (key && key.name === 'up') {
        if (menuState === 'help') return; // Ignore arrows in help view
        if (menuState !== 'none' && filtered.length > 0) {
          selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
          draw();
          return;
        }
        // No menu active -> recall the previous prompt from history
        if (menuState === 'none' && promptHistory.length > 0 && historyIndex > 0) {
          if (historyIndex === promptHistory.length) {
            pendingBuffer = inputBuffer; // remember the line being typed
          }
          historyIndex--;
          inputBuffer = promptHistory[historyIndex];
          cursorOffset = 0;
          draw();
        }
        return;
      }

      if (key && key.name === 'down') {
        if (menuState === 'help') return; // Ignore arrows in help view
        if (menuState !== 'none' && filtered.length > 0) {
          selectedIndex = (selectedIndex + 1) % filtered.length;
          draw();
          return;
        }
        // No menu active -> move forward through history (back to the typed line)
        if (menuState === 'none' && historyIndex < promptHistory.length) {
          historyIndex++;
          inputBuffer = historyIndex === promptHistory.length ? pendingBuffer : promptHistory[historyIndex];
          cursorOffset = 0;
          draw();
        }
        return;
      }

      if (key && (key.name === 'tab' || key.name === 'return')) {
        // Tab with no active menu cycles the agent mode (Default → Plan → Auto).
        if (key.name === 'tab' && menuState === 'none') {
          cycleMode();
          draw();
          return;
        }

        if (menuState === 'help') {
          menuState = 'none';
          inputBuffer = '';
          cursorOffset = 0;
          selectedIndex = 0;
          draw();
          return;
        }

        if (menuState !== 'none' && filtered.length > 0) {
          if (menuState === 'commands') {
            const selected = filtered[selectedIndex].name;
            if (selected === '/model') {
              menuState = 'models';
              inputBuffer = '';
              cursorOffset = 0;
              selectedIndex = 0;
              draw();
            } else if (selected === '/help') {
              menuState = 'help';
              inputBuffer = '';
              cursorOffset = 0;
              selectedIndex = 0;
              draw();
            } else {
              // Auto-submit immediately for other commands (e.g. /exit, /clear)
              inputBuffer = selected;
              cleanup(true);
              resolve(inputBuffer);
            }
          } else if (menuState === 'models') {
            const selectedModel = filtered[selectedIndex].name;
            inputBuffer = `/model ${selectedModel}`;
            cleanup(true);
            resolve(inputBuffer);
          } else if (menuState === 'files') {
            const selectedFile = filtered[selectedIndex].name; // e.g. "@src/" or "@package.json"
            const isDir = selectedFile.endsWith('/');
            
            const cursorIdx = inputBuffer.length - cursorOffset;
            const textBeforeCursor = inputBuffer.slice(0, cursorIdx);
            const textAfterCursor = inputBuffer.slice(cursorIdx);
            const lastAtIdx = textBeforeCursor.lastIndexOf('@');
            
            const completedText = textBeforeCursor.slice(0, lastAtIdx) + selectedFile + (isDir ? '' : ' ');
            inputBuffer = completedText + textAfterCursor;
            cursorOffset = textAfterCursor.length;
            
            if (isDir) {
              menuState = 'files';
              selectedIndex = 0;
            } else {
              menuState = 'none';
            }
            draw();
          }
        } else if (key.name === 'return') {
          // No suggestions active -> Submit!
          const submitted = inputBuffer.trim();
          if (submitted && promptHistory[promptHistory.length - 1] !== inputBuffer) {
            promptHistory.push(inputBuffer);
          }
          cleanup(true);
          resolve(inputBuffer);
        }
        return;
      }

      if (key && key.name === 'escape') {
        if (menuState === 'help') {
          menuState = 'none';
          inputBuffer = '';
          cursorOffset = 0;
          selectedIndex = 0;
          draw();
        } else if (menuState === 'models') {
          menuState = 'commands';
          inputBuffer = '/';
          cursorOffset = 0;
          selectedIndex = 0;
          draw();
        } else if (menuState === 'commands') {
          menuState = 'none';
          inputBuffer = '';
          cursorOffset = 0;
          selectedIndex = 0;
          draw();
        } else {
          inputBuffer = '';
          cursorOffset = 0;
          draw();
        }
        return;
      }

      if (key && key.name === 'backspace') {
        const indexToRemove = inputBuffer.length - cursorOffset - 1;
        if (indexToRemove >= 0) {
          inputBuffer = inputBuffer.slice(0, indexToRemove) + inputBuffer.slice(indexToRemove + 1);
          if (menuState === 'commands' && inputBuffer === '') {
            menuState = 'none';
          }
          draw();
        }
        return;
      }

      if (key && key.name === 'left') {
        cursorOffset = Math.min(inputBuffer.length, cursorOffset + 1);
        draw();
        return;
      }

      if (key && key.name === 'right') {
        cursorOffset = Math.max(0, cursorOffset - 1);
        draw();
        return;
      }

      if (key && (key.meta || key.ctrl)) {
        return;
      }

      // Printable characters
      if (str && str.length === 1 && str >= ' ') {
        if (menuState === 'help') {
          return;
        }
        // If user types '?' when input is empty, trigger help view
        if (str === '?' && inputBuffer === '') {
          menuState = 'help';
          inputBuffer = '';
          cursorOffset = 0;
          selectedIndex = 0;
          draw();
          return;
        }
        const insertIndex = inputBuffer.length - cursorOffset;
        inputBuffer = inputBuffer.slice(0, insertIndex) + str + inputBuffer.slice(insertIndex);
        draw();
      }
    };

    process.stdin.on('keypress', onKeypress);

    function cleanup(submitted: boolean) {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw);
      
      // Clear interactive block cleanly in a single write
      const clearSeq = getClearSeq();
      process.stdout.write(clearSeq);
      
      lastLineCount = 0;
      lastPromptLineIndexFromBottom = 0;

      if (submitted) {
        // Print the user's prompt as a white-on-gray block in scrollback history
        console.log(renderUserEcho(inputBuffer));
      }
    }
  });
}

export function askInteractiveChoice(question: string, options: string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(options[0] || '');
      return;
    }

    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    readline.emitKeypressEvents(process.stdin);

    let selectedIndex = 0;
    let lastLineCount = 0;

    function redraw() {
      if (lastLineCount > 0) {
        process.stdout.write('\r\x1B[J');
      }

      const cols = process.stdout.columns || 80;
      const horizontalLine = chalk.gray('─'.repeat(cols - 2));

      const lines: string[] = [];
      options.forEach((opt, idx) => {
        const isSelected = idx === selectedIndex;
        const indicator = isSelected ? chalk.bold.cyan(' ● ') : chalk.gray(' ○ ');
        const text = isSelected ? chalk.bgCyan.black(` ${opt} `) : chalk.gray(` ${opt} `);
        lines.push(`${indicator}${text}`);
      });

      lines.push(horizontalLine);

      const config = loadConfig();
      const prettyModel = getPrettyModelName(config.model);
      const leftText = '? for shortcuts (esc to interrupt)';
      const right = footerRight(prettyModel);
      const padding = Math.max(0, cols - leftText.length - right.raw.length - 2);
      const footer = chalk.gray(leftText) + ' '.repeat(padding) + right.colored;
      lines.push(footer);

      process.stdout.write(lines.join('\n'));
      lastLineCount = lines.length;

      // Move cursor back to the first line
      process.stdout.write(`\r\x1B[${lines.length - 1}A`);
    }

    redraw();

    const onKeypress = (str: string, key: any) => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        process.exit(0);
      }

      if (key && key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        redraw();
        return;
      }

      if (key && key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % options.length;
        redraw();
        return;
      }

      if (key && key.name === 'return') {
        cleanup();
        resolve(options[selectedIndex]);
        return;
      }

      if (key && key.name === 'escape') {
        cleanup();
        resolve('');
        return;
      }
    };

    process.stdin.on('keypress', onKeypress);

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw);
      // Cleanly clear all lines from the first line downwards
      process.stdout.write('\r\x1B[J');
    }
  });
}

// ---------------------------------------------------------------------------
// Pertanyaan terstruktur ala Claude Code (tool `ask_user`)
// ---------------------------------------------------------------------------

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface AskAnswer {
  question: string;
  answers: string[];
}

// Label for the "type your own" item always appended at the end of the options.
const OTHER_LABEL = 'Other (type your own)';

// Combine answers into concise text to return to the model. Pure function,
// exported for easy testing.
export function formatAskAnswers(answers: AskAnswer[]): string {
  if (answers.length === 0) return 'The user gave no answer.';
  const lines = answers.map((a) => {
    const val = a.answers.length > 0 ? a.answers.join(', ') : '(not answered)';
    return `- ${a.question}: ${val}`;
  });
  return `User answers:\n${lines.join('\n')}`;
}

// Tampilkan SATU pertanyaan terstruktur secara interaktif. Mengembalikan daftar
// jawaban terpilih (label opsi atau teks bebas), atau null bila dibatalkan (Esc)
// / lingkungan non-TTY. Meminjam pola raw-mode + single-batch redraw dari
// askInteractiveChoice/askCustomPrompt di atas.
function askStructuredQuestion(
  q: AskQuestion,
  idx: number,
  total: number
): Promise<string[] | null> {
  return new Promise<string[] | null>((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(null);
      return;
    }

    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    readline.emitKeypressEvents(process.stdin);

    // Item menu = opsi model + satu item "Lainnya".
    const items: AskOption[] = [...q.options, { label: OTHER_LABEL }];
    const otherIndex = items.length - 1;
    const multi = q.multiSelect === true;

    let selectedIndex = 0;
    const checked = new Set<number>(); // hanya untuk multi-select
    let mode: 'menu' | 'typing' = 'menu';
    let typed = '';
    let lastLineCount = 0;

    function redraw() {
      if (lastLineCount > 0) {
        process.stdout.write('\r\x1B[J');
      }

      const cols = process.stdout.columns || 80;
      const horizontalLine = chalk.gray('─'.repeat(Math.max(1, cols - 2)));
      const lines: string[] = [];

      // Header: [i/total] + chip header + teks pertanyaan
      const counter = total > 1 ? chalk.gray(`[${idx + 1}/${total}] `) : '';
      const chip = q.header ? `${chalk.bgCyan.black(` ${q.header} `)} ` : '';
      lines.push(`${counter}${chip}${chalk.bold.white(q.question)}`);
      lines.push('');

      items.forEach((opt, i) => {
        const cursor = i === selectedIndex;
        let marker: string;
        if (multi && i !== otherIndex) {
          marker = checked.has(i) ? chalk.cyan('[x]') : chalk.gray('[ ]');
        } else {
          marker = cursor ? chalk.bold.cyan('●') : chalk.gray('○');
        }
        const label = cursor ? chalk.bgCyan.black(` ${opt.label} `) : chalk.white(` ${opt.label} `);
        lines.push(` ${marker} ${label}`);
        if (opt.description) {
          lines.push(`      ${chalk.gray(opt.description)}`);
        }
      });

      lines.push(horizontalLine);

      if (mode === 'typing') {
        lines.push(`${chalk.cyan('Type your answer:')} ${typed}${chalk.inverse(' ')}`);
        lines.push(chalk.gray('enter Submit · esc Back to options'));
      } else {
        const hint = multi
          ? '↑/↓ Navigate · space Toggle · enter Confirm · esc Cancel'
          : '↑/↓ Navigate · enter Select · esc Cancel';
        lines.push(chalk.gray(hint));
      }

      process.stdout.write(lines.join('\n'));
      lastLineCount = lines.length;
      // Kembalikan kursor ke baris pertama blok.
      if (lines.length > 1) process.stdout.write(`\r\x1B[${lines.length - 1}A`);
      else process.stdout.write('\r');
    }

    redraw();

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdout.write('\r\x1B[J');
    }

    const onKeypress = (str: string, key: any) => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        process.exit(0);
      }

      if (mode === 'typing') {
        if (key && key.name === 'return') {
          const value = typed.trim();
          cleanup();
          resolve(value ? [value] : []);
          return;
        }
        if (key && key.name === 'escape') {
          mode = 'menu';
          typed = '';
          redraw();
          return;
        }
        if (key && key.name === 'backspace') {
          typed = typed.slice(0, -1);
          redraw();
          return;
        }
        if (str && str.length === 1 && str >= ' ' && !key?.ctrl && !key?.meta) {
          typed += str;
          redraw();
        }
        return;
      }

      // mode === 'menu'
      if (key && key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        redraw();
        return;
      }
      if (key && key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % items.length;
        redraw();
        return;
      }

      // Space menandai opsi pada multi-select (kecuali item "Lainnya").
      if (multi && str === ' ' && selectedIndex !== otherIndex) {
        if (checked.has(selectedIndex)) checked.delete(selectedIndex);
        else checked.add(selectedIndex);
        redraw();
        return;
      }

      if (key && key.name === 'return') {
        if (selectedIndex === otherIndex) {
          mode = 'typing';
          typed = '';
          redraw();
          return;
        }
        if (multi) {
          const picked = [...checked].sort((a, b) => a - b).map((i) => items[i].label);
          if (picked.length === 0) {
            // Belum ada yang ditandai → perlakukan Enter sebagai memilih baris ini.
            picked.push(items[selectedIndex].label);
          }
          cleanup();
          resolve(picked);
          return;
        }
        cleanup();
        resolve([items[selectedIndex].label]);
        return;
      }

      if (key && key.name === 'escape') {
        cleanup();
        resolve(null);
        return;
      }
    };

    process.stdin.on('keypress', onKeypress);
  });
}

// Ajukan 1..N pertanyaan terstruktur secara berurutan. Mengembalikan jawaban,
// atau null bila pengguna membatalkan salah satu pertanyaan (Esc) atau non-TTY.
export async function askUser(questions: AskQuestion[]): Promise<AskAnswer[] | null> {
  const answers: AskAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const picked = await askStructuredQuestion(q, i, questions.length);
    if (picked === null) return null;
    // Echo ringkas ke scrollback agar tampil sebagai jejak interaksi.
    console.log(
      chalk.bgBlackBright.whiteBright(` ? ${q.question} `) +
        ' ' +
        chalk.cyan(picked.length ? picked.join(', ') : '(dilewati)')
    );
    answers.push({ question: q.question, answers: picked });
  }
  return answers;
}
