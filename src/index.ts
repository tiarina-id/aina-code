import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import type OpenAI from 'openai';
import os from 'node:os';
import { loadConfig, saveConfig, getPrettyModelName, isKnownModel, KNOWN_MODELS } from './config.js';
import { getOpenAIClient } from './openai.js';
import { AinaAgent, formatTokens } from './agent.js';
import { askCustomPrompt, askInteractiveChoice, renderUserEcho } from './prompt.js';
import { setAutoApprove, isAutoApprove, undoLast, runValidation, resolveValidateCommand, isGitRepo, runGit } from './tools.js';
import { setMode, isPlanMode, getModeLabel } from './mode.js';
import { loadProjectContext } from './context.js';
import { saveSession, loadSession, newSessionId, generateSessionTitle, fallbackTitle, type SavedSession } from './session.js';

// Disable standard Ctrl+C process termination globally
process.on('SIGINT', () => {});

// Read the package version from package.json next to the compiled bundle.
function getVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  console.log(`aina — CLI AI coding assistant (ainacode) v${getVersion()}

Usage:
  aina                     Interactive shell mode (REPL)
  aina "question"          One-shot direct query mode
  aina -m <model> "..."    Override the model for a single invocation
  aina --resume <uuid>     Resume a previous session by its id

Options:
  -m, --model <model>      Choose a model (aina-1-flash | mini | pro | ultra)
  -y, --yes                Auto-approve mode (skip tool confirmations)
  -r, --resume <uuid>      Resume a saved session by its id
  -v, --version            Show version
  -h, --help               Show this help

Configuration (env or ~/.ainacode/config.json):
  AINA_API_KEY             Tiarina API key
  AINA_MODEL               Default model
  AINA_BASE_URL            Gateway base URL (default https://api.tiarina.id/v1)

Inside the REPL:
  /help /model /init /undo /check /diff /commit /resume /clear /auto /plan /exit   Slash commands
  Tab                               Switch mode (Default → Plan → Auto)
  @<file>                           Attach a file's contents to your message
  !<command>                        Run a bash command directly`);
}

// Kartu sambutan saat belum login (API key belum ada). Dibuat agar konsisten
// dengan banner utama: logo AINA + box cyan, tanpa emoji.
function printLoginScreen(): void {
  const cols = process.stdout.columns || 80;
  const W = Math.max(40, Math.min(cols, 58));
  const inner = W - 2;

  const center = (raw: string, colored?: string): string => {
    const pad = Math.max(0, inner - raw.length);
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + (colored ?? raw) + ' '.repeat(pad - l);
  };
  const row = (raw: string, colored?: string): string =>
    chalk.cyan('│') + center(raw, colored) + chalk.cyan('│');
  const top = chalk.cyan('╭' + '─'.repeat(inner) + '╮');
  const bottom = chalk.cyan('╰' + '─'.repeat(inner) + '╯');
  const sep = chalk.cyan('├' + '─'.repeat(inner) + '┤');
  const blank = row('');

  const lines = [
    '',
    top,
    blank,
    row(' ▟█▙ ', chalk.cyanBright(' ▟█▙ ')),
    row('▜█████▛', chalk.cyan('▜█████▛')),
    row(' ▝▀▀▘ ', chalk.cyan.dim(' ▝▀▀▘ ')),
    blank,
    row('AINA Code', chalk.bold.white('AINA Code')),
    row('CLI AI coding assistant', chalk.gray('CLI AI coding assistant')),
    blank,
    sep,
    blank,
    row('You are not signed in', chalk.yellow('You are not signed in')),
    row('Tiarina API Key is not configured.', chalk.gray('Tiarina API Key is not configured.')),
    blank,
    row('Paste your API Key below to begin.', chalk.gray('Paste your API Key below to begin.')),
    row('It will be saved to ~/.ainacode/config.json', chalk.gray('It will be saved to ~/.ainacode/config.json')),
    blank,
    row('Press Ctrl+C to exit', chalk.dim('Press Ctrl+C to exit')),
    blank,
    bottom,
    '',
  ];
  console.log(lines.join('\n'));
}

