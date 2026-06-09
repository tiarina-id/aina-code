import type OpenAI from "openai";
import chalk from "chalk";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { toolsList, executeTool, resetTurnApproval, runValidation } from "./tools.js";
import { loadConfig, getPrettyModelName } from "./config.js";
import { renderMarkdown } from "./markdown.js";
import { isPlanMode, footerRight } from "./mode.js";
import { loadProjectContext, formatProjectContext } from "./context.js";

const SYSTEM_PROMPT = `You are Aina, a helpful, precise, and powerful AI coding assistant CLI.
You have access to tools to inspect the user's filesystem, edit code, and execute command line tasks.
Your default language of communication should match the user's language (for example Indonesian or English).
Be direct, concise, and professional. Briefly explain what you are about to do before using tools.

Core working rules:
- Understand the existing project before making changes. Inspect relevant files, configs, schemas, tests, and nearby patterns first.
- Solve the user's request at the root cause when possible, while keeping changes minimal and focused.
- Do not change unrelated code, rename things unnecessarily, or introduce large rewrites unless the user asked for them.
- Follow the style, architecture, naming, and conventions already present in the repository.
- If requirements are ambiguous, infer safely from the repo when possible. Ask the user only when the decision materially changes behavior and cannot be discovered locally.

Tool usage rules:
- ALWAYS use the provided tools to perform real actions. Do not claim a file was created, edited, deleted, moved, or that a command ran unless you actually called the matching tool.
- Use 'read_file' to inspect a file before editing it. Prefer 'edit_file' (exact string replacement) for small changes and 'write_file' only for new files or full rewrites.
- Use 'find_files' to locate files by name and 'grep_search' to search inside file contents.
- Use 'list_dir' to explore directories, 'make_dir' to create folders, 'delete_file' to remove a file, and 'move_file' to move/rename.
- Use 'run_command' for commands, tests, builds, package scripts, git inspection, or anything not covered by the other tools.
- Use 'ask_user' to ask 1-3 structured multiple-choice questions when requirements are genuinely ambiguous, when you need the user to choose a direction, or to confirm a decision that materially changes behavior. Provide clear options (with short descriptions) and set multiSelect when several answers may apply. Do NOT use it for things you can discover from the repo; prefer inferring safely.
- When a file is provided inline in the user's message (under an "Attached files" section), use its contents directly instead of re-reading it.

Validation rules:
- After code changes, run the most relevant test, typecheck, build, or lint command when feasible.
- Start with targeted validation near the changed code, then use broader validation when appropriate.
- Do not fix unrelated failing tests or unrelated lint errors; report them clearly instead.
- If validation is skipped or cannot run, explain the reason briefly.

Response guidelines:
- Use markdown for clarity, but avoid excessive decoration. Prefer short bullets and compact sections for coding updates.
- Use tables only when they make structured comparisons easier to scan.
- Wrap code blocks with the correct syntax highlighting language tag when including code.
- Final answers for completed coding work should summarize what changed, name the relevant files, and list validation performed.
- Do not overuse emojis; use them only when they improve readability.

When you want the user to choose between multiple options or files, present the choices as a numbered list at the very end of your response. For example:
1. Option A
2. Option B
This enables the interactive dropdown menu in the CLI.
`;

// Injected as a transient system message (only while plan mode is active). It is
// NOT persisted to history, so switching modes takes effect immediately without
// leaving stale instructions behind.
const PLAN_DIRECTIVE = `PLAN MODE IS ACTIVE.
You may ONLY investigate and plan. DO NOT change anything.
- You must not write, edit, delete, or move files, create folders, run shell commands, run formatters, or perform any other mutating action.
- Use only read tools (read_file, list_dir, grep_search, find_files) to understand the relevant code, configuration, types, schemas, tests, and implementation patterns.
- Explore the repo first to answer facts that can be found locally. Ask the user only for important product/technical decisions that cannot be inferred from the repo.
- Once you understand enough, present a decision-complete implementation plan: summary, key changes, important files/areas, a test plan, and the assumptions/defaults you chose.
- Do not claim you have made changes, run tests, or validated anything.
- End by noting that the user can choose to implement this plan.`;

// Bangun pesan system awal: SYSTEM_PROMPT, lalu (jika ada) konteks proyek dari
// AINA.md/CLAUDE.md/AGENT.md sebagai pesan system kedua.
function buildSeedMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
  const seed: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  const ctx = loadProjectContext();
  if (ctx) {
    seed.push({ role: "system", content: formatProjectContext(ctx) });
  }
  return seed;
}

// Penanda awal pesan ringkasan kompaksi konteks (untuk mencegah penumpukan).
const SUMMARY_MARKER = "Summary of the previous conversation";

// Label ringkas per-tool untuk baris aktivitas gaya "⏺ Label(arg)".
const TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  multi_edit: "MultiEdit",
  delete_file: "Delete",
  list_dir: "List",
  find_files: "Find",
  make_dir: "Mkdir",
  move_file: "Move",
  grep_search: "Search",
  run_command: "Bash",
  ask_user: "Ask",
  git_status: "GitStatus",
  git_diff: "GitDiff",
};

