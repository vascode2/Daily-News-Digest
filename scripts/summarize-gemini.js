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
const requestedModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const geminiRequestTimeoutMs = Math.max(30000, parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || '180000', 10) || 180000);
const fallbackModels = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash,gemini-1.5-flash')
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
- If both transcriptSegments and geminiTimestampNotes are empty, summarize from the available title and description only. Be conservative, clearly say when details are not available, do not invent timestamps, and omit 주요 타임라인.
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

  let markdown;
  try {
    markdown = normalizeVideoMarkdown(cleanMarkdown(await callGeminiTextWithFallback(prompt)), video);

    if (hasResolvableTeaserPlaceholder(markdown)) {
      console.log(`Retrying teaser resolution for: ${video.title || video.videoId}`);
      const retryText = await callGeminiTextWithFallback(`${prompt}

Previous markdown still contained unresolved teaser wording such as 이 주식, 이 종목, or 이 섹터:
${markdown}

Rewrite the same markdown, preserving the required format, but replace every unresolved teaser phrase with the actual named stock/company/sector from the video JSON. If the video never reveals it, write "영상에서 구체명은 공개하지 않음".`);
      markdown = normalizeVideoMarkdown(cleanMarkdown(retryText), video);
    }
  } catch (err) {
    console.warn(`Gemini summary fallback for ${video.videoId} (${video.title?.slice(0,60) || ''}): ${err.message}`);
    markdown = buildFallbackVideoMarkdown(video, err);
  }

  return markdown;
}

function buildFallbackVideoMarkdown(video, err = null) {
  const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
  const title = String(video.title || '영상 요약').replace(/[\[\]\n]/g, ' ').replace(/\s+/g, ' ').trim();
  const description = neutralizeFallbackTeasers(firstUsefulSentence(video.description) || '영상 설명에서 확인 가능한 세부 정보가 제한적입니다.');
  const segments = selectFallbackTimelineSegments(video);
  const channelName = String(video.channelName || video.channel || '채널 미상').trim();

  const lines = [
    `## [${title}](${videoUrl})`,
    '',
    '**한 줄 인사이트**',
    `💡 ${description}`,
    '',
    '**핵심 요약**',
    `${channelName} 영상의 자동 요약 응답이 제한되어 제목·설명·자막 조각만으로 보수적으로 정리한 사례입니다. 영상 본문에서 직접 확인이 권장되며, 아래는 공개 메타데이터에서 확인 가능한 범위입니다.`,
    '',
    `1. **영상 개요**`,
    `   - ${description}`,
    `   - 채널: ${channelName}`,
    '',
    `2. **확인 권장 구간**`,
  ];

  if (segments.length >= 3) {
    const first = segments[0];
    lines.push(`   - 자막 기준으로 의미가 비교적 분명한 구간은 [${formatCompactTimestamp(first.seconds)}](${videoUrl}&t=${first.seconds})부터 확인할 수 있습니다.`);
    lines.push('', '**주요 타임라인**', '');
    for (const segment of segments) {
      lines.push(`- [${formatCompactTimestamp(segment.seconds)}](${videoUrl}&t=${segment.seconds}) ${segment.text}`);
    }
  } else {
    lines.push(`   - 자막 조각이 충분하지 않아 별도 타임라인은 제공되지 않습니다. 영상에서 직접 확인을 권장합니다.`);
    const reasonHint = err?.message ? `  (사유: ${err.message.slice(0, 200).replace(/\r?\n/g, ' ')})` : '';
    lines.push('', `> ⚠️ Gemini 응답이 제한되어 자동 요약이 제한된 상태입니다.${reasonHint}`);
  }

  return lines.join('\n').trim();
}

function selectFallbackTimelineSegments(video) {
  const rawSegments = (video.transcriptSegments || [])
    .map(segment => ({ seconds: segmentStartSeconds(segment.start), text: cleanSentence(segment.text) }))
    .filter(segment => Number.isFinite(segment.seconds) && isUsefulTimelineText(segment.text));

  if (rawSegments.length <= 6) return rawSegments;

  const targetCount = Math.min(6, Math.max(3, Math.ceil(rawSegments.length / 80)));
  const firstContentIndex = rawSegments.findIndex(segment => segment.seconds >= 30);
  const candidates = rawSegments.slice(firstContentIndex >= 0 ? firstContentIndex : 0);
  const selected = [];
  const minGapSeconds = 90;
  const stride = Math.max(1, Math.floor(candidates.length / targetCount));

  for (let index = 0; index < candidates.length && selected.length < targetCount; index += stride) {
    const segment = candidates[index];
    if (selected.every(existing => Math.abs(existing.seconds - segment.seconds) >= minGapSeconds)) {
      selected.push(segment);
    }
  }

  for (const segment of candidates) {
    if (selected.length >= targetCount) break;
    if (selected.every(existing => Math.abs(existing.seconds - segment.seconds) >= minGapSeconds)) {
      selected.push(segment);
    }
  }

  return selected.sort((left, right) => left.seconds - right.seconds).slice(0, 6);
}

function isUsefulTimelineText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length < 12) return false;
  if (/^(네|예|음|어|자|그|이제|근데|그래서|그리고|아니|맞습니다|그렇죠)[\s,.?!]*$/i.test(normalized)) return false;
  if (/^(구독|좋아요|알림|댓글|촬영일시|출연 신청|광고 문의|도서 구매)/.test(normalized)) return false;
  return /[가-힣A-Za-z0-9]/.test(normalized);
}

