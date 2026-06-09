import chalk from 'chalk';

// Operating mode for the agent. A single shared state used by tools.ts (enforcement),
// agent.ts (system directive + plan capture), prompt.ts/index.ts (UI & toggles).
//   default → minta konfirmasi sebelum mengubah / menjalankan
//   plan    → read-only penuh: hanya menyelidiki & menyusun rencana
//   auto    → auto-approve: ubah/jalankan tanpa konfirmasi (kecuali di luar cwd)
export type AgentMode = 'default' | 'plan' | 'auto';

let current: AgentMode = 'default';

export function getMode(): AgentMode {
  return current;
}

export function setMode(mode: AgentMode): void {
  current = mode;
}

export function isPlanMode(): boolean {
  return current === 'plan';
}

export function isAutoMode(): boolean {
  return current === 'auto';
}

// Cycle order requested by the user: Default → Plan → Auto → Default.
export function cycleMode(): AgentMode {
  current = current === 'default' ? 'plan' : current === 'plan' ? 'auto' : 'default';
  return current;
}

const LABELS: Record<AgentMode, string> = {
  default: 'Default',
  plan: 'Plan',
  auto: 'Auto-approve'
};

export function getModeLabel(mode: AgentMode = current): string {
  return LABELS[mode];
}

// Colored mode chip used in the bottom-right of footers. Intentionally avoids
// wide emoji: the footer is padded to the exact terminal width, so any glyph
// that renders wider than its string length would overflow and wrap, stacking
// an extra line on every redraw. Color alone distinguishes the modes.
export function modeChip(mode: AgentMode = current): string {
  const label = LABELS[mode];
  if (mode === 'plan') return chalk.cyan(label);
  if (mode === 'auto') return chalk.yellow(label);
  return chalk.gray(label);
}

// Build the right-hand side of a footer: "<mode> · <model>".
// `raw` (no ANSI, no wide glyphs) is used to compute padding; its plain text is
// identical in width to `colored`, so the footer never exceeds the terminal width.
export function footerRight(prettyModel: string): { raw: string; colored: string } {
  const label = getModeLabel();
  const raw = `${label} · ${prettyModel}`;
  const colored = `${modeChip()} ${chalk.gray(`· ${prettyModel}`)}`;
  return { raw, colored };
}
