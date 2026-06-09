import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import { loadConfig, getPrettyModelName } from './config.js';
import { renderDiff } from './diff.js';
import { isAutoMode, isPlanMode, setMode, footerRight } from './mode.js';
import { loadIgnore, type IgnoreMatcher } from './gitignore.js';
import { askUser, formatAskAnswers, type AskQuestion } from './prompt.js';

// Auto-approve mode: when enabled, file-mutating tools and run_command skip the
// Yes/No confirmation. Toggled via the /auto slash command or the -y/--yes flag.
// Safety exception: actions whose target is OUTSIDE the current working directory
// always ask, even in auto-approve mode. State now lives in mode.ts; these thin
// wrappers preserve the existing call sites.
export function setAutoApprove(value: boolean): void {
  setMode(value ? 'auto' : 'default');
}
export function isAutoApprove(): boolean {
  return isAutoMode();
}

// Tools that change the filesystem or run shell commands. Blocked entirely in
// plan mode (read-only), enforced here as a safety net beyond the system prompt.
const MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'delete_file',
  'move_file',
  'make_dir',
  'run_command'
]);

// Undo stack: setiap aksi mutasi (write/edit/delete/move) mendorong cara
// memulihkan keadaan sebelumnya. Slash /undo memanggil undoLast(). Hanya berlaku
// dalam satu sesi (tidak persisten).
interface UndoEntry {
  label: string;
  undo: () => void;
}
const undoStack: UndoEntry[] = [];
const MAX_UNDO = 50;

function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

// Undo the last mutating action. Returns a status message to display.
export function undoLast(): string {
  const entry = undoStack.pop();
  if (!entry) return 'No changes to undo.';
  try {
    entry.undo();
    return `Undone: ${entry.label}`;
  } catch (e: any) {
    return `Failed to undo (${entry.label}): ${e.message}`;
  }
}

export function getUndoCount(): number {
  return undoStack.length;
}

// Working directory yang bertahan antar pemanggilan run_command dalam satu sesi.
// `cd <dir>` standalone memperbaruinya; perintah lain dijalankan dengan cwd ini.
let sessionCwd = process.cwd();

export function getSessionCwd(): string {
  return sessionCwd;
}

// Persetujuan "semua di langkah ini": sekali disetujui, mutasi berikutnya dalam
// giliran agen yang sama tidak menanyakan konfirmasi (kecuali target di luar cwd).
// Direset tiap giliran via resetTurnApproval() — beda dari /auto yang permanen.
let approveAllThisTurn = false;

export function resetTurnApproval(): void {
  approveAllThisTurn = false;
}