// Ringkasan argumen tool yang ditampilkan di dalam kurung pada baris aktivitas.
function toolArgSummary(name: string, args: any): string {
  switch (name) {
    case "find_files":
      return String(args.pattern ?? "");
    case "grep_search":
      return String(args.query ?? "");
    case "run_command":
      return String(args.command ?? "");
    case "move_file":
      return `${args.source ?? ""} → ${args.destination ?? ""}`;
    case "ask_user":
      return `${Array.isArray(args.questions) ? args.questions.length : 0} questions`;
    case "git_status":
    case "git_diff":
      return "";
    case "list_dir":
      return String(args.path ?? ".");
    default:
      return String(args.path ?? "");
  }
}

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

// Shining/shimmer effect: a bright highlight sweeps left-to-right across the
// text while the rest stays dim, recomputed each animation tick.
function colorizeWave(str: string, tick: number): string {
  const len = str.length;
  if (len === 0) return str;
  const period = len + 8; // brief pause between sweeps
  const pos = tick % period;
  let out = "";
  for (let i = 0; i < len; i++) {
    const dist = Math.abs(i - pos);
    if (dist === 0) {
      out += chalk.cyanBright.bold(str[i]);
    } else if (dist <= 2) {
      out += chalk.cyan(str[i]);
    } else {
      out += chalk.cyan.dim(str[i]);
    }
  }
  return out;
}

// Format elapsed milliseconds as "43s" or "2m 13s"
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Playful status words: { ing } shown while working, { ed } shown when done.
const WORD_PAIRS: { ing: string; ed: string }[] = [
  { ing: "Ainating", ed: "Ainated" },
  { ing: "Thinking", ed: "Thought" },
  { ing: "Cooking", ed: "Cooked" },
  { ing: "Brewing", ed: "Brewed" },
  { ing: "Pondering", ed: "Pondered" },
  { ing: "Conjuring", ed: "Conjured" },
  { ing: "Crunching", ed: "Crunched" },
  { ing: "Summoning", ed: "Summoned" },
  { ing: "Forging", ed: "Forged" },
  { ing: "Weaving", ed: "Wove" },
  { ing: "Tinkering", ed: "Tinkered" },
  { ing: "Wrangling", ed: "Wrangled" },
  { ing: "Noodling", ed: "Noodled" },
  { ing: "Percolating", ed: "Percolated" },
  { ing: "Synthesizing", ed: "Synthesized" },
  { ing: "Hatching", ed: "Hatched" },
  { ing: "Manifesting", ed: "Manifested" },
  { ing: "Channeling", ed: "Channeled" },
  { ing: "Vibing", ed: "Vibed" },
  { ing: "Spelunking", ed: "Spelunked" },
  { ing: "Galvanizing", ed: "Galvanized" },
  { ing: "Concocting", ed: "Concocted" },
  { ing: "Calibrating", ed: "Calibrated" },
  { ing: "Orchestrating", ed: "Orchestrated" },
  { ing: "Marinating", ed: "Marinated" },
];

function randomWord(): { ing: string; ed: string } {
  return WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
}

function stripMarkdown(str: string): string {
  return str
    .replace(/\*\*(.*?)\*\*/g, "$1") // Bold **text** -> text
    .replace(/\*(.*?)\*/g, "$1") // Italic *text* -> text
    .replace(/\`(.*?)\`/g, "$1") // Code `text` -> text
    .replace(/\_\_(.*?)\_\_/g, "$1") // Underline __text__ -> text
    .replace(/\_(.*?)\_/g, "$1") // Italic _text_ -> text
    .trim();
}

export function parseChoices(
  text: string,
): { question: string; options: string[] } | null {
  const lines = text.split("\n");
  const options: string[] = [];
  const optionIndices: number[] = [];
  const optionRegex = /^\s*(?:\d+[\.\)])\s*(.+)$/;

  let foundOptions = false;
  let skippedLines = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    const match = line.match(optionRegex);
    if (match) {
      options.unshift(stripMarkdown(match[1].trim()));
      optionIndices.unshift(i);
      foundOptions = true;
    } else {
      if (foundOptions) {
        break;
      }
      skippedLines++;
      if (skippedLines > 3) {
        break;
      }
    }
  }

  if (options.length >= 2) {
    const firstOptionIdx = optionIndices[0];
    const questionLines = lines.slice(0, firstOptionIdx);

    const lastOptionIdx = optionIndices[optionIndices.length - 1];
    const trailingLines = lines.slice(lastOptionIdx + 1);

    let question = questionLines.join("\n").trim();
    const trailingText = trailingLines.join("\n").trim();
    if (trailingText) {
      question += "\n\n" + trailingText;
    }

    return { question, options };
  }

  return null;
}

const MAX_ATTACH_BYTES = 50 * 1024; // 50 KB cap per attached file

// Potong string ke maksimum `maxBytes` byte UTF-8 tanpa memecah karakter multibyte
// (memotong per-karakter bisa jauh melebihi cap byte untuk teks Unicode).
export function truncateToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const buf = Buffer.from(s, "utf8").subarray(0, maxBytes);
  let out = buf.toString("utf8");
  // Buang karakter pengganti di ujung bila byte multibyte terakhir terpotong.
  if (out.endsWith("�")) out = out.slice(0, -1);
  return out;
}

// Expand "@path" tags in the user's input by reading the referenced files/dirs
// and appending their contents so the model receives them inline (Claude Code style).
function expandFileTags(input: string): string {
  const tagRegex = /@([^\s]+)/g;
  const seen = new Set<string>();
  const attachments: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(input)) !== null) {
    const rawPath = match[1];
    // Trim a trailing slash used purely for directory navigation in the picker
    const lookupPath = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    if (!lookupPath || seen.has(lookupPath)) continue;

    const resolved = path.resolve(lookupPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue; // Not a real path — leave the token as literal text
    }
    seen.add(lookupPath);

    try {
      if (stat.isFile()) {
        let content = fs.readFileSync(resolved, "utf8");
        let truncatedNote = "";
        if (Buffer.byteLength(content, "utf8") > MAX_ATTACH_BYTES) {
          content = truncateToBytes(content, MAX_ATTACH_BYTES);
          truncatedNote = "\n... (truncated)";
        }
        attachments.push(
          `File: ${lookupPath}\n\`\`\`\n${content}${truncatedNote}\n\`\`\``,
        );
      } else if (stat.isDirectory()) {
        const entries = fs.readdirSync(resolved).map((f) => {
          let isDir = false;
          try {
            isDir = fs.statSync(path.join(resolved, f)).isDirectory();
          } catch {}
          return `${isDir ? "DIR " : "FILE"}  ${f}`;
        });
        attachments.push(
          `Directory: ${lookupPath}\n\`\`\`\n${entries.join("\n")}\n\`\`\``,
        );
      }
    } catch {
      // Skip unreadable attachments silently
    }
  }

  if (attachments.length === 0) return input;
  return `${input}\n\n---\nAttached files:\n\n${attachments.join("\n\n")}`;
}

