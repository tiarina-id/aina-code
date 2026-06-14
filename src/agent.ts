import type OpenAI from "openai";
import chalk from "chalk";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { toolsList, executeTool, resetTurnApproval, runValidation } from "./tools.js";
import { getActiveProvider, loadConfig, getPrettyModelName } from "./config.js";
import { renderMarkdown } from "./markdown.js";
import { isPlanMode, footerRight } from "./mode.js";
import { loadProjectContext, formatProjectContext } from "./context.js";

const SYSTEM_PROMPT = `You are Aina, a concise and precise coding assistant CLI.
Match the user's language. Explain briefly before tool use.

Work rules:
- Inspect relevant files/config/tests first; follow existing style.
- Fix root causes with minimal focused changes; avoid unrelated edits.
- Infer safely from the repo; ask only for decisions that materially change behavior.
- Never claim file/command actions unless you used the matching tool.
- Prefer read_file before edits, edit_file for small changes, write_file for new/full rewrites.
- Use find_files/grep_search/list_dir for discovery and run_command for builds/tests/git inspection.
- Use ask_user only for genuine ambiguity requiring a structured choice.
- If content appears under "Attached files", use it directly instead of re-reading.
- After code changes, run relevant validation when feasible; report unrelated failures without fixing them.
- Final coding answers should summarize changed files and validation.

For interactive choices, put a numbered list at the very end so the CLI can render a selector.`;

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
const MAX_TOOL_RESULT_BYTES = 32 * 1024;
const MAX_COMPLETION_TOKENS = 4096;
const TOOL_RESULT_EVICT_AFTER_REQUESTS = 1;
const STREAM_FALLBACK_FLUSH_MS = 1200;
const STREAM_FALLBACK_FLUSH_CHARS = 240;
const VALIDATION_PREFIX = "Automatic validation (";
const ATTACHMENTS_MARKER = "\n\nAttached files:\n";
const READ_ONLY_TOOL_NAMES = new Set([
  "read_file",
  "list_dir",
  "grep_search",
  "find_files",
  "git_status",
  "git_diff",
  "ask_user",
]);

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

export function summarizeToolResult(name: string, args: any, result: string): string {
  const pathLike = args?.path ?? args?.source ?? args?.pattern ?? args?.query ?? "";
  const lineCount = result ? result.split("\n").length : 0;
  const bytes = Buffer.byteLength(result ?? "", "utf8");
  const target = pathLike ? `: ${String(pathLike)}` : "";
  return `[${name}${target} — ${lineCount} lines, ${bytes} bytes; previous tool result summarized]`;
}

export function capToolResult(name: string, args: any, result: string): string {
  if (Buffer.byteLength(result, "utf8") <= MAX_TOOL_RESULT_BYTES) return result;
  const capped = truncateToBytes(result, MAX_TOOL_RESULT_BYTES);
  const hint =
    name === "read_file"
      ? "Use read_file with offset/limit to inspect the omitted portion."
      : name === "grep_search"
        ? "Narrow the query or path to inspect more matches."
        : "Narrow the request to inspect the omitted portion.";
  return `${capped}\n... (tool result truncated at ${MAX_TOOL_RESULT_BYTES / 1024}KB. ${hint})`;
}

