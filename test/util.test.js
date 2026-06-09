import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getPrettyModelName } from '../dist/config.js';
import { globToRegExp } from '../dist/tools.js';
import { parseChoices } from '../dist/agent.js';
import { diffLines, renderDiff } from '../dist/diff.js';

test('getPrettyModelName: maps known ids and falls back to input', () => {
  assert.equal(getPrettyModelName('aina-1-pro'), 'Aina 1 Pro');
  assert.equal(getPrettyModelName('AINA-1-FLASH'), 'Aina 1 Flash');
  assert.equal(getPrettyModelName('something-else'), 'something-else');
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