// Jika command HANYA "cd <dir>" (tanpa operator majemuk), kembalikan argumen dir,
// selain itu null. Dipakai untuk melacak cwd; di-export untuk diuji.
export function parseCdCommand(cmd: string): string | null {
  const trimmed = cmd.trim();
  // Tolak bila ada operator shell (cd majemuk tidak dilacak).
  if (/[;&|]/.test(trimmed)) return null;
  const m = trimmed.match(/^cd\s+(.+)$/);
  if (!m) return null;
  // Lepas kutip di sekeliling path bila ada.
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

// True when the resolved path is inside (or equal to) the current working directory.
function isInsideCwd(targetPath: string): boolean {
  const rel = path.relative(process.cwd(), targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}


export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export const toolsList: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file from the local filesystem. Output is returned with line numbers (like "cat -n"), which helps target edits. Large files are truncated; use offset/limit to page through them.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The absolute or relative path to the file to read.'
          },
          offset: {
            type: 'number',
            description: 'Optional 1-based line number to start reading from.'
          },
          limit: {
            type: 'number',
            description: 'Optional maximum number of lines to read starting at offset.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or overwrite an existing file with content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to write.'
          },
          content: {
            type: 'string',
            description: 'The text content to write to the file.'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the contents (files and directories) of a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the directory to list. Defaults to the current directory if empty.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command on the user\'s system and return its standard output/error.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute.'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search for a regex pattern or plain text in the CONTENTS of files under a directory.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search term or regex pattern.'
          },
          path: {
            type: 'string',
            description: 'The directory path to search. Defaults to current directory.'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit an existing file by replacing a string with new text. Matching prefers an exact match, then falls back to a whitespace-tolerant match (indentation/spacing differences are ignored) — but the match must still be unique. Prefer this over write_file for small changes. For several edits to the same file, prefer multi_edit.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to edit.'
          },
          old_string: {
            type: 'string',
            description: 'The exact text to find and replace. Must match the file content precisely.'
          },
          new_string: {
            type: 'string',
            description: 'The text to replace old_string with.'
          },
          replace_all: {
            type: 'boolean',
            description: 'If true, replace every occurrence. If false (default), old_string must be unique.'
          }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'multi_edit',
      description: 'Apply several string edits to a SINGLE file in one atomic operation. Edits are applied in order; if any edit fails to match, NOTHING is written. Use this instead of multiple edit_file calls on the same file.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to edit.'
          },
          edits: {
            type: 'array',
            description: 'List of edits applied sequentially. Each later edit sees the result of previous edits.',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string', description: 'Text to find (exact, or whitespace-tolerant unique match).' },
                new_string: { type: 'string', description: 'Replacement text.' },
                replace_all: { type: 'boolean', description: 'Replace every exact occurrence (default false).' }
              },
              required: ['old_string', 'new_string']
            }
          }
        },
        required: ['path', 'edits']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the filesystem. Asks the user for confirmation before deleting.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to delete.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files by NAME using a glob pattern. Examples: "*.ts" (any .ts file at any depth), "**/*.test.ts", "config.*". Use grep_search to search file contents instead.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern. Supports "*" (within a path segment), "**" (across directories) and "?". Case-insensitive. A simple pattern like "*.ts" matches files at any depth.'
          },
          path: {
            type: 'string',
            description: 'The directory to search recursively. Defaults to current directory.'
          }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'make_dir',
      description: 'Create a directory (and any missing parent directories).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The directory path to create.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Move or rename a file or directory. Asks the user for confirmation. Creates parent folders of the destination if missing.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'The current path of the file or directory.'
          },
          destination: {
            type: 'string',
            description: 'The new path.'
          }
        },
        required: ['source', 'destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user 1-3 structured questions with multiple-choice options (and optional multi-select). Use ONLY to clarify ambiguous requirements, let the user pick a direction, or confirm a decision that materially changes behavior and cannot be inferred from the repo. Do not use for facts discoverable locally. Each question always also offers a free-text "Other" choice.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'Between 1 and 3 questions to ask the user.',
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The full question to ask the user.'
                },
                header: {
                  type: 'string',
                  description: 'A very short label/category for the question (shown as a chip).'
                },
                multiSelect: {
                  type: 'boolean',
                  description: 'If true, the user may select multiple options. Default false (single choice).'
                },
                options: {
                  type: 'array',
                  description: 'At least 2 distinct options the user can choose from.',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'The option text shown to the user.' },
                      description: { type: 'string', description: 'Optional short explanation of the option.' }
                    },
                    required: ['label']
                  }
                }
              },
              required: ['question', 'options']
            }
          }
        },
        required: ['questions']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show the git working-tree status (porcelain/short). Read-only; use to see which files changed before committing.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show the git diff of changes. Read-only. Optionally limit to a path, or show staged changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional file/dir to limit the diff to.' },
          staged: { type: 'boolean', description: 'If true, show staged (cached) changes instead of unstaged.' }
        }
      }
    }
  }
];

// Helper to ask user for permission for run_command with interactive choices
async function askUserPermission(promptText: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    readline.emitKeypressEvents(process.stdin);

    let selectedIndex = 0; // 0 = Yes, 1 = Semua (langkah ini), 2 = Always, 3 = No
    const OPTION_COUNT = 4;
    let lastLineCount = 0;

    function draw() {
      if (lastLineCount > 0) {
        process.stdout.write('\r\x1B[J');
      }

      const cols = process.stdout.columns || 80;
      const horizontalLine = chalk.gray('─'.repeat(cols - 2));
      const approveText = selectedIndex === 0 ? chalk.bgGreen.black(' Yes ') : chalk.gray(' Yes ');
      const allText = selectedIndex === 1 ? chalk.bgCyan.black(' All steps this turn ') : chalk.gray(' All steps this turn ');
      const alwaysText = selectedIndex === 2 ? chalk.bgCyan.black(' Always ') : chalk.gray(' Always ');
      const rejectText = selectedIndex === 3 ? chalk.bgRed.black(' No ') : chalk.gray(' No ');
      const mainLine = `${promptText}   ${approveText}  ${allText}  ${alwaysText}  ${rejectText}`;

      const config = loadConfig();
      const prettyModel = getPrettyModelName(config.model);
      const leftText = '←/→ select · enter ok · s: all steps this turn · a: always · esc cancel';
      const right = footerRight(prettyModel);
      const padding = Math.max(0, cols - leftText.length - right.raw.length - 2);
      const footer = chalk.gray(leftText) + ' '.repeat(padding) + right.colored;

      const lines = [
        mainLine,
        horizontalLine,
        footer
      ];

      process.stdout.write(lines.join('\n'));
      lastLineCount = lines.length;

      // Move cursor back to the first line
      process.stdout.write(`\r\x1B[${lines.length - 1}A`);
    }

    draw();

    // Selecting "Always" turns on auto-approve for the rest of the session so the
    // user confirms once; subsequent mutations/commands skip the prompt (except
    // targets outside the working directory, which always ask). Equivalent to /auto.
    function approveAlways() {
      cleanup();
      setMode('auto');
      console.log(
        chalk.yellow(
          'Auto-approve mode enabled — Aina will not ask for confirmation again ' +
            '(except targets outside the working folder). Press Tab or /auto to turn it off.'
        )
      );
      resolve(true);
    }

    // "All steps this turn": approve the remaining mutations in this agent turn only.
    function approveAllStep() {
      cleanup();
      approveAllThisTurn = true;
      console.log(
        chalk.cyan(
          'Approving all changes in this step — the next confirmations are skipped ' +
            'until this turn finishes (except targets outside the working folder).'
        )
      );
      resolve(true);
    }

    const onKeypress = (str: string, key: any) => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        resolve(false);
        return;
      }

      if (key && (key.name === 'left' || key.name === 'right')) {
        selectedIndex = key.name === 'right'
          ? (selectedIndex + 1) % OPTION_COUNT
          : (selectedIndex + OPTION_COUNT - 1) % OPTION_COUNT;
        draw();
        return;
      }

      if (key && key.name === 'return') {
        if (selectedIndex === 1) {
          approveAllStep();
          return;
        }
        if (selectedIndex === 2) {
          approveAlways();
          return;
        }
        cleanup();
        resolve(selectedIndex === 0);
        return;
      }

      if (key && key.name === 'escape') {
        cleanup();
        resolve(false);
        return;
      }

      if (key && key.name === 'y') {
        cleanup();
        resolve(true);
        return;
      }

      if (key && key.name === 's') {
        approveAllStep();
        return;
      }

      if (key && key.name === 'a') {
        approveAlways();
        return;
      }

      if (key && key.name === 'n') {
        cleanup();
        resolve(false);
        return;
      }
    };

    process.stdin.on('keypress', onKeypress);

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdout.write('\r\x1B[J');
    }
  });
}