async function checkApiKey(): Promise<string> {
  const config = loadConfig();
  if (config.apiKey) {
    return config.apiKey;
  }

  // Non-interactive (mis. dipipe / mode query tanpa TTY): tidak bisa menanyakan
  // key — langsung gagal cepat dengan instruksi jelas, jangan pakai dummy-key.
  if (!input.isTTY) {
    exitNoApiKey();
  }

  printLoginScreen();

  const rl = readline.createInterface({ input, output });
  // Ctrl+C on the login screen = clean exit (not an error).
  rl.on('SIGINT', () => {
    rl.close();
    console.log(chalk.cyan('\nCancelled. Goodbye!\n'));
    process.exit(0);
  });
  try {
    const key = await rl.question(chalk.cyan('  › Tiarina API Key: '));
    const cleanedKey = key.trim();
    if (!cleanedKey) {
      console.log(chalk.red('\nAPI Key cannot be empty.'));
      exitNoApiKey();
    }
    saveConfig({ apiKey: cleanedKey });
    console.log(chalk.green('\nSigned in successfully. API Key saved to ~/.ainacode/config.json\n'));
    return cleanedKey;
  } catch (e: any) {
    // Ctrl+C / abort = clean exit without a scary error message.
    if (/abort|sigint|ctrl/i.test(e?.message || '')) {
      console.log(chalk.cyan('\nCancelled. Goodbye!\n'));
      process.exit(0);
    }
    console.error(chalk.red(`Failed to read API Key: ${e?.message || e}`));
    exitNoApiKey();
  } finally {
    rl.close();
  }
  // Unreachable: exitNoApiKey() memanggil process.exit, tapi membantu type-checker.
  return '';
}

// Cetak instruksi konfigurasi key lalu keluar dengan kode error. Dipanggil saat
// API key tidak tersedia agar pengguna tidak menemui error API yang membingungkan
// di kemudian hari (sebelumnya kode memakai fallback 'dummy-key').
function exitNoApiKey(): never {
  const cols = process.stdout.columns || 80;
  const W = Math.max(46, Math.min(cols, 60));
  const inner = W - 2;

  const centerRow = (raw: string, color: (s: string) => string = (s) => s): string => {
    const pad = Math.max(0, inner - raw.length);
    const l = Math.floor(pad / 2);
    return chalk.cyan('│') + ' '.repeat(l) + color(raw) + ' '.repeat(pad - l) + chalk.cyan('│');
  };
  const leftRow = (raw: string, color: (s: string) => string = (s) => s): string => {
    const pad = Math.max(0, inner - raw.length - 2);
    return chalk.cyan('│') + '  ' + color(raw) + ' '.repeat(pad) + chalk.cyan('│');
  };
  const top = chalk.cyan('╭' + '─'.repeat(inner) + '╮');
  const bottom = chalk.cyan('╰' + '─'.repeat(inner) + '╯');
  const blank = centerRow('');

  const lines = [
    '',
    top,
    blank,
    centerRow('AINA Code', chalk.bold.white),
    blank,
    centerRow('Tiarina API Key is not configured.', chalk.yellow),
    blank,
    leftRow('Set one of these, then run again:', chalk.gray),
    blank,
    leftRow('env :  export AINA_API_KEY="<your-key>"', chalk.gray),
    leftRow('file:  ~/.ainacode/config.json', chalk.gray),
    leftRow('       { "apiKey": "<your-key>" }', chalk.dim),
    blank,
    bottom,
    '',
  ];
  console.error(lines.join('\n'));
  process.exit(1);
}

// Bash mode: jalankan perintah shell secara langsung (prefix "!").
// stdio diwariskan agar perintah interaktif & berwarna tampil apa adanya.
function runBashCommand(command: string): Promise<void> {
  return new Promise((resolve) => {
    console.log(chalk.gray(`$ ${command}`));
    const child = spawn(command, { shell: true, stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(chalk.red(`Failed to run command: ${err.message}`));
      resolve();
    });
    child.on('close', (code) => {
      if (code && code !== 0) {
        console.log(chalk.gray(`(exited with code ${code})`));
      }
      resolve();
    });
  });
}

function getPrettyCwd(): string {
  const cwd = process.cwd();
  const homedir = os.homedir();
  if (cwd.startsWith(homedir)) {
    return cwd.replace(homedir, '~');
  }
  return cwd;
}

