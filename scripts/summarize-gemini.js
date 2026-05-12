#!/usr/bin/env node
/**
 * summarize-gemini.js — Generate tmp/summaries-*.md from the latest tmp/raw-*.json using Gemini.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tmpDir = path.join(ROOT, 'tmp');

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const requestedModel = process.env.GEMINI_MODEL || 'gemini-3-fast';
const fallbackModels = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3-flash-preview,gemini-2.5-flash,gemini-2.0-flash,gemini-1.5-flash')
  .split(',')
  .map(modelName => modelName.trim())
  .filter(Boolean);
const modelsToTry = [...new Set([requestedModel, ...fallbackModels])];

if (!apiKey) {
  console.error('Missing GEMINI_API_KEY. Add it as a GitHub Actions secret or local environment variable.');
  process.exit(1);
}

const rawFile = findLatestRaw(tmpDir);
if (!rawFile) {
  console.error(`No raw-*.json file found in ${tmpDir}`);
  process.exit(1);
}

const key = path.basename(rawFile).replace(/^raw-/, '').replace(/\.json$/, '');
const outputFile = path.join(tmpDir, `summaries-${key}.md`);
const rawJson = fs.readFileSync(rawFile, 'utf8');
const rawItems = JSON.parse(rawJson);
const format = fs.readFileSync(path.join(ROOT, 'config', 'format.md'), 'utf8');
const guidance = fs.readFileSync(path.join(ROOT, 'agents', 'summarizer.md'), 'utf8');

const isChannel = key.startsWith('channel-');
const title = isChannel ? `# Channel News Digest — ${key}` : `# News Digest — ${key}`;

console.log(`Summarizing ${path.basename(rawFile)} with Gemini model preference: ${modelsToTry.join(' -> ')}`);

const enrichedRawItems = await enrichWithGeminiVideoTimestamps(rawItems);
const videoSummaries = [];

if (enrichedRawItems.length === 0) {
  const markdown = `${title}

수집 조건에 맞는 공개 영상이 없습니다.
`;
  fs.writeFileSync(outputFile, markdown);
  console.log(`Saved empty digest: ${outputFile}`);
  process.exit(0);
}

for (let i = 0; i < enrichedRawItems.length; i++) {
  const video = enrichedRawItems[i];
  console.log(`Summarizing video ${i + 1}/${enrichedRawItems.length}: ${video.title || video.videoId}`);
  const summary = await summarizeVideo(video, i + 1, enrichedRawItems.length);
  videoSummaries.push({ video, summary });
}

const markdown = assembleDigest(title, videoSummaries);

fs.writeFileSync(outputFile, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
console.log(`Saved: ${outputFile}`);

async function summarizeVideo(video, index, total) {
  const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
  if (isInsufficientVideo(video)) {
    return unavailableVideoMarkdown(video, videoUrl);
  }

  const prompt = `You are writing one Korean YouTube video summary for a morning news digest.

This is video ${index} of ${total}. Focus only on this video. Do not summarize other videos.

Output requirements:
- Return markdown only. No code fence. No explanations.
- Start with exactly one h2 video heading: ## [한국어 영상 제목](${videoUrl})
- The first sentence after **핵심 요약** must NOT restate the video title. Start with the speaker, issue, claim, or data point instead.
- Do NOT include a digest title, channel heading, upload date, view count, duration, or transcript indicator.
- Section order: **한 줄 인사이트** → **핵심 요약** → **주요 타임라인** when transcriptSegments or geminiTimestampNotes exist.
- 핵심 요약 = intro 1-2 sentences + 3-5 numbered points with bold sub-headings. Each point has 1-3 sub-bullets.
- Use concrete names/companies/stocks/sectors/numbers/years from the transcript, description, or geminiTimestampNotes.
- If transcriptSegments has 3+ entries, include at least 3 inline timestamp links in 핵심 요약 using exact segment start times: [HH:MM](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS), and include a **주요 타임라인** section with 3-6 linked entries.
- If transcriptSegments is empty but geminiTimestampNotes has 3+ entries, use those notes for at least 3 inline timestamp links and include a **주요 타임라인** section with 3-6 linked entries.
- If both transcriptSegments and geminiTimestampNotes are empty, do not invent timestamps and omit 주요 타임라인.
- Use exactly one inline timestamp per bullet. Two timestamps beside each other are not a range; avoid adjacent timestamp links like [03:07](...) [05:40](...). Put extra moments in 주요 타임라인 instead.
- No blockquote > prefix. No generic takeaway or 실무 적용 sentences. Stay faithful to what the speaker actually says.

Teaser-resolution requirements, very important:
- Korean finance/news titles often hide the answer behind teaser phrases such as "이 주식", "이 종목", "이 섹터", "3가지", "딱 4개", "수혜주", "유망섹터".
- In the summary, never use those teaser phrases as if they were the answer.
- Resolve the actual named stock, company, sector, place, policy, number, or example from the transcript/description/geminiTimestampNotes.
- For stock recommendations, name the actual company/ticker/sector when the speaker names it. Separate direct speaker claims from your inference.
- If the video never reveals the specific name, write "영상에서 구체명은 공개하지 않음" instead of repeating the teaser.

config/format.md:
${format}

agents/summarizer.md:
${guidance}

video JSON:
${JSON.stringify(video, null, 2)}`;

  const response = await callGeminiWithFallback(prompt);
  let markdown = normalizeVideoMarkdown(cleanMarkdown(extractText(response)), video);

  if (hasResolvableTeaserPlaceholder(markdown)) {
    console.log(`Retrying teaser resolution for: ${video.title || video.videoId}`);
    const retryResponse = await callGeminiWithFallback(`${prompt}

Previous markdown still contained unresolved teaser wording such as 이 주식, 이 종목, or 이 섹터:
${markdown}

Rewrite the same markdown, preserving the required format, but replace every unresolved teaser phrase with the actual named stock/company/sector from the video JSON. If the video never reveals it, write "영상에서 구체명은 공개하지 않음".`);
    markdown = normalizeVideoMarkdown(cleanMarkdown(extractText(retryResponse)), video);
  }

  return markdown;
}

function hasResolvableTeaserPlaceholder(markdown) {
  return /(?:'|"|‘|“)?(이 주식|이 종목|이 섹터)(?:'|"|’|”)?/.test(markdown) && !/영상에서 구체명은 공개하지 않음/.test(markdown);
}

function isInsufficientVideo(video) {
  const sourceText = [video.transcript, video.description]
    .filter(Boolean)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  const hasSegments = (video.transcriptSegments || []).length >= 3;
  const hasTimestampNotes = (video.geminiTimestampNotes || []).length >= 3;
  return !hasSegments && !hasTimestampNotes && sourceText.length < 300;
}

function unavailableVideoMarkdown(video, videoUrl) {
  const fallbackTitle = String(video.title || '내용 부족 영상')
    .replace(/[\[\]\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return `## [${fallbackTitle}](${videoUrl})

**한 줄 인사이트**
💡 자막과 설명이 충분하지 않아 신뢰할 수 있는 요약을 만들 수 없습니다.

**핵심 요약**
이 영상은 자막, 설명, Gemini timestamp notes가 충분하지 않아 핵심 내용을 검증할 수 없습니다.

1. **내용 부족**
   - 영상에서 구체적인 발언, 종목, 수치, 정책 내용을 확인할 수 없어 요약을 보류합니다.
   - 멤버십 전용, 비공개, 자막 미제공, 또는 설명 부족 영상일 가능성이 있습니다.`;
}

function normalizeVideoMarkdown(markdown, video) {
  let cleaned = markdown
    .replace(/^#\s+[^\n]*\n+/, '')
    .replace(/^###\s+📺[^\n]*\n+/m, '')
    .replace(/\n---\s*$/g, '')
    .trim();

  if (!/^##\s+\[[^\]]+\]\(https:\/\/www\.youtube\.com\/watch\?v=/m.test(cleaned)) {
    const fallbackTitle = String(video.title || '영상 요약').replace(/[\[\]\n]/g, ' ').replace(/\s+/g, ' ').trim();
    cleaned = `## [${fallbackTitle}](https://www.youtube.com/watch?v=${video.videoId})\n\n${cleaned}`;
  }

  return cleaned;
}

function assembleDigest(digestTitle, entries) {
  const lines = [digestTitle, ''];
  let currentChannelKey = '';

  for (const { video, summary } of entries) {
    const handle = String(video.channel || '').startsWith('@') ? video.channel : `@${video.channel || ''}`;
    const channelKey = handle || video.channelName || 'unknown';
    if (channelKey !== currentChannelKey) {
      if (currentChannelKey) lines.push('---', '');
      lines.push(`### 📺 [${video.channelName || handle || 'Unknown Channel'}](https://www.youtube.com/${handle})`, '');
      currentChannelKey = channelKey;
    } else {
      lines.push('---', '');
    }

    lines.push(summary.trim(), '');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function findLatestRaw(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(file => file.startsWith('raw-') && file.endsWith('.json'))
    .map(file => ({ file, mtime: fs.statSync(path.join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(dir, files[0].file) : null;
}

async function callGeminiWithFallback(text) {
  const errors = [];

  for (const model of modelsToTry) {
    console.log(`Trying Gemini model: ${model}`);
    try {
      const response = await callGemini(model, text);
      console.log(`Using Gemini model: ${model}`);
      return response;
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
      if (!isMissingModelError(err) && !isQuotaError(err)) throw err;
      console.warn(`${isQuotaError(err) ? 'Model quota exhausted' : 'Model unavailable'}, trying fallback: ${model}`);
    }
  }

  throw new Error(`No configured Gemini model worked. Tried: ${modelsToTry.join(', ')}\n${errors.join('\n')}`);
}

async function enrichWithGeminiVideoTimestamps(items) {
  if (process.env.GEMINI_YOUTUBE_FALLBACK === 'false') return items;

  const maxVideos = Math.max(0, parseInt(process.env.GEMINI_YOUTUBE_FALLBACK_LIMIT || '2', 10) || 2);
  let enriched = 0;
  let quotaExhausted = false;
  const output = [];

  for (const item of items) {
    const clone = { ...item };
    const hasSegments = (clone.transcriptSegments || []).length >= 3;
    if (!hasSegments && clone.videoId && enriched < maxVideos && !quotaExhausted) {
      try {
        clone.geminiTimestampNotes = await callGeminiVideoTimestampsWithFallback(clone);
        if (clone.geminiTimestampNotes.length >= 3) {
          enriched++;
          console.log(`Added Gemini video timestamp fallback: ${clone.videoId} (${clone.geminiTimestampNotes.length} notes)`);
        }
      } catch (err) {
        if (isQuotaError(err)) {
          quotaExhausted = true;
          console.warn(`Gemini video timestamp fallback paused after quota limit: ${err.message}`);
        } else {
          console.warn(`Gemini video timestamp fallback skipped for ${clone.videoId}: ${err.message}`);
        }
        clone.geminiTimestampNotes = [];
      }
    }
    output.push(clone);
  }

  return output;
}

async function callGeminiVideoTimestampsWithFallback(video) {
  const errors = [];
  for (const model of modelsToTry) {
    try {
      return await callGeminiVideoTimestamps(model, video);
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
      if (isQuotaError(err)) throw err;
      if (!isMissingModelError(err) && !isVideoInputModelError(err)) throw err;
    }
  }
  throw new Error(`No configured Gemini model worked for YouTube timestamp fallback. ${errors.join(' | ')}`);
}

async function callGeminiVideoTimestamps(model, video) {
  const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
  const text = `Analyze this YouTube video and return Korean timestamp notes for a morning news digest.

Return JSON only, no markdown, with this exact shape:
{
  "notes": [
    { "time": "MM:SS", "seconds": 0, "label": "Korean concrete point from the video" }
  ]
}

Requirements:
- Create 5 to 8 notes when possible.
- Use timestamps that actually correspond to the video.
- Keep labels factual and specific: names, numbers, companies, policies, or claims.
- Do not add generic advice.
- Video title: ${video.title || ''}`;

  const response = await callGemini(model, text, [
    { file_data: { file_uri: videoUrl } },
    { text }
  ]);
  return normalizeTimestampNotes(extractJsonObject(extractText(response)).notes || [], video.videoId);
}

async function callGemini(model, text, parts = [{ text }]) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts
        }
      ],
      generationConfig: {
        temperature: 0.2,
        topP: 0.8
      }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    const error = new Error(`Gemini API failed (${res.status}): ${err.slice(0, 1200)}`);
    error.status = res.status;
    error.body = err;
    throw error;
  }
  return res.json();
}

function extractJsonObject(text) {
  const cleaned = cleanMarkdown(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`Gemini did not return JSON: ${cleaned.slice(0, 300)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeTimestampNotes(notes, videoId) {
  return notes
    .map(note => {
      const seconds = Number.isFinite(note.seconds) ? Math.max(0, Math.floor(note.seconds)) : parseTimestamp(note.time);
      const label = String(note.label || '').replace(/\s+/g, ' ').trim();
      if (!Number.isFinite(seconds) || !label) return null;
      return {
        time: formatCompactTimestamp(seconds),
        seconds,
        label,
        url: `https://www.youtube.com/watch?v=${videoId}&t=${seconds}`
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function parseTimestamp(value) {
  const parts = String(value || '').split(':').map(part => parseInt(part, 10));
  if (parts.some(part => !Number.isFinite(part))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

function formatCompactTimestamp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function isMissingModelError(err) {
  return err?.status === 404 || /not found|NOT_FOUND|not supported for generateContent/i.test(err?.body || err?.message || '');
}

function isQuotaError(err) {
  return err?.status === 429 || /RESOURCE_EXHAUSTED|quota exceeded|rate[- ]?limit/i.test(err?.body || err?.message || '');
}

function isVideoInputModelError(err) {
  return /file[_ ]?data|video|youtube|unsupported|not supported/i.test(err?.body || err?.message || '');
}

function extractText(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(part => part.text || '').join('\n').trim();
  if (!text) {
    throw new Error(`Gemini response did not contain text: ${JSON.stringify(response).slice(0, 1000)}`);
  }
  return text;
}

function cleanMarkdown(text) {
  return text
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}