// Gate a mutating action. In auto-approve mode the prompt is skipped UNLESS the
// target lives outside the current working directory (always confirmed). When a
// confirmation is needed, an optional preview (e.g. a diff) is printed first.
async function confirmMutation(promptText: string, targetPath: string, preview?: string): Promise<boolean> {
  const outside = !isInsideCwd(targetPath);
  if (preview) console.log(preview);
  if ((isAutoMode() || approveAllThisTurn) && !outside) return true;
  if (outside) {
    console.log(chalk.yellow(`Target is OUTSIDE the working folder: ${targetPath}`));
  }
  return askUserPermission(promptText);
}

// Batas jumlah baris hasil grep agar tidak membanjiri context window.
const MAX_GREP_RESULTS = 200;

// Bangun pencocok baris untuk grep_search. Coba perlakukan query sebagai regex
// (case-insensitive); jika polanya invalid, jatuh ke pencocokan substring literal
// agar perilaku lama tetap aman.
function buildLineMatcher(query: string): (line: string) => boolean {
  try {
    const re = new RegExp(query, 'i');
    return (line: string) => re.test(line);
  } catch {
    return (line: string) => line.includes(query);
  }
}

// Cache ketersediaan ripgrep (rg) — dideteksi sekali per proses.
let rgAvailable: boolean | null = null;

function hasRipgrep(): boolean {
  if (rgAvailable === null) {
    try {
      const r = spawnSync('rg', ['--version'], { stdio: 'ignore' });
      rgAvailable = !r.error && r.status === 0;
    } catch {
      rgAvailable = false;
    }
  }
  return rgAvailable;
}

// Coba grep via ripgrep (menghormati .gitignore secara native, jauh lebih cepat
// di repo besar). Mengembalikan baris hasil "path:line:content", atau null bila
// rg tidak tersedia / polanya invalid (agar pemanggil bisa fallback ke JS).
function tryRipgrep(query: string, dir: string): string[] | null {
  if (!hasRipgrep()) return null;
  try {
    const r = spawnSync(
      'rg',
      ['--line-number', '--no-heading', '--color', 'never', '--smart-case', '-e', query, '.'],
      { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    // status 0 = ada match, 1 = tidak ada match (keduanya sukses); selain itu error
    // (mis. pola regex invalid) → fallback.
    if (r.error || (r.status !== 0 && r.status !== 1)) return null;
    const lines = (r.stdout || '')
      .split('\n')
      .filter((l) => l.length > 0)
      // rg memberi path relatif terhadap `dir`; jadikan absolut agar serupa output JS.
      .map((l) => `${dir}${path.sep}${l.replace(/^\.[\\/]/, '')}`);
    return lines.slice(0, MAX_GREP_RESULTS);
  } catch {
    return null;
  }
}

// Function to recursively search files for grep_search. Menghormati .gitignore
// (via `ignore`) dan berhenti setelah MAX_GREP_RESULTS baris.
function searchDirectory(
  dir: string,
  match: (line: string) => boolean,
  root: string,
  ignore: IgnoreMatcher,
  results: string[] = []
): string[] {
  if (results.length >= MAX_GREP_RESULTS) return results;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return results;
  }
  for (const file of files) {
    if (results.length >= MAX_GREP_RESULTS) break;
    const fullPath = path.join(dir, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    const rel = path.relative(root, fullPath).replace(/\\/g, '/');
    if (ignore(rel, stat.isDirectory())) continue;
    if (stat.isDirectory()) {
      searchDirectory(fullPath, match, root, ignore, results);
    } else if (stat.isFile()) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');
        for (let idx = 0; idx < lines.length; idx++) {
          if (match(lines[idx])) {
            results.push(`${fullPath}:${idx + 1}: ${lines[idx].trim()}`);
            if (results.length >= MAX_GREP_RESULTS) break;
          }
        }
      } catch {
        // Skip binary or unreadable files
      }
    }
  }
  return results;
}

