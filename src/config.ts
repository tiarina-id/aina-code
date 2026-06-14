import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

export type ProviderKind = 'tiarina' | 'openai' | 'openrouter' | 'custom';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  modelsCache?: string[];
  modelsFetchedAt?: string;
}

export interface Config {
  activeProviderId?: string;
  activeModel?: string;
  providers: ProviderConfig[];
  autoValidate: boolean;
  validateCommand?: string;
}

export interface EffectiveProviderConfig {
  provider: ProviderConfig;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface ProviderModelOverview {
  provider: ProviderConfig;
  models: string[];
  hiddenModelCount: number;
}

export type ModelTreeItem =
  | { type: 'provider'; provider: ProviderConfig }
  | { type: 'model'; provider: ProviderConfig; model: string }
  | { type: 'more-models'; provider: ProviderConfig; hiddenCount: number }
  | { type: 'more-providers'; hiddenCount: number };

export const CONFIG_DIR = path.join(os.homedir(), '.ainacode');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const PROVIDER_PRESETS: Record<Exclude<ProviderKind, 'custom'>, Omit<ProviderConfig, 'apiKey'>> = {
  tiarina: {
    id: 'tiarina',
    name: 'Tiarina API',
    kind: 'tiarina',
    baseUrl: 'https://api.tiarina.id/v1',
    defaultModel: 'aina-1-flash',
    modelsCache: ['aina-1-flash', 'aina-1-mini'],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.5',
    modelsCache: ['gpt-5.5'],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.5',
    modelsCache: ['openai/gpt-5.5'],
  },
};

export const MAX_MODEL_MENU_ITEMS = 10;
export const MAX_MODEL_OVERVIEW_PROVIDERS = 5;
export const MAX_MODEL_OVERVIEW_MODELS = 4;
export const MODEL_TREE_PROVIDER_LIMIT = 2;
export const MODEL_TREE_MODEL_LIMIT = 3;

export const OPENROUTER_CURATED_MODELS = [
  'openai/gpt-5.5',
  'openai/gpt-5.5-mini',
  'anthropic/claude-sonnet-4.5',
  'google/gemini-2.5-pro',
  'deepseek/deepseek-chat',
];

export function createPresetProvider(kind: Exclude<ProviderKind, 'custom'>, apiKey = ''): ProviderConfig {
  return { ...PROVIDER_PRESETS[kind], apiKey };
}

export function loadConfig(): Config {
  let fileConfig: Partial<Config> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}

  const envValidate = process.env.AINA_AUTO_VALIDATE;
  const autoValidate = envValidate !== undefined
    ? !(envValidate === 'false' || envValidate === '0')
    : fileConfig.autoValidate !== false;

  let providers = Array.isArray(fileConfig.providers) ? fileConfig.providers : [];
  const activeProviderId = process.env.AINA_PROVIDER || fileConfig.activeProviderId;
  if (process.env.AINA_API_KEY && activeProviderId && !providers.some((p) => p.id === activeProviderId)) {
    if (activeProviderId === 'openai' || activeProviderId === 'openrouter' || activeProviderId === 'tiarina') {
      providers = [...providers, createPresetProvider(activeProviderId, process.env.AINA_API_KEY)];
    } else if (process.env.AINA_BASE_URL) {
      providers = [...providers, {
        id: activeProviderId,
        name: activeProviderId,
        kind: 'custom',
        baseUrl: process.env.AINA_BASE_URL,
        apiKey: process.env.AINA_API_KEY,
        defaultModel: process.env.AINA_MODEL,
        modelsCache: process.env.AINA_MODEL ? [process.env.AINA_MODEL] : [],
      }];
    }
  }
  const activeModel = process.env.AINA_MODEL || fileConfig.activeModel;
  const validateCommand = process.env.AINA_VALIDATE_CMD || fileConfig.validateCommand || undefined;

  return { activeProviderId, activeModel, providers, autoValidate, validateCommand };
}

export function saveConfig(config: Partial<Config>): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    let existing: Partial<Config> = {};
    if (fs.existsSync(CONFIG_FILE)) existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const updated = { ...existing, ...config };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

export function upsertProvider(provider: ProviderConfig, activate = true): Config {
  const config = loadConfig();
  const providers = config.providers.filter((p) => p.id !== provider.id);
  providers.push(provider);
  const updated = { ...config, providers, activeProviderId: activate ? provider.id : config.activeProviderId };
  saveConfig(updated);
  return updated;
}

export function getActiveProvider(config = loadConfig()): ProviderConfig | undefined {
  const id = process.env.AINA_PROVIDER || config.activeProviderId;
  if (!id) return undefined;
  const provider = config.providers.find((p) => p.id === id);
  if (!provider) return undefined;
  return {
    ...provider,
    apiKey: process.env.AINA_API_KEY || provider.apiKey,
    baseUrl: process.env.AINA_BASE_URL || provider.baseUrl,
  };
}

export function getEffectiveConfig(config = loadConfig()): EffectiveProviderConfig | undefined {
  const provider = getActiveProvider(config);
  if (!provider || !provider.apiKey) return undefined;
  const model = process.env.AINA_MODEL || config.activeModel || provider.modelsCache?.[0] || provider.defaultModel || '';
  if (!model) return undefined;
  return { provider, apiKey: provider.apiKey, baseUrl: provider.baseUrl, model };
}

