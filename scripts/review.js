#!/usr/bin/env node
/**
 * review.js — Quality check and auto-fix the most recent summaries file in tmp/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tmpDir = path.join(ROOT, 'tmp');

const summariesFile = findLatestSummaries(tmpDir);
if (!summariesFile) {
  console.error(`❌ No summaries-*.md found in ${tmpDir}`);
  process.exit(1);
}

const key = path.basename(summariesFile).replace(/^summaries-/, '').replace(/\.md$/, '');
const reportFile = path.join(tmpDir, `review-report-${key}.json`);
const rawFile = path.join(tmpDir, `raw-${key}.json`);

console.log(`🔍 Reviewing: ${path.basename(summariesFile)}\n`);

let content = fs.readFileSync(summariesFile, 'utf8');
const rawItems = fs.existsSync(rawFile) ? JSON.parse(fs.readFileSync(rawFile, 'utf8')) : [];
const rawByVideoId = new Map(rawItems.map(item => [item.videoId, item]));

const issues = [];
let errorCount = 0;
let fixCount = 0;

// Track insights across the whole digest to catch duplicates.
const insightToTitles = new Map();

const alwaysRequired = ['핵심 요약', '한 줄 인사이트'];
const transcriptOnlyRequired = ['주요 타임라인']; // only required when transcript is available
// Split on standalone --- separators (not table separators like |---|)
// Video blocks are identified by their h2 title with a link: `## [Title](url)`
// Channel headers (### 📺 @handle) are NOT video blocks — they're metadata
const videoBlocks = content.split(/\n---\s*\n/).filter(b => /^##\s+\[/m.test(b));

for (const block of videoBlocks) {
  // Title is the first `## [Title](url)` line
  const titleMatch = block.match(/^##\s+\[([^\]]+)\]/m);
  if (!titleMatch) continue;
  const title = titleMatch[1].trim();
  const urlMatch = block.match(/^##\s+\[[^\]]+\]\((https?:\/\/www\.youtube\.com\/watch\?v=([^\s)]+))\)/m);
  const videoId = urlMatch ? urlMatch[2] : null;
  const raw = videoId ? rawByVideoId.get(videoId) : null;

  for (const section of alwaysRequired) {
    if (!block.includes(section)) {
      issues.push({ level: 'ERROR', video: title, check: 'missing_section', detail: `Missing: ${section}` });
      errorCount++;
      console.log(`  ❌ ERROR: "${title}" — missing section: ${section}`);
    }
  }
  // 주요 타임라인 is optional — only warn if missing.
  // It can also be replaced by inline timestamps in the structured summary body
  // (computed below as `inlineStamps`); we re-check after that count is known.
  const summaryTextEarly = extractSectionBody(block, '핵심 요약', ['주요 타임라인']);
  const earlyInlineStamps = (summaryTextEarly.match(/\[\[?\d{1,2}:\d{2}(?::\d{2})?\]?\]\(https?:\/\/[^)]*[?&]t=\d+/g) || []).length;
  for (const section of transcriptOnlyRequired) {
    if ((raw?.hasTranscript || ((raw?.transcriptSegments || []).length >= 3)) && !block.includes(section) && earlyInlineStamps < 3) {
      issues.push({ level: 'ERROR', video: title, check: 'missing_section', detail: `Missing: ${section} (and <3 inline timestamps in body)` });
      errorCount++;
      console.log(`  ❌ ERROR: "${title}" — missing section: ${section} (transcript available, no inline stamps)`);
    } else if (!raw?.hasTranscript && !block.includes(section)) {
      issues.push({ level: 'WARNING', video: title, check: 'missing_section', detail: `Missing: ${section}` });
    }
  }

  const summaryText = extractSectionBody(block, '핵심 요약', ['주요 타임라인']);
  const summaryParagraphs = splitParagraphs(summaryText);
  // Accept either: legacy 2-3 prose paragraphs, OR new structured format
  // (intro + at least 2 numbered points like "1. **제목**" / "2. **제목**").
  const numberedHeads = (summaryText.match(/^\s*\d+\.\s+\*\*/gm) || []).length;
  const isStructured = numberedHeads >= 2;
  if (!isStructured && (summaryParagraphs.length < 2 || summaryParagraphs.length > 3)) {
    issues.push({
      level: 'ERROR',
      video: title,
      check: 'summary_paragraph_count',
      detail: `핵심 요약 must be 2-3 prose paragraphs OR structured with 2+ numbered points (found ${summaryParagraphs.length} paragraphs, ${numberedHeads} numbered)`
    });
    errorCount++;
    console.log(`  ❌ ERROR: "${title}" — 핵심 요약 문단 수 ${summaryParagraphs.length} (구조화 항목 ${numberedHeads}개)`);
  }

  const normalizedSummary = summaryParagraphs.join(' ');
  // Structured format intentionally cites English proper nouns / jargon
  // (e.g., "Mark Andreessen", "Consumer Surplus") inside Korean prose, so
  // we loosen the dominance ratio when numbered points are present.
  if (!looksMostlyKorean(normalizedSummary, isStructured ? 0.5 : 1.1)) {
    issues.push({
      level: 'ERROR',
      video: title,
      check: 'summary_language',
      detail: '핵심 요약 must be primarily Korean'
    });
    errorCount++;
    console.log(`  ❌ ERROR: "${title}" — 핵심 요약 언어가 한국어 중심이 아님`);
  }

  if (!/(예를 들어|예시|사례|데모|실험|비교)/.test(normalizedSummary)) {
    issues.push({
      level: 'ERROR',
      video: title,
      check: 'summary_examples',
      detail: '핵심 요약 must include at least one concrete example/demo/case'
    });
    errorCount++;
    console.log(`  ❌ ERROR: "${title}" — 핵심 요약에 사례/데모가 없음`);
  }

  // Forbid 핵심 요약 from echoing the video title in its first paragraph.
  // Title is already shown in the h2 above; restating it wastes the slot.
  const firstPara = summaryParagraphs[0] || '';
  const titleWords = title.split(/[\s\-—–:|()|,\.]+/).filter(w => w.length >= 4);
  const titleHead = titleWords.slice(0, 4).join(' ');
  const titleStarts = [
    title,
    titleHead,
    title.split(/[\-—–:|]/)[0].trim()
  ].filter(s => s && s.length >= 6);
  const startsWithTitle = titleStarts.some(t =>
    firstPara.startsWith(t) || firstPara.startsWith(`${t}는`) || firstPara.startsWith(`${t}은`) ||
    firstPara.startsWith(`${t}이`) || firstPara.startsWith(`${t}가`) || firstPara.startsWith(`"${t}"`)
  );
  if (startsWithTitle) {
    issues.push({
      level: 'ERROR',
      video: title,
      check: 'summary_starts_with_title',
      detail: '핵심 요약 must NOT start with the video title (title is already in the h2 above)'
    });
    errorCount++;
    console.log(`  ❌ ERROR: "${title}" — 핵심 요약이 영상 제목으로 시작함`);
  }

  const timestamps = block.match(/\[\d+:\d+:\d+\]/g) || [];
  // Inline summary timestamps `[MM:SS](url&t=)` are intentionally compact and
  // already correct as markdown links — exclude them from the MM:SS→HH:MM:SS
  // auto-fix (which only targets the legacy timeline-section format).
  const badTimestamps = block.match(/\[\d+:\d+\](?![:(])/g) || [];
  if (badTimestamps.length > timestamps.length) {
    content = content.replace(/\[(\d+):(\d+)\](?![:(])/g, (_, m, s) => `[00:${m.padStart(2,'0')}:${s.padStart(2,'0')}]`);
    issues.push({ level: 'WARNING', video: title, check: 'timestamp_format', detail: 'Auto-fixed MM:SS → HH:MM:SS', fixed: true });
    fixCount++;
    console.log(`  🔧 Fixed timestamp format in: "${title}"`);
  }

  const timelineBody = extractSectionBody(block, '주요 타임라인', []);
  const timelineLines = timelineBody.split('\n').map(l => l.trim()).filter(l => l.startsWith('- '));
  const timelineSec = [];
  let timelineMalformed = false;

  for (const line of timelineLines) {
    const m = line.match(/^-\s*\[(\d{2}:\d{2}:\d{2})\]\s*(.+)$/);
    if (!m) {
      timelineMalformed = true;
      continue;
    }
    timelineSec.push(parseHms(m[1]));
  }

  if (timelineLines.length > 0 && timelineMalformed) {
    issues.push({ level: 'ERROR', video: title, check: 'timeline_format', detail: 'Timeline lines must be `- [HH:MM:SS] content` or `- [HH:MM:SS](URL) content`' });
    errorCount++;
  }

  // Inline timestamps in the structured summary body count as timeline coverage —
  // we no longer require a separate '주요 타임라인' section when the body has them.
  const inlineStamps = (summaryText.match(/\[\[?\d{1,2}:\d{2}(?::\d{2})?\]?\]\(https?:\/\/[^)]*[?&]t=\d+/g) || []).length;

  if ((raw?.transcriptSegments || []).length >= 3 && timelineLines.length < 3 && inlineStamps < 3) {
    issues.push({ level: 'ERROR', video: title, check: 'timeline_length', detail: `Expected at least 3 timeline entries OR 3+ inline timestamps in the body (found ${timelineLines.length} timeline lines, ${inlineStamps} inline)` });
    errorCount++;
  }

  if (raw?.duration && timelineSec.some(t => t > raw.duration)) {
    issues.push({ level: 'ERROR', video: title, check: 'timeline_out_of_range', detail: 'Timeline contains timestamp beyond video duration' });
    errorCount++;
  }

  if (!isSorted(timelineSec)) {
    issues.push({ level: 'WARNING', video: title, check: 'timeline_order', detail: 'Timeline timestamps are not ascending' });
  }

  if ((raw?.transcriptSegments || []).length >= 3 && timelineSec.length > 0) {
    const segmentSec = raw.transcriptSegments.map(s => parseHms(s.start));
    const unmatched = timelineSec.filter(t => !segmentSec.some(s => Math.abs(s - t) <= 120));
    if (unmatched.length > 0) {
      issues.push({ level: 'WARNING', video: title, check: 'timeline_alignment', detail: 'Some timeline timestamps do not align with transcript segments (±120s)' });
    }
  }

  if (!(raw?.transcriptSegments || []).length && timelineLines.length > 0) {
    issues.push({ level: 'WARNING', video: title, check: 'timeline_source', detail: 'Timeline present without transcriptSegments; accuracy may be low' });
  }

  const insightMatch = block.match(/한 줄 인사이트[^\n]*\n(.*)/);
  if (insightMatch) {
    const insight = insightMatch[1].trim();
    const sentences = insight.split(/[.。!?！？]/).filter(s => s.trim()).length;
    if (sentences > 2) {
      issues.push({ level: 'WARNING', video: title, check: 'insight_length', detail: `Too long: ${sentences} sentences` });
      console.log(`  ⚠️  WARNING: "${title}" — 한 줄 인사이트 too long (${sentences} sentences)`);
    }
    // Track for cross-video duplicate detection.
    const norm = insight.replace(/^💡\s*/, '').replace(/\s+/g, ' ').trim();
    if (norm) {
      if (!insightToTitles.has(norm)) insightToTitles.set(norm, []);
      insightToTitles.get(norm).push(title);
    }
  }
}

// Cross-video: insights must be unique. Generic, copy-pasted insights are
// a strong signal that the summarizer fell back to a template instead of
// reading each transcript.
for (const [insight, titles] of insightToTitles.entries()) {
  if (titles.length > 1) {
    issues.push({
      level: 'ERROR',
      check: 'insight_duplicate',
      detail: `한 줄 인사이트 duplicated across ${titles.length} videos: ${titles.map(t => `"${t}"`).join(', ')}`
    });
    errorCount++;
    console.log(`  ❌ ERROR: 한 줄 인사이트 중복 — ${titles.length}개 영상이 동일: ${titles.slice(0, 3).map(t => `"${t}"`).join(', ')}${titles.length > 3 ? ', …' : ''}`);
  }
}

if (!/###\s+📺\s+/.test(content)) {
  issues.push({ level: 'ERROR', check: 'structure', detail: 'No channel sections found (### 📺 ChannelName)' });
  errorCount++;
}

fs.writeFileSync(summariesFile, content);

const report = {
  key,
  totalIssues: issues.length,
  errors: errorCount,
  warnings: issues.length - errorCount,
  autoFixed: fixCount,
  issues
};
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

console.log(`\n📊 Review: ${issues.length} issues (${errorCount} errors, ${issues.length - errorCount} warnings), ${fixCount} auto-fixed`);

if (errorCount > 0) {
  console.error(`❌ ${errorCount} error(s) require manual attention.`);
  process.exit(1);
}
console.log('✅ Review passed.');

function extractSectionBody(block, sectionTitle, nextSections = []) {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const next = nextSections
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  const re = next
    ? new RegExp(`\\*\\*${escaped}\\*\\*\\s*\\n([\\s\\S]*?)(?=\\n\\*\\*(?:${next})\\*\\*|$)`)
    : new RegExp(`\\*\\*${escaped}\\*\\*\\s*\\n([\\s\\S]*?)$`);

  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function splitParagraphs(text) {
  if (!text) return [];
  const unquoted = text
    .split('\n')
    .map(line => line.replace(/^>\s?/, ''))
    .join('\n')
    .trim();

  return unquoted
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function looksMostlyKorean(text, minHangulOverLatin = 1.1) {
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (!text.trim()) return false;
  return hangul >= Math.max(30, latin * minHangulOverLatin);
}

function parseHms(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function isSorted(values) {
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) return false;
  }
  return true;
}

function findLatestSummaries(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('summaries-') && f.endsWith('.md'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}