// Detect the API's context-length-exceeded error across shapes.
function isContextLengthError(error: any): boolean {
  const code = error?.code || error?.error?.code || "";
  const msg = (error?.message || "").toLowerCase();
  return (
    code === "context_length_exceeded" ||
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("too many tokens") ||
    msg.includes("context_length")
  );
}

// Map common API/network failures to friendly English messages.
function friendlyError(error: any): string {
  const status = error?.status || error?.statusCode;
  const code = error?.code || "";
  if (status === 401 || status === 403) {
    return "Error: API key is invalid or rejected. Check AINA_API_KEY or ~/.ainacode/config.json.";
  }
  if (status === 429) {
    return "Error: too many requests (rate limit). Try again shortly.";
  }
  if (status === 404 || code === "model_not_found" || /model.*not.*found|unknown model/i.test(error?.message || "")) {
    return "Error: model not found on the gateway. Check the model name (/model) — choices: aina-1-flash, aina-1-mini, aina-1-pro, aina-1-ultra.";
  }
  if (typeof status === "number" && status >= 500) {
    return `Error: gateway server problem (HTTP ${status}). Try again later.`;
  }
  if (["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"].includes(code)) {
    return "Error: failed to connect to the server. Check your internet connection / AINA_BASE_URL.";
  }
  return `Execution error: ${error?.message || String(error)}`;
}

// Format a token count compactly: 1234 -> "1.2k".
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

class AinaSpinner {
  private timer: NodeJS.Timeout | null = null;
  private tick = 0;
  private startTime = 0;
  private model: string;
  private lastLineCount = 0;
  private customStatus: string | null = null;
  private inputLine = "";
  private queuedCount = 0;
  private word = randomWord();
  private suppressed = false;

  constructor(model: string) {
    this.model = model;
  }

  // Temporarily prevent all drawing (used while raw assistant text is streamed).
  suppress(value: boolean) {
    this.suppressed = value;
    if (value) this.clear();
  }

  start() {
    if (this.timer) return;
    if (!this.startTime) this.startTime = Date.now();
    this.draw();
    this.timer = setInterval(() => {
      this.tick++;
      this.draw();
    }, 80);
  }

  setStatus(status: string | null) {
    this.customStatus = status;
    // Returning to the idle state picks a fresh random word for variety.
    if (status === null) this.word = randomWord();
    this.draw();
  }

  // Past-tense word for the completion message (e.g. "Cooked", "Ainated")
  doneWord(): string {
    return this.word.ed;
  }

  // Update the in-progress typed line and the count of queued messages
  setInputLine(text: string, queuedCount = this.queuedCount) {
    this.inputLine = text;
    this.queuedCount = queuedCount;
    this.draw();
  }

  elapsedText(): string {
    if (!this.startTime) return "0s";
    return formatElapsed(Date.now() - this.startTime);
  }