export function saveActiveModel(model: string, providerId?: string): void {
  const config = loadConfig();
  saveConfig({ ...config, activeModel: model, activeProviderId: providerId || config.activeProviderId });
}

const MODEL_LABELS: Record<string, string> = {
  'aina-1-flash': 'Aina 1 Flash',
  'aina-1-mini': 'Aina 1 Mini',
  'aina-1-pro': 'Aina 1 Pro',
  'aina-1-ultra': 'Aina 1 Ultra',
  'gpt-5.5': 'GPT 5.5',
  'openai/gpt-5.5': 'GPT 5.5',
};

export const KNOWN_MODELS = Object.keys(MODEL_LABELS);

export function isKnownModel(model: string): boolean {
  return model.toLowerCase() in MODEL_LABELS;
}

export function getPrettyModelName(model: string): string {
  return MODEL_LABELS[model.toLowerCase()] || model;
}

export function getProviderModelLabel(provider: ProviderConfig, model: string): string {
  return `${provider.name} - ${getPrettyModelName(model)}`;
}

export function getCuratedModels(provider: ProviderConfig): string[] {
  const candidates = provider.kind === 'openrouter'
    ? OPENROUTER_CURATED_MODELS
    : provider.defaultModel
      ? [provider.defaultModel, ...(provider.modelsCache || [])]
      : provider.modelsCache || [];
  return [...new Set(candidates)].slice(0, MAX_MODEL_MENU_ITEMS);
}

export function getDefaultModelForProvider(provider: ProviderConfig): string {
  return provider.modelsCache?.[0] || provider.defaultModel || filterModelOptions(provider)[0]?.id || '';
}

export function filterModelOptions(provider: ProviderConfig, query = '', limit = MAX_MODEL_MENU_ITEMS): ModelOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const cached = provider.modelsCache || [];
  const source = normalizedQuery ? cached : getCuratedModels(provider);
  const matches = source.filter((model) => {
    if (!normalizedQuery) return true;
    return model.toLowerCase().includes(normalizedQuery) || getPrettyModelName(model).toLowerCase().includes(normalizedQuery);
  });
  return [...new Set(matches)].slice(0, limit).map((id) => ({ id, label: getPrettyModelName(id) }));
}

export function countModelMatches(provider: ProviderConfig, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return getCuratedModels(provider).length;
  return (provider.modelsCache || []).filter((model) =>
    model.toLowerCase().includes(normalizedQuery) || getPrettyModelName(model).toLowerCase().includes(normalizedQuery)
  ).length;
}

export function orderProvidersForModelPicker(providers: ProviderConfig[]): ProviderConfig[] {
  const order = ['tiarina', 'openai', 'openrouter'];
  return [...providers].sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
    return 0;
  });
}

export function getProviderModelOverviews(
  providers: ProviderConfig[],
  providerLimit = MAX_MODEL_OVERVIEW_PROVIDERS,
  modelLimit = MAX_MODEL_OVERVIEW_MODELS,
): { overviews: ProviderModelOverview[]; hiddenProviderCount: number } {
  const readyProviders = orderProvidersForModelPicker(providers).filter((provider) => provider.apiKey && (provider.modelsCache?.length || provider.defaultModel));
  const visibleProviders = readyProviders.slice(0, providerLimit);
  return {
    overviews: visibleProviders.map((provider) => {
      const models = [...new Set(provider.modelsCache?.length ? provider.modelsCache : getCuratedModels(provider))];
      return {
        provider,
        models: models.slice(0, modelLimit),
        hiddenModelCount: Math.max(0, models.length - modelLimit),
      };
    }),
    hiddenProviderCount: Math.max(0, readyProviders.length - providerLimit),
  };
}

export function buildModelTreeItems(
  providers: ProviderConfig[],
  query = '',
  providerLimit = MODEL_TREE_PROVIDER_LIMIT,
  modelLimit = MODEL_TREE_MODEL_LIMIT,
): ModelTreeItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  const readyProviders = orderProvidersForModelPicker(providers).filter((provider) => provider.apiKey && provider.modelsCache?.length);
  const matching = readyProviders
    .map((provider) => {
      const models = (provider.modelsCache || []).filter((model) => {
        if (!normalizedQuery) return true;
        return model.toLowerCase().includes(normalizedQuery) || getPrettyModelName(model).toLowerCase().includes(normalizedQuery);
      });
      return { provider, models };
    })
    .filter((entry) => entry.models.length > 0);

  const visible = matching.slice(0, providerLimit);
  const items: ModelTreeItem[] = [];
  for (const entry of visible) {
    items.push({ type: 'provider', provider: entry.provider });
    for (const model of entry.models.slice(0, modelLimit)) {
      items.push({ type: 'model', provider: entry.provider, model });
    }
    const hiddenModelCount = Math.max(0, entry.models.length - modelLimit);
    if (hiddenModelCount > 0) items.push({ type: 'more-models', provider: entry.provider, hiddenCount: hiddenModelCount });
  }
  const hiddenProviderCount = Math.max(0, matching.length - providerLimit);
  if (hiddenProviderCount > 0) items.push({ type: 'more-providers', hiddenCount: hiddenProviderCount });
  return items;
}