function printWelcomeBanner(model: string) {
  const prettyCwd = getPrettyCwd();
  const prettyModel = getPrettyModelName(model);
  const headerModel = model.toLowerCase() === prettyModel.toLowerCase() ? model : prettyModel;

  const cols = process.stdout.columns || 80;
  const total = Math.min(cols, 96);
  const Lw = 31;                    // left column inner width
  const Rw = total - Lw - 7;        // right column inner width (borders + gaps = 7)

  const trunc = (s: string, w: number) => (s.length <= w ? s : s.slice(0, Math.max(0, w - 1)) + '…');
  const center = (raw: string, colored: string, w: number) => {
    const pad = Math.max(0, w - raw.length);
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + colored + ' '.repeat(pad - l);
  };
  const padR = (raw: string, colored: string, w: number) => colored + ' '.repeat(Math.max(0, w - raw.length));
  const wrap = (text: string, w: number) => {
    const out: string[] = [];
    let cur = '';
    for (const word of text.split(' ')) {
      if (!cur) cur = word;
      else if ((cur + ' ' + word).length <= w) cur += ' ' + word;
      else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
    return out;
  };

  // --- Left column (centered): greeting, icon, model & cwd ---
  const icon = [' ▟█▙ ', '▜█████▛', ' ▝▀▀▘ '];
  const leftSpec: { t: string; c: (s: string) => string }[] = [
    { t: '', c: (s) => s },
    { t: 'Welcome!', c: (s) => chalk.bold.white(s) },
    { t: '', c: (s) => s },
    { t: icon[0], c: (s) => chalk.cyanBright(s) },
    { t: icon[1], c: (s) => chalk.cyan(s) },
    { t: icon[2], c: (s) => chalk.cyan.dim(s) },
    { t: '', c: (s) => s },
    { t: `${headerModel} · API Tiarina`, c: (s) => chalk.gray(s) },
    { t: prettyCwd, c: (s) => chalk.gray(s) }
  ];
  const leftLines = leftSpec.map(({ t, c }) => {
    const raw = trunc(t, Lw);
    return center(raw, c(raw), Lw);
  });

  // --- Right column (left-aligned, wrapped): tips & features ---
  const rightSpec: { type: 'head' | 'text' | 'sep'; t?: string }[] = [
    { type: 'head', t: 'Getting started' },
    { type: 'text', t: 'Type your task, or run /help for the command list.' },
    { type: 'sep' },
    { type: 'head', t: 'Features' },
    { type: 'text', t: '@ attaches a file  ·  ! runs bash directly' },
    { type: 'text', t: 'Tab: switch mode (Default → Plan → Auto)' },
    { type: 'text', t: 'Queue new messages while a task runs' },
    { type: 'text', t: '/model to switch models' }
  ];
  const rightLines: string[] = [];
  for (const e of rightSpec) {
    if (e.type === 'sep') {
      rightLines.push(padR('─'.repeat(Rw), chalk.gray('─'.repeat(Rw)), Rw));
      continue;
    }
    const color = e.type === 'head' ? (s: string) => chalk.bold.white(s) : (s: string) => chalk.gray(s);
    for (const ln of wrap(e.t || '', Rw)) rightLines.push(padR(ln, color(ln), Rw));
  }

  // Pad both columns to the same number of rows
  const rowCount = Math.max(leftLines.length, rightLines.length);
  while (leftLines.length < rowCount) leftLines.push(' '.repeat(Lw));
  while (rightLines.length < rowCount) rightLines.push(' '.repeat(Rw));

  const side = chalk.cyan('│');
  const title = ` AINA Code v${getVersion()} `;
  const top = chalk.cyan('╭───') + chalk.bold.cyanBright(title) + chalk.cyan('─'.repeat(Math.max(0, total - 3 - title.length - 2)) + '╮');
  const bottom = chalk.cyan('╰' + '─'.repeat(total - 2) + '╯');

  const body: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    body.push(`${side} ${leftLines[i]} ${side} ${rightLines[i]} ${side}`);
  }

  console.log('\n' + [top, ...body, bottom].join('\n') + '\n');
}

// Print the goodbye message and, when the current session has saved turns, the
// command to resume it later from the shell.
function printGoodbye(sessionId: string, hasMessages: boolean): void {
  console.log(chalk.cyan('Goodbye!'));
  if (hasMessages) {
    console.log(chalk.gray('Resume this session later with:  ') + chalk.white(`aina --resume ${sessionId}`));
  }
}

