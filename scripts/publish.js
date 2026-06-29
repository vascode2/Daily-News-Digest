#!/usr/bin/env node
/**
 * publish.js — Save the latest summaries from tmp/ to output/ and Notion
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  updateParentPageTitle,
  listChildBlocks,
  childPageTitle,
  archiveBlock,
  createDigestPage,
  markdownToNotionBlocks
} from './notion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tmpDir = path.join(ROOT, 'tmp');
const outputDir = path.join(ROOT, 'output');

const summariesFile = findLatestSummaries(tmpDir);
if (!summariesFile) {
  console.error(`❌ No summaries-*.md found in ${tmpDir}`);
  process.exit(1);
}

const key = path.basename(summariesFile).replace(/^summaries-/, '').replace(/\.md$/, '');
const reportFile = path.join(tmpDir, `review-report-${key}.json`);
const rawFile = path.join(tmpDir, `raw-${key}.json`);
const outputFile = path.join(outputDir, `${key}.md`);

const isRange = key.includes('_to_');
const isChannel = key.startsWith('channel-');
let startStr, endStr, channelHandle;
if (isChannel) {
  // key format: channel-{handle}-YYYY-MM-DD
  const m = key.match(/^channel-(.+)-(\d{4}-\d{2}-\d{2})$/);
  if (m) { channelHandle = m[1]; endStr = startStr = m[2]; }
  else { endStr = startStr = key; }
} else {
  [startStr, endStr] = isRange ? key.split('_to_') : [key, key];
}

fs.mkdirSync(outputDir, { recursive: true });

// Display timestamp in DIGEST_TIMEZONE (set in workflow), or local TZ if unset
const now = new Date();
const displayTz = process.env.DIGEST_TIMEZONE || undefined;
const timeStr = formatGeneratedTime(now, displayTz);
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : {};
const summaries = fs.readFileSync(summariesFile, 'utf8');
const compareMethod = (process.env.DIGEST_COMPARE_METHOD || '').trim();

// New format: channels are h3 with `### 📺 @handle`, videos are h2 with `## [Title](url)`
const channelCount = (summaries.match(/^###\s+📺\s+/gm) || []).length;
const videoCount = (summaries.match(/^##\s+\[/gm) || []).length;

// Pipeline stats: collected (raw), summarized (videoCount), fallback summaries, errors/warnings
let collectedCount = 0;
let collectedChannels = 0;
if (fs.existsSync(rawFile)) {
  try {
    const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
    if (Array.isArray(raw)) {
      collectedCount = raw.length;
      collectedChannels = new Set(raw.map(v => v.channel || v.channelName).filter(Boolean)).size;
    }
  } catch { /* ignore raw read errors */ }
}
const fallbackCount = (summaries.match(/Gemini 응답이 제한되어/g) || []).length;
const reviewErrors = report.errors || 0;
const reviewWarnings = report.warnings || 0;

const statsParts = [];
if (collectedCount) statsParts.push(`수집: ${collectedCount}개${collectedChannels ? ` (${collectedChannels}채널)` : ''}`);
statsParts.push(`요약 성공: ${videoCount - fallbackCount}개`);
if (fallbackCount) statsParts.push(`Fallback: ${fallbackCount}개`);
const dropped = Math.max(0, collectedCount - videoCount);
if (dropped) statsParts.push(`누락: ${dropped}개`);
if (reviewErrors) statsParts.push(`⚠️ 오류: ${reviewErrors}건`);
if (reviewWarnings) statsParts.push(`경고: ${reviewWarnings}건`);
const statsLine = statsParts.length ? `\n> ${statsParts.join(' | ')}` : '';

const titleHeading = isChannel
  ? `# 📺 Channel News Digest — @${channelHandle} (${formatDateKo(endStr)})`
  : isRange
    ? `# 📰 Weekly News Digest — ${formatDateKo(startStr)} ~ ${formatDateKo(endStr)}`
    : `# 📰 News Digest — ${formatDateKo(endStr)}`;

const header = `${titleHeading}

> 생성: ${timeStr} | 채널: ${channelCount}개 | 영상: ${videoCount}개${statsLine}
${compareMethod ? `> 비교 방식: ${compareMethod}\n` : ''}

---
`;