// Convert a glob pattern into a case-insensitive RegExp.
// Supports "*" (within a path segment), "**" (across segments), and "?".
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // "**/" matches zero or more directories
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

// Recursively collect file paths matching the given pattern.
// When matchRelative is true the pattern is tested against the path relative to
// `root` (for glob patterns containing "/"); otherwise against the basename.
function findFilesByName(
  dir: string,
  regex: RegExp,
  matchRelative: boolean,
  root: string,
  ignore: IgnoreMatcher,
  results: string[] = []
): string[] {
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      const rel = path.relative(root, fullPath).replace(/\\/g, '/');
      if (ignore(rel, stat.isDirectory())) continue;
      if (stat.isDirectory()) {
        findFilesByName(fullPath, regex, matchRelative, root, ignore, results);
      } else if (stat.isFile()) {
        const target = matchRelative
          ? path.relative(root, fullPath).replace(/\\/g, '/')
          : file;
        if (regex.test(target)) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // Ignore read errors
  }
  return results;
}

// Cap default pembacaan file agar file besar tidak menghabiskan context window.
const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 100 * 1024;

// Baca file dan kembalikan output bernomor baris gaya "cat -n". Mendukung
// offset (baris awal 1-based) & limit (jumlah baris). Tanpa keduanya, dibatasi
// READ_MAX_LINES / READ_MAX_BYTES dengan pesan truncation. Di-export untuk diuji.
export function readFileWithLineNumbers(
  filePath: string,
  offset?: number,
  limit?: number
): string {
  let content = fs.readFileSync(filePath, 'utf8');
  let bytesTruncated = false;
  if (Buffer.byteLength(content, 'utf8') > READ_MAX_BYTES) {
    content = content.slice(0, READ_MAX_BYTES);
    bytesTruncated = true;
  }

  const allLines = content.split('\n');
  const totalLines = allLines.length;

  const start = offset && offset > 0 ? offset - 1 : 0;
  const explicitLimit = limit && limit > 0 ? limit : undefined;
  const maxLines = explicitLimit ?? READ_MAX_LINES;
  const end = Math.min(allLines.length, start + maxLines);

  const slice = allLines.slice(start, end);
  if (slice.length === 0) {
    return `(no lines in the requested range; the file has ${totalLines} lines)`;
  }

  const width = String(end).length;
  const numbered = slice
    .map((line, i) => `${String(start + i + 1).padStart(width, ' ')}\t${line}`)
    .join('\n');

  const notes: string[] = [];
  if (end < totalLines) {
    notes.push(`... (${totalLines - end} more lines not shown; use offset=${end + 1} to continue)`);
  }
  if (bytesTruncated) {
    notes.push(`... (file exceeds ${READ_MAX_BYTES / 1024}KB, contents truncated)`);
  }
  return notes.length > 0 ? `${numbered}\n${notes.join('\n')}` : numbered;
}

// Heuristik perintah destruktif. Mengembalikan alasan (string) bila terdeteksi,
// atau null. BUKAN jaminan keamanan — hanya untuk memaksa konfirmasi eksplisit
// (bahkan di mode auto-approve) dan menampilkan peringatan mencolok. Di-export
// untuk diuji.
export function detectDangerousCommand(cmd: string): string | null {
  const c = cmd.toLowerCase();
  const checks: [RegExp, string][] = [
    [/\brm\b[^|;&]*-[a-z]*r[a-z]*f|\brm\b[^|;&]*-[a-z]*f[a-z]*r|\brm\b[^|;&]*-rf|\brm\b[^|;&]*-fr/, 'recursive forced deletion (rm -rf)'],
    [/\bsudo\b/, 'execution with root privileges (sudo)'],
    [/\bmkfs\b|\bfdisk\b|\bparted\b/, 'disk format/partition operation'],
    [/\bdd\b[^|;&]*\bof=/, 'direct block write (dd of=)'],
    [/>\s*\/dev\/(sd|nvme|disk)/, 'writing directly to a disk device'],
    [/:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;/, 'fork bomb'],
    [/\bchmod\b[^|;&]*-R[^|;&]*777|\bchmod\b[^|;&]*777[^|;&]*-R/, 'recursive chmod 777'],
    [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, 'piping a script from the internet straight into a shell'],
    [/\bgit\b[^|;&]*\bpush\b[^|;&]*(--force\b|-f\b)/, 'force git push (--force)'],
    [/\bgit\b[^|;&]*\breset\b[^|;&]*--hard/, 'git reset --hard (discards changes)'],
    // Dangerous Windows-specific patterns (cmd/PowerShell).
    [/\bdel\b[^|;&]*\/[sq]\b|\bdel\b[^|;&]*\/s\b[^|;&]*\/q\b/, 'forced Windows deletion (del /s /q)'],
    [/\b(rd|rmdir)\b[^|;&]*\/s\b/, 'recursive Windows directory deletion (rmdir /s)'],
    [/\bformat\b\s+[a-z]:/, 'format a Windows drive'],
    [/\bremove-item\b[^|;&]*-recurse[^|;&]*-force|\bremove-item\b[^|;&]*-force[^|;&]*-recurse|\bri\b[^|;&]*-recurse[^|;&]*-force/, 'recursive forced PowerShell deletion (Remove-Item -Recurse -Force)'],
  ];
  for (const [re, reason] of checks) {
    if (re.test(c)) return reason;
  }
  return null;
}

