import fs from 'node:fs';
import path from 'node:path';

// Matcher mengembalikan true bila path (relatif terhadap root, separator '/')
// harus DIABAIKAN. Dipakai oleh grep_search, find_files, dan file-picker agar
// tidak menyusuri build artifacts / file ber-secret (mis. .env) yang di-gitignore.
export type IgnoreMatcher = (relPath: string, isDir: boolean) => boolean;

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

// Direktori yang selalu diabaikan walau tak tercantum di .gitignore.
const ALWAYS_IGNORE = ['.git', 'node_modules', 'dist'];

// Ubah satu baris pola gitignore menjadi RegExp yang diuji terhadap relPath.
function compileRule(raw: string): Rule | null {
  let pattern = raw.trim();
  if (!pattern || pattern.startsWith('#')) return null;

  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  }

  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }

  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);
  if (!pattern) return null;

  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }

  // Pola tanpa slash (dan tak ter-anchor) cocok pada basename di kedalaman mana pun.
  if (!anchored && !pattern.includes('/')) {
    return { re: new RegExp(`(?:^|/)${re}(?:/|$)`), negate, dirOnly };
  }
  return { re: new RegExp(`^${re}(?:/|$)`), negate, dirOnly };
}

// Baca .gitignore di root (jika ada) dan bangun matcher. Selalu sertakan
// ALWAYS_IGNORE sebagai baseline sehingga tetap aman tanpa .gitignore.
export function loadIgnore(root: string = process.cwd()): IgnoreMatcher {
  const rules: Rule[] = [];

  try {
    const gi = path.join(root, '.gitignore');
    if (fs.existsSync(gi) && fs.statSync(gi).isFile()) {
      const lines = fs.readFileSync(gi, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const rule = compileRule(line);
        if (rule) rules.push(rule);
      }
    }
  } catch {
    // .gitignore tak terbaca → cukup pakai baseline.
  }

  const alwaysSet = new Set(ALWAYS_IGNORE);

  return (relPath: string, isDir: boolean): boolean => {
    const normalized = relPath.replace(/\\/g, '/');
    const base = normalized.split('/').pop() || normalized;
    if (alwaysSet.has(base)) return true;

    // Aturan belakangan menang (mendukung negasi !pola).
    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(normalized)) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  };
}