  draw() {
    if (this.suppressed) return;
    const cols = process.stdout.columns || 80;
    const horizontalLine = chalk.gray("─".repeat(cols));
    const spinnerChar = chalk.cyan(
      SPINNER_FRAMES[this.tick % SPINNER_FRAMES.length],
    );
    const statusText = this.customStatus || `${this.word.ing}…`;

    // Apply the shining sweep to the status text and append the running timer
    const animatedStatus = colorizeWave(statusText, this.tick);
    const elapsed = chalk.gray(this.elapsedText());
    const prettyModel = getPrettyModelName(this.model);
    const text = `${spinnerChar} ${animatedStatus} ${elapsed} ${chalk.gray("(" + prettyModel + ")")}`;

    this.clear();

    const isTyping = this.inputLine.length > 0;
    const leftText = isTyping
      ? "enter to queue · esc to interrupt"
      : "type to queue a message · esc to interrupt";
    const right = footerRight(prettyModel);
    const padding = Math.max(0, cols - leftText.length - right.raw.length);
    const footer = chalk.gray(leftText) + " ".repeat(padding) + right.colored;

    // Sama seperti prompt idle: baris input dibingkai garis atas & bawah agar
    // tampil utuh selama proses berjalan (saat kosong hanya menampilkan caret).
    const lines = [
      text,
      horizontalLine,
      chalk.cyan("› ") + this.inputLine + chalk.dim("▏"),
      horizontalLine,
    ];
    if (this.queuedCount > 0) {
      lines.push(
        chalk.gray(
          `  ⏎ ${this.queuedCount} message${this.queuedCount > 1 ? "s" : ""} queued`,
        ),
      );
    }
    lines.push(footer);
    // No leading newline to prevent extra vertical spacing
    process.stdout.write(lines.join("\n"));
    this.lastLineCount = lines.length;
  }

  clear() {
    if (this.lastLineCount > 0) {
      // Move to column 1, then move up, then clear to end of screen
      process.stdout.write(`\r\x1B[${this.lastLineCount - 1}A\x1B[J`);
      this.lastLineCount = 0;
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clear();
  }

  log(text: string) {
    this.clear();
    console.log(text);
    this.draw();
  }
}

export class AinaAgent {
  private openai: OpenAI;
  private model: string;
  private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private lastChoices: { question: string; options: string[] } | null = null;
  private lastPlan: string | null = null;
  // Statistik pemakaian sesi (untuk /usage & /status). sessionTokens menjumlah
  // token yang dilaporkan gateway tiap giliran; turnCount menghitung giliran.
  private sessionTokens = 0;
  private turnCount = 0;
  // Pesan system awal: SYSTEM_PROMPT + (opsional) konteks proyek dari
  // AINA.md/CLAUDE.md/AGENT.md. Dihitung sekali saat konstruksi agar /clear bisa
  // memulihkannya tanpa membaca ulang disk.
  private readonly seedMessages: OpenAI.Chat.ChatCompletionMessageParam[];

  constructor(openai: OpenAI, model: string) {
    this.openai = openai;
    this.model = model;
    this.seedMessages = buildSeedMessages();
    this.messages.push(...this.seedMessages.map((m) => ({ ...m })));
  }

  changeModel(newModel: string): void {
    this.model = newModel;
  }

  getModel(): string {
    return this.model;
  }

  getLastChoices(): { question: string; options: string[] } | null {
    return this.lastChoices;
  }

  clearLastChoices(): void {
    this.lastChoices = null;
  }

  // The plan text produced during the most recent plan-mode turn (if any).
  getLastPlan(): string | null {
    return this.lastPlan;
  }

  clearLastPlan(): void {
    this.lastPlan = null;
  }

  clearHistory(): void {
    this.messages = this.seedMessages.map((m) => ({ ...m }));
    this.lastChoices = null;
    this.lastPlan = null;
  }

  // Riwayat percakapan saat ini (untuk persistensi sesi).
  getHistory(): OpenAI.Chat.ChatCompletionMessageParam[] {
    return this.messages;
  }

  // Pulihkan riwayat percakapan dari sesi tersimpan (slash /resume).
  restoreHistory(messages: OpenAI.Chat.ChatCompletionMessageParam[]): void {
    this.messages = messages;
    this.lastChoices = null;
    this.lastPlan = null;
  }

  // Statistik pemakaian sesi + estimasi ukuran konteks saat ini (slash /usage,
  // /status). `budget` adalah ambang yang memicu kompaksi otomatis.
  getUsage(): {
    sessionTokens: number;
    turns: number;
    contextTokens: number;
    budget: number;
  } {
    const contextTokens = this.messages.reduce(
      (s, m) => s + this.approxTokens(m),
      0,
    );
    return {
      sessionTokens: this.sessionTokens,
      turns: this.turnCount,
      contextTokens,
      budget: 100_000,
    };
  }

  // Ringkas konteks secara manual (slash /compact), terlepas dari budget.
  // Mengembalikan estimasi token konteks sebelum & sesudah kompaksi.
  async compact(): Promise<{ before: number; after: number }> {
    const measure = () =>
      this.messages.reduce((s, m) => s + this.approxTokens(m), 0);
    const before = measure();
    await this.compactHistory(undefined, true);
    return { before, after: measure() };
  }

