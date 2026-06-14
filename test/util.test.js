import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  MAX_MODEL_MENU_ITEMS,
  buildModelTreeItems,
  getProviderModelOverviews,
  createPresetProvider,
  filterModelOptions,
  getDefaultModelForProvider,
  getProviderModelLabel,
  getPrettyModelName,
} from '../dist/config.js';
import { loadProjectContext, formatProjectContext } from '../dist/context.js';
import { globToRegExp } from '../dist/tools.js';
import {
  AinaAgent,
  chooseRequestToolPolicy,
  compactAttachedFilesContent,
  estimateUsageCostUsd,
  findFlushBoundary,
  friendlyError,
  locallyCompactHistoryForSerialization,
  normalizeUsageDelta,
  parseChoices,
  sanitizeActiveHistory,
  sanitizeHistoryForSave,
  extractThoughtPreview,
} from '../dist/agent.js';
import { diffLines, renderDiff } from '../dist/diff.js';
import { getMode, setMode, cycleMode, getModeLabel, footerRight } from '../dist/mode.js';
import { renderMarkdown } from '../dist/markdown.js';
import { fallbackTitle } from '../dist/session.js';

const TMP = path.resolve('.aina-util-test-tmp');

test.after(() => {
  setMode('default');
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('getPrettyModelName: maps known ids and falls back to input', () => {
  assert.equal(getPrettyModelName('aina-1-pro'), 'Aina 1 Pro');
  assert.equal(getPrettyModelName('AINA-1-FLASH'), 'Aina 1 Flash');
  assert.equal(getPrettyModelName('something-else'), 'something-else');
});

test('provider presets: Tiarina recommended defaults and provider model label', () => {
  const provider = createPresetProvider('tiarina', 'test-key');
  assert.equal(provider.name, 'Tiarina API');
  assert.equal(provider.baseUrl, 'https://api.tiarina.id/v1');
  assert.equal(provider.defaultModel, 'aina-1-flash');
  assert.deepEqual(provider.modelsCache, ['aina-1-flash', 'aina-1-mini']);
  assert.equal(getProviderModelLabel(provider, 'aina-1-flash'), 'Tiarina API - Aina 1 Flash');
});

test('provider presets: OpenAI and OpenRouter need only API keys', () => {
  const openai = createPresetProvider('openai', 'openai-key');
  const openrouter = createPresetProvider('openrouter', 'openrouter-key');
  assert.equal(openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(openai.apiKey, 'openai-key');
  assert.equal(openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(openrouter.apiKey, 'openrouter-key');
});

test('filterModelOptions: empty query shows curated OpenRouter list only', () => {
  const provider = createPresetProvider('openrouter', 'key');
  provider.modelsCache = Array.from({ length: 50 }, (_, i) => `provider/model-${i}`);
  const options = filterModelOptions(provider);
  assert.ok(options.length <= MAX_MODEL_MENU_ITEMS);
  assert.equal(options[0].id, 'openai/gpt-5.5');
});

test('filterModelOptions: query searches cache and limits results', () => {
  const provider = createPresetProvider('openrouter', 'key');
  provider.modelsCache = [
    ...Array.from({ length: 20 }, (_, i) => `openai/gpt-test-${i}`),
    'anthropic/claude-sonnet-4.5',
  ];
  const options = filterModelOptions(provider, 'gpt');
  assert.equal(options.length, MAX_MODEL_MENU_ITEMS);
  assert.ok(options.every((option) => option.id.includes('gpt')));
});

test('getDefaultModelForProvider: uses provider defaults and cache fallback', () => {
  const tiarina = createPresetProvider('tiarina', 'key');
  const openrouter = createPresetProvider('openrouter', 'key');
  const custom = {
    id: 'custom-test',
    name: 'Custom Test',
    kind: 'custom',
    baseUrl: 'https://example.test/v1',
    apiKey: 'key',
    defaultModel: 'custom/default',
    modelsCache: ['custom/other'],
  };
  const cacheOnly = {
    id: 'cache-only',
    name: 'Cache Only',
    kind: 'custom',
    baseUrl: 'https://example.test/v1',
    apiKey: 'key',
    modelsCache: ['cache/first', 'cache/second'],
  };
  assert.equal(getDefaultModelForProvider(tiarina), 'aina-1-flash');
  assert.equal(getDefaultModelForProvider(openrouter), 'openai/gpt-5.5');
  assert.equal(getDefaultModelForProvider(custom), 'custom/other');
  assert.equal(getDefaultModelForProvider(cacheOnly), 'cache/first');
});

test('getProviderModelOverviews: limits providers and models with hidden counts', () => {
  const providers = Array.from({ length: 6 }, (_, i) => ({
    id: i === 0 ? 'tiarina' : `custom-${i}`,
    name: i === 0 ? 'Tiarina API' : `Custom ${i}`,
    kind: i === 0 ? 'tiarina' : 'custom',
    baseUrl: 'https://example.test/v1',
    apiKey: 'key',
    modelsCache: Array.from({ length: 6 }, (_unused, modelIndex) => `model-${i}-${modelIndex}`),
  }));
  const overview = getProviderModelOverviews(providers);
  assert.equal(overview.overviews.length, 5);
  assert.equal(overview.hiddenProviderCount, 1);
  assert.equal(overview.overviews[0].models.length, 4);
  assert.equal(overview.overviews[0].hiddenModelCount, 2);
});

test('model overview label shape: provider with indented model children', () => {
  const provider = createPresetProvider('tiarina', 'key');
  provider.modelsCache = ['aina-1-flash', 'aina-1-mini', 'aina-1-pro', 'aina-1-ultra', 'aina-2-test'];
  const overview = getProviderModelOverviews([provider]).overviews[0];
  assert.deepEqual(overview.models, ['aina-1-flash', 'aina-1-mini', 'aina-1-pro', 'aina-1-ultra']);
  assert.equal(overview.hiddenModelCount, 1);
});

test('buildModelTreeItems: provider headers are non-model items with 2x3 limits', () => {
  const providers = Array.from({ length: 3 }, (_, providerIndex) => ({
    id: providerIndex === 0 ? 'tiarina' : `custom-${providerIndex}`,
    name: providerIndex === 0 ? 'Tiarina API' : `Custom ${providerIndex}`,
    kind: providerIndex === 0 ? 'tiarina' : 'custom',
    baseUrl: 'https://example.test/v1',
    apiKey: 'key',
    modelsCache: Array.from({ length: 5 }, (_unused, modelIndex) => `provider-${providerIndex}-model-${modelIndex}`),
  }));
  const items = buildModelTreeItems(providers);
  assert.equal(items.filter((item) => item.type === 'provider').length, 2);
  assert.equal(items.filter((item) => item.type === 'model').length, 6);
  assert.equal(items.filter((item) => item.type === 'more-models').length, 2);
  assert.equal(items.at(-1).type, 'more-providers');
});

test('buildModelTreeItems: search only shows providers with matching models', () => {
  const tiarina = createPresetProvider('tiarina', 'key');
  tiarina.modelsCache = ['aina-1-flash'];
  const openai = createPresetProvider('openai', 'key');
  openai.modelsCache = ['gpt-5.5'];
  const items = buildModelTreeItems([openai, tiarina], 'Aina');
  assert.equal(items.filter((item) => item.type === 'provider').length, 1);
  assert.equal(items.find((item) => item.type === 'provider').provider.id, 'tiarina');
  assert.equal(items.find((item) => item.type === 'model').model, 'aina-1-flash');
});

test('extractThoughtPreview: strips thought tags and truncates preview', () => {
  const input = '<thought>' + 'a '.repeat(200) + '</thought>Halo!';
  const result = extractThoughtPreview(input);
  assert.equal(result.visible, 'Halo!');
  assert.ok(result.preview.length <= 241);
  assert.ok(!result.preview.includes('<thought>'));
});

test('extractThoughtPreview: unclosed think tag does not leak raw tag', () => {
  const result = extractThoughtPreview('Hello\n<think>internal reasoning');
  assert.equal(result.visible, 'Hello\n');
  assert.equal(result.preview, 'internal reasoning');
});

test('CLI non-TTY: --help dan --version tidak butuh API key', () => {
  const env = { ...process.env, AINA_API_KEY: '', HOME: path.join(TMP, 'cli-home') };
  const help = spawnSync(process.execPath, ['dist/index.js', '--help'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  if (help.error?.code === 'EPERM') return;
  assert.equal(help.status, 0, help.stderr || help.stdout);
  const helpOutput = `${help.stdout}${help.stderr}`;
  assert.ok(helpOutput.includes('Usage:'));
  assert.ok(helpOutput.includes('aina "question"'));

  const version = spawnSync(process.execPath, ['dist/index.js', '--version'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  assert.equal(version.status, 0, version.stderr || version.stdout);
  assert.match(`${version.stdout}${version.stderr}`.trim(), /^\d+\.\d+\.\d+/);
});

test('friendlyError: timeout/gateway lambat punya pesan aksi jelas', () => {
  assert.ok(friendlyError({ code: 'ETIMEDOUT' }).includes('timed out'));
  assert.ok(friendlyError({ status: 503 }).includes('gateway server problem'));
});

test('globToRegExp: *.ts matches by extension only', () => {
  const re = globToRegExp('*.ts');
  assert.ok(re.test('index.ts'));
  assert.ok(re.test('Index.TS')); // case-insensitive
  assert.ok(!re.test('index.js'));
});

test('globToRegExp: **/ matches across directories', () => {
  const re = globToRegExp('**/*.test.ts');
  assert.ok(re.test('src/util.test.ts'));
  assert.ok(re.test('a/b/c/x.test.ts'));
  assert.ok(!re.test('src/util.ts'));
});

test('parseChoices: extracts a numbered option list', () => {
  const parsed = parseChoices('Pilih salah satu:\n1. Opsi A\n2. Opsi B');
  assert.ok(parsed);
  assert.deepEqual(parsed.options, ['Opsi A', 'Opsi B']);
  assert.ok(parsed.question.includes('Pilih salah satu'));
});

test('parseChoices: returns null for plain prose', () => {
  assert.equal(parseChoices('Ini hanya jawaban biasa tanpa pilihan.'), null);
});

test('diffLines: classifies added and removed lines', () => {
  const diff = diffLines('a\nb', 'a\nc');
  assert.equal(diff.filter((d) => d.type === 'add').length, 1);
  assert.equal(diff.filter((d) => d.type === 'del').length, 1);
  assert.equal(diff.filter((d) => d.type === 'ctx').length, 1);
});

test('renderDiff: summary reports added/removed counts', () => {
  const out = renderDiff('Update', 'file.txt', 'a\nb', 'a\nc');
  assert.ok(out.includes('Added 1 line'));
  assert.ok(out.includes('Removed 1 line'));
});

test('renderDiff: add/remove use gutter signs while preserving line text', () => {
  const out = renderDiff('Update', 'file.txt', 'old', 'new');
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(plain.includes(' + new'));
  assert.ok(plain.includes(' - old'));
});

test('renderDiff: tabs are expanded in changed block rows', () => {
  const out = renderDiff('Update', 'file.go', '\treturn 1', '\tif n <= 1 {');
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(plain.includes('+   if n <= 1 {'));
  assert.ok(!plain.includes('\tif'));
});

test('loadProjectContext: memilih file prioritas pertama yang berisi', () => {
  const dir = path.join(TMP, 'ctx-priority');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AINA.md'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'claude rules', 'utf8');
  fs.writeFileSync(path.join(dir, 'AGENT.md'), 'agent rules', 'utf8');
  const ctx = loadProjectContext(dir);
  assert.deepEqual(ctx, { fileName: 'CLAUDE.md', content: 'claude rules' });
  assert.ok(formatProjectContext(ctx).includes('Project Context (CLAUDE.md)'));
});

test('loadProjectContext: truncate konteks besar', () => {
  const dir = path.join(TMP, 'ctx-large');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AINA.md'), 'x'.repeat(40 * 1024), 'utf8');
  const ctx = loadProjectContext(dir);
  assert.equal(ctx?.fileName, 'AINA.md');
  assert.ok(ctx?.content.includes('project context truncated'));
});

test('mode: set, cycle, label, dan footer text', () => {
  setMode('default');
  assert.equal(getMode(), 'default');
  assert.equal(cycleMode(), 'plan');
  assert.equal(cycleMode(), 'auto');
  assert.equal(cycleMode(), 'default');
  setMode('plan');
  assert.equal(getModeLabel(), 'Plan');
  assert.equal(footerRight('Aina 1 Pro').raw, 'Plan · Aina 1 Pro');
});

test('renderMarkdown: output tidak kosong untuk markdown umum', () => {
  assert.ok(renderMarkdown('plain text').trim());
  assert.ok(renderMarkdown('**bold**\n- item\n```js\n1 + 1\n```').trim());
});

test('renderMarkdown: headings hide markdown markers and emoji is stripped', () => {
  const plain = renderMarkdown('# Selamat ✨\n## Info 😊\n- 🚀 Semangat').replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(plain.includes('Selamat'));
  assert.ok(plain.includes('Info'));
  assert.ok(!plain.includes('# Selamat'));
  assert.ok(!plain.includes('✨'));
  assert.ok(!plain.includes('😊'));
  assert.ok(!plain.includes('🚀'));
});

test('session: save/load isolated HOME lewat child process', () => {
  const home = path.join(TMP, 'home');
  fs.mkdirSync(home, { recursive: true });
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    const session = await import('./dist/session.js');
    session.saveSession({ id: 'satu', title: 'Satu', model: 'aina-1-pro', savedAt: '', messages: [{ role: 'user', content: 'hi' }] });
    session.saveSession({ id: 'dua', title: 'Dua', model: 'aina-1-pro', savedAt: '', messages: [{ role: 'assistant', content: 'ok' }] });
    assert.equal(session.loadSession('satu').title, 'Satu');
    assert.equal(session.loadSession().id, 'dua');
    assert.equal(session.loadSession('missing'), null);
    assert.ok(fs.existsSync(path.join(process.env.HOME, '.ainacode', 'sessions', 'dua.json')));
    assert.ok(fs.existsSync(path.join(process.env.HOME, '.ainacode', 'last-session.json')));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('sanitizeHistoryForSave: validation lama dibuang dan attachment diringkas', () => {
  const history = sanitizeHistoryForSave([
    { role: 'system', content: 'base' },
    { role: 'system', content: 'Automatic validation (npm test) FOUND issues. old' },
    {
      role: 'user',
      content: 'tolong cek @a.txt\n\nAttached files:\n--- File: a.txt ---\nsecret\n--- End File: a.txt ---',
    },
    { role: 'system', content: 'Automatic validation (npm test) FOUND issues. newest' },
  ]);
  assert.equal(history.length, 3);
  assert.ok(!JSON.stringify(history).includes('old'));
  assert.ok(JSON.stringify(history).includes('newest'));
  assert.ok(JSON.stringify(history).includes('Attached file contents summarized'));
  assert.ok(!JSON.stringify(history).includes('secret'));
});

test('sanitizeActiveHistory: attachment aktif diringkas tanpa menghapus prompt normal', () => {
  const history = sanitizeActiveHistory([
    { role: 'user', content: 'normal message' },
    {
      role: 'user',
      content: 'tolong cek @a.txt\n\nAttached files:\n--- File: a.txt ---\nsecret\n--- End File: a.txt ---',
    },
  ]);
  assert.equal(history.length, 2);
  assert.equal(history[0].content, 'normal message');
  assert.ok(history[1].content.includes('Attached file contents summarized'));
  assert.ok(!JSON.stringify(history).includes('secret'));
});

test('locallyCompactHistoryForSerialization: tool result besar dicap dan validation lama dibuang', () => {
  const compacted = locallyCompactHistoryForSerialization([
    { role: 'system', content: 'base' },
    { role: 'system', content: 'Automatic validation (npm test) FOUND issues. old' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'x'.repeat(40_000) },
    { role: 'system', content: 'Automatic validation (npm test) FOUND issues. newest' },
  ]);
  const json = JSON.stringify(compacted);
  assert.ok(!json.includes('old'));
  assert.ok(json.includes('newest'));
  assert.ok(json.includes('tool result truncated'));
  const assistantIndex = compacted.findIndex((message) => message.role === 'assistant');
  assert.equal(compacted[assistantIndex + 1].role, 'tool');
});

test('AinaAgent.compactLocal: memutasi active history tanpa LLM call', () => {
  const agent = new AinaAgent({}, 'aina-1-pro');
  agent.restoreHistory([
    { role: 'system', content: 'base' },
    {
      role: 'user',
      content: 'tolong cek @a.txt\n\nAttached files:\n--- File: a.txt ---\nsecret\n--- End File: a.txt ---',
    },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'x'.repeat(40_000) },
  ]);
  const { before, after } = agent.compactLocal();
  assert.ok(after < before);
  const json = JSON.stringify(agent.getHistory());
  assert.ok(json.includes('Attached file contents summarized'));
  assert.ok(json.includes('tool result truncated'));
  assert.ok(!json.includes('secret'));
});

test('fallbackTitle: first message gives non-empty sync title', () => {
  assert.equal(fallbackTitle('  Perbaiki bug session title race sekarang  '), 'Perbaiki bug session title race sekarang');
  assert.equal(fallbackTitle(''), 'Untitled session');
});

test('chooseRequestToolPolicy: default, plan, dan no-tool condition', () => {
  const normal = chooseRequestToolPolicy({ planMode: false, toolsNeeded: true });
  assert.ok(normal.tools.length >= 14);
  const plan = chooseRequestToolPolicy({ planMode: true, toolsNeeded: true });
  assert.ok(plan.tools.length < normal.tools.length);
  assert.ok(plan.tools.every((tool) => ['read_file', 'list_dir', 'grep_search', 'find_files', 'git_status', 'git_diff', 'ask_user'].includes(tool.function.name)));
  assert.deepEqual(chooseRequestToolPolicy({ planMode: false, toolsNeeded: false }), { tool_choice: 'none' });
});

test('compactAttachedFilesContent: content tanpa attachment tidak berubah', () => {
  assert.equal(compactAttachedFilesContent('plain prompt'), 'plain prompt');
});

test('normalizeUsageDelta: mendukung usage penuh dan total-only', () => {
  assert.deepEqual(normalizeUsageDelta({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });
  assert.deepEqual(normalizeUsageDelta({ total_tokens: 7 }), {
    promptTokens: 7,
    completionTokens: 0,
    totalTokens: 7,
  });
});

test('estimateUsageCostUsd: known model menghitung, unknown unavailable', () => {
  assert.equal(estimateUsageCostUsd('unknown-model', 1000, 1000), null);
  assert.ok((estimateUsageCostUsd('aina-1-pro', 1_000_000, 1_000_000) ?? 0) > 0);
});

test('diag.mjs: gagal jelas tanpa API key, tanpa dummy-key', () => {
  const home = path.join(TMP, 'diag-home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    PATH: process.env.PATH ?? '',
    PWD: process.cwd(),
    NODE_ENV: 'test',
  };
  const result = spawnSync('node', ['diag.mjs'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  const source = fs.readFileSync(path.resolve('diag.mjs'), 'utf8');
  assert.ok(!source.includes("|| 'dummy-key'"));
  assert.ok(source.includes('Missing API key'));
  if (result.error?.code === 'EPERM') return;
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('Missing API key'));
  assert.ok(!result.stderr.includes('dummy-key'));
});

test('findFlushBoundary: flushes complete markdown blocks', () => {
  assert.equal(findFlushBoundary('Satu paragraf.\n\nDua', false), 14);
});

test('findFlushBoundary: fallback flushes long single paragraph at word boundary', () => {
  const text = `${'kata '.repeat(80)}akhir`;
  const boundary = findFlushBoundary(text, false, 120, true);
  assert.ok(boundary > 0);
  assert.ok(boundary <= 120);
  assert.equal(text[boundary], ' ');
});

test('findFlushBoundary: stale non-final flush does not act like final force', () => {
  assert.equal(findFlushBoundary('S', false, 120, true), -1);
  assert.equal(findFlushBoundary('Saya adalah Aina', false, 120, true), -1);
  assert.equal(findFlushBoundary('## Heading', false, 120, true), -1);
});

test('findFlushBoundary: does not flush inside open code fence', () => {
  const text = '```ts\nconst value = 1;\n\nmasih code';
  assert.equal(findFlushBoundary(text, true), -1);
});

test('findFlushBoundary: force flushes final tail', () => {
  assert.equal(findFlushBoundary('jawaban akhir', true), 'jawaban akhir'.length);
});