// Run one user turn. After the agent finishes, if a plan was produced in plan
// mode, present the next-step menu (implement now / clear context & implement /
// keep editing the plan). Returns any messages the user queued during the run.
async function runTurn(agent: AinaAgent, input: string): Promise<string[]> {
  const queued = await agent.run(input);

  const plan = agent.getLastPlan();
  if (plan) {
    agent.clearLastPlan();
    const optImplement = 'Implement this plan now';
    const optFresh = 'Clear context then implement (keep using the plan)';
    const optEdit = 'Stay in Plan mode to edit the plan';
    const choice = await askInteractiveChoice('Plan ready. What next?', [
      optImplement,
      optFresh,
      optEdit
    ]);

    if (choice === optImplement) {
      setMode('default');
      console.log(renderUserEcho('Implement this plan now'));
      queued.push(...await agent.run(`The following plan has been approved. Implement it now, step by step:\n\n${plan}`));
    } else if (choice === optFresh) {
      setMode('default');
      agent.clearHistory();
      console.log(renderUserEcho('Clear context then implement the plan'));
      queued.push(...await agent.run(`Implement the following approved plan:\n\n${plan}`));
    }
    // optEdit or Esc → stay in plan mode; user keeps refining the plan.
  }

  return queued;
}

async function runInteractive(agent: AinaAgent, client: OpenAI, resume?: SavedSession) {
  printWelcomeBanner(agent.getModel());

  // Identity for the current session. A resumed session keeps its id/title so
  // that subsequent saves continue the same file; a fresh session gets a new id
  // and its title is generated after the first turn.
  let sessionId = resume?.id ?? newSessionId();
  let sessionTitle = resume?.title ?? '';
  // True once a background title-generation request is in flight, so persist()
  // never launches a second one (or blocks the prompt) while it resolves.
  let titleRequested = false;

  if (resume) {
    const turns = resume.messages.filter((m) => m.role === 'user').length;
    console.log(chalk.green(`Resumed session "${sessionTitle || 'Untitled'}" (${turns} turns, saved ${resume.savedAt}).`));
  }

  // Persist the current session, generating a title from the first user message
  // on the first save where one is not yet set.
  const persist = async () => {
    // Generate the session title in the BACKGROUND. The gateway can take many
    // seconds to respond, and awaiting it here would block the next prompt from
    // appearing after a turn finishes. We save immediately with whatever title we
    // have, then re-save once the generated title arrives.
    if (!sessionTitle && !titleRequested) {
      const firstUser = agent.getHistory().find((m) => m.role === 'user');
      const firstText = typeof firstUser?.content === 'string' ? firstUser.content : '';
      if (firstText.trim()) {
        sessionTitle = fallbackTitle(firstText);
        titleRequested = true;
        generateSessionTitle(client, agent.getModel(), firstText)
          .then((t) => {
            sessionTitle = t;
            saveSession({
              id: sessionId,
              title: sessionTitle,
              model: agent.getModel(),
              savedAt: '',
              messages: agent.getSanitizedHistory(),
            });
          })
          .catch(() => {});
      }
    }
    saveSession({
      id: sessionId,
      title: sessionTitle,
      model: agent.getModel(),
      savedAt: '',
      messages: agent.getSanitizedHistory(),
    });
  };

  try {
    while (true) {
      let userInput = '';
      const lastChoices = agent.getLastChoices();
      
      if (lastChoices) {
        agent.clearLastChoices();
        const selected = await askInteractiveChoice(lastChoices.question, lastChoices.options);
        if (selected) {
          userInput = selected;
          // Print the selected option as the user's turn in history
          console.log(renderUserEcho(userInput));
        } else {
          // If user cancels the menu with Esc, fallback to standard text input
          userInput = await askCustomPrompt(agent.getModel());
        }
      } else {
        userInput = await askCustomPrompt(agent.getModel());
      }

      const trimmed = userInput.trim();
      if (!trimmed) continue;

      // Bash mode: baris diawali "!" dijalankan langsung di shell, tanpa LLM.
      if (trimmed.startsWith('!')) {
        const bashCmd = trimmed.slice(1).trim();
        if (!bashCmd) {
          console.log(chalk.gray('Bash mode: type a command after "!", e.g. !ls -la'));
          continue;
        }
        await runBashCommand(bashCmd);
        continue;
      }

      // Check for slash commands
      if (trimmed.startsWith('/')) {
        const parts = trimmed.split(' ');
        const cmd = parts[0].toLowerCase();
        const arg = parts.slice(1).join(' ').trim();

        if (cmd === '/exit') {
          printGoodbye(sessionId, agent.getHistory().length > 0);
          process.exit(0);
        } else if (cmd === '/clear') {
          agent.clearHistory();
          console.clear();
          printWelcomeBanner(agent.getModel());
          console.log(chalk.green('Conversation history and screen cleared.'));
          continue;
        } else if (cmd === '/init') {
          if (isPlanMode()) {
            console.log(chalk.yellow('Plan mode is active (read-only). Press Tab or /plan to leave Plan mode before running /init.'));
            continue;
          }
          console.log(renderUserEcho('/init'));
          const initPrompt = `Create a project context file named AINA.md at the root of this working directory.
Investigate the repo first (directory structure, package.json/build configuration, scripts, main source files, patterns & conventions in use). Then write an AINA.md that is concise yet useful for an AI assistant, covering:
- Short overview: what this project is and its tech stack.
- Important commands: build, run, test, lint (if any).
- Architecture map: main files/directories and their responsibilities.
- Important conventions to follow (style, language, import patterns, etc.).
Write it in the user's language. If AINA.md already exists, update its contents. Write the file with the write_file tool.`;
          const initQueued = await runTurn(agent, initPrompt);
          while (initQueued.length > 0) {
            const next = initQueued.shift()!;
            if (!next.trim()) continue;
            console.log(renderUserEcho(next.trim()));
            initQueued.push(...await runTurn(agent, next.trim()));
          }
          continue;
        } else if (cmd === '/model') {
          if (!arg) {
            console.log(chalk.cyan(`Current model: ${agent.getModel()}`));
            try {
              const list = await client.models.list();
              const ids = list.data.map((m: any) => m.id);
              console.log(chalk.gray(`Available models: ${ids.join(', ')}`));
            } catch {
              console.log(chalk.gray('Available models: aina-1-flash, aina-1-mini, aina-1-pro, aina-1-ultra'));
            }
          } else {
            if (!isKnownModel(arg)) {
              console.log(chalk.yellow(`Model "${arg}" is not recognized. Supported models: ${KNOWN_MODELS.join(', ')}.`));
              const ok = await askInteractiveChoice(`Use "${arg}" anyway?`, ['Yes, use it', 'Cancel']);
              if (ok !== 'Yes, use it') {
                console.log(chalk.gray('Cancelled. Model unchanged.'));
                continue;
              }
            }
            agent.changeModel(arg);
            saveConfig({ model: arg });
            console.clear();
            printWelcomeBanner(agent.getModel());
            console.log(chalk.green(`Model changed to: ${arg}`));
          }
          continue;
        } else if (cmd === '/auto') {
          setAutoApprove(!isAutoApprove());
          if (isAutoApprove()) {
            console.log(chalk.yellow('Auto-approve mode ON — file changes & commands run without confirmation (except targets outside the working folder).'));
          } else {
            console.log(chalk.green('Auto-approve mode OFF — Aina will ask for confirmation again.'));
          }
          continue;
        } else if (cmd === '/plan') {
          setMode(isPlanMode() ? 'default' : 'plan');
          if (isPlanMode()) {
            console.log(chalk.cyan('Plan mode ON — Aina only investigates (read-only) & drafts a plan, changing nothing. Press Tab to switch mode.'));
          } else {
            console.log(chalk.green('Plan mode OFF — back to Default mode.'));
          }
          continue;
        } else if (cmd === '/undo') {
          const result = undoLast();
          console.log(chalk.cyan(result));
          continue;
        } else if (cmd === '/check') {
          const cmdToRun = resolveValidateCommand();
          if (!cmdToRun) {
            console.log(chalk.yellow('No validation command detected (set "validateCommand" in ~/.ainacode/config.json or add a "typecheck" script).'));
            continue;
          }
          console.log(chalk.gray(`Running validation: ${cmdToRun}`));
          const v = runValidation();
          if (!v) {
            console.log(chalk.yellow('Validation failed to run.'));
          } else if (v.ok) {
            console.log(chalk.green(`Passed (${v.command}).`));
          } else {
            console.log(chalk.red(`Issues found (${v.command}):`));
            console.log(v.output);
          }
          continue;
        } else if (cmd === '/diff') {
          if (!isGitRepo()) {
            console.log(chalk.yellow('This directory is not a git repository.'));
            continue;
          }
          const r = runGit(['--no-pager', 'diff', ...(arg ? ['--', arg] : [])]);
          console.log(r.output ? r.output : chalk.gray('(no changes)'));
          continue;
        } else if (cmd === '/commit') {
          if (!isGitRepo()) {
            console.log(chalk.yellow('This directory is not a git repository.'));
            continue;
          }
          if (!arg) {
            console.log(chalk.yellow('Include a commit message, e.g. /commit "fix login bug".'));
            continue;
          }
          const status = runGit(['status', '--short']);
          if (!status.output.trim()) {
            console.log(chalk.gray('No changes to commit.'));
            continue;
          }
          console.log(chalk.cyan('Changes to be committed:'));
          console.log(status.output);
          const message = arg.replace(/^["']|["']$/g, '');
          const choice = await askInteractiveChoice(`Commit all changes with message: "${message}"?`, ['Yes, commit', 'Cancel']);
          if (choice !== 'Yes, commit') {
            console.log(chalk.gray('Cancelled.'));
            continue;
          }
          const add = runGit(['add', '-A']);
          if (!add.ok) {
            console.log(chalk.red(`git add failed: ${add.output}`));
            continue;
          }
          const commit = runGit(['commit', '-m', message]);
          console.log(commit.ok ? chalk.green(commit.output) : chalk.red(commit.output));
          continue;
        } else if (cmd === '/resume') {
          const saved = loadSession(arg || undefined);
          if (!saved) {
            console.log(chalk.yellow(arg ? `No session found with id ${arg}.` : 'No saved session to resume.'));
            continue;
          }
          agent.restoreHistory(saved.messages);
          sessionId = saved.id;
          sessionTitle = saved.title;
          if (saved.model && saved.model !== agent.getModel()) {
            agent.changeModel(saved.model);
          }
          const turns = saved.messages.filter((m) => m.role === 'user').length;
          console.log(chalk.green(`Resumed session "${sessionTitle || 'Untitled'}" (${turns} turns, saved ${saved.savedAt}).`));
          continue;
        } else if (cmd === '/compact') {
          if (agent.getHistory().length <= 1) {
            console.log(chalk.gray('Nothing to compact yet.'));
            continue;
          }
          console.log(chalk.gray('Compacting conversation… (this calls the model and may take a moment)'));
          try {
            const { before, after } = await agent.compact();
            if (after < before) {
              console.log(chalk.green(`Context compacted: ~${formatTokens(before)} → ~${formatTokens(after)} token.`));
            } else {
              console.log(chalk.gray('Context is already compact — nothing changed.'));
            }
          } catch {
            const { before, after } = agent.compactLocal();
            if (after < before) {
              console.log(chalk.yellow(`Model compaction failed; local fallback compacted active history: ~${formatTokens(before)} → ~${formatTokens(after)} token.`));
            } else {
              console.log(chalk.yellow('Model compaction failed; local fallback found nothing to shrink.'));
            }
          }
          continue;
        } else if (cmd === '/usage') {
          const u = agent.getUsage();
          const pct = Math.min(100, Math.round((u.contextTokens / u.budget) * 100));
          console.log(chalk.bold.yellow('Usage:'));
          console.log(`  ${chalk.gray('Turns this session')} : ${u.turns}`);
          console.log(`  ${chalk.gray('Tokens input')}      : ${formatTokens(u.promptTokens)}`);
          console.log(`  ${chalk.gray('Tokens output')}     : ${formatTokens(u.completionTokens)}`);
          console.log(`  ${chalk.gray('Tokens total')}      : ${formatTokens(u.sessionTokens)}`);
          console.log(`  ${chalk.gray('Cost estimate')}     : ${u.estimatedCostUsd === null ? 'unavailable' : `$${u.estimatedCostUsd.toFixed(4)}`}`);
          console.log(`  ${chalk.gray('Context (est.)')}     : ~${formatTokens(u.contextTokens)} / ${formatTokens(u.budget)} (${pct}%)`);
          console.log(chalk.gray('  Tip: /compact to shrink the context.'));
          continue;
        } else if (cmd === '/config') {
          const cfg = loadConfig();
          if (!arg) {
            console.log(chalk.bold.yellow('Configuration (~/.ainacode/config.json):'));
            console.log(`  ${chalk.gray('model')}          : ${cfg.model}`);
            console.log(`  ${chalk.gray('baseUrl')}        : ${cfg.baseUrl}`);
            console.log(`  ${chalk.gray('apiKey')}         : ${cfg.apiKey ? 'configured ✓' : chalk.red('not set')}`);
            console.log(`  ${chalk.gray('autoValidate')}   : ${cfg.autoValidate}`);
            console.log(`  ${chalk.gray('validateCommand')}: ${cfg.validateCommand || chalk.gray('(auto-detect)')}`);
            console.log(chalk.gray('  Change with: /config <key> <value>  (keys: model, baseUrl, apiKey, autoValidate, validateCommand)'));
            continue;
          }
          const cparts = arg.split(' ');
          const key = cparts[0];
          const value = cparts.slice(1).join(' ').trim();
          if (!value && key !== 'validateCommand') {
            console.log(chalk.yellow(`Provide a value, e.g. /config ${key} <value>.`));
            continue;
          }
          if (key === 'model') {
            agent.changeModel(value);
            saveConfig({ model: value });
            console.log(chalk.green(`model = ${value}`));
          } else if (key === 'baseUrl') {
            saveConfig({ baseUrl: value });
            console.log(chalk.green(`baseUrl = ${value}`) + chalk.gray(' (restart aina to apply)'));
          } else if (key === 'apiKey') {
            saveConfig({ apiKey: value });
            console.log(chalk.green('apiKey updated') + chalk.gray(' (restart aina to apply)'));
          } else if (key === 'autoValidate') {
            const on = value === 'true' || value === 'on' || value === '1';
            saveConfig({ autoValidate: on });
            console.log(chalk.green(`autoValidate = ${on}`));
          } else if (key === 'validateCommand') {
            saveConfig({ validateCommand: value || undefined });
            console.log(chalk.green(`validateCommand = ${value || '(auto-detect)'}`));
          } else {
            console.log(chalk.yellow(`Unknown key "${key}". Keys: model, baseUrl, apiKey, autoValidate, validateCommand.`));
          }
          continue;
        } else if (cmd === '/status') {
          const cfg = loadConfig();
          const u = agent.getUsage();
          const ctx = loadProjectContext();
          const pct = Math.min(100, Math.round((u.contextTokens / u.budget) * 100));
          console.log(chalk.bold.yellow('Status:'));
          console.log(`  ${chalk.gray('Version')}     : ${getVersion()}`);
          console.log(`  ${chalk.gray('Model')}       : ${getPrettyModelName(agent.getModel())} (${agent.getModel()})`);
          console.log(`  ${chalk.gray('Mode')}        : ${getModeLabel()}${isAutoApprove() ? ' · auto-approve' : ''}`);
          console.log(`  ${chalk.gray('Directory')}   : ${process.cwd()}`);
          console.log(`  ${chalk.gray('Gateway')}     : ${cfg.baseUrl}`);
          console.log(`  ${chalk.gray('API key')}     : ${cfg.apiKey ? 'configured ✓' : chalk.red('not set')}`);
          console.log(`  ${chalk.gray('Session')}     : ${sessionTitle || 'Untitled'} (${sessionId.slice(0, 8)})`);
          console.log(`  ${chalk.gray('Project ctx')} : ${ctx ? ctx.fileName : chalk.gray('none')}`);
          console.log(`  ${chalk.gray('Turns')}       : ${u.turns}`);
          console.log(`  ${chalk.gray('Tokens')}      : ${formatTokens(u.sessionTokens)} (${formatTokens(u.promptTokens)} in / ${formatTokens(u.completionTokens)} out)`);
          console.log(`  ${chalk.gray('Cost est.')}   : ${u.estimatedCostUsd === null ? 'unavailable' : `$${u.estimatedCostUsd.toFixed(4)}`}`);
          console.log(`  ${chalk.gray('Context')}     : ~${formatTokens(u.contextTokens)} / ${formatTokens(u.budget)} (${pct}%)`);
          continue;
        } else if (cmd === '/help') {
          console.log(chalk.bold.yellow('Interactive Commands:'));
          console.log(`  ${chalk.cyan('/model [model_name]')} : Show the active model or switch models`);
          console.log(`  ${chalk.cyan('/init')}               : Auto-create/update AINA.md (project context)`);
          console.log(`  ${chalk.cyan('/undo')}               : Undo the last file change (write/edit/delete/move)`);
          console.log(`  ${chalk.cyan('/check')}              : Run validation (typecheck/lint) now`);
          console.log(`  ${chalk.cyan('/diff')}               : Show the git diff of changes`);
          console.log(`  ${chalk.cyan('/commit "message"')}   : Stage all & commit (with confirmation)`);
          console.log(`  ${chalk.cyan('/resume [uuid]')}      : Resume the previous session (or one by id)`);
          console.log(`  ${chalk.cyan('/compact')}            : Summarize & shrink the conversation context`);
          console.log(`  ${chalk.cyan('/usage')}              : Show session token usage & context size`);
          console.log(`  ${chalk.cyan('/status')}             : Show model, mode, directory, session & usage`);
          console.log(`  ${chalk.cyan('/config [key value]')} : Show config, or set model/baseUrl/apiKey/autoValidate/validateCommand`);
          console.log(`  ${chalk.cyan('/clear')}              : Reset conversation history and clear the screen`);
          console.log(`  ${chalk.cyan('/auto')}               : Toggle auto-approve mode (skip confirmations)`);
          console.log(`  ${chalk.cyan('/plan')}               : Toggle plan mode (read-only, plan only)`);
          console.log(`  ${chalk.cyan('/exit')}              : Exit the interactive session`);
          console.log(`  ${chalk.cyan('/help')}              : Show this help`);
          console.log(`  ${chalk.cyan('Tab')}                : Switch mode (Default → Plan → Auto)`);
          console.log(`  ${chalk.cyan('@<file>')}            : Attach a file's contents to your message`);
          console.log(`  ${chalk.cyan('!<command>')}         : Run a bash command directly (e.g. !ls -la)`);
          continue;
        } else {
          console.log(chalk.red(`Unknown command: ${cmd}. Type /help to see the command list.`));
          continue;
        }
      }

      // Legacy support for plain exit
      if (trimmed.toLowerCase() === 'exit') {
        printGoodbye(sessionId, agent.getHistory().length > 0);
        process.exit(0);
      }

      // Run the task, then drain any messages the user queued while it ran.
      const queued = await runTurn(agent, trimmed);
      while (queued.length > 0) {
        const next = queued.shift()!;
        const trimmedNext = next.trim();
        if (!trimmedNext) continue;
        // Echo the queued prompt so it appears in the scrollback history
        console.log(renderUserEcho(trimmedNext));
        const more = await runTurn(agent, trimmedNext);
        queued.push(...more);
      }

      // Save the session after each turn so it can be resumed with /resume.
      await persist();
    }
  } catch (e: any) {
    console.error(chalk.red(`Error in REPL: ${e.message}`));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-v') || argv.includes('--version')) {
    console.log(getVersion());
    process.exit(0);
  }
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const apiKey = await checkApiKey();
  const config = loadConfig();
  
  const args = process.argv.slice(2);
  let model = config.model;
  let modelExplicit = false;
  let resumeId: string | undefined;
  const queryArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-m' || args[i] === '--model') && i + 1 < args.length) {
      model = args[i + 1];
      modelExplicit = true;
      i++;
    } else if ((args[i] === '-r' || args[i] === '--resume') && i + 1 < args.length) {
      resumeId = args[i + 1];
      i++;
    } else if (args[i] === '-y' || args[i] === '--yes') {
      setAutoApprove(true);
    } else {
      queryArgs.push(args[i]);
    }
  }

  // Resume by id: load the saved session, adopt its model unless -m was given,
  // restore its history, then continue interactively.
  let resumeSession: SavedSession | undefined;
  if (resumeId) {
    resumeSession = loadSession(resumeId) ?? undefined;
    if (!resumeSession) {
      console.error(chalk.red(`No session found with id ${resumeId}.`));
      process.exit(1);
    }
    if (!modelExplicit && resumeSession.model) {
      model = resumeSession.model;
    }
  }

  const client = getOpenAIClient(apiKey, config.baseUrl);
  const agent = new AinaAgent(client, model);

  if (resumeSession) {
    agent.restoreHistory(resumeSession.messages);
    await runInteractive(agent, client, resumeSession);
    return;
  }

  const query = queryArgs.join(' ').trim();
  if (query) {
    console.log(chalk.gray(`Connected to API: ${config.baseUrl}`));
    console.log(chalk.gray(`Using model: ${model} (${getPrettyModelName(model)})`));
    await agent.run(query);
  } else {
    await runInteractive(agent, client);
  }
}

main().catch((err) => {
  console.error(chalk.red('Fatal Error:'), err);
});
