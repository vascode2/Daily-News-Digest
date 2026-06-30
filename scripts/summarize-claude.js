#!/usr/bin/env node
/**
 * summarize-claude.js — Generate tmp/summaries-*.md from the latest tmp/raw-*.json using Anthropic Claude.
 *
 * Mirrors scripts/summarize-gemini.js, but uses the Anthropic Messages API.
 * Note: Claude does not ingest YouTube URLs natively. When a video has no
 * transcript (e.g. captions blocked on CI datacenter IPs), Gemini ingests the
 * YouTube URL server-side to recover the content, which Claude then summarizes.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tmpDir = path.join(ROOT, 'tmp');

const apiKey = process.env.ANTHROPIC_API_KEY;
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_OAUTH_TOKEN;
const requestedModel = process.env.CLAUDE_MODEL || 'claude-opus-4-7';
const claudeRequestTimeoutMs = Math.max(30000, parseInt(process.env.CLAUDE_REQUEST_TIMEOUT_MS || '180000', 10) || 180000);
const claudeMaxTokens = Math.max(1024, parseInt(process.env.CLAUDE_MAX_TOKENS || '4096', 10) || 4096);
const fallbackModels = (process.env.CLAUDE_FALLBACK_MODELS || 'claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);
const modelsToTry = [...new Set([requestedModel, ...fallbackModels])];

// Inter-request delay between videos to stay below Anthropic per-minute token limits.
const interRequestDelayMs = Math.max(0, parseInt(process.env.CLAUDE_INTER_REQUEST_DELAY_MS || '2000', 10) || 0);
// Per-model retries on transient (429 rate limit / 529 overloaded) errors before moving to the next model.
const transientMaxRetries = Math.max(0, parseInt(process.env.CLAUDE_TRANSIENT_MAX_RETRIES || '2', 10) || 0);
const transientBaseBackoffMs = Math.max(500, parseInt(process.env.CLAUDE_TRANSIENT_BACKOFF_MS || '5000', 10) || 5000);

// Optional Gemini fallback chain when all Claude models fail.
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiFallbackModels = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3-fast,gemini-2.5-flash,gemini-2.5-flash-lite')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);
const geminiRequestTimeoutMs = Math.max(30000, parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || '180000', 10) || 180000);

// Gemini-based transcript recovery. YouTube blocks caption downloads from
// datacenter IPs (e.g. GitHub Actions), so videos collected in CI often have
// no transcript and degrade to a "자막 데이터가 제공되지 않아…" disclaimer. Gemini
// ingests the YouTube URL server-side (Google → YouTube), bypassing that block,
// so we ask it to watch the video and return a substantive summary that Claude
// then uses as the content source. On by default whenever GEMINI_API_KEY exists.
const geminiVideoRecovery = process.env.GEMINI_VIDEO_RECOVERY !== 'false' && Boolean(geminiApiKey);
const geminiVideoRecoveryLimit = Math.max(0, parseInt(process.env.GEMINI_VIDEO_RECOVERY_LIMIT || '20', 10) || 20);
// Delay between recovery calls helps stay under Gemini's per-minute limits so
// more caption-less videos get recovered before the quota trips.
const geminiRecoveryDelayMs = Math.max(0, parseInt(process.env.GEMINI_RECOVERY_DELAY_MS || '4000', 10) || 0);
// Per-video retries on a 429 before giving up on that model.
const geminiRecoveryMaxRetries = Math.max(0, parseInt(process.env.GEMINI_RECOVERY_MAX_RETRIES || '1', 10) || 0);
const geminiRecoveryBackoffMs = Math.max(0, parseInt(process.env.GEMINI_RECOVERY_BACKOFF_MS || '15000', 10) || 0);

if (!apiKey && !oauthToken) {
  console.error('Missing ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN. Add one as a GitHub Actions secret or local environment variable.');
  process.exit(1);
}
const authMode = apiKey ? 'api-key' : 'oauth';
console.log(`Claude auth mode: ${authMode}`);

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

console.log(`Summarizing ${path.basename(rawFile)} with Claude model preference: ${modelsToTry.join(' -> ')}`);

const videoSummaries = [];

if (rawItems.length === 0) {
  const markdown = `${title}

수집 조건에 맞는 공개 영상이 없습니다.
`;
  fs.writeFileSync(outputFile, markdown);
  console.log(`Saved empty digest: ${outputFile}`);
  process.exit(0);
}

await recoverMissingTranscriptsWithGemini(rawItems);

for (let i = 0; i < rawItems.length; i++) {
  const video = rawItems[i];
  console.log(`Summarizing video ${i + 1}/${rawItems.length}: ${video.title || video.videoId}`);
  if (i > 0 && interRequestDelayMs > 0) {
    await sleep(interRequestDelayMs);
  }
  const summary = await summarizeVideo(video, i + 1, rawItems.length);
  videoSummaries.push({ video, summary });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
- Start with exactly one h2 video heading: ## [영상 제목](${videoUrl})
- Title language rule, very important: write the heading title in the SAME language the speaker actually uses in the video. The video JSON title field is the creator's chosen title and is sometimes English even on Korean-spoken channels — do NOT copy an English title for a Korean video. If the video is spoken in Korean, render a natural Korean title (translate or rewrite the English/foreign title into concise Korean that reflects the real content). Only keep an English/foreign title if the video itself is actually spoken in that language.
- The first sentence after **핵심 요약** must NOT restate the video title. Start with the speaker, issue, claim, or data point instead.
- Do NOT include a digest title, channel heading, upload date, view count, duration, or transcript indicator.
- Section order: **한 줄 인사이트** → **핵심 요약** → **주요 타임라인** when transcriptSegments or geminiTimestampNotes exist.
- 핵심 요약 = intro 1-2 sentences + 3-5 numbered points with bold sub-headings. Each point has 1-3 sub-bullets.
- Use concrete names/companies/stocks/sectors/numbers/years from the transcript or description.
- If transcriptSegments has 3+ entries, include at least 3 inline timestamp links in 핵심 요약 using exact segment start times: [HH:MM](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS), and include a **주요 타임라인** section with 3-6 linked entries.
- If transcriptSegments is empty but geminiVideoSummary (a Gemini analysis of the actual video) is present, treat geminiVideoSummary as the primary content source — write a full, specific summary from it. If geminiTimestampNotes has 3+ entries, build at least 3 inline timestamp links and a **주요 타임라인** from those notes. Do NOT say transcripts are unavailable.
- If transcriptSegments and geminiVideoSummary are both empty, summarize from the available title and description only. Extract every concrete fact, name, number, and claim the title/description/hashtags actually contain — be substantive, not vague. State the transcript limitation briefly and at most ONCE (a single short clause in the intro, e.g. "자막이 없어 제목·설명 기준으로 정리"); never repeat "자막 미제공/확인 불가" in individual bullets. Do not invent timestamps and omit 주요 타임라인.
- Use exactly one inline timestamp per bullet. Two timestamps beside each other are not a range; avoid adjacent timestamp links like [03:07](...) [05:40](...). Put extra moments in 주요 타임라인 instead.
- No blockquote > prefix. No generic takeaway or 실무 적용 sentences. Stay faithful to what the speaker actually says.

Teaser-resolution requirements, very important:
- Korean finance/news titles often hide the answer behind teaser phrases such as "이 주식", "이 종목", "이 섹터", "3가지", "딱 4개", "수혜주", "유망섹터".
- In the summary, never use those teaser phrases as if they were the answer.
- Resolve the actual named stock, company, sector, place, policy, number, or example from the transcript/description.
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
    markdown = normalizeVideoMarkdown(cleanMarkdown(await callClaudeWithFallback(prompt)), video);

    if (hasResolvableTeaserPlaceholder(markdown)) {
      console.log(`Retrying teaser resolution for: ${video.title || video.videoId}`);
      const retryText = await callClaudeWithFallback(`${prompt}

Previous markdown still contained unresolved teaser wording such as 이 주식, 이 종목, or 이 섹터:
${markdown}

Rewrite the same markdown, preserving the required format, but replace every unresolved teaser phrase with the actual named stock/company/sector from the video JSON. If the video never reveals it, write "영상에서 구체명은 공개하지 않음".`);
      markdown = normalizeVideoMarkdown(cleanMarkdown(retryText), video);
    }
  } catch (err) {
    console.warn(`Claude summary fallback for ${video.videoId}: ${err.message}`);
    markdown = buildFallbackVideoMarkdown(video, err);
  }

  return markdown;
}

function buildFallbackVideoMarkdown(video, err = null) {
  const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
  const titleText = String(video.title || '영상 요약').replace(/[\[\]\n]/g, ' ').replace(/\s+/g, ' ').trim();
  const geminiNotes = Array.isArray(video.geminiTimestampNotes) ? video.geminiTimestampNotes : [];
  const description = neutralizeFallbackTeasers(
    (video.geminiVideoSummary && firstUsefulSentence(video.geminiVideoSummary))
    || firstUsefulSentence(video.description)
    || '영상 설명에서 확인 가능한 세부 정보가 제한적입니다.'
  );
  const segments = selectFallbackTimelineSegments(video);
  const channelName = video.channelName || video.channel || '채널';

  const overview = video.geminiVideoSummary
    ? trimToSentence(video.geminiVideoSummary, 600)
    : description;

  const lines = [
    `## [${titleText}](${videoUrl})`,
    '',
    '**한 줄 인사이트**',
    '',
    `💡 ${description}`,
    '',
    '**핵심 요약**',
    '',
    video.geminiVideoSummary
      ? `${channelName} 영상을 분석한 내용 요약입니다.`
      : `${channelName} 영상의 자동 요약 응답이 제한되어 제목·설명만으로 보수적으로 정리한 사례입니다. 영상 본문에서 직접 확인이 권장됩니다.`,
    '',
    '**영상 개요**',
    '',
    `- ${overview}`,
    `- 채널: ${channelName}`,
    ''
  ];

  if (geminiNotes.length >= 3) {
    lines.push('**주요 타임라인**', '');
    for (const n of geminiNotes) {
      lines.push(`- [${formatCompactTimestamp(n.seconds)}](${n.url}) ${n.label}`);
    }
  } else if (segments.length >= 3) {
    lines.push('**주요 타임라인**', '');
    for (const segment of segments) {
      lines.push(`- [${formatCompactTimestamp(segment.seconds)}](${videoUrl}&t=${segment.seconds}) ${segment.text}`);
    }
  }

  // When Gemini recovery already produced a substantive summary + timeline, the
  // output above is genuine content (just assembled without a final LLM pass),
  // so suppress the alarming "자동 요약이 제한된 상태" warning. Only show it when
  // we truly fell back to title/description with no recovered transcript.
  const hasRecoveredContent = Boolean(video.geminiVideoSummary) && (geminiNotes.length >= 3 || segments.length >= 3);
  if (!hasRecoveredContent) {
    if (err) {
      const reason = String(err.message || '').replace(/\s+/g, ' ').slice(0, 220);
      lines.push('', `> ⚠️ 자동 요약 응답이 제한되어 제목·설명 기준으로만 정리했습니다. (사유: ${reason})`);
    } else {
      lines.push('', '> ⚠️ 자동 요약 응답이 제한되어 제목·설명 기준으로만 정리했습니다.');
    }
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

  const lines = cleaned.split('\n');
  let keptVideoH2 = false;
  const filtered = lines.filter(line => {
    if (!/^##\s+/.test(line)) return true;
    if (!keptVideoH2 && line.includes(`watch?v=${video.videoId}`)) {
      keptVideoH2 = true;
      return true;
    }
    if (/^##\s+\[[^\]]+\]\([^)]+\)\s*$/.test(line)) return false;
    return true;
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

async function callClaudeWithFallback(text) {
  const errors = [];

  for (const model of modelsToTry) {
    for (let attempt = 0; attempt <= transientMaxRetries; attempt++) {
      console.log(`Trying Claude model: ${model}${attempt > 0 ? ` (retry ${attempt}/${transientMaxRetries})` : ''}`);
      try {
        const response = await callClaude(model, text);
        const responseText = extractText(response);
        console.log(`Using Claude model: ${model}`);
        return responseText;
      } catch (err) {
        errors.push(`${model}#${attempt}: ${err.message}`);
        const transient = isOverloadError(err) || isQuotaError(err) || (Number.isFinite(err?.status) && err.status >= 500);
        if (transient && attempt < transientMaxRetries) {
          const backoff = transientBaseBackoffMs * Math.pow(2, attempt);
          console.warn(`Claude transient error on ${model}, backing off ${backoff}ms then retrying. (${String(err.message).slice(0, 160)})`);
          await sleep(backoff);
          continue;
        }
        if (!isRetryableClaudeError(err)) throw err;
        console.warn(`Claude text response failed, trying next model after ${model} (${String(err.message).slice(0, 160)})`);
        break;
      }
    }
  }

  if (geminiApiKey && geminiFallbackModels.length) {
    console.warn(`All Claude models exhausted; falling back to Gemini (${geminiFallbackModels.join(' -> ')}).`);
    try {
      return await callGeminiWithFallback(text);
    } catch (geminiErr) {
      errors.push(`gemini-fallback: ${geminiErr.message}`);
    }
  }

  throw new Error(`No configured model returned usable text. Tried Claude: ${modelsToTry.join(', ')}${geminiApiKey ? ` then Gemini: ${geminiFallbackModels.join(', ')}` : ''} | ${errors.join(' | ')}`);
}

async function callGeminiWithFallback(prompt) {
  const errors = [];
  for (const model of geminiFallbackModels) {
    console.log(`Trying Gemini fallback model: ${model}`);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(geminiRequestTimeoutMs),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, topP: 0.8 }
        })
      });
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Gemini API failed (${res.status}): ${body.slice(0, 600)}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      const json = await res.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const text = parts.map(p => p?.text || '').join('\n').trim();
      if (!text) throw new Error(`Gemini response had no text: ${JSON.stringify(json).slice(0, 400)}`);
      console.log(`Using Gemini fallback model: ${model}`);
      return text;
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
      const status = err?.status;
      const retryable = status === 404 || status === 429 || status === 503 || (Number.isFinite(status) && status >= 500);
      if (!retryable) throw err;
      console.warn(`Gemini fallback ${model} failed, trying next. (${String(err.message).slice(0, 160)})`);
    }
  }
  throw new Error(`Gemini fallback exhausted: ${errors.join(' | ')}`);
}

async function recoverMissingTranscriptsWithGemini(items) {
  if (!geminiVideoRecovery || geminiVideoRecoveryLimit === 0) return;

  const targets = items.filter(v => v.videoId && (v.transcriptSegments || []).length < 3);
  if (targets.length === 0) return;

  // Prioritize the neediest videos: those with the least description text gain
  // the most from a Gemini watch-through, so spend the scarce quota there first.
  targets.sort((a, b) => (a.description || '').length - (b.description || '').length);

  console.log(`Gemini transcript recovery: ${Math.min(targets.length, geminiVideoRecoveryLimit)} video(s) lack captions; analyzing via Gemini video input.`);
  let recovered = 0;
  let attempted = 0;
  const deadModels = new Set();

  for (const video of targets) {
    if (recovered >= geminiVideoRecoveryLimit) break;
    if (deadModels.size >= geminiFallbackModels.length) {
      console.warn('  Gemini recovery paused: all models quota-exhausted.');
      break;
    }
    if (attempted > 0 && geminiRecoveryDelayMs > 0) await sleep(geminiRecoveryDelayMs);
    attempted++;
    try {
      const result = await callGeminiVideoSummaryWithFallback(video, deadModels);
      if (result?.summary && result.summary.length > 80) {
        video.geminiVideoSummary = result.summary;
        video.geminiTimestampNotes = result.notes;
        recovered++;
        console.log(`  ✅ Recovered ${video.videoId} via Gemini (${result.summary.length} chars, ${result.notes.length} notes)`);
      }
    } catch (err) {
      console.warn(`  Gemini recovery skipped for ${video.videoId}: ${String(err.message).slice(0, 160)}`);
    }
  }
  console.log(`Gemini transcript recovery: ${recovered} recovered.`);
}

async function callGeminiVideoSummaryWithFallback(video, deadModels = new Set()) {
  const models = [...new Set([...geminiFallbackModels])].filter(m => !deadModels.has(m));
  const errors = [];
  for (const model of models) {
    for (let attempt = 0; attempt <= geminiRecoveryMaxRetries; attempt++) {
      try {
        return await callGeminiVideoSummary(model, video);
      } catch (err) {
        errors.push(`${model}: ${err.message}`);
        if (isQuotaError(err)) {
          // A 429 is often a per-minute limit; back off and retry the same model
          // before declaring it dead for the rest of the run.
          if (attempt < geminiRecoveryMaxRetries && geminiRecoveryBackoffMs > 0) {
            const wait = geminiRecoveryBackoffMs * Math.pow(2, attempt);
            console.warn(`  Gemini ${model} hit 429; backing off ${Math.round(wait / 1000)}s then retrying.`);
            await sleep(wait);
            continue;
          }
          deadModels.add(model);
          console.warn(`  Gemini model ${model} quota-exhausted; rotating to next model.`);
          break;
        }
        if (!isMissingModelError(err) && !isVideoInputModelError(err)) throw err;
        break;
      }
    }
  }
  throw new Error(`No Gemini model accepted video input. ${errors.join(' | ')}`);
}

async function callGeminiVideoSummary(model, video) {
  const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
  const dur = Number.isFinite(video.duration) ? `${video.duration} seconds` : 'unknown';
  const text = `Watch this Korean YouTube video and extract its content for a news digest. Return JSON only, no markdown:
{
  "summary": "8-15 sentence Korean summary of what the speaker actually says: specific names, companies, numbers, claims. No teasers, no generic advice.",
  "notes": [ { "time": "MM:SS", "seconds": 0, "label": "concrete Korean point at this moment" } ]
}
Requirements:
- 5 to 8 notes; every seconds value within video duration (${dur}).
- Title: ${video.title || ''}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(geminiRequestTimeoutMs),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ file_data: { file_uri: videoUrl } }, { text }] }],
      generationConfig: { temperature: 0.2, topP: 0.8 }
    })
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Gemini video API failed (${res.status}): ${body.slice(0, 600)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const out = parts.map(p => p?.text || '').join('\n').trim();
  const obj = extractJsonObject(out);
  return { summary: String(obj.summary || '').trim(), notes: normalizeTimestampNotes(obj.notes || [], video.videoId, video.duration) };
}

function extractJsonObject(text) {
  if (!text) return {};
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
}

function normalizeTimestampNotes(notes, videoId, duration) {
  if (!Array.isArray(notes)) return [];
  const max = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return notes
    .map(n => {
      const seconds = Math.max(0, Math.floor(Number(n.seconds)));
      const label = cleanSentence(String(n.label || ''));
      if (!Number.isFinite(seconds) || seconds > max || !label) return null;
      return { seconds, label, url: `https://www.youtube.com/watch?v=${videoId}&t=${seconds}` };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function isVideoInputModelError(err) {
  return /file[_ ]?data|video|youtube|unsupported|not supported/i.test(err?.body || err?.message || '');
}

async function callClaude(model, prompt) {
  const url = 'https://api.anthropic.com/v1/messages';
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01'
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  } else {
    headers['authorization'] = `Bearer ${oauthToken}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  }

  const body = {
    model,
    max_tokens: claudeMaxTokens,
    messages: [
      { role: 'user', content: prompt }
    ]
  };
  if (!apiKey) {
    // Claude Code OAuth tokens require the standard Claude Code system prompt as the first system block.
    body.system = [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text', text: 'You are summarizing Korean YouTube videos for a morning news digest. Follow the user instructions exactly and return markdown only.' }
    ];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(claudeRequestTimeoutMs),
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const bodyText = await res.text();
    const error = new Error(`Claude API failed (${res.status}): ${bodyText.slice(0, 1200)}`);
    error.status = res.status;
    error.body = bodyText;
    throw error;
  }
  return res.json();
}

function extractText(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const text = blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
  if (!text) {
    const stop = response?.stop_reason || 'unknown';
    throw new Error(`Claude response did not contain text (stop_reason=${stop}): ${JSON.stringify(response).slice(0, 800)}`);
  }
  return text;
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

// Clean markdown/whitespace from text and trim to maxLen, cutting at the last
// sentence boundary so the overview never ends mid-word (e.g. "작용하기 어렵습니").
function trimToSentence(text, maxLen = 600) {
  const cleaned = String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[#>*_`\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  const window = cleaned.slice(0, maxLen);
  const lastBoundary = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
    window.lastIndexOf('다. '),
    window.lastIndexOf('다.'),
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？')
  );
  if (lastBoundary >= maxLen * 0.5) {
    return cleaned.slice(0, lastBoundary + 1).trim();
  }
  const lastSpace = window.lastIndexOf(' ');
  return `${(lastSpace >= maxLen * 0.5 ? window.slice(0, lastSpace) : window).trim()}…`;
}

function segmentStartSeconds(value) {
  if (Number.isFinite(value)) return Math.max(0, Math.floor(value));
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
  return err?.status === 404 || /not_found|model.*not.*(found|exist|available)/i.test(err?.body || err?.message || '');
}

function isOverloadError(err) {
  return err?.status === 529 || /overloaded/i.test(err?.body || err?.message || '');
}

function isQuotaError(err) {
  return err?.status === 429 || /rate[_ -]?limit|quota|exceeded/i.test(err?.body || err?.message || '');
}

function isRetryableClaudeError(err) {
  return isMissingModelError(err) ||
    isOverloadError(err) ||
    isQuotaError(err) ||
    (Number.isFinite(err?.status) && err.status >= 500) ||
    /Claude response did not contain text/i.test(err?.message || '');
}

function cleanMarkdown(text) {
  return text
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}