function neutralizeFallbackTeasers(text) {
  return String(text || '')
    .replace(/(?:'|"|‘|“)?이 주식(?:'|"|’|”)?/g, '영상에서 구체명은 공개하지 않음')
    .replace(/(?:'|"|‘|“)?이 종목(?:'|"|’|”)?/g, '영상에서 구체명은 공개하지 않음')
    .replace(/(?:'|"|‘|“)?이 섹터(?:'|"|’|”)?/g, '영상에서 구체 섹터명은 공개하지 않음');
}

function hasResolvableTeaserPlaceholder(markdown) {
  return /(?:'|"|‘|“)?(이 주식|이 종목|이 섹터)(?:'|"|’|”)?/.test(markdown) && !/영상에서 구체명은 공개하지 않음/.test(markdown);
}

function normalizeVideoMarkdown(markdown, video) {
  let cleaned = markdown
    .replace(/^#\s+[^\n]*\n+/, '')
    .replace(/^###\s+📺[^\n]*\n+/m, '')
    .replace(/\n---\s*$/g, '')
    .trim();

  // Find the first H2 that links to this video. Drop every other H2 line —
  // Gemini sometimes emits an extra unlinked `## [Title]` line in the body
  // that turns into a duplicate heading.
  const lines = cleaned.split('\n');
  let keptVideoH2 = false;
  const filtered = lines.filter(line => {
    if (!/^##\s+/.test(line)) return true;
    // Only treat H2 lines that contain a markdown link as candidate video-title headings.
    // Plain ## Section lines inside the body must be preserved.
    if (!/\[.+\]\(.+\)/.test(line)) return true;
    if (!keptVideoH2 && line.includes(`watch?v=${video.videoId}`)) {
      keptVideoH2 = true;
      return true;
    }
    return false;
  });
  cleaned = filtered.join('\n');

  if (!keptVideoH2) {
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

async function callGeminiTextWithFallback(text) {
  const errors = [];

  for (const model of modelsToTry) {
    console.log(`Trying Gemini model: ${model}`);
    try {
      const response = await callGemini(model, text);
      const responseText = extractText(response);
      console.log(`Using Gemini model: ${model}`);
      return responseText;
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
      if (!isRetryableGeminiTextError(err)) throw err;
      console.warn(`Gemini text response failed, trying fallback: ${model} (${err.message.slice(0, 160)})`);
    }
  }

  throw new Error(`No configured Gemini model returned usable text. Tried: ${modelsToTry.join(', ')}\n${errors.join('\n')}`);
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
- Every seconds value must be within the video duration: ${Number.isFinite(video.duration) ? `${video.duration} seconds` : 'unknown'}.
- Keep labels factual and specific: names, numbers, companies, policies, or claims.
- Do not add generic advice.
- Video title: ${video.title || ''}`;

  const response = await callGemini(model, text, [
    { file_data: { file_uri: videoUrl } },
    { text }
  ]);
  return normalizeTimestampNotes(extractJsonObject(extractText(response)).notes || [], video.videoId, video.duration);
}

async function callGemini(model, text, parts = [{ text }]) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(geminiRequestTimeoutMs),
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

function normalizeTimestampNotes(notes, videoId, duration) {
  const maxSeconds = Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null;
  return notes
    .map(note => {
      const seconds = Number.isFinite(note.seconds) ? Math.max(0, Math.floor(note.seconds)) : parseTimestamp(note.time);
      const label = String(note.label || '').replace(/\s+/g, ' ').trim();
      if (!Number.isFinite(seconds) || !label) return null;
      if (maxSeconds !== null && seconds > maxSeconds) return null;
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

function segmentStartSeconds(value) {
  if (Number.isFinite(value)) return Math.max(0, Math.floor(value));
  return parseTimestamp(value);
}

function firstUsefulSentence(text) {
  const cleaned = cleanSentence(text);
  if (!cleaned) return '';
  return cleaned.split(/(?<=[.!?。！？])\s+/).find(sentence => sentence.length >= 12) || cleaned.slice(0, 180);
}

function cleanSentence(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[#>*_`\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
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

function isRetryableGeminiTextError(err) {
  return isMissingModelError(err) ||
    isQuotaError(err) ||
    (Number.isFinite(err?.status) && err.status >= 500) ||
    /Gemini response did not contain text/i.test(err?.message || '');
}

function extractText(response) {
  const candidate = response?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.map(part => part.text || '').join('\n').trim();
  if (!text) {
    // Surface the *reason* Gemini returned no text so we can diagnose
    // safety blocks, MAX_TOKENS truncation, recitation, etc.
    const finishReason = candidate?.finishReason || 'UNKNOWN';
    const safety = (candidate?.safetyRatings || [])
      .filter(r => r.blocked || r.probability === 'HIGH' || r.probability === 'MEDIUM')
      .map(r => `${r.category}=${r.probability}${r.blocked ? '(blocked)' : ''}`)
      .join(', ');
    const promptBlock = response?.promptFeedback?.blockReason;
    const reasons = [
      `finishReason=${finishReason}`,
      safety ? `safety=[${safety}]` : null,
      promptBlock ? `promptBlocked=${promptBlock}` : null,
    ].filter(Boolean).join(' | ');
    throw new Error(`Gemini response had no text (${reasons})`);
  }
  return text;
}

function cleanMarkdown(text) {
  return text
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}
