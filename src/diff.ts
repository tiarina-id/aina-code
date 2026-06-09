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

  const out: string[] = [header, "  " + chalk.gray(`⎿ ${summary}`)];
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
      out.push("       " + chalk.gray("... (truncated)"));
      break;
    }
    if (lastIdx >= 0 && idx - lastIdx > 1) {
      out.push("       " + chalk.gray("⋮"));
    }
    const d = diff[idx];
    const no = d.type === "del" ? d.oldNo : d.newNo;
    const numStr = chalk.gray(String(no ?? "").padStart(5));
    if (d.type === "add") {
      out.push(`${numStr} ${chalk.green("+")} ${chalk.green(d.text)}`);
    } else if (d.type === "del") {
      out.push(`${numStr} ${chalk.red("-")} ${chalk.red(d.text)}`);
    } else {
      out.push(`${numStr}   ${chalk.gray(d.text)}`);
    }
    shown++;
    lastIdx = idx;
  }
  return out.join("\n");
}
