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
const fallbackModels = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash,gemini-2.0-flash,gemini-1.5-flash')
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
const format = fs.readFileSync(path.join(ROOT, 'config', 'format.md'), 'utf8');
const guidance = fs.readFileSync(path.join(ROOT, 'agents', 'summarizer.md'), 'utf8');

const isChannel = key.startsWith('channel-');
const title = isChannel ? `# Channel News Digest — ${key}` : `# News Digest — ${key}`;

console.log(`Summarizing ${path.basename(rawFile)} with Gemini model preference: ${modelsToTry.join(' -> ')}`);

const prompt = `You are writing a Korean morning news digest from collected YouTube transcript JSON.

SOURCE OF TRUTH: Follow config/format.md and agents/summarizer.md exactly. The review script will reject malformed output.

Output destination: tmp/summaries-${key}.md
First line must be exactly: ${title}

Hard requirements:
- Write Korean summaries, even if a video title or transcript is English.
- Video h2 display titles MUST be Korean. If a raw title is English or YouTube auto-translated English, translate it back into natural Korean based on the raw title and transcript context. Preserve proper nouns like GTX, AI, Fed, USDT, company names, and guest names.
- Group videos by channel under channel h3 headings: ### 📺 [ChannelName](https://www.youtube.com/@CHANNEL_HANDLE)
- Each video title must be h2 with a Korean clickable YouTube link: ## [한국어 제목](https://www.youtube.com/watch?v=VIDEO_ID)
- Section order per video: 한 줄 인사이트 → 핵심 요약 → optional 주요 타임라인.
- Prefer omitting 주요 타임라인 when 핵심 요약 already has 3+ inline timestamp links.
- For every video object, inspect transcriptSegments before writing.
- If transcriptSegments has 3+ entries, 핵심 요약 MUST contain at least 3 inline timestamp links using exact segment start times: [[HH:MM](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS)]. Put them inside the numbered bullet body.
- Do NOT write [자막 기반 타임라인 없음] for any video with transcriptSegments.
- If transcriptSegments is empty, do not invent timestamps; omit 주요 타임라인.
- 핵심 요약 = intro 1-2 sentences + 3-5 numbered points with bold sub-headings. Each point has 1-3 sub-bullets containing concrete names/companies/numbers/years from the transcript.
- No blockquote > prefix. No generic takeaway or 실무 적용 sentences. Stay faithful to the video.
- Do NOT include upload dates, view counts, duration, or transcript indicators.
- Put --- between videos.
- Return markdown only. Do not wrap in a code fence. Do not explain your process.

config/format.md:
${format}

agents/summarizer.md:
${guidance}

raw JSON:
${rawJson}`;

const response = await callGeminiWithFallback(prompt);
const markdown = cleanMarkdown(extractText(response));

if (!markdown.startsWith(title)) {
  console.error(`Gemini output did not start with required title: ${title}`);
  process.exit(1);
}

fs.writeFileSync(outputFile, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
console.log(`Saved: ${outputFile}`);

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
      if (!isMissingModelError(err)) throw err;
      console.warn(`Model unavailable, trying fallback: ${model}`);
    }
  }

  throw new Error(`No configured Gemini model worked. Tried: ${modelsToTry.join(', ')}\n${errors.join('\n')}`);
}

async function callGemini(model, text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text }]
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

function isMissingModelError(err) {
  return err?.status === 404 || /not found|NOT_FOUND|not supported for generateContent/i.test(err?.body || err?.message || '');
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
