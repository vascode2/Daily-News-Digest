#!/usr/bin/env node
/**
 * publish.js — Save the latest summaries from tmp/ to output/ and Notion
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
    await tryUpdateParentPageTitle(notionPageId, notionRootTitle, notionToken);

    const blocks = markdownToNotionBlocks(finalContent);
    console.log(`   Converted to ${blocks.length} Notion blocks`);

    const notionTitle = isChannel
      ? `📺 Channel News Digest: @${channelHandle} (${endStr})`
      : isRange
        ? `📰 Weekly News Digest ${startStr} ~ ${endStr}`
        : `📰 ${endStr}`;

    const firstBatch = blocks.slice(0, 100);
    const restBatches = [];
    for (let i = 100; i < blocks.length; i += 100) {
      restBatches.push(blocks.slice(i, i + 100));
    }

    const createRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: notionHeaders(notionToken),
      body: JSON.stringify({
        parent: { page_id: notionPageId },
        properties: { title: { title: [{ text: { content: notionTitle } }] } },
        children: firstBatch
      })
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`${createRes.status}: ${err}`);
    }

    const createdPage = await createRes.json();
    const newPageId = createdPage.id;

    for (const batch of restBatches) {
      const r = await fetch(`https://api.notion.com/v1/blocks/${newPageId}/children`, {
        method: 'PATCH',
        headers: notionHeaders(notionToken),
        body: JSON.stringify({ children: batch })
      });
      if (!r.ok) console.error(`   ⚠️  Append failed: ${r.status}`);
    }

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

function notionHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };
}

async function tryUpdateParentPageTitle(pageId, targetTitle, token) {
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: notionHeaders(token),
      body: JSON.stringify({
        properties: {
          title: {
            title: [{ text: { content: targetTitle } }]
          }
        }
      })
    });

    if (!res.ok) {
      console.log(`   ⚠️  Could not rename parent page title (${res.status})`);
    }
  } catch (err) {
    console.log(`   ⚠️  Could not rename parent page title (${err.message})`);
  }
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

function markdownToNotionBlocks(md) {
  const blocks = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }

    if (trimmed === '---') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      i++; continue;
    }
    if (trimmed.startsWith('# ')) { blocks.push(headingBlock(1, trimmed.slice(2))); i++; continue; }
    if (trimmed.startsWith('## ')) { blocks.push(headingBlock(2, trimmed.slice(3))); i++; continue; }
    if (trimmed.startsWith('### ')) { blocks.push(headingBlock(3, trimmed.slice(4))); i++; continue; }

    if (trimmed.startsWith('> ')) {
      blocks.push({
        object: 'block', type: 'quote',
        quote: { rich_text: parseRichText(trimmed.slice(2)) }
      });
      i++; continue;
    }
    if (trimmed.startsWith('- ')) {
      blocks.push({
        object: 'block', type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: parseRichText(trimmed.slice(2)) }
      });
      i++; continue;
    }
    if (trimmed.startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      const cleaned = tableLines.filter(l => !/^\|[\s\-:|]+\|$/.test(l));
      blocks.push({
        object: 'block', type: 'code',
        code: {
          rich_text: [{ type: 'text', text: { content: cleaned.join('\n').slice(0, 2000) } }],
          language: 'plain text'
        }
      });
      continue;
    }

    blocks.push({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: parseRichText(trimmed) }
    });
    i++;
  }
  return blocks;
}

function headingBlock(level, text) {
  const type = `heading_${level}`;
  // Channel headers (### 📺 Channel Name) are styled red for visibility
  const isChannelHeader = level === 3 && /^📺\s/.test(text);
  const block = { rich_text: parseRichText(text) };
  if (isChannelHeader) block.color = 'red';
  return { object: 'block', type, [type]: block };
}

/**
 * Parse markdown inline syntax into Notion rich_text array.
 * Supports: [text](url) links, **bold**, plain text. Order-independent.
 */
function parseRichText(text) {
  // Tokenize: find all [text](url) and **bold** spans, fill the rest as plain.
  // Link regex: non-greedy text, but must be followed by '](http...' so nested
  // brackets in YouTube titles like '[프롬프트 공유] 시댄스...' are handled.
  const tokens = [];
  const linkRe = /\[([\s\S]+?)\]\((https?:\/\/[^)]+)\)/g;
  const boldRe = /\*\*([^*]+)\*\*/g;
  const matches = [];
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, kind: 'link', text: m[1], url: m[2] });
  }
  while ((m = boldRe.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, kind: 'bold', text: m[1] });
  }
  matches.sort((a, b) => a.start - b.start);

  // Drop overlapping matches (keep first)
  const filtered = [];
  let lastEnd = 0;
  for (const mt of matches) {
    if (mt.start >= lastEnd) { filtered.push(mt); lastEnd = mt.end; }
  }

  let cursor = 0;
  for (const mt of filtered) {
    if (mt.start > cursor) tokens.push(plainSegment(text.slice(cursor, mt.start)));
    if (mt.kind === 'link') tokens.push(linkSegment(mt.text, mt.url));
    else if (mt.kind === 'bold') tokens.push(boldSegment(mt.text));
    cursor = mt.end;
  }
  if (cursor < text.length) tokens.push(plainSegment(text.slice(cursor)));

  return tokens.length > 0 ? tokens : [plainSegment(text)];
}

function plainSegment(t) {
  return { type: 'text', text: { content: t.slice(0, 2000) } };
}
function boldSegment(t)  {
  return { type: 'text', text: { content: t.slice(0, 2000) }, annotations: { bold: true } };
}
function linkSegment(t, url) {
  return { type: 'text', text: { content: t.slice(0, 2000), link: { url } } };
}
