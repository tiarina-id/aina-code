import chalk from "chalk";
import path from "node:path";

interface DiffLine {
  type: "ctx" | "add" | "del";
  text: string;
  oldNo?: number;
  newNo?: number;
}

// Line-based LCS diff between two texts.
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const n = a.length;
  const m = b.length;

  // LCS length table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i], oldNo: oldNo++ });
      i++;
    } else {
      out.push({ type: "add", text: b[j], newNo: newNo++ });
      j++;
    }
  }
  while (i < n) (out.push({ type: "del", text: a[i], oldNo: oldNo++ }), i++);
  while (j < m) (out.push({ type: "add", text: b[j], newNo: newNo++ }), j++);
  return out;
}

function prettyRelPath(filePath: string): string {
  try {
    const rel = path.relative(process.cwd(), path.resolve(filePath));
    if (rel && !rel.startsWith("..")) return rel;
  } catch {}
  return filePath;
}

const CONTEXT = 3; // context lines around each change
const MAX_LINES = 40; // cap on printed diff lines
const LEFT_MARGIN = "  ";
const RIGHT_MARGIN = 3;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function expandTabs(text: string): string {
  return text.replace(/\t/g, "  ");
}

function padAnsiLine(text: string, width: number): string {
  const plainLength = stripAnsi(text).length;
  return text + " ".repeat(Math.max(0, width - plainLength));
}

type StyleName = "normal" | "keyword" | "string" | "comment" | "number" | "dim";
interface CodeToken { text: string; style: StyleName }

const tokenPattern = /(\/\/.*$|#.*$)|(`[^`]*`|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')|\b(function|func|const|let|var|return|if|else|for|range|package|import|type|struct|interface|go|defer|switch|case|default|map|string|int|bool|error)\b|\b\d+(?:\.\d+)?\b/g;

function tokenizeCode(text: string): CodeToken[] {
  const expanded = expandTabs(text);
  const tokens: CodeToken[] = [];
  let last = 0;
  for (const match of expanded.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ text: expanded.slice(last, index), style: "normal" });
    const value = match[0];
    const style: StyleName = match[1] ? "comment" : match[2] ? "string" : match[3] ? "keyword" : "number";
    tokens.push({ text: value, style });
    last = index + value.length;
  }
  if (last < expanded.length) tokens.push({ text: expanded.slice(last), style: "normal" });
  return tokens;
}

function applyFg(text: string, style: StyleName): string {
  if (style === "keyword") return chalk.cyan(text);
  if (style === "string") return chalk.hex("#d19a66")(text);
  if (style === "comment") return chalk.green.dim(text);
  if (style === "number") return chalk.cyanBright(text);
  if (style === "dim") return chalk.dim(text);
  return text;
}

function renderTokens(tokens: CodeToken[], background?: (s: string) => string, dimAll = false): string {
  return tokens.map((token) => {
    const fg = applyFg(token.text, dimAll && token.style === "normal" ? "dim" : token.style);
    return background ? background(fg) : fg;
  }).join("");
}

function highlightCode(text: string): string {
  return renderTokens(tokenizeCode(text));
}

function blockRow(numStr: string, sign: string, text: string, color: "add" | "del"): string {
  const width = Math.max(40, (process.stdout.columns || 100) - RIGHT_MARGIN);
  const bg = color === "add" ? chalk.bgHex("#123524") : chalk.bgHex("#3a1c1c");
  const signColor = color === "add" ? chalk.green : chalk.red;
  const prefix = `${numStr} ${signColor(sign)} `;
  const tokens = tokenizeCode(text);
  const plainLength = stripAnsi(prefix).length + tokens.reduce((sum, token) => sum + token.text.length, 0);
  const padding = " ".repeat(Math.max(0, width - LEFT_MARGIN.length - plainLength));
  return LEFT_MARGIN + bg(prefix) + renderTokens(tokens, bg, color === "del") + bg(padding);
}

/**
 * Render a Claude-Code-style file diff:
 *   Update(path)
 *     ⎿ Added 4 lines, Removed 1 line
 *      390        }
 *      393 +      const submitted = ...
 */
export function renderDiff(
  verb: string,
  filePath: string,
  oldText: string,
  newText: string,
): string {
  const header = chalk.bold(`${verb}(${prettyRelPath(filePath)})`);
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");

  // Guard against pathologically large diffs (LCS table is O(n*m))
  if (a.length + b.length > 4000) {
    return `${header}\n  ${chalk.gray(`⎿ Updated (${b.length} lines)`)}`;
  }

  const diff = diffLines(oldText, newText);
  const added = diff.filter((d) => d.type === "add").length;
  const removed = diff.filter((d) => d.type === "del").length;

  const summaryParts: string[] = [];
  if (added) summaryParts.push(`Added ${added} line${added !== 1 ? "s" : ""}`);
  if (removed)
    summaryParts.push(`Removed ${removed} line${removed !== 1 ? "s" : ""}`);
  const summary = summaryParts.length ? summaryParts.join(", ") : "No changes";

  const out: string[] = [LEFT_MARGIN + header, LEFT_MARGIN + "  " + chalk.gray(`⎿ ${summary}`)];
  if (!added && !removed) return out.join("\n");

  // Mark which lines to show (changes + surrounding context)
  const show = new Array(diff.length).fill(false);
  diff.forEach((d, idx) => {
    if (d.type !== "ctx") {
      for (
        let k = Math.max(0, idx - CONTEXT);
        k <= Math.min(diff.length - 1, idx + CONTEXT);
        k++
      ) {
        show[k] = true;
      }
    }
  });

  let shown = 0;
  let lastIdx = -2;
  for (let idx = 0; idx < diff.length; idx++) {
    if (!show[idx]) continue;
    if (shown >= MAX_LINES) {
      out.push(LEFT_MARGIN + "       " + chalk.gray("... (truncated)"));
      break;
    }
    if (lastIdx >= 0 && idx - lastIdx > 1) {
      out.push(LEFT_MARGIN + "       " + chalk.gray("⋮"));
    }
    const d = diff[idx];
    const no = d.type === "del" ? d.oldNo : d.newNo;
    const numStr = chalk.gray(String(no ?? "").padStart(5));
    if (d.type === "add") {
      out.push(blockRow(numStr, "+", d.text, "add"));
    } else if (d.type === "del") {
      out.push(blockRow(numStr, "-", d.text, "del"));
    } else {
      out.push(`${LEFT_MARGIN}${numStr} ${chalk.gray(" │ ")} ${chalk.gray(highlightCode(d.text))}`);
    }
    shown++;
    lastIdx = idx;
  }
  return out.join("\n");
}
