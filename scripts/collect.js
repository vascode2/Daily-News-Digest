#!/usr/bin/env node
/**
 * collect.js — Fetch recent YouTube videos using yt-dlp
 * Usage: node scripts/collect.js [--days N] [--date YYYY-MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD]
 *   --days 1  (default) → yesterday only → tmp/raw-YYYY-MM-DD.json
 *   --days 7            → last 7 days   → tmp/raw-YYYY-MM-DD_to_YYYY-MM-DD.json
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Args
const argv = process.argv.slice(2);
const daysIdx = argv.indexOf('--days');
const days = daysIdx >= 0 ? Math.max(1, parseInt(argv[daysIdx + 1], 10) || 1) : 1;
const maxPerChannelIdx = argv.indexOf('--max-per-channel');
const maxPerChannel = maxPerChannelIdx >= 0 ? Math.max(1, parseInt(argv[maxPerChannelIdx + 1], 10) || 0) : 0; // 0 = unlimited
const maxVideosIdx = argv.indexOf('--max-videos');
const maxVideos = maxVideosIdx >= 0
  ? Math.max(1, parseInt(argv[maxVideosIdx + 1], 10) || 0)
  : Math.max(0, parseInt(process.env.DIGEST_MAX_VIDEOS || '0', 10) || 0); // 0 = unlimited
const channelIdx = argv.indexOf('--channel');
const singleChannel = channelIdx >= 0 ? argv[channelIdx + 1] : null;
const limitIdx = argv.indexOf('--limit');
const limit = limitIdx >= 0 ? Math.max(1, parseInt(argv[limitIdx + 1], 10) || 10) : 10;
const dateIdx = argv.indexOf('--date');
const dateArg = dateIdx >= 0 ? argv[dateIdx + 1] : null;
const fromIdx = argv.indexOf('--from');
const toIdx = argv.indexOf('--to');
const fromArg = fromIdx >= 0 ? argv[fromIdx + 1] : null;
const toArg = toIdx >= 0 ? argv[toIdx + 1] : null;

// Date range. Default = UTC, but DIGEST_TIMEZONE env var can shift the
// reference timezone (e.g. "Asia/Seoul", "America/New_York", or numeric "+09:00", "-05:00").
// "Yesterday" is computed in this timezone.
const tzOffsetMs = parseTimezoneOffset(process.env.DIGEST_TIMEZONE);
const nowAdjusted = new Date(Date.now() + tzOffsetMs);
let endDate = new Date(nowAdjusted);
endDate.setUTCDate(endDate.getUTCDate() - 1);
let startDate = new Date(endDate);
startDate.setUTCDate(startDate.getUTCDate() - (days - 1));

if (!singleChannel && dateArg) {
  assertIsoDate(dateArg, '--date');
  startDate = new Date(`${dateArg}T00:00:00Z`);
  endDate = new Date(`${dateArg}T00:00:00Z`);
}

if (!singleChannel && fromArg && toArg) {
  assertIsoDate(fromArg, '--from');
  assertIsoDate(toArg, '--to');
  startDate = new Date(`${fromArg}T00:00:00Z`);
  endDate = new Date(`${toArg}T00:00:00Z`);
  if (startDate > endDate) {
    console.error('❌ --from must be earlier than or equal to --to');
    process.exit(1);
  }
}

const endStr = endDate.toISOString().split('T')[0];
const startStr = startDate.toISOString().split('T')[0];
const key = startStr === endStr ? endStr : `${startStr}_to_${endStr}`;

function parseTimezoneOffset(tz) {
  if (!tz) return 0; // UTC default
  // Numeric: "+09:00", "-05:00", "+9", "-5"
  const numMatch = String(tz).match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (numMatch) {
    const sign = numMatch[1] === '-' ? -1 : 1;
    const h = parseInt(numMatch[2], 10);
    const m = parseInt(numMatch[3] || '0', 10);
    return sign * (h * 60 + m) * 60 * 1000;
  }
  // Named timezone via Intl
  try {
    const d = new Date();
    const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
    const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
    return local.getTime() - utc.getTime();
  } catch {
    console.warn(`Unknown DIGEST_TIMEZONE "${tz}", falling back to UTC`);
    return 0;
  }
}

function assertIsoDate(dateValue, flagName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    console.error(`❌ ${flagName} must be YYYY-MM-DD format`);
    process.exit(1);
  }
}

const channelsFile = path.join(ROOT, 'config', 'channels.txt');
const keywordsFile = path.join(ROOT, 'config', 'keywords.txt');
const tmpDir = path.join(ROOT, 'tmp');

// Single-channel mode: ignore date range, fetch last N videos from one handle
let mode = 'multi';
let channelKey = null;
if (singleChannel) {
  mode = 'channel';
  const sanitized = singleChannel.replace(/^@/, '').replace(/[^A-Za-z0-9가-힣_-]/g, '');
  channelKey = `channel-${sanitized}-${endStr}`;
}
const outputFile = path.join(tmpDir, `raw-${mode === 'channel' ? channelKey : key}.json`);

fs.mkdirSync(tmpDir, { recursive: true });

// If YOUTUBE_COOKIES_B64 is set (from GitHub Secret in CI), decode to a temp file
// so yt-dlp can use authenticated cookies and bypass anonymous-access restrictions.
let cookiesFile = null;
if (process.env.YOUTUBE_COOKIES_B64) {
  cookiesFile = path.join(tmpDir, 'cookies.txt');
  fs.writeFileSync(cookiesFile, Buffer.from(process.env.YOUTUBE_COOKIES_B64, 'base64'));
  console.log(`🍪 Using YouTube cookies from env (${fs.statSync(cookiesFile).size} bytes)`);

  // Cookie-expiry check: Netscape format columns are
  //   domain  flag  path  secure  expiration  name  value
  // Warn loudly if the most-recently-expiring auth cookie is < 7 days away.
  try {
    const cookieText = fs.readFileSync(cookiesFile, 'utf8');
    const nowSec = Math.floor(Date.now() / 1000);
    const authNames = new Set(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID']);
    let maxAuthExpiry = 0;
    for (const line of cookieText.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      const expiry = parseInt(parts[4], 10);
      const name = parts[5];
      if (!Number.isFinite(expiry) || expiry === 0) continue;
      if (authNames.has(name)) maxAuthExpiry = Math.max(maxAuthExpiry, expiry);
    }
    if (maxAuthExpiry > 0) {
      const daysLeft = Math.floor((maxAuthExpiry - nowSec) / 86400);
      if (maxAuthExpiry < nowSec) {
        console.error(`❌ COOKIE EXPIRED — YouTube auth cookies in YOUTUBE_COOKIES_B64 expired ${Math.abs(daysLeft)} day(s) ago. Refresh per README step 7.`);
        process.exit(2); // distinct exit code so CI can flag this clearly
      } else if (daysLeft <= 7) {
        console.warn(`⚠️  COOKIE EXPIRES SOON — auth cookies expire in ${daysLeft} day(s). Refresh per README step 7 before they break the daily run.`);
      } else {
        console.log(`   cookies valid for ~${daysLeft} more day(s)`);
      }
    }
  } catch (err) {
    console.warn(`   (cookie expiry check skipped: ${err.message})`);
  }
}
const cookieArgs = cookiesFile ? ['--cookies', cookiesFile] : [];

// Channels list: from --channel arg (single) or channels.txt (multi).
// channels.txt supports per-channel follow filters:
//   @channel :: 오건영, another keyword
const channels = mode === 'channel'
  ? [{ handle: singleChannel, requiredKeywords: [] }]
  : fs.readFileSync(channelsFile, 'utf8')
      .split('\n')
      .map(parseChannelLine)
      .filter(Boolean);

const keywords = mode === 'channel'
  ? []  // no keyword filter in single-channel mode
  : (fs.existsSync(keywordsFile)
    ? fs.readFileSync(keywordsFile, 'utf8')
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    : []);

if (mode === 'channel') {
  console.log(`🎯 Channel mode: ${singleChannel}, last ${limit} videos (no date filter)`);
} else {
  console.log(`📅 Range: ${startStr} → ${endStr} (${days} day${days > 1 ? 's' : ''})`);
  console.log(`🌐 Timezone: ${process.env.DIGEST_TIMEZONE || 'UTC (default)'}`);
}
console.log(`📺 Channels: ${channels.length}`);
if (mode !== 'channel') {
  const filteredChannels = channels.filter(c => c.requiredKeywords.length > 0).length;
  if (filteredChannels > 0) console.log(`👤 Follow filters: ${filteredChannels} channel${filteredChannels > 1 ? 's' : ''}`);
}
console.log(`🔑 Keywords: ${keywords.length > 0 ? keywords.join(', ') : 'none (all videos)'}\n`);

const ytdlpCheck = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' });
if (ytdlpCheck.error || ytdlpCheck.status !== 0) {
  console.error('❌ yt-dlp not found in PATH. Install: https://github.com/yt-dlp/yt-dlp/releases');
  process.exit(1);
}

const startStrYtdlp = startStr.replace(/-/g, '');
const endStrYtdlp = endStr.replace(/-/g, '');
const youtubeClientArgs = [
  '--extractor-args', 'youtube:player_client=default,web,android,ios,tv;lang=ko',
  '--add-header', 'Accept-Language: ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
];
const channelSource = (process.env.DIGEST_CHANNEL_SOURCE || 'yt-dlp').toLowerCase();
if (!['yt-dlp', 'web', 'rss'].includes(channelSource)) {
  console.warn(`Unknown DIGEST_CHANNEL_SOURCE "${channelSource}", falling back to yt-dlp`);
}

const PLAYLIST_END = mode === 'channel' ? limit : Math.max(50, days * 20);

// Concurrency: how many channels to fetch in parallel.
// Default 5 keeps us under YouTube's per-IP burst limit while cutting wall-time ~5x.
const concurrencyIdx = argv.indexOf('--concurrency');
const concurrency = Math.max(1, Math.min(
  10,
  concurrencyIdx >= 0 ? parseInt(argv[concurrencyIdx + 1], 10) || 5 :
    parseInt(process.env.DIGEST_CONCURRENCY || '', 10) || 5
));
console.log(`⚙️  Concurrency: ${concurrency} channel${concurrency > 1 ? 's' : ''} in parallel\n`);

// Per-channel fetch — pure function, safe to run in parallel.
async function fetchChannel(channelEntry) {
  const handle = channelEntry.handle.startsWith('@') ? channelEntry.handle : `@${channelEntry.handle}`;
  const requiredKeywords = channelEntry.requiredKeywords || [];
  const url = `https://www.youtube.com/${handle}/videos`;
  const out = [];
  const log = [];
  const push = (msg) => log.push(msg);

  push(`Fetching ${handle}${requiredKeywords.length ? ` (follow filter: ${requiredKeywords.join(', ')})` : ''}...`);

  let videos = [];
  const preferWeb = channelSource === 'web';
  const preferRss = channelSource === 'rss';
  if (preferWeb) {
    videos = await fetchChannelPageVideos(handle, push);
  } else if (preferRss) {
    videos = await fetchRssVideos(handle, push);
  }

  const fetchList = (authArgs = []) => runCommand('yt-dlp', [
    ...authArgs,
    '--dump-json',
    '--skip-download',
    '--ignore-no-formats-error',
    ...youtubeClientArgs,
    '--playlist-end', String(PLAYLIST_END),
    '--ignore-errors',
    '--no-warnings',
    url
  ], { timeout: 180000, maxBuffer: 200 * 1024 * 1024 });

  if (videos.length === 0) {
    if (preferWeb) push('  ↪️  Channel page parse empty/failed; retrying channel metadata with yt-dlp');
    if (preferRss) push('  ↪️  RSS feed empty/failed; retrying channel metadata with yt-dlp');

    let listResult = await fetchList(cookieArgs);
    if (cookieArgs.length > 0 && (listResult.status !== 0 || !listResult.stdout.trim())) {
      // Cookies failed (e.g. expired/invalidated). Try anonymous as a last resort.
      push('  ↪️  Authenticated metadata fetch was empty/failed; retrying without cookies');
      listResult = await fetchList();
    } else if (cookieArgs.length === 0) {
      // No cookies configured at all — single anonymous attempt.
    }

    if (listResult.status !== 0 && !listResult.stdout) {
      const stderr = (listResult.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' | ');
      push(`  ⚠️  yt-dlp failed: ${stderr.slice(0, 400)}`);
      videos = await fetchChannelPageVideos(handle, push);
      if (videos.length === 0) videos = await fetchRssVideos(handle, push);
      if (videos.length === 0) {
        push(`  ❌ No usable channel metadata from yt-dlp, channel page, or RSS`);
        return { handle, videos: out, log };
      }
    } else {
      if (listResult.stderr && listResult.stderr.length > 0) {
        const errLines = listResult.stderr.split('\n').filter(l => l.trim() && !l.includes('WARNING')).slice(0, 2).join(' | ');
        if (errLines) push(`  ⚠️  yt-dlp stderr: ${errLines.slice(0, 300)}`);
      }

      videos = listResult.stdout.split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      if (videos.length === 0) {
        push(`  ↪️  No videos in yt-dlp metadata response; retrying with channel page`);
        videos = await fetchChannelPageVideos(handle, push);
        if (videos.length === 0) videos = await fetchRssVideos(handle, push);
      }
    }
  }

  if (videos.length === 0) {
    push(`  ⏭️  No videos in metadata response`);
    return { handle, videos: out, log };
  }
  push(`  → Got ${videos.length} videos with full metadata`);
  if (videos[0]) push(`     newest upload_date: ${videos[0].upload_date} (target: ${startStrYtdlp}..${endStrYtdlp})`);

  let matched = 0;
  let savedThisChannel = 0;

  for (const video of videos) {
    const cap = mode === 'channel' ? limit : maxPerChannel;
    if (cap > 0 && savedThisChannel >= cap) {
      push(`  🛑 Reached cap of ${cap} videos for this channel`);
      break;
    }

    const videoId = video.id;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const uploadDate = video.upload_date;
    if (!uploadDate) continue;
    if (mode !== 'channel') {
      if (uploadDate < startStrYtdlp) break;
      if (uploadDate > endStrYtdlp) continue;
    }

    if (shouldSkipRestrictedVideo(video)) {
      push(`  ⏭️  Skipped (restricted/members-only): ${video.title}`);
      continue;
    }

    matched++;

    let transcript = '';
    let transcriptSegments = [];
    let hasTranscript = false;
    let transcriptSource = '';

    const fetchSubtitles = (authArgs = []) => runCommand('yt-dlp', [
      ...authArgs,
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang', 'ko-orig,ko,ko.*,en,en.*,ja,ja.*,all',
      '--sub-format', 'json3/srv3/vtt/best',
      '--skip-download',
      '--ignore-no-formats-error',
      ...youtubeClientArgs,
      '--no-warnings',
      '-o', path.join(tmpDir, `%(id)s.%(ext)s`),
      videoUrl
    ], { timeout: 60000 });

    await fetchSubtitles(cookieArgs);

    let subtitleFiles = sortSubtitleFiles(fs.readdirSync(tmpDir).filter(f =>
      f.startsWith(videoId) && /\.(json3|srv3|vtt|xml)$/.test(f)
    ));

    if (subtitleFiles.length === 0 && cookieArgs.length > 0) {
      // Cookies returned nothing; try anonymous fallback for public auto-subs.
      await fetchSubtitles();
      subtitleFiles = sortSubtitleFiles(fs.readdirSync(tmpDir).filter(f =>
        f.startsWith(videoId) && /\.(json3|srv3|vtt|xml)$/.test(f)
      ));
    }
    if (subtitleFiles.length > 0) {
      const subtitleFile = subtitleFiles[0];
      const subtitleContent = fs.readFileSync(path.join(tmpDir, subtitleFile), 'utf8');
      transcriptSegments = subtitleFile.endsWith('.json3')
        ? parseJSON3Segments(subtitleContent)
        : parseVTTSegments(subtitleContent);
      transcript = transcriptSegments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
      hasTranscript = transcriptSegments.length >= 3 && transcript.length > 100;
      transcriptSource = subtitleFile;
      subtitleFiles.forEach(f => { try { fs.unlinkSync(path.join(tmpDir, f)); } catch {} });
    }

    if (!hasTranscript) {
      // Per-video --dump-json: channel-listing entries don't include subtitles/automatic_captions,
      // so fetch the full info_dict for this single video to populate the metadata-URL pool.
      const perVideoInfo = await fetchVideoInfoDict(videoUrl, cookieArgs);
      const fallback = await fetchTranscriptFromMetadata(perVideoInfo || video);
      if (fallback.transcriptSegments.length > 0) {
        transcriptSegments = fallback.transcriptSegments;
        transcript = transcriptSegments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
        hasTranscript = transcriptSegments.length >= 3 && transcript.length > 100;
        transcriptSource = fallback.source;
      }
    }

    if (requiredKeywords.length > 0 && !matchesKeywords(video, transcript, requiredKeywords)) {
      push(`  ⏭️  Skipped (no follow keyword): ${video.title}`);
      continue;
    }

    if (keywords.length > 0 && !matchesKeywords(video, transcript, keywords)) {
      push(`  ⏭️  Skipped (no keyword): ${video.title}`);
      continue;
    }

    const uploadDateStr = `${uploadDate.slice(0,4)}-${uploadDate.slice(4,6)}-${uploadDate.slice(6,8)}`;

    out.push({
      channel: handle,
      channelName: video.channel || video.uploader || handle,
      videoId,
      title: video.title || 'Untitled',
      views: video.view_count || 0,
      uploadDate: uploadDateStr,
      duration: video.duration || 0,
      transcript: transcript || video.description || '',
      transcriptSegments,
      description: video.description || '',
      hasTranscript
    });
    savedThisChannel++;

    push(`  📝 [${uploadDateStr}] ${video.title} ${hasTranscript ? `(${transcriptSegments.length} transcript segments via ${transcriptSource})` : '(desc only)'}`);
  }

  if (matched === 0) push(`  ⏭️  No videos in range`);
  return { handle, videos: out, log };
}

async function fetchChannelPageVideos(handle, push) {
  const cleanHandle = handle.startsWith('@') ? handle : `@${handle}`;
  const pageUrl = `https://www.youtube.com/${cleanHandle}/videos`;
  try {
    const response = await fetchWithTimeout(pageUrl, {
      headers: {
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'User-Agent': 'Mozilla/5.0'
      }
    }, 30000);
    if (!response.ok) {
      push(`  ⚠️  Channel page fetch failed: HTTP ${response.status}`);
      return [];
    }
    const html = await response.text();
    const videos = parseChannelPageVideos(html);
    if (videos.length > 0) push(`  → Got ${videos.length} videos from channel page`);
    return videos;
  } catch (error) {
    push(`  ⚠️  Channel page fetch failed: ${error.message}`);
    return [];
  }
}

function parseChannelPageVideos(html) {
  const seen = new Set();
  const videos = [];
  const idMatches = [...html.matchAll(/"videoId":"([\w-]{11})"/g)];

  for (const match of idMatches) {
    const videoId = match[1];
    if (seen.has(videoId)) continue;
    seen.add(videoId);

    const blockEnd = html.indexOf('"richItemRenderer"', match.index + 20);
    const block = html.slice(match.index, blockEnd > match.index ? blockEnd : match.index + 30000);
    const title = decodeJsonText(regexGroup(block, /"lockupMetadataViewModel":\{"title":\{"content":"((?:\\.|[^"\\])+)"/));
    if (!title) continue;

    const relativeTime = decodeJsonText(regexGroup(block, /"text":\{"content":"((?:\\.|[^"\\])*(?:분|시간|일|주|개월|년) 전)"/));
    const uploadDate = relativeTimeToUploadDate(relativeTime);
    if (!uploadDate) continue;

    const durationText = decodeJsonText(regexGroup(block, /"thumbnailBadgeViewModel":\{"text":"([^"]+)"/));

    videos.push({
      id: videoId,
      title,
      upload_date: uploadDate,
      channel: '',
      uploader: '',
      duration: durationTextToSeconds(durationText),
      view_count: 0,
      description: '',
      availability: 'public'
    });

    if (videos.length >= PLAYLIST_END) break;
  }

  return videos;
}

function regexGroup(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1] : '';
}

function decodeJsonText(value) {
  if (!value) return '';
  try {
    return JSON.parse(`"${value}"`).replace(/\s+/g, ' ').trim();
  } catch {
    return String(value).replace(/\\u0026/g, '&').replace(/\s+/g, ' ').trim();
  }
}

function relativeTimeToUploadDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/(\d+)\s*(분|시간|일|주|개월|년) 전/);
  if (!match) return '';

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return '';

  const date = new Date(Date.now() + tzOffsetMs);
  const unit = match[2];
  if (unit === '분') date.setUTCMinutes(date.getUTCMinutes() - amount);
  else if (unit === '시간') date.setUTCHours(date.getUTCHours() - amount);
  else if (unit === '일') date.setUTCDate(date.getUTCDate() - amount);
  else if (unit === '주') date.setUTCDate(date.getUTCDate() - amount * 7);
  else if (unit === '개월') date.setUTCMonth(date.getUTCMonth() - amount);
  else if (unit === '년') date.setUTCFullYear(date.getUTCFullYear() - amount);

  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function durationTextToSeconds(value) {
  const parts = String(value || '').split(':').map(part => Number(part));
  if (parts.some(part => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

async function fetchRssVideos(handle, push) {
  const channelId = await resolveChannelId(handle, push);
  if (!channelId) return [];

  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  try {
    const response = await fetchWithTimeout(rssUrl, {}, 30000);
    if (!response.ok) {
      push(`  ⚠️  RSS feed failed: HTTP ${response.status}`);
      return [];
    }
    const xml = await response.text();
    const videos = parseYoutubeRss(xml);
    if (videos.length > 0) push(`  → Got ${videos.length} videos from RSS feed`);
    return videos;
  } catch (error) {
    push(`  ⚠️  RSS feed failed: ${error.message}`);
    return [];
  }
}

async function resolveChannelId(handle, push) {
  const cleanHandle = handle.startsWith('@') ? handle : `@${handle}`;
  const urls = [
    `https://www.youtube.com/${cleanHandle}`,
    `https://www.youtube.com/${cleanHandle}/videos`
  ];

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': 'Mozilla/5.0'
        }
      }, 30000);
      if (!response.ok) continue;
      const html = await response.text();
      const channelId = extractChannelId(html);
      if (channelId) return channelId;
    } catch {
      // Try the next channel URL form.
    }
  }

  push(`  ⚠️  Could not resolve RSS channel id for ${cleanHandle}`);
  return '';
}

function extractChannelId(html) {
  const patterns = [
    /<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[^"']+)["']/,
    /<meta[^>]+content=["'](UC[^"']+)["'][^>]+itemprop=["']channelId["']/,
    /"channelId":"(UC[^"]+)"/,
    /"externalId":"(UC[^"]+)"/,
    /youtube\.com\/channel\/(UC[\w-]+)/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function parseYoutubeRss(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(match => match[1]);
  return entries.map(entry => {
    const videoId = xmlText(entry, 'yt:videoId');
    const title = decodeXml(xmlText(entry, 'title'));
    const published = xmlText(entry, 'published') || xmlText(entry, 'updated');
    const channelName = decodeXml(xmlText(entry, 'name'));
    const description = decodeXml(xmlText(entry, 'media:description'));
    const uploadDate = published ? new Date(published).toISOString().slice(0, 10).replace(/-/g, '') : '';

    if (!videoId || !uploadDate) return null;
    return {
      id: videoId,
      title: title || 'Untitled',
      upload_date: uploadDate,
      channel: channelName,
      uploader: channelName,
      duration: 0,
      view_count: 0,
      description,
      availability: 'public'
    };
  }).filter(Boolean);
}

function xmlText(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`));
  return match ? match[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : '';
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function shouldSkipRestrictedVideo(video) {
  const text = [video.title, video.description, video.availability, video.live_status, video.release_timestamp]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase();

  return Boolean(
    video.is_private ||
    video.needs_subscription ||
    video.is_members_only ||
    /members[- ]only|member only|membership|join this channel|멤버십|회원 전용|구독자 전용|비공개|프리미어 공개 전|premiere/.test(text)
  );
}

async function fetchTranscriptFromMetadata(video) {
  for (const entry of subtitleMetadataEntries(video)) {
    try {
      const res = await fetch(entry.url, {
        headers: {
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': 'Mozilla/5.0'
        }
      });
      if (!res.ok) continue;
      const text = await res.text();
      const isJson3 = entry.ext === 'json3' || entry.url.includes('fmt=json3') || text.trimStart().startsWith('{');
      const segments = isJson3
        ? parseJSON3Segments(text)
        : parseVTTSegments(text);
      if (segments.length >= 3) {
        return { transcriptSegments: segments, source: `${entry.lang}.${entry.ext || 'auto'} timedtext` };
      }
    } catch {
      // Try the next available caption URL.
    }
  }

  return { transcriptSegments: [], source: '' };
}

async function fetchVideoInfoDict(videoUrl, authArgs = []) {
  // Pulls subtitles/automatic_captions which channel-listing --dump-json omits.
  const tryRun = (auth) => runCommand('yt-dlp', [
    ...auth,
    '--dump-single-json',
    '--skip-download',
    '--write-auto-sub',
    '--write-sub',
    '--sub-lang', 'ko-orig,ko,ko.*,en,en.*,ja,ja.*,all',
    '--ignore-no-formats-error',
    '--extractor-args', 'youtube:player_client=default,web,android,ios,tv;lang=ko',
    '--add-header', 'Accept-Language: ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    '--no-warnings',
    videoUrl
  ], { timeout: 60000, maxBuffer: 50 * 1024 * 1024 });

  let result = await tryRun(authArgs);
  if ((result.status !== 0 || !result.stdout.trim()) && authArgs.length > 0) {
    result = await tryRun([]);
  }
  if (!result.stdout || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function subtitleMetadataEntries(video) {
  const entries = [];
  const pools = [video.subtitles || {}, video.automatic_captions || {}];

  for (const pool of pools) {
    for (const [lang, items] of Object.entries(pool)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item?.url) continue;
        const ext = item.ext
          || (item.url.includes('fmt=json3') ? 'json3'
            : item.url.includes('fmt=srv3') ? 'srv3'
            : item.url.includes('fmt=vtt') ? 'vtt'
            : '');
        entries.push({ lang, ext, url: item.url });
      }
    }
  }

  return entries.sort((a, b) =>
    subtitleLanguageRank(a.lang) - subtitleLanguageRank(b.lang) ||
    subtitleFormatRank(a.ext) - subtitleFormatRank(b.ext)
  );
}

function subtitleLanguageRank(lang) {
  if (lang === 'ko-orig') return 0;
  if (lang === 'ko' || lang.startsWith('ko-') || lang.startsWith('ko.')) return 1;
  if (lang === 'en' || lang.startsWith('en-') || lang.startsWith('en.')) return 2;
  if (lang === 'ja' || lang.startsWith('ja-') || lang.startsWith('ja.')) return 3;
  return 9;
}

function subtitleFormatRank(ext) {
  if (ext === 'json3') return 0;
  if (ext === 'srv3') return 1;
  if (ext === 'vtt') return 2;
  return 3;
}

function parseChannelLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const [handlePart, keywordPart = ''] = trimmed.split('::');
  const handle = handlePart.trim();
  if (!handle) return null;

  const requiredKeywords = keywordPart
    .split(',')
    .map(keyword => keyword.trim())
    .filter(Boolean);

  return { handle, requiredKeywords };
}

function runCommand(command, args, { timeout = 60000, maxBuffer = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let timedOut = false;
    let overflow = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', chunk => {
      stdoutSize += chunk.length;
      if (stdoutSize <= maxBuffer) stdoutChunks.push(chunk);
      else {
        overflow = true;
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', chunk => {
      stderrSize += chunk.length;
      if (stderrSize <= maxBuffer) stderrChunks.push(chunk);
      else {
        overflow = true;
        child.kill('SIGTERM');
      }
    });

    child.on('error', error => {
      clearTimeout(timer);
      resolve({ status: 1, stdout: '', stderr: error.message, error });
    });

    child.on('close', code => {
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString('utf8') + (timedOut ? '\nProcess timed out' : '') + (overflow ? '\nOutput exceeded maxBuffer' : '');
      resolve({
        status: code ?? (timedOut || overflow ? 1 : 0),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr
      });
    });
  });
}

function matchesKeywords(video, transcript, requiredKeywords) {
  if (requiredKeywords.length === 0) return true;

  const haystack = [video.title, video.description, transcript]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase();

  return requiredKeywords.some(keyword => haystack.includes(keyword.toLocaleLowerCase()));
}

function sortSubtitleFiles(files) {
  const languageRank = (file) => {
    if (file.includes('.ko-orig.')) return 0;
    if (file.includes('.ko.')) return 1;
    if (file.includes('.en.')) return 2;
    return 9;
  };

  const formatRank = (file) => file.endsWith('.json3') ? 0 : 1;

  return [...files].sort((a, b) =>
    languageRank(a) - languageRank(b) || formatRank(a) - formatRank(b) || a.localeCompare(b)
  );
}

// Tiny concurrency limiter — runs `tasks` with at most `n` in flight.
async function runWithConcurrency(items, n, taskFn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      // spawnSync inside still blocks this worker, but other workers run
      // concurrently in their own microtask queues — the OS schedules the
      // child processes in parallel. Net effect: ~Nx wall-time speedup.
      results[i] = await Promise.resolve().then(() => taskFn(items[i]));
    }
  });
  await Promise.all(workers);
  return results;
}

const channelResults = await runWithConcurrency(channels, concurrency, fetchChannel);

// Print logs in original channel order so output stays readable
const results = [];
let okChannels = 0;
let failedChannels = 0;
for (const r of channelResults) {
  for (const line of r.log) console.log(line);
  results.push(...r.videos);
  if (r.log.some(l => l.includes('❌'))) failedChannels++;
  else okChannels++;
}

if (mode !== 'channel' && maxVideos > 0 && results.length > maxVideos) {
  console.log(`\n✂️  Limiting digest from ${results.length} to ${maxVideos} videos`);
  results.length = maxVideos;
}

fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
console.log(`\n✅ Saved ${results.length} videos to ${outputFile}`);
console.log(`   Channels: ${okChannels} ok, ${failedChannels} failed`);

// Empty-collection alert: distinguishes "no uploads yesterday" (normal) from
// "every channel exploded" (cookies expired / IP banned / yt-dlp broken).
// Multi-day runs (--days 7) where 0 videos came back from N>=10 channels are
// almost always a systemic failure, not a quiet day.
if (mode !== 'channel') {
  const allFailed = channels.length > 0 && failedChannels === channels.length;
  const suspiciousEmpty = results.length === 0 && (days >= 3 || channels.length >= 8);
  if (allFailed) {
    console.error(`\n❌ ALL ${channels.length} channels failed. Likely cause: cookies expired, IP blocked, or yt-dlp outdated. Check earlier ❌ lines.`);
    process.exit(3); // CI flag: systemic failure
  } else if (suspiciousEmpty) {
    console.error(`\n❌ EMPTY COLLECTION — 0 videos across ${channels.length} channels over ${days} day(s). Possible auth/cookie issue or YouTube rate-limit. Refusing to publish an empty digest.`);
    process.exit(4);
  }
}

function parseVTTSegments(vtt) {
  const segments = [];
  const blocks = vtt.split(/\r?\n\r?\n+/);
  const seen = new Set();

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const tsIdx = lines.findIndex(l => l.includes('-->'));
    if (tsIdx < 0) continue;

    const timeLine = lines[tsIdx];
    const m = timeLine.match(/^(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\s+-->\s+(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)/);
    if (!m) continue;

    const text = lines
      .slice(tsIdx + 1)
      .map(l => l.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) continue;

    const start = m[1].split('.')[0];
    const end = m[2].split('.')[0];
    const dedupKey = `${start}|${text}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    segments.push({ start, end, text });
  }

  return segments;
}

function parseJSON3Segments(jsonText) {
  const segments = [];
  const seen = new Set();
  let data;

  try {
    data = JSON.parse(jsonText);
  } catch {
    return segments;
  }

  for (const event of data.events || []) {
    if (!Array.isArray(event.segs) || !Number.isFinite(event.tStartMs)) continue;

    const text = event.segs
      .map(seg => seg.utf8 || '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text || text === '\n') continue;

    const startSec = Math.max(0, Math.floor(event.tStartMs / 1000));
    const endSec = Math.max(startSec, Math.floor((event.tStartMs + (event.dDurationMs || 0)) / 1000));
    const start = formatSeconds(startSec);
    const end = formatSeconds(endSec);
    const dedupKey = `${start}|${text}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    segments.push({ start, end, text });
  }

  return segments;
}

function formatSeconds(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
