import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";

// Configure marked once to use the terminal renderer (ANSI colors, tables, etc.)
// markedTerminal is a synchronous extension, so marked.parse() returns a string.
let configured = false;
function ensureConfigured() {
  if (configured) return;
  marked.use(markedTerminal({
    heading(text: string, level: number) {
      const clean = stripEmoji(String(text)).trim();
      if (level === 1) return `\n${chalk.bold.cyan(clean)}\n`;
      if (level === 2) return `\n${chalk.bold.white(clean)}\n`;
      return `\n${chalk.bold(clean)}\n`;
    },
    listitem(text: string) {
      return `- ${String(text).trim()}\n`;
    },
  } as any) as any);
  configured = true;
}

export function stripEmoji(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F/gu, "")
    .replace(/[ \t]{2,}/g, " ");
}

/**
 * Render a markdown string into ANSI-colored text suitable for the terminal.
 * Falls back to the raw text if rendering fails for any reason.
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  try {
    ensureConfigured();
    const out = marked.parse(stripEmoji(text)) as string;
    if (typeof out !== "string") return text;
    // marked-terminal adds generous vertical spacing; collapse big gaps and
    // trim leading/trailing blank lines for a tidy, compact terminal output.
    return out
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*\*\s+-\s+/gm, "- ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
  } catch {
    return text;
  }
}