export function countCodeFences(s: string): number {
  return (s.match(/^```/gm) || []).length;
}

export function findFlushBoundary(
  pending: string,
  force = false,
  minChars = STREAM_FALLBACK_FLUSH_CHARS,
  allowSoftFlush = false,
): number {
  let from = 0;
  while (true) {
    const idx = pending.indexOf("\n\n", from);
    if (idx === -1) break;
    if (countCodeFences(pending.slice(0, idx)) % 2 === 0) return idx;
    from = idx + 1;
  }
  if (!force && (!allowSoftFlush || pending.length < minChars)) return -1;
  if (countCodeFences(pending) % 2 !== 0) return -1;

  const newline = pending.lastIndexOf("\n");
  if ((force || allowSoftFlush) && newline > 0) return newline;

  if (allowSoftFlush && pending.length >= minChars) {
    const softBreak = pending.lastIndexOf(" ", minChars);
    if (softBreak > 0) return softBreak;
  }
  return force && pending.trim() ? pending.length : -1;
}

export function compactAttachedFilesContent(content: string): string {
  const idx = content.indexOf(ATTACHMENTS_MARKER);
  if (idx === -1) return content;
  const prompt = content.slice(0, idx).trimEnd();
  const attachments = content.slice(idx + ATTACHMENTS_MARKER.length);
  const fileRefs = Array.from(attachments.matchAll(/^--- (?:File|Directory): (.+) ---$/gm))
    .map((m) => m[1].trim())
    .filter(Boolean);
  const summary = fileRefs.length > 0
    ? fileRefs.map((f) => `- ${f}`).join("\n")
    : "- attached content processed earlier";
  return `${prompt}\n\n[Attached file contents summarized after processing; referenced paths:]\n${summary}`;
}

export function sanitizeHistoryForSave(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const lastValidation = [...messages]
    .reverse()
    .findIndex((m: any) => m.role === "system" && typeof m.content === "string" && m.content.startsWith(VALIDATION_PREFIX));
  const validationKeepIndex = lastValidation === -1 ? -1 : messages.length - 1 - lastValidation;
  return messages.flatMap((message, idx) => {
    const anyMessage = message as any;
    if (anyMessage.role === "system" && typeof anyMessage.content === "string" && anyMessage.content.startsWith(VALIDATION_PREFIX) && idx !== validationKeepIndex) {
      return [];
    }
    if (anyMessage.role === "user" && typeof anyMessage.content === "string") {
      const content = compactAttachedFilesContent(anyMessage.content);
      if (content !== anyMessage.content) return [{ ...message, content }];
    }
    return [message];
  });
}

function isValidationMessage(message: OpenAI.Chat.ChatCompletionMessageParam): boolean {
  const anyMessage = message as any;
  return anyMessage.role === "system" && typeof anyMessage.content === "string" && anyMessage.content.startsWith(VALIDATION_PREFIX);
}

export function sanitizeActiveHistory(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return sanitizeHistoryForSave(messages);
}

export function locallyCompactHistoryForSerialization(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const sanitized = sanitizeHistoryForSave(messages);
  const lastValidationIndex = sanitized.map(isValidationMessage).lastIndexOf(true);

  return sanitized.map((message, idx) => {
    const anyMessage = message as any;
    if (anyMessage.role === "tool" && typeof anyMessage.content === "string") {
      return {
        ...message,
        content: capToolResult("tool", {}, anyMessage.content),
      };
    }
    if (isValidationMessage(message) && idx !== lastValidationIndex) {
      return {
        ...message,
        content: "[Older validation result omitted; latest validation result is kept later in history.]",
      };
    }
    return message;
  });
}

export function estimateHistoryTokens(messages: OpenAI.Chat.ChatCompletionMessageParam[]): number {
  return messages.reduce((sum, message: any) => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    const tools = message.tool_calls ? JSON.stringify(message.tool_calls) : "";
    return sum + Math.ceil((content.length + tools.length) / 4) + 4;
  }, 0);
}

export type RequestToolPolicy =
  | { tools: typeof toolsList; tool_choice?: never }
  | { tools?: never; tool_choice: "none" };

export function chooseRequestToolPolicy(options: {
  planMode: boolean;
  toolsNeeded: boolean;
}): RequestToolPolicy {
  if (!options.toolsNeeded) return { tool_choice: "none" };
  if (!options.planMode) return { tools: toolsList };
  return {
    tools: toolsList.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.function.name)),
  };
}

const COST_PER_MILLION_TOKENS_USD: Record<string, { input: number; output: number }> = {
  "aina-1-flash": { input: 0.15, output: 0.6 },
  "aina-1-mini": { input: 0.3, output: 1.2 },
  "aina-1-pro": { input: 2.5, output: 10 },
  "aina-1-ultra": { input: 5, output: 20 },
};

export function estimateUsageCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const pricing = COST_PER_MILLION_TOKENS_USD[model.toLowerCase()];
  if (!pricing) return null;
  return (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
}

export function normalizeUsageDelta(usage: any): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const promptTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;
  const reportedTotal = typeof usage?.total_tokens === "number" ? usage.total_tokens : 0;
  const totalTokens = reportedTotal || promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens > 0) {
    return { promptTokens: totalTokens, completionTokens: 0, totalTokens };
  }
  return { promptTokens, completionTokens, totalTokens };
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
export function friendlyError(error: any): string {
  const status = error?.status || error?.statusCode;
  const code = error?.code || "";
  const message = String(error?.message || "");
  if (status === 401 || status === 403) {
    return "Error: API key is invalid or rejected. Check your active provider with /provider or ~/.ainacode/config.json.";
  }
  if (status === 429) {
    return "Error: too many requests (rate limit). Try again shortly.";
  }
  if (status === 404 || code === "model_not_found" || /model.*not.*found|unknown model/i.test(error?.message || "")) {
    return "Error: model not found on the gateway. Check the model name (/model) — choices: aina-1-flash, aina-1-mini, aina-1-pro, aina-1-ultra.";
  }
  if (typeof status === "number" && status >= 500) {
    return `Error: gateway server problem (HTTP ${status}). The request may have been retried; try again later.`;
  }
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || /timeout|timed out|aborted/i.test(message)) {
    return "Error: gateway request timed out or was interrupted after retries. Check your connection/AINA_BASE_URL and try again.";
  }
  if (["ENOTFOUND", "ECONNREFUSED"].includes(code)) {
    return "Error: failed to connect to the server. Check your internet connection / AINA_BASE_URL.";
  }
  return `Execution error: ${error?.message || String(error)}`;
}

export function extractThoughtPreview(text: string, maxChars = 240, maxLines = 3): { visible: string; preview: string } {
  const thoughts: string[] = [];
  let visible = text.replace(/<(thought|think)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, body) => {
    thoughts.push(String(body || '').trim());
    return '';
  });
  visible = visible.replace(/<(thought|think)\b[^>]*>[\s\S]*$/gi, (match) => {
    thoughts.push(match.replace(/^<(thought|think)\b[^>]*>/i, '').trim());
    return '';
  });
  visible = visible.replace(/^[\s\S]*?<\/(thought|think)>/i, '');
  const rawPreview = thoughts.join('\n').replace(/\s+/g, ' ').trim();
  if (!rawPreview) return { visible, preview: '' };
  const limited = rawPreview.length > maxChars ? `${rawPreview.slice(0, Math.max(0, maxChars - 1)).trim()}…` : rawPreview;
  return { visible, preview: limited.split('\n').slice(0, maxLines).join('\n') };
}

function hasUnclosedThoughtTag(text: string): boolean {
  const open = text.search(/<(thought|think)\b[^>]*>/i);
  if (open === -1) return false;
  const close = text.slice(open).search(/<\/(thought|think)>/i);
  return close === -1;
}

function formatThoughtPreview(preview: string): string {
  const lines = preview.split("\n").filter(Boolean);
  const body = lines.length > 0 ? lines : [preview];
  return [
    chalk.cyan.dim("╭─ Thinking Preview"),
    ...body.map((line) => `${chalk.cyan.dim("│")} ${chalk.dim(line)}`),
    chalk.cyan.dim("╰─"),
    "",
  ].join("\n");
}

function insetAssistantOutput(text: string): string {
  const left = "  ";
  const rightMargin = 3;
  const width = Math.max(40, (process.stdout.columns || 100) - left.length - rightMargin);
  const truncateAnsi = (line: string) => {
    let visible = 0;
    let out = "";
    for (let i = 0; i < line.length && visible < width; i++) {
      if (line[i] === "\x1b") {
        const match = line.slice(i).match(/^\x1b\[[0-9;]*m/);
        if (match) {
          out += match[0];
          i += match[0].length - 1;
          continue;
        }
      }
      out += line[i];
      visible++;
    }
    return out + (visible >= width ? chalk.reset("") : "");
  };
  return text.split("\n").map((line) => {
    if (!line.trim()) return "";
    return left + truncateAnsi(line);
  }).join("\n");
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
    const provider = getActiveProvider(loadConfig());
    const prettyModel = getPrettyModelName(this.model);
    const providerModel = provider ? `${provider.name} · ${prettyModel}` : prettyModel;
    const text = `${spinnerChar} ${animatedStatus} ${elapsed} ${chalk.gray("(" + providerModel + ")")}`;

    this.clear();

    const isTyping = this.inputLine.length > 0;
    const leftText = isTyping
      ? "enter to queue · esc to interrupt"
      : "type to queue a message · esc to interrupt";
    const right = footerRight(providerModel);
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
    console.log(`${text.startsWith("\n") ? "" : "\n"}${text}`);
    this.draw();
  }
}

export class AinaAgent {
  private openai: OpenAI;
  private model: string;
  private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private lastChoices: { question: string; options: string[] } | null = null;
  private lastPlan: string | null = null;
  // Statistik pemakaian sesi (untuk /usage & /status). Gateway modern memberi
  // prompt/completion; sebagian gateway lama hanya memberi total.
  private sessionTokens = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private turnCount = 0;
  private requestGeneration = 0;
  private readonly toolResultGenerations = new WeakMap<object, number>();
  private readonly toolResultSummaries = new WeakMap<object, string>();
  private readonly readFileCache = new Map<string, string>();
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

  changeClient(openai: OpenAI): void {
    this.openai = openai;
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
    this.requestGeneration = 0;
    this.readFileCache.clear();
  }

  // Riwayat percakapan saat ini (untuk persistensi sesi).
  getHistory(): OpenAI.Chat.ChatCompletionMessageParam[] {
    return this.messages;
  }

  getSanitizedHistory(): OpenAI.Chat.ChatCompletionMessageParam[] {
    return locallyCompactHistoryForSerialization(this.messages);
  }

  // Pulihkan riwayat percakapan dari sesi tersimpan (slash /resume).
  restoreHistory(messages: OpenAI.Chat.ChatCompletionMessageParam[]): void {
    this.messages = messages;
    this.lastChoices = null;
    this.lastPlan = null;
    this.requestGeneration = 0;
    this.readFileCache.clear();
  }

  private requestToolPolicy(toolsNeeded = true): RequestToolPolicy {
    return chooseRequestToolPolicy({ planMode: isPlanMode(), toolsNeeded });
  }

  private evictStaleToolResults(): void {
    for (const message of this.messages) {
      const anyMessage = message as any;
      if (anyMessage.role !== "tool") continue;
      const generation = this.toolResultGenerations.get(message as object);
      if (generation === undefined) continue;
      if (this.requestGeneration - generation < TOOL_RESULT_EVICT_AFTER_REQUESTS) {
        continue;
      }
      const summary = this.toolResultSummaries.get(message as object);
      if (summary && anyMessage.content !== summary) {
        anyMessage.content = summary;
      }
    }
  }

  private readFileCacheKey(args: any): string {
    const rawPath = String(args?.path ?? "");
    const resolved = rawPath ? path.resolve(rawPath) : rawPath;
    return JSON.stringify({
      path: resolved,
      offset: args?.offset ?? null,
      limit: args?.limit ?? null,
    });
  }

  private invalidateReadFileCacheForMutation(name: string, args: any): void {
    if (!["write_file", "edit_file", "multi_edit", "delete_file", "move_file"].includes(name)) {
      return;
    }
    this.readFileCache.clear();
  }

  // Statistik pemakaian sesi + estimasi ukuran konteks saat ini (slash /usage,
  // /status). `budget` adalah ambang yang memicu kompaksi otomatis.
  getUsage(): {
    sessionTokens: number;
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number | null;
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
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      estimatedCostUsd: estimateUsageCostUsd(this.model, this.promptTokens, this.completionTokens),
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

  compactLocal(): { before: number; after: number } {
    const before = estimateHistoryTokens(this.messages);
    this.messages = locallyCompactHistoryForSerialization(this.messages);
    return { before, after: estimateHistoryTokens(this.messages) };
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
    this.messages = sanitizeActiveHistory(this.messages);

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
    // Tokens used across all completions in this run (for summary & /usage).
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
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
      this.evictStaleToolResults();

      try {
        const requestPolicy = this.requestToolPolicy(true);
        const stream = await this.openai.chat.completions.create(
          {
            model: this.model,
            messages: this.buildRequestMessages(),
            ...(requestPolicy as any),
            max_tokens: MAX_COMPLETION_TOKENS,
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
        let printedThoughtPreview = false;

        const beginStream = () => {
          streamingNow = true;
        };

        let lastFlushAt = Date.now();

        // Render `raw` as markdown and append it to scrollback. spinner.log() clears
        // the status bar, prints, then redraws the bar — safe at any height.
        const printBlock = (raw: string) => {
          const extracted = extractThoughtPreview(raw);
          if (extracted.preview && !printedThoughtPreview) {
            spinner.log(formatThoughtPreview(extracted.preview));
            printedThoughtPreview = true;
          }
          if (!extracted.visible.trim()) return;
          const rendered = renderMarkdown(extracted.visible);
          if (!rendered) return;
          const output = insetAssistantOutput(rendered);
          spinner.log(printedAny ? `\n${output}` : output);
          printedAny = true;
        };

        // Flush every complete block at the front of the unprinted region, leaving
        // the trailing in-progress block buffered.
        const flushBlocks = (force = false) => {
          while (true) {
            const pending = contentBuf.slice(flushedLen);
            const stale = Date.now() - lastFlushAt >= STREAM_FALLBACK_FLUSH_MS;
            const cut = findFlushBoundary(pending, force, STREAM_FALLBACK_FLUSH_CHARS, stale);
            if (cut === -1) break;
            if (!force && hasUnclosedThoughtTag(pending.slice(0, cut))) break;
            printBlock(pending.slice(0, cut));
            // Consume the run of newlines separating this block from the next.
            let sep = cut;
            if (sep < pending.length && pending[sep] === " ") sep++;
            while (contentBuf[flushedLen + sep] === "\n") sep++;
            flushedLen += sep;
            lastFlushAt = Date.now();
          }
        };

        for await (const chunk of stream as any) {
          if (cancelled) break;
          if (chunk?.usage) {
            const usage = normalizeUsageDelta(chunk.usage);
            promptTokens += usage.promptTokens;
            completionTokens += usage.completionTokens;
            totalTokens += usage.totalTokens;
          }
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
        this.requestGeneration++;

        // Catch any block that completed right at the end of the stream.
        flushBlocks(true);
        streamingNow = false;
        acceptTyping = true;

        if (cancelled) {
          // Loop top logs the cancellation via spinner.log(), which clears the bar.
          continue; // loop top logs the cancellation and breaks
        }

        const toolCalls = toolCallsAcc.filter(Boolean);
        const extractedContent = extractThoughtPreview(contentBuf);
        const assistantMessage: any = {
          role: "assistant",
          content: extractedContent.visible || null,
        };
        if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
        this.messages.push(assistantMessage);

        // `tail` is the final, still-unprinted block (everything after the last
        // completed block). The earlier blocks already streamed to the screen.
        const tail = contentBuf.slice(flushedLen);
        if (contentBuf) {
          // In plan mode the numbered steps of the plan must not be turned into a
          // selection menu — the plan-decision menu (REPL) handles next steps.
          const parsed = isPlanMode() ? null : parseChoices(extractedContent.visible);
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
            if (name === "read_file" && !result.startsWith("Error")) {
              const cacheKey = this.readFileCacheKey(args);
              const previousSummary = this.readFileCache.get(cacheKey);
              if (previousSummary) {
                result = `[read_file: ${args.path} — duplicate read omitted; refer to earlier result: ${previousSummary}]`;
              } else {
                this.readFileCache.set(cacheKey, summarizeToolResult(name, args, result));
              }
            }
            result = capToolResult(name, args, result);

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
              this.invalidateReadFileCacheForMutation(name, args);
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

            const toolMessage = {
              role: "tool",
              tool_call_id: toolCall.id,
              content: result,
            } as OpenAI.Chat.ChatCompletionToolMessageParam;
            this.messages.push(toolMessage);
            this.toolResultGenerations.set(toolMessage as object, this.requestGeneration);
            this.toolResultSummaries.set(
              toolMessage as object,
              summarizeToolResult(name, args, result),
            );
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
                this.messages = this.messages.filter((m: any) =>
                  !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(VALIDATION_PREFIX)),
                );
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
        this.messages = sanitizeActiveHistory(this.messages);
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
    this.promptTokens += promptTokens;
    this.completionTokens += completionTokens;
    if (!cancelled) {
      const tokenStr =
        totalTokens > 0 ? ` · ${formatTokens(totalTokens)} token` : "";
      console.log(chalk.gray(`\n${doneWord} in ${elapsed}${tokenStr}`));
    }

    // Gap between the process output and the next prompt input below.
    console.log();

    // If the task was cancelled, drop anything queued during it.
    return cancelled ? [] : queuedInputs;
  }
}