// Cari kecocokan `oldStr` di `content` dengan toleransi whitespace: setiap
// rentetan whitespace (spasi/tab/baris baru) dianggap sepadan. Mengembalikan
// rentang [start,end) bila tepat satu kecocokan, 'ambiguous' bila lebih dari satu,
// atau null bila tidak ada. Dipakai sebagai fallback saat exact-match gagal.
export function findFlexibleMatch(
  content: string,
  oldStr: string
): { start: number; end: number } | 'ambiguous' | null {
  const escaped = oldStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\s+/g, '\\s+');
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'g');
  } catch {
    return null;
  }
  const matches = [...content.matchAll(re)];
  if (matches.length === 0) return null;
  if (matches.length > 1) return 'ambiguous';
  const m = matches[0];
  return { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
}

export type EditOutcome =
  | { ok: true; updated: string; flexible: boolean }
  | { ok: false; error: string };

// Terapkan satu pengeditan string ke `content`. Coba exact-match dulu (hormati
// `replaceAll` & keunikan); bila gagal, fallback ke pencocokan toleran-whitespace
// yang tetap mewajibkan kecocokan tunggal. Fungsi murni, di-export untuk diuji
// dan dipakai oleh edit_file & multi_edit.
export function applySingleEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll = false
): EditOutcome {
  if (oldStr === '') return { ok: false, error: 'old_string cannot be empty.' };

  const exactCount = content.split(oldStr).length - 1;
  if (exactCount > 0) {
    if (replaceAll) {
      return { ok: true, updated: content.split(oldStr).join(newStr), flexible: false };
    }
    if (exactCount > 1) {
      return {
        ok: false,
        error: `old_string is not unique (found ${exactCount} times). Add more context or set replace_all=true.`,
      };
    }
    return { ok: true, updated: content.replace(oldStr, newStr), flexible: false };
  }

  // Fallback toleran whitespace (hanya untuk kecocokan tunggal; replace_all tetap exact).
  const m = findFlexibleMatch(content, oldStr);
  if (m === null) {
    return { ok: false, error: 'old_string not found (even after whitespace normalization).' };
  }
  if (m === 'ambiguous') {
    return { ok: false, error: 'old_string is ambiguous after whitespace normalization; add more context.' };
  }
  return {
    ok: true,
    updated: content.slice(0, m.start) + newStr + content.slice(m.end),
    flexible: true,
  };
}

// Tentukan perintah validasi (typecheck/lint) yang akan dijalankan otomatis
// setelah perubahan file. Urutan: override config → script "typecheck" di
// package.json → tsc --noEmit bila ada tsconfig → null (lewati). Di-export & dites.
export function resolveValidateCommand(cwd: string = process.cwd()): string | null {
  const cfg = loadConfig();
  if (cfg.validateCommand?.trim()) {
    return cfg.validateCommand.trim();
  }
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};
      if (scripts.typecheck) return 'npm run -s typecheck';
      if (scripts['type-check']) return 'npm run -s type-check';
    }
  } catch {
    // package.json tak terbaca → coba heuristik berikutnya.
  }
  if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    return 'npx -y tsc --noEmit';
  }
  return null;
}

// ---- Git helpers (read-only tools + slash /diff /commit) -------------------

export function isGitRepo(cwd: string = sessionCwd): boolean {
  try {
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return !r.error && r.status === 0 && (r.stdout || '').trim() === 'true';
  } catch {
    return false;
  }
}

