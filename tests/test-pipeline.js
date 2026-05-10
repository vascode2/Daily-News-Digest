#!/usr/bin/env node
/**
 * test-pipeline.js — Validate project setup
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('🧪 Running setup tests...\n');

console.log('Stage 1: Config files');
test('channels.txt exists', () => {
  assert(fs.existsSync(path.join(ROOT, 'config', 'channels.txt')), 'missing');
});
test('format.md exists', () => {
  assert(fs.existsSync(path.join(ROOT, 'config', 'format.md')), 'missing');
});
test('channels.txt has at least 1 channel', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'config', 'channels.txt'), 'utf8')
    .split('\n').filter(l => l.trim() && !l.startsWith('#'));
  assert(lines.length > 0, 'No channels configured');
});

console.log('\nStage 2: Script files');
for (const script of ['collect.js', 'review.js', 'publish.js']) {
  test(`scripts/${script} exists`, () => {
    assert(fs.existsSync(path.join(ROOT, 'scripts', script)), 'missing');
  });
}

console.log('\nStage 3: Agent guides');
for (const agent of ['collector.md', 'summarizer.md', 'reviewer.md', 'publisher.md']) {
  test(`agents/${agent} exists`, () => {
    assert(fs.existsSync(path.join(ROOT, 'agents', agent)), 'missing');
  });
}

console.log('\nStage 4: External tools');
test('yt-dlp is installed', () => {
  try {
    execSync('yt-dlp --version', { stdio: 'pipe' });
  } catch {
    throw new Error('yt-dlp not found. Install: https://github.com/yt-dlp/yt-dlp/releases');
  }
});

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✅ ${passed} passed | ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('\n🎉 Setup complete! Try: 어제 거 요약해 줘');