  // Build the messages array for an API request. In plan mode a transient system
  // directive is inserted right after the base system prompt; it is never stored
  // in this.messages, so toggling modes mid-session has an immediate effect.
  private buildRequestMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
    if (!isPlanMode()) return this.messages;
    // Sisipkan directive plan tepat setelah seluruh pesan seed (SYSTEM_PROMPT +
    // konteks proyek), sebelum riwayat percakapan.
    const n = this.seedMessages.length;
    return [
      ...this.messages.slice(0, n),
      { role: "system", content: PLAN_DIRECTIVE },
      ...this.messages.slice(n),
    ];
  }

  // Approximate token count of a message (chars / 4 heuristic + small overhead).
  private approxTokens(m: OpenAI.Chat.ChatCompletionMessageParam): number {
    const anyM = m as any;
    const content =
      typeof anyM.content === "string"
        ? anyM.content
        : JSON.stringify(anyM.content ?? "");
    const tools = anyM.tool_calls ? JSON.stringify(anyM.tool_calls) : "";
    return Math.ceil((content.length + tools.length) / 4) + 4;
  }

  // Keep the conversation under an approximate token budget by dropping the
  // oldest messages (after the system prompt). The kept window always begins at
  // a 'user' message so no orphan assistant-tool_calls / tool messages remain.
  private trimHistory(aggressive = false): void {
    const budget = aggressive ? 50_000 : 100_000;
    let total = this.messages.reduce((s, m) => s + this.approxTokens(m), 0);
    if (total <= budget) return;

    const system = this.messages[0];
    const rest = this.messages.slice(1);
    while (rest.length > 1 && total > budget) {
      total -= this.approxTokens(rest.shift()!);
    }
    // Realign the window to start at a user message (a valid suffix boundary).
    while (rest.length > 1 && (rest[0] as any).role !== "user") {
      total -= this.approxTokens(rest.shift()!);
    }
    this.messages = [system, ...rest];
  }