// Jalankan perintah git dan kembalikan { ok, output }. Output di-cap.
export function runGit(gitArgs: string[], cwd: string = sessionCwd): { ok: boolean; output: string } {
  try {
    const r = spawnSync('git', gitArgs, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) return { ok: false, output: `git error: ${r.error.message}` };
    let output = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
    const MAX = 16 * 1024;
    if (output.length > MAX) output = output.slice(0, MAX) + '\n... (output truncated)';
    return { ok: r.status === 0, output };
  } catch (e: any) {
    return { ok: false, output: `git error: ${e.message}` };
  }
}

export interface ValidationResult {
  command: string;
  ok: boolean;
  output: string;
}

// Jalankan perintah validasi secara sinkron (di sessionCwd). Mengembalikan null
// bila tidak ada perintah / gagal start. Output di-cap.
export function runValidation(): ValidationResult | null {
  const command = resolveValidateCommand(sessionCwd);
  if (!command) return null;
  try {
    const r = spawnSync(command, {
      shell: true,
      cwd: sessionCwd,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.error) return null; // gagal start (mis. perintah tak ada) → diam
    let output = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
    const MAX = 8 * 1024;
    if (output.length > MAX) output = output.slice(0, MAX) + '\n... (output truncated)';
    return { command, ok: r.status === 0, output };
  } catch {
    return null;
  }
}

export async function executeTool(name: string, args: any): Promise<string> {
  // Plan mode is read-only: refuse any mutating tool so the agent stays in
  // planning mode and presents a plan instead of changing anything.
  if (isPlanMode() && MUTATING_TOOLS.has(name)) {
    return (
      'Error: Plan mode is active. Aina must not modify files or run ' +
      'commands. Present a clear implementation plan (summary, key changes, ' +
      'important files/areas, and a test plan), then ask the user to press Tab to switch ' +
      'to Default/Auto mode and approve before the plan is executed.'
    );
  }
  switch (name) {
    case 'read_file': {
      const targetPath = path.resolve(args.path);
      try {
        if (!fs.existsSync(targetPath)) {
          return `Error: File not found at ${args.path}`;
        }
        const stats = fs.statSync(targetPath);
        if (!stats.isFile()) {
          return `Error: ${args.path} is not a file.`;
        }
        return readFileWithLineNumbers(targetPath, args.offset, args.limit);
      } catch (err: any) {
        return `Error reading file: ${err.message}`;
      }
    }
    case 'write_file': {
      const targetPath = path.resolve(args.path);
      try {
        let before = '';
        let existed = false;
        if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
          before = fs.readFileSync(targetPath, 'utf8');
          existed = true;
        }
        const after = String(args.content ?? '');
        const preview = renderDiff(existed ? 'Update' : 'Create', args.path, before, after);
        const approved = await confirmMutation(chalk.green('Apply this change?'), targetPath, preview);
        if (!approved) {
          return 'Error: Write rejected by user.';
        }
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(targetPath, after, 'utf8');
        pushUndo({
          label: `${existed ? 'rewrite' : 'create'} ${args.path}`,
          undo: () => {
            if (existed) {
              fs.writeFileSync(targetPath, before, 'utf8');
            } else if (fs.existsSync(targetPath)) {
              fs.unlinkSync(targetPath);
            }
          },
        });
        return `Successfully wrote to file: ${args.path}`;
      } catch (err: any) {
        return `Error writing file: ${err.message}`;
      }
    }
    case 'list_dir': {
      const targetPath = path.resolve(args.path || '.');
      try {
        if (!fs.existsSync(targetPath)) {
          return `Error: Directory not found at ${targetPath}`;
        }
        const stats = fs.statSync(targetPath);
        if (!stats.isDirectory()) {
          return `Error: ${args.path} is not a directory.`;
        }
        const files = fs.readdirSync(targetPath);
        const resultLines = files.map(file => {
          const fPath = path.join(targetPath, file);
          const fStats = fs.statSync(fPath);
          const type = fStats.isDirectory() ? 'DIR' : 'FILE';
          return `${type.padEnd(6)} ${file}`;
        });
        return resultLines.length > 0 ? resultLines.join('\n') : '(empty directory)';
      } catch (err: any) {
        return `Error listing directory: ${err.message}`;
      }
    }
    case 'run_command': {
      const cmd = args.command;
      const danger = detectDangerousCommand(cmd);
      console.log(chalk.yellow('[Aina wants to run a command]:'));
      console.log(chalk.gray(`  cwd: ${sessionCwd}`));
      console.log(chalk.cyan(`  $ ${cmd}`));
      if (danger) {
        console.log(`${chalk.bgRed.white(' DANGEROUS ')} ${chalk.red(`This command looks risky: ${danger}.`)}`);
      }
      // Destructive commands ALWAYS require explicit confirmation, even in auto mode.
      const approved = isAutoMode() && !danger
        ? true
        : await askUserPermission(chalk.green('Approve this command?'));
      if (!approved) {
        return 'Error: Command execution rejected by user.';
      }

      // Standalone "cd <dir>": update the session working dir without spawning a shell.
      const cdTarget = parseCdCommand(cmd);
      if (cdTarget !== null) {
        const resolved = path.resolve(sessionCwd, cdTarget);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          return `Error: directory not found: ${cdTarget}`;
        }
        sessionCwd = resolved;
        return `Working directory changed to: ${sessionCwd}`;
      }

      const COMMAND_TIMEOUT = 120000; // hentikan perintah yang menggantung setelah 120s
      const MAX_OUTPUT = 100 * 1024;  // batasi output yang dikembalikan ke 100 KB
      return new Promise<string>((resolve) => {
        const child = spawn(cmd, { shell: true, cwd: sessionCwd });
        let output = '';
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, COMMAND_TIMEOUT);

        const onData = (chunk: Buffer) => {
          const s = chunk.toString();
          // Tampilkan progres secara live ke konsol (spinner sudah dihentikan).
          process.stdout.write(s);
          output += s;
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve(`EXECUTION ERROR: ${err.message}`);
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          if (timedOut) {
            output += `\nEXECUTION ERROR: command stopped after exceeding the ${COMMAND_TIMEOUT / 1000}s timeout.`;
          } else if (code && code !== 0) {
            output += `\nEXECUTION ERROR: command exited with code ${code}.`;
          }
          if (output.length > MAX_OUTPUT) {
            output = output.slice(0, MAX_OUTPUT) + '\n... (output truncated)';
          }
          resolve(output || '(command executed with no output)');
        });
      });
    }
    case 'grep_search': {
      const targetPath = path.resolve(args.path || '.');
      try {
        if (!fs.existsSync(targetPath)) {
          return `Error: Path not found at ${targetPath}`;
        }
        // Utamakan ripgrep (cepat + hormati .gitignore native); fallback ke JS.
        let results = tryRipgrep(args.query, targetPath);
        if (results === null) {
          const matcher = buildLineMatcher(args.query);
          const ignore = loadIgnore(targetPath);
          results = searchDirectory(targetPath, matcher, targetPath, ignore, []);
        }
        if (results.length === 0) {
          return `No matches found for query: "${args.query}"`;
        }
        let out = results.join('\n');
        if (results.length >= MAX_GREP_RESULTS) {
          out += `\n... (results truncated at ${MAX_GREP_RESULTS} lines; narrow your query)`;
        }
        return out;
      } catch (err: any) {
        return `Error performing search: ${err.message}`;
      }
    }
    case 'edit_file': {
      const targetPath = path.resolve(args.path);
      try {
        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
          return `Error: File not found at ${args.path}`;
        }
        const original = fs.readFileSync(targetPath, 'utf8');
        const outcome = applySingleEdit(
          original,
          args.old_string ?? '',
          args.new_string ?? '',
          args.replace_all === true
        );
        if (!outcome.ok) {
          return `Error: ${outcome.error} (${args.path})`;
        }
        const updated = outcome.updated;
        const preview = renderDiff('Update', args.path, original, updated);
        const approved = await confirmMutation(chalk.green('Apply this change?'), targetPath, preview);
        if (!approved) {
          return 'Error: Edit rejected by user.';
        }
        fs.writeFileSync(targetPath, updated, 'utf8');
        pushUndo({
          label: `edit ${args.path}`,
          undo: () => fs.writeFileSync(targetPath, original, 'utf8'),
        });
        const note = outcome.flexible ? ' (whitespace-tolerant match)' : '';
        return `Successfully edited file: ${args.path}${note}`;
      } catch (err: any) {
        return `Error editing file: ${err.message}`;
      }
    }
    case 'multi_edit': {
      const targetPath = path.resolve(args.path);
      try {
        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
          return `Error: File not found at ${args.path}`;
        }
        const edits = Array.isArray(args.edits) ? args.edits : [];
        if (edits.length === 0) {
          return 'Error: multi_edit requires at least 1 entry in "edits".';
        }
        const original = fs.readFileSync(targetPath, 'utf8');
        // Terapkan berurutan pada salinan in-memory; atomik — gagal satu, batal semua.
        let working = original;
        for (let i = 0; i < edits.length; i++) {
          const e = edits[i];
          const outcome = applySingleEdit(
            working,
            e?.old_string ?? '',
            e?.new_string ?? '',
            e?.replace_all === true
          );
          if (!outcome.ok) {
            return `Error: edit #${i + 1} failed — ${outcome.error}. No changes were written (${args.path}).`;
          }
          working = outcome.updated;
        }
        if (working === original) {
          return `No changes: the result is identical to the original contents (${args.path}).`;
        }
        const preview = renderDiff('Update', args.path, original, working);
        const approved = await confirmMutation(chalk.green('Apply this change?'), targetPath, preview);
        if (!approved) {
          return 'Error: Multi-edit rejected by user.';
        }
        fs.writeFileSync(targetPath, working, 'utf8');
        pushUndo({
          label: `multi_edit ${args.path}`,
          undo: () => fs.writeFileSync(targetPath, original, 'utf8'),
        });
        return `Successfully applied ${edits.length} edit${edits.length > 1 ? 's' : ''} to: ${args.path}`;
      } catch (err: any) {
        return `Error editing file: ${err.message}`;
      }
    }
    case 'delete_file': {
      const targetPath = path.resolve(args.path);
      try {
        if (!fs.existsSync(targetPath)) {
          return `Error: File not found at ${args.path}`;
        }
        if (!fs.statSync(targetPath).isFile()) {
          return `Error: ${args.path} is not a file. Use a shell command to remove directories.`;
        }
        console.log(chalk.yellow('[Aina wants to delete a file]:'));
        console.log(chalk.cyan(`  ${args.path}`));
        const approved = await confirmMutation(chalk.green('Delete this file?'), targetPath);
        if (!approved) {
          return 'Error: File deletion rejected by user.';
        }
        const deletedContent = fs.readFileSync(targetPath, 'utf8');
        fs.unlinkSync(targetPath);
        pushUndo({
          label: `delete ${args.path}`,
          undo: () => fs.writeFileSync(targetPath, deletedContent, 'utf8'),
        });
        return `Successfully deleted file: ${args.path}`;
      } catch (err: any) {
        return `Error deleting file: ${err.message}`;
      }
    }
    case 'find_files': {
      const targetPath = path.resolve(args.path || '.');
      try {
        if (!fs.existsSync(targetPath)) {
          return `Error: Path not found at ${targetPath}`;
        }
        const pattern = args.pattern || '*';
        // Patterns containing "/" are matched against the relative path (glob);
        // simple patterns like "*.ts" are matched against the basename so they
        // still find files at any depth.
        const matchRelative = pattern.includes('/');
        const regex = globToRegExp(pattern);
        const ignore = loadIgnore(targetPath);
        const results = findFilesByName(targetPath, regex, matchRelative, targetPath, ignore);
        return results.length > 0 ? results.join('\n') : `No files found matching pattern: "${pattern}"`;
      } catch (err: any) {
        return `Error finding files: ${err.message}`;
      }
    }
    case 'make_dir': {
      const targetPath = path.resolve(args.path);
      try {
        fs.mkdirSync(targetPath, { recursive: true });
        return `Successfully created directory: ${args.path}`;
      } catch (err: any) {
        return `Error creating directory: ${err.message}`;
      }
    }
    case 'move_file': {
      const sourcePath = path.resolve(args.source);
      const destPath = path.resolve(args.destination);
      try {
        if (!fs.existsSync(sourcePath)) {
          return `Error: Source not found at ${args.source}`;
        }
        console.log(chalk.yellow('[Aina wants to move/rename]:'));
        console.log(chalk.cyan(`  ${args.source}  →  ${args.destination}`));
        // Guard against either endpoint escaping the working directory.
        const guardPath = !isInsideCwd(sourcePath) ? sourcePath : destPath;
        const approved = await confirmMutation(chalk.green('Approve this move?'), guardPath);
        if (!approved) {
          return 'Error: Move rejected by user.';
        }
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.renameSync(sourcePath, destPath);
        pushUndo({
          label: `move ${args.source} → ${args.destination}`,
          undo: () => {
            const backDir = path.dirname(sourcePath);
            if (!fs.existsSync(backDir)) fs.mkdirSync(backDir, { recursive: true });
            fs.renameSync(destPath, sourcePath);
          },
        });
        return `Successfully moved ${args.source} to ${args.destination}`;
      } catch (err: any) {
        return `Error moving file: ${err.message}`;
      }
    }
    case 'git_status': {
      if (!isGitRepo()) return 'Error: this directory is not a git repository.';
      const r = runGit(['status', '--short', '--branch']);
      return r.output || '(working tree clean)';
    }
    case 'git_diff': {
      if (!isGitRepo()) return 'Error: this directory is not a git repository.';
      const gitArgs = ['--no-pager', 'diff'];
      if (args.staged === true) gitArgs.push('--staged');
      if (args.path) gitArgs.push('--', String(args.path));
      const r = runGit(gitArgs);
      return r.output || '(no changes)';
    }
    case 'ask_user': {
      const questions: AskQuestion[] = Array.isArray(args.questions) ? args.questions : [];
      if (questions.length === 0) {
        return 'Error: ask_user requires at least 1 question.';
      }
      if (questions.length > 3) {
        return 'Error: ask_user allows at most 3 questions per call.';
      }
      for (const q of questions) {
        if (!q || typeof q.question !== 'string' || !Array.isArray(q.options) || q.options.length < 2) {
          return 'Error: each question must have a "question" and at least 2 "options".';
        }
      }
      const answers = await askUser(questions);
      if (answers === null) {
        return 'The user closed/cancelled the question without answering. Continue with your best assumption and state the assumption you made.';
      }
      return formatAskAnswers(answers);
    }
    default:
      return `Error: Tool ${name} not found.`;
  }
}