// Strip any pre-existing top-level title, ALL leading quote/stats lines (publish
// can be re-run on the same output file, so multiple '> 생성: ...' lines may have
// accumulated), and any opening divider.
let stripped = summaries.replace(/^#\s+[^\n]*\n+/, '');
// Remove leading quote-block / divider lines repeatedly until none remain.
while (/^>\s+[^\n]*\n+/.test(stripped) || /^---\s*\n+/.test(stripped) || /^\s*\n/.test(stripped)) {
  stripped = stripped
    .replace(/^>\s+[^\n]*\n+/, '')
    .replace(/^---\s*\n+/, '')
    .replace(/^\s*\n/, '');
}
const finalContent = header + stripped;
fs.writeFileSync(outputFile, finalContent);
console.log(`✅ Saved: ${outputFile}`);

const notionToken = process.env.NOTION_TOKEN;
const notionPageId = process.env.NOTION_PAGE_ID;
const notionRootTitle = process.env.NOTION_ROOT_TITLE || 'News Digest';
const skipNotion = process.env.DIGEST_SKIP_NOTION === 'true';

let notionUrl = videoCount === 0
  ? 'SKIPPED (empty digest: 0 videos)'
  : 'SKIPPED (no NOTION_TOKEN/NOTION_PAGE_ID set)';

if (videoCount === 0) {
  console.log('📝 Notion skipped: empty digest has 0 videos');
} else if (skipNotion) {
  notionUrl = 'SKIPPED (DIGEST_SKIP_NOTION=true)';
  console.log('📝 Notion skipped: DIGEST_SKIP_NOTION=true');
} else if (notionToken && notionPageId) {
  console.log('📝 Publishing to Notion...');
  try {
    await updateParentPageTitle(notionPageId, notionRootTitle, notionToken);

    const blocks = markdownToNotionBlocks(finalContent);
    console.log(`   Converted to ${blocks.length} Notion blocks`);

    const notionTitle = isChannel
      ? `📺 Channel News Digest: @${channelHandle} (${endStr})`
      : isRange
        ? `📰 Weekly News Digest ${startStr} ~ ${endStr}`
        : `📰 ${endStr}`;

    // De-dup: archive any existing child page(s) with the same title so re-runs
    // don't pile up duplicate date pages.
    try {
      const children = await listChildBlocks(notionPageId, notionToken);
      const dupes = children.filter(b => b.type === 'child_page' && childPageTitle(b) === notionTitle);
      for (const dup of dupes) {
        await archiveBlock(dup.id, notionToken);
        console.log(`   🗑️  Archived existing page "${notionTitle}"`);
      }
    } catch (err) {
      console.log(`   ⚠️  Dedup skipped: ${err.message}`);
    }

    // Insert at the top so the newest digest appears first.
    const createdPage = await createDigestPage({
      parentPageId: notionPageId,
      title: notionTitle,
      blocks,
      position: { type: 'start' },
      token: notionToken
    });

    notionUrl = createdPage.url;
    console.log(`   ✅ Notion: ${notionUrl}`);
  } catch (err) {
    console.error(`   ❌ Notion failed: ${err.message}`);
    notionUrl = `FAILED: ${err.message.slice(0, 100)}`;
  }
}

if (fs.existsSync(tmpDir)) {
  fs.readdirSync(tmpDir)
    .filter(f => f.includes(key))
    .forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
  console.log('🧹 Cleaned tmp files');
}

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ ${isRange ? 'Weekly digest' : 'Digest'} complete!
📄 File:    output/${key}.md
📊 Stats:   채널 ${channelCount}개 | 영상 ${videoCount}개 | 오류 ${report.errors || 0}건
📝 Notion:  ${notionUrl}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);


// ── helpers ──────────────────────────────────────────────────

function findLatestSummaries(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('summaries-') && f.endsWith('.md'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

function formatDateKo(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y}.${m}.${d}`;
}

function formatGeneratedTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone,
    timeZoneName: 'short'
  }).formatToParts(date);

  const value = type => parts.find(part => part.type === type)?.value || '';
  return `${value('dayPeriod')} ${value('hour')}:${value('minute')} ${value('timeZoneName')}`.trim();
}
