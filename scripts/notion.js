/**
 * notion.js — Shared Notion REST helpers for the digest pipeline.
 *
 * Handles auth headers, markdown → Notion block conversion, listing/archiving
 * child pages (for de-duplication), and creating a digest page at a chosen
 * position (newest-on-top ordering).
 */

const NOTION_API = 'https://api.notion.com/v1';
// 2026-03-11 introduced the `position` object (insert at start/end/after_block),
// which we use to keep the newest digest on top. Override with NOTION_VERSION.
const NOTION_VERSION = process.env.NOTION_VERSION || '2026-03-11';

export function notionHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * fetch wrapper that retries on 429 / 5xx with backoff, honoring Retry-After.
 */
async function notionFetch(url, options, { retries = 4, baseDelay = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseFloat(res.headers.get('retry-after') || '0');
        const wait = retryAfter > 0 ? retryAfter * 1000 : baseDelay * Math.pow(2, attempt);
        if (attempt < retries) {
          console.log(`   ⏳ Notion ${res.status}; retrying in ${Math.round(wait)}ms`);
          await sleep(wait);
          continue;
        }
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(baseDelay * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastErr || new Error('Notion request failed');
}

export async function updateParentPageTitle(pageId, targetTitle, token) {
  try {
    const res = await notionFetch(`${NOTION_API}/pages/${pageId}`, {
      method: 'PATCH',
      headers: notionHeaders(token),
      body: JSON.stringify({
        properties: { title: { title: [{ text: { content: targetTitle } }] } }
      })
    });
    if (!res.ok) console.log(`   ⚠️  Could not rename parent page title (${res.status})`);
  } catch (err) {
    console.log(`   ⚠️  Could not rename parent page title (${err.message})`);
  }
}

/**
 * Return all direct child blocks of a page/block (paginated).
 */
export async function listChildBlocks(blockId, token) {
  const out = [];
  let cursor;
  do {
    const url = new URL(`${NOTION_API}/blocks/${blockId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const res = await notionFetch(url.toString(), { method: 'GET', headers: notionHeaders(token) });
    if (!res.ok) throw new Error(`List children failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    out.push(...(json.results || []));
    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);
  return out;
}

/**
 * Plain-text title of a child_page block.
 */
export function childPageTitle(block) {
  if (block?.type !== 'child_page') return null;
  return block.child_page?.title || '';
}

/**
 * Archive (soft-delete) a block by id.
 */
export async function archiveBlock(blockId, token) {
  const res = await notionFetch(`${NOTION_API}/blocks/${blockId}`, {
    method: 'DELETE',
    headers: notionHeaders(token)
  });
  if (!res.ok) throw new Error(`Archive failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

/**
 * Create a digest page under a parent page from already-converted blocks.
 * `position` is an optional Notion position object, e.g. { type: 'page_start' }.
 * Falls back gracefully (no position) if the API rejects the position param.
 * Returns the created page object.
 */
export async function createDigestPage({ parentPageId, title, blocks, position, token }) {
  const firstBatch = blocks.slice(0, 100);
  const restBatches = [];
  for (let i = 100; i < blocks.length; i += 100) restBatches.push(blocks.slice(i, i + 100));

  const body = {
    parent: { page_id: parentPageId },
    properties: { title: { title: [{ text: { content: title } }] } },
    children: firstBatch
  };
  if (position) body.position = position;

  let res = await notionFetch(`${NOTION_API}/pages`, {
    method: 'POST', headers: notionHeaders(token), body: JSON.stringify(body)
  });

  // If the position parameter is unsupported, retry once without it.
  if (!res.ok && position) {
    const errText = await res.text();
    if (res.status === 400 && /position/i.test(errText)) {
      console.log(`   ⚠️  position param rejected (${errText.slice(0, 200)}); creating without ordering.`);
      delete body.position;
      res = await notionFetch(`${NOTION_API}/pages`, {
        method: 'POST', headers: notionHeaders(token), body: JSON.stringify(body)
      });
    } else {
      throw new Error(`${res.status}: ${errText}`);
    }
  }
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text())}`);

  const page = await res.json();
  for (const batch of restBatches) {
    const r = await notionFetch(`${NOTION_API}/blocks/${page.id}/children`, {
      method: 'PATCH', headers: notionHeaders(token), body: JSON.stringify({ children: batch })
    });
    if (!r.ok) console.error(`   ⚠️  Append failed: ${r.status}`);
  }
  return page;
}

// ── Markdown → Notion blocks ─────────────────────────────────────

export function markdownToNotionBlocks(md) {
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
  const isChannelHeader = level === 3 && /^📺\s/.test(text);
  const block = { rich_text: parseRichText(text) };
  if (isChannelHeader) block.color = 'red';
  return { object: 'block', type, [type]: block };
}

/**
 * Parse markdown inline syntax into Notion rich_text array.
 * Supports: [text](url) links, **bold**, plain text. Order-independent.
 */
export function parseRichText(text) {
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
function boldSegment(t) {
  return { type: 'text', text: { content: t.slice(0, 2000) }, annotations: { bold: true } };
}
function linkSegment(t, url) {
  return { type: 'text', text: { content: t.slice(0, 2000), link: { url } } };
}

/**
 * True when a child_page title looks like a generated digest page.
 * Matches daily "📰 2026-06-27", weekly "📰 Weekly News Digest ...",
 * and channel "📺 Channel News Digest: @handle (...)".
 */
export function isDigestPageTitle(title) {
  if (!title) return false;
  return /^📰\s*\d{4}-\d{2}-\d{2}/.test(title)
    || /^📰\s*Weekly News Digest/i.test(title)
    || /^📺\s*Channel News Digest/i.test(title);
}
