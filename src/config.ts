import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  // Jalankan typecheck/lint otomatis setelah perubahan file (default true).
  autoValidate: boolean;
  // Override perintah validasi; bila kosong, dideteksi otomatis.
  validateCommand?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.ainacode');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function loadConfig(): Config {
  let fileConfig: Partial<Config> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      fileConfig = JSON.parse(data);
    }
  } catch (e) {
    // Ignore config read errors, fallback to env
  }

  const apiKey = process.env.AINA_API_KEY || fileConfig.apiKey || '';
  const baseUrl = process.env.AINA_BASE_URL || fileConfig.baseUrl || 'https://api.tiarina.id/v1';
  const model = process.env.AINA_MODEL || fileConfig.model || 'aina-1-flash';

  // autoValidate: default true; bisa dimatikan via env "false"/"0" atau config file.
  const envValidate = process.env.AINA_AUTO_VALIDATE;
  const autoValidate = envValidate !== undefined
    ? !(envValidate === 'false' || envValidate === '0')
    : fileConfig.autoValidate !== false;
  const validateCommand = process.env.AINA_VALIDATE_CMD || fileConfig.validateCommand || undefined;

  return { apiKey, baseUrl, model, autoValidate, validateCommand };
}

export function saveConfig(config: Partial<Config>): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    let existing: Partial<Config> = {};
    if (fs.existsSync(CONFIG_FILE)) {
      existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
    const updated = { ...existing, ...config };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

// Nama tampilan untuk model yang dikenal. Sumber kebenaran untuk getPrettyModelName
// dan validasi /model.
const MODEL_LABELS: Record<string, string> = {
  'aina-1-flash': 'Aina 1 Flash',
  'aina-1-mini': 'Aina 1 Mini',
  'aina-1-pro': 'Aina 1 Pro',
  'aina-1-ultra': 'Aina 1 Ultra'
};

export const KNOWN_MODELS = Object.keys(MODEL_LABELS);

export function isKnownModel(model: string): boolean {
  return model.toLowerCase() in MODEL_LABELS;
}

export function getPrettyModelName(model: string): string {
  return MODEL_LABELS[model.toLowerCase()] || model;
}