  // Kompaksi konteks via LLM: saat melebihi budget, ringkas pesan lama menjadi
  // satu catatan padat dan pertahankan pesan terbaru verbatim. Jauh lebih menjaga
  // kualitas konteks dibanding sekadar membuang pesan lama. Bila gagal (jaringan/
  // kosong), jatuh ke trimHistory() lama sebagai jaring pengaman.
  private async compactHistory(
    signal?: AbortSignal,
    force = false,
  ): Promise<void> {
    const budget = 100_000;
    const total = this.messages.reduce((s, m) => s + this.approxTokens(m), 0);
    if (!force && total <= budget) return;

    // "Head" = pesan system di awal (seed + ringkasan sebelumnya bila ada).
    let headEnd = 0;
    while (headEnd < this.messages.length && (this.messages[headEnd] as any).role === "system") {
      headEnd++;
    }
    // Buang ringkasan lama agar tidak menumpuk; pertahankan seed.
    const head = this.messages
      .slice(0, headEnd)
      .filter((m) => !String((m as any).content || "").startsWith(SUMMARY_MARKER));
    const conv = this.messages.slice(headEnd);
    if (conv.length < 6) {
      this.trimHistory();
      return;
    }

    // Pertahankan ~40k token terakhir verbatim, selaraskan ke batas pesan 'user'.
    let keepFrom = conv.length;
    let acc = 0;
    const keepBudget = 40_000;
    while (keepFrom > 0) {
      const t = this.approxTokens(conv[keepFrom - 1]);
      if (acc + t > keepBudget) break;
      acc += t;
      keepFrom--;
    }
    while (keepFrom < conv.length && (conv[keepFrom] as any).role !== "user") keepFrom++;
    if (keepFrom >= conv.length) keepFrom = Math.max(0, conv.length - 4);

    const toSummarize = conv.slice(0, keepFrom);
    const toKeep = conv.slice(keepFrom);
    if (toSummarize.length === 0) {
      this.trimHistory();
      return;
    }

    const transcript = toSummarize
      .map((m) => {
        const anyM = m as any;
        let content =
          typeof anyM.content === "string" ? anyM.content : JSON.stringify(anyM.content ?? "");
        if (anyM.tool_calls) {
          content += ` [memanggil tool: ${anyM.tool_calls.map((t: any) => t.function?.name).join(", ")}]`;
        }
        return `${anyM.role}: ${content}`;
      })
      .join("\n")
      .slice(0, 60_000);

    const resp = await this.openai.chat.completions.create(
      {
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "Summarize the following coding conversation into a compact note that preserves: the user's request/goal, important decisions, files created/changed, and the current status & findings. Max ~400 words. Use the same language as the conversation. Do not add new information.",
          },
          { role: "user", content: transcript },
        ],
        stream: false,
      },
      { signal },
    );
    const summary = resp.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      this.trimHistory();
      return;
    }

    this.messages = [
      ...head,
      { role: "system", content: `${SUMMARY_MARKER} (compressed to save context):\n${summary}` },
      ...toKeep,
    ];
  }

  async run(userInput: string): Promise<string[]> {
    // Persetujuan "semua langkah ini" hanya berlaku untuk satu giliran.
    resetTurnApproval();
    this.messages.push({
      role: "user",
      content: expandFileTags(userInput),
    });

    // Gap between the echoed user prompt and the process output below.
    console.log();

    const spinner = new AinaSpinner(this.model);
    spinner.start();

    let keepGoing = true;
    let cancelled = false;
    const abortController = new AbortController();

    // Guard against a model that never stops calling tools (runaway cost/time).
    const MAX_ITERATIONS = 25;
    let iterations = 0;
    // Allow exactly one automatic retry after trimming on a context-length error.
    let retriedContext = false;
    // Total tokens used across all completions in this run (for the summary line).
    let totalTokens = 0;
    // True while raw assistant text is being streamed to the screen.
    let streamingNow = false;

    // Let the user keep typing while the task runs; submitted lines are queued
    // and returned to the REPL to run after this task finishes.
    let typedInput = "";
    const queuedInputs: string[] = [];
    let acceptTyping = true;

    const onCancelKey = (str: string, key: any) => {
      if (key && key.name === "escape") {
        cancelled = true;
        abortController.abort();
        return;
      }
      if (!acceptTyping || !key) return;

      if (key.ctrl && key.name === "c") {
        typedInput = "";
        spinner.setInputLine("");
        return;
      }
      if (key.name === "return") {
        const trimmed = typedInput.trim();
        if (trimmed) queuedInputs.push(typedInput);
        typedInput = "";
        spinner.setInputLine("", queuedInputs.length);
        return;
      }
      if (key.name === "backspace") {
        typedInput = typedInput.slice(0, -1);
        spinner.setInputLine(typedInput);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (str && str.length === 1 && str >= " ") {
        typedInput += str;
        spinner.setInputLine(typedInput);
      }
    };

    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      readline.emitKeypressEvents(process.stdin);
      process.stdin.on("keypress", onCancelKey);
    }

    while (keepGoing) {
      if (cancelled) {
        spinner.log(chalk.red("\n[Task Cancelled]"));
        break;
      }

      iterations++;
      if (iterations > MAX_ITERATIONS) {
        spinner.log(
          chalk.yellow(
            `\n[Stopped] Reached the limit of ${MAX_ITERATIONS} tool steps. Send "continue" if you want Aina to keep going.`,
          ),
        );
        break;
      }

      // Keep the conversation within an approximate token budget. Utamakan
      // kompaksi via LLM (jaga kualitas); jika gagal, fallback ke trim biasa.
      try {
        await this.compactHistory(abortController.signal);
      } catch {
        this.trimHistory();
      }

      try {
        const stream = await this.openai.chat.completions.create(
          {
            model: this.model,
            messages: this.buildRequestMessages(),
            tools: toolsList as any,
            stream: true,
            stream_options: { include_usage: true },
          },
          {
            signal: abortController.signal,
          },
        );

        // Assemble the assistant message from streamed deltas.
        let contentBuf = "";
        const toolCallsAcc: any[] = [];

        // Block-wise streaming: as text arrives we keep it in `contentBuf` but only
        // print a block once it is COMPLETE (a markdown block ends at a blank line,
        // with code fences balanced). Each completed block is rendered as markdown
        // and printed into scrollback via spinner.log() — so the answer appears
        // progressively (streaming feel) yet is always clean (no stray ***, `, ___,
        // ---). The trailing, still-in-progress block stays buffered until the end.
        let flushedLen = 0; // chars of contentBuf already printed
        let printedAny = false; // whether any block has been printed this turn

        const beginStream = () => {
          streamingNow = true;
        };

        // Count code-fence lines (``` at start of a line). A block is only safe to
        // flush when the fences within it are balanced (even count).
        const fenceCount = (s: string): number => (s.match(/^```/gm) || []).length;

        // Render `raw` as markdown and append it to scrollback. spinner.log() clears
        // the status bar, prints, then redraws the bar — safe at any height.
        const printBlock = (raw: string) => {
          if (!raw.trim()) return;
          const rendered = renderMarkdown(raw);
          if (!rendered) return;
          spinner.log(printedAny ? `\n${rendered}` : rendered);
          printedAny = true;
        };

        // Flush every complete block at the front of the unprinted region, leaving
        // the trailing in-progress block buffered.
        const flushBlocks = () => {
          while (true) {
            const pending = contentBuf.slice(flushedLen);
            let from = 0;
            let cut = -1;
            while (true) {
              const idx = pending.indexOf("\n\n", from);
              if (idx === -1) break;
              if (fenceCount(pending.slice(0, idx)) % 2 === 0) {
                cut = idx;
                break;
              }
              from = idx + 1; // boundary sits inside an open code fence — keep looking
            }
            if (cut === -1) break;
            printBlock(pending.slice(0, cut));
            // Consume the run of newlines separating this block from the next.
            let sep = cut;
            while (contentBuf[flushedLen + sep] === "\n") sep++;
            flushedLen += sep;
          }
        };

        for await (const chunk of stream as any) {
          if (cancelled) break;
          if (chunk?.usage?.total_tokens)
            totalTokens += chunk.usage.total_tokens;
          const delta = chunk?.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            if (!streamingNow) beginStream();
            contentBuf += delta.content;
            flushBlocks(); // print any blocks that just completed
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsAcc[idx]) {
                toolCallsAcc[idx] = {
                  id: tc.id || "",
                  type: "function",
                  function: { name: "", arguments: "" },
                };
              }
              if (tc.id) toolCallsAcc[idx].id = tc.id;
              if (tc.function?.name)
                toolCallsAcc[idx].function.name += tc.function.name;
              if (tc.function?.arguments)
                toolCallsAcc[idx].function.arguments += tc.function.arguments;
            }
          }
        }

        // Catch any block that completed right at the end of the stream.
        flushBlocks();
        streamingNow = false;
        acceptTyping = true;

        if (cancelled) {
          // Loop top logs the cancellation via spinner.log(), which clears the bar.
          continue; // loop top logs the cancellation and breaks
        }

        const toolCalls = toolCallsAcc.filter(Boolean);
        const assistantMessage: any = {
          role: "assistant",
          content: contentBuf || null,
        };
        if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
        this.messages.push(assistantMessage);

        // `tail` is the final, still-unprinted block (everything after the last
        // completed block). The earlier blocks already streamed to the screen.
        const tail = contentBuf.slice(flushedLen);
        if (contentBuf) {
          // In plan mode the numbered steps of the plan must not be turned into a
          // selection menu — the plan-decision menu (REPL) handles next steps.
          const parsed = isPlanMode() ? null : parseChoices(contentBuf);
          if (parsed) {
            this.lastChoices = parsed;
            // The options become the interactive menu, so they must NOT be echoed
            // as text. Print only the part of the trailing block that precedes the
            // first option (the rest of the question already streamed above).
            const optRe = /^\s*(?:\d+[.)])\s*(.+)$/;
            const tailLines = tail.split("\n");
            const firstOpt = tailLines.findIndex((l) => optRe.test(l.trim()));
            const questionTail =
              firstOpt === -1 ? tail : tailLines.slice(0, firstOpt).join("\n");
            printBlock(questionTail);
          } else {
            printBlock(tail); // flush the last block
          }
          flushedLen = contentBuf.length;
        }

        if (
          assistantMessage.tool_calls &&
          assistantMessage.tool_calls.length > 0
        ) {
          // Lacak apakah ada perubahan file pada batch tool ini (untuk auto-validate).
          let mutatedThisRound = false;
          for (const toolCall of assistantMessage.tool_calls) {
            if (cancelled) break;

            const name = toolCall.function.name;
            let args: any = {};
            let argParseError = false;
            try {
              args = JSON.parse(toolCall.function.arguments || "{}");
            } catch {
              // Jangan fallback diam ke {} — beri tahu model agar memanggil ulang
              // dengan argumen JSON yang valid alih-alih menjalankan tool secara salah.
              argParseError = true;
            }

            // Update spinner status based on the tool
            let loadingText = "Thinking...";
            if (name === "read_file") {
              loadingText = `Reading ${args.path || ""}`;
            } else if (name === "write_file") {
              loadingText = `Writing ${args.path || ""}`;
            } else if (name === "edit_file") {
              loadingText = `Editing ${args.path || ""}`;
            } else if (name === "multi_edit") {
              loadingText = `Editing ${args.path || ""}`;
            } else if (name === "delete_file") {
              loadingText = `Deleting ${args.path || ""}`;
            } else if (name === "list_dir") {
              loadingText = `Listing directory ${args.path || "."}`;
            } else if (name === "find_files") {
              loadingText = `Finding "${args.pattern || ""}" in ${args.path || "."}`;
            } else if (name === "make_dir") {
              loadingText = `Creating directory ${args.path || ""}`;
            } else if (name === "move_file") {
              loadingText = `Moving ${args.source || ""}`;
            } else if (name === "grep_search") {
              loadingText = `Searching "${args.query || ""}" in ${args.path || "."}`;
            } else if (name === "run_command") {
              loadingText = `Running command "${args.command || ""}"`;
            } else if (name === "ask_user") {
              loadingText = "Asking the user…";
            } else if (name === "git_status") {
              loadingText = "Checking git status…";
            } else if (name === "git_diff") {
              loadingText = "Reading git diff…";
            }

            spinner.setStatus(loadingText);

            // Tools that prompt the user must hide the spinner first. write_file
            // and edit_file are interactive too: they show a diff + confirmation
            // (unless auto-approve is on) and print the diff themselves.
            const isInteractive =
              name === "run_command" ||
              name === "delete_file" ||
              name === "move_file" ||
              name === "write_file" ||
              name === "edit_file" ||
              name === "multi_edit" ||
              name === "ask_user";
            if (isInteractive) {
              // Pause typing capture and hide the spinner so the confirmation
              // prompt has sole control of stdin.
              acceptTyping = false;
              spinner.stop();
            }

            let result: string;
            if (argParseError) {
              result = `Error: arguments for tool '${name}' are not valid JSON: ${toolCall.function.arguments}. Call the tool again with correct JSON arguments.`;
            } else {
              try {
                result = await executeTool(name, args);
              } catch (toolErr: any) {
                result = `Error: tool '${name}' failed: ${toolErr?.message || String(toolErr)}`;
              }
            }

            if (isInteractive) {
              // Restart the spinner for next LLM turn
              spinner.start();
              acceptTyping = true;
            }

            // Format clean history log line
            let historyLog = "";
            let skipOutputLog = false;
            const isError = result.startsWith("Error");

            // Tandai bila ada perubahan file sukses (memicu auto-validate nanti).
            const FILE_MUTATORS = new Set([
              "write_file",
              "edit_file",
              "multi_edit",
              "delete_file",
              "move_file",
            ]);
            if (!isError && FILE_MUTATORS.has(name)) {
              mutatedThisRound = true;
            }

            // Baris aktivitas tool gaya bersih: "⏺ Label(arg)" — satu titik
            // berwarna menurut status, tanpa emoji per-tool.
            const label = TOOL_LABELS[name] ?? name;
            const argStr = toolArgSummary(name, args);
            const rejected = result.includes("rejected by user");
            const dot = isError
              ? chalk.red("⏺")
              : rejected
                ? chalk.yellow("⏺")
                : chalk.green("⏺");
            const head = argStr
              ? `${chalk.white(label)}${chalk.dim(`(${argStr})`)}`
              : chalk.white(label);
            const suffix = rejected
              ? chalk.yellow(" rejected")
              : isError
                ? chalk.red(" failed")
                : "";
            historyLog = `${dot} ${head}${suffix}`;

            // Tool yang sudah menampilkan dirinya sendiri (diff/jawaban) tidak
            // perlu menampilkan output mentah lagi saat sukses.
            if (
              !isError &&
              (name === "write_file" ||
                name === "edit_file" ||
                name === "multi_edit" ||
                name === "ask_user")
            ) {
              skipOutputLog = true;
            }

            let outputLog = "";
            if (!skipOutputLog && result && result.trim()) {
              const lines = result.trim().split("\n");
              const maxLines = 5;
              // Output ringkas di bawah baris aktivitas: baris pertama diawali
              // "⎿", sisanya menjorok sejajar (gaya bersih).
              const shown = lines.slice(0, maxLines).map((l, i) =>
                i === 0
                  ? `  ${chalk.dim("⎿")} ${chalk.gray(l)}`
                  : `    ${chalk.gray(l)}`,
              );
              if (lines.length > maxLines) {
                shown.push(`    ${chalk.gray("… (truncated)")}`);
              }
              outputLog = "\n" + shown.join("\n");
            }

            spinner.log(historyLog + outputLog);

            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: result,
            } as OpenAI.Chat.ChatCompletionToolMessageParam);
          }

          // Feedback loop pasca-edit: setelah ada perubahan file, jalankan
          // typecheck/lint otomatis dan suntik hasilnya agar model bisa
          // mengoreksi diri di iterasi berikutnya. Sekali per giliran tool.
          if (mutatedThisRound && !cancelled && loadConfig().autoValidate) {
            spinner.setStatus("Validating changes…");
            const v = runValidation();
            if (v) {
              if (v.ok) {
                // Passed: just inform the console, no need to burden the context.
                spinner.log(chalk.green(`Validation: ${v.command} — passed`));
              } else {
                spinner.log(chalk.yellow(`Validation: ${v.command} — issues found; Aina will fix them.`));
                this.messages.push({
                  role: "system",
                  content: `Automatic validation (${v.command}) FOUND issues. Fix the ones relevant to your changes (ignore unrelated errors), then continue:\n\n${v.output}`,
                });
              }
            }
          }
          // Reset spinner status to default "Thinking..." after all current tool calls are finished
          spinner.setStatus(null);
        } else {
          keepGoing = false;
          // A terminal answer with no tool calls while in plan mode IS the plan.
          if (isPlanMode() && contentBuf.trim()) {
            this.lastPlan = contentBuf;
          }
        }
      } catch (error: any) {
        // Reset stream flags if an error/abort interrupted a buffered stream.
        if (streamingNow) {
          streamingNow = false;
          acceptTyping = true;
        }
        if (
          cancelled ||
          error.name === "AbortError" ||
          error.message?.includes("abort")
        ) {
          spinner.log(chalk.red("\n[Task Cancelled]"));
          keepGoing = false;
        } else if (!retriedContext && isContextLengthError(error)) {
          // Trim aggressively and retry once before giving up.
          retriedContext = true;
          this.trimHistory(true);
          spinner.setStatus(
            "History too long — trimming & retrying…",
          );
        } else {
          spinner.log(chalk.red(`\n${friendlyError(error)}`));
          keepGoing = false;
        }
      }
    }

    if (process.stdin.isTTY) {
      process.stdin.removeListener("keypress", onCancelKey);
      process.stdin.setRawMode(wasRaw);
    }

    const elapsed = spinner.elapsedText();
    const doneWord = spinner.doneWord();
    spinner.stop();
    // Akumulasi statistik sesi untuk /usage & /status.
    this.turnCount++;
    this.sessionTokens += totalTokens;
    if (!cancelled) {
      const tokenStr =
        totalTokens > 0 ? ` · ${formatTokens(totalTokens)} token` : "";
      console.log(chalk.gray(`${doneWord} in ${elapsed}${tokenStr}`));
    }

    // Gap between the process output and the next prompt input below.
    console.log();

    // If the task was cancelled, drop anything queued during it.
    return cancelled ? [] : queuedInputs;
  }
}
