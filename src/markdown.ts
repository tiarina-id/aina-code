import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// Configure marked once to use the terminal renderer (ANSI colors, tables, etc.)
// markedTerminal is a synchronous extension, so marked.parse() returns a string.
let configured = false;
function ensureConfigured() {
  if (configured) return;
  marked.use(markedTerminal() as any);
  configured = true;
}

/**
 * Render a markdown string into ANSI-colored text suitable for the terminal.
 * Falls back to the raw text if rendering fails for any reason.
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  try {
    ensureConfigured();
    const out = marked.parse(text) as string;
    if (typeof out !== "string") return text;
    // marked-terminal adds generous vertical spacing; collapse big gaps and
    // trim leading/trailing blank lines for a tidy, compact terminal output.
    return out
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
  } catch {
    return text;
  }
}
