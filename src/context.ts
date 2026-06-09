import fs from 'node:fs';
import path from 'node:path';

// File instruksi proyek yang dicari di cwd, sesuai urutan prioritas. File pertama
// yang ditemukan dipakai sebagai konteks proyek dan disisipkan ke system prompt.
const CONTEXT_FILES = ['AINA.md', 'CLAUDE.md', 'AGENT.md'];

// Batas ukuran agar file instruksi yang sangat besar tidak menghabiskan context
// window. Selaras dengan cap baca file lain di tools.ts.
const MAX_CONTEXT_BYTES = 32 * 1024;

export interface ProjectContext {
  fileName: string;
  content: string;
}

// Cari & baca file instruksi proyek pertama yang ada di `cwd`. Mengembalikan
// null bila tidak ada satupun. Output di-truncate bila melebihi MAX_CONTEXT_BYTES.
export function loadProjectContext(cwd: string = process.cwd()): ProjectContext | null {
  for (const fileName of CONTEXT_FILES) {
    const full = path.join(cwd, fileName);
    try {
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
      let content = fs.readFileSync(full, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > MAX_CONTEXT_BYTES) {
        content = content.slice(0, MAX_CONTEXT_BYTES) + '\n... (project context truncated)';
      }
      if (!content.trim()) continue;
      return { fileName, content };
    } catch {
      // File tak terbaca → coba kandidat berikutnya.
    }
  }
  return null;
}

// Bungkus isi file konteks sebagai blok yang siap disisipkan ke system prompt.
export function formatProjectContext(ctx: ProjectContext): string {
  return `--- Project Context (${ctx.fileName}) ---
Below are the project's instructions & conventions from ${ctx.fileName} in the working directory. Follow these instructions where relevant.

${ctx.content}
--- End Project Context ---`;
}
