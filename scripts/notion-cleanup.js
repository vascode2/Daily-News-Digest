#!/usr/bin/env node
/**
 * notion-cleanup.js — One-time maintenance for the Notion daily-report section.
 *
 * 1. De-duplicates: removes duplicate date pages under the parent page.
 * 2. Re-orders: rebuilds the digest pages so the NEWEST date is on top.
 *
 * Existing Notion child_page blocks can't be moved via the API, so to change
 * their order we archive the current digest pages and recreate them from the
 * repo's output/*.md (the source of truth) in chronological order, inserting
 * each at the top (position: start) — oldest first, newest last, so the newest
 * ends up on top.
 *
 * Modes:
 *   default ("mirror") — only rebuild dates that currently exist in Notion.
 *   REBUILD_ALL=true   — rebuild every output/*.md (optionally capped).
 *
 * Env:
 *   NOTION_TOKEN, NOTION_PAGE_ID   (required)
 *   NOTION_ROOT_TITLE              (optional parent title)
 *   REBUILD_ALL=true               (optional, rebuild from all output files)
 *   CLEANUP_LIMIT=N                (optional, keep only the N most recent)
 *   NOTION_CREATE_DELAY_MS=400     (optional, delay between API writes)
 *   DRY_RUN=true                   (optional, log actions without changing Notion)
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
  markdownToNotionBlocks,
  isDigestPageTitle
} from './notion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const outputDir = path.join(ROOT, 'output');

const token = process.env.NOTION_TOKEN;
const parentPageId = process.env.NOTION_PAGE_ID;
const rootTitle = process.env.NOTION_ROOT_TITLE || 'News Digest';
const rebuildAll = process.env.REBUILD_ALL === 'true';
const cleanupLimit = parseInt(process.env.CLEANUP_LIMIT || '0', 10) || 0;
const createDelayMs = Math.max(0, parseInt(process.env.NOTION_CREATE_DELAY_MS || '400', 10) || 0);
const dryRun = process.env.DRY_RUN === 'true';

if (!token || !parentPageId) {
  console.error('❌ NOTION_TOKEN and NOTION_PAGE_ID are required.');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Derive the Notion page title + sort date from an output file key. */
function keyToTitle(key) {
  if (key.startsWith('channel-')) {
    const m = key.match(/^channel-(.+)-(\d{4}-\d{2}-\d{2})$/);
    const handle = m ? m[1] : '';
    const date = m ? m[2] : key;
    return { title: `📺 Channel News Digest: @${handle} (${date})`, sort: date };
  }
  if (key.includes('_to_')) {
    const [s, e] = key.split('_to_');
    return { title: `📰 Weekly News Digest ${s} ~ ${e}`, sort: e };
  }
  return { title: `📰 ${key}`, sort: key };
}

// Map each output file to its Notion title + sort date.
const outputFiles = fs.existsSync(outputDir)
  ? fs.readdirSync(outputDir).filter(f => f.endsWith('.md'))
  : [];
const titleToFile = new Map();
const titleToSort = new Map();
for (const f of outputFiles) {
  const key = f.replace(/\.md$/, '');
  const { title, sort } = keyToTitle(key);
  titleToFile.set(title, path.join(outputDir, f));
  titleToSort.set(title, sort);
}

async function main() {
  console.log(`🔧 Notion cleanup — mode: ${rebuildAll ? 'REBUILD_ALL' : 'mirror'}${dryRun ? ' (DRY_RUN)' : ''}`);

  if (!dryRun) await updateParentPageTitle(parentPageId, rootTitle, token);

  // 1. Read current digest child pages under the parent.
  const children = await listChildBlocks(parentPageId, token);
  const digestPages = children.filter(b => b.type === 'child_page' && isDigestPageTitle(childPageTitle(b)));
  console.log(`   Found ${digestPages.length} digest page(s) currently under the parent.`);

  // Group existing pages by title to detect duplicates.
  const byTitle = new Map();
  for (const p of digestPages) {
    const t = childPageTitle(p);
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(p);
  }
  const dupCount = [...byTitle.values()].reduce((n, arr) => n + Math.max(0, arr.length - 1), 0);
  console.log(`   ${byTitle.size} unique title(s), ${dupCount} duplicate page(s).`);

  // 2. Decide which titles to (re)build.
  let targetTitles;
  if (rebuildAll) {
    targetTitles = [...titleToFile.keys()];
  } else {
    // Mirror: only titles that currently exist AND have an output file.
    targetTitles = [...byTitle.keys()].filter(t => titleToFile.has(t));
    const missing = [...byTitle.keys()].filter(t => !titleToFile.has(t));
    if (missing.length) {
      console.log(`   ⚠️  ${missing.length} existing page(s) have no output file; leaving them untouched:`);
      missing.forEach(t => console.log(`        - ${t}`));
    }
  }

  // Sort ascending by date so newest is created last → ends on top.
  targetTitles.sort((a, b) => String(titleToSort.get(a)).localeCompare(String(titleToSort.get(b))));
  if (cleanupLimit > 0 && targetTitles.length > cleanupLimit) {
    targetTitles = targetTitles.slice(targetTitles.length - cleanupLimit);
  }
  console.log(`   Will rebuild ${targetTitles.length} page(s).`);

  // 3. Archive existing pages for the target titles (all duplicates).
  const titlesToArchive = new Set(targetTitles);
  let archived = 0;
  for (const [title, pages] of byTitle) {
    if (!titlesToArchive.has(title)) continue;
    for (const p of pages) {
      if (dryRun) { console.log(`   [dry] archive "${title}"`); archived++; continue; }
      try {
        await archiveBlock(p.id, token);
        archived++;
        await sleep(createDelayMs);
      } catch (err) {
        console.error(`   ⚠️  Archive failed for "${title}": ${err.message}`);
      }
    }
  }
  console.log(`   🗑️  Archived ${archived} page(s).`);

  // 4. Recreate from output files (oldest → newest, each at the top).
  let created = 0;
  let positionStartWorks = null;
  for (const title of targetTitles) {
    const file = titleToFile.get(title);
    if (!file || !fs.existsSync(file)) {
      console.log(`   ⏭️  No output file for "${title}", skipping recreate.`);
      continue;
    }
    const md = fs.readFileSync(file, 'utf8');
    const blocks = markdownToNotionBlocks(md);
    if (dryRun) { console.log(`   [dry] create "${title}" (${blocks.length} blocks) at top`); created++; continue; }
    try {
      const page = await createDigestPage({
        parentPageId, title, blocks, position: { type: 'start' }, token
      });
      created++;
      if (positionStartWorks === null) positionStartWorks = true;
      console.log(`   ✅ Recreated "${title}" → ${page.url}`);
      await sleep(createDelayMs);
    } catch (err) {
      console.error(`   ❌ Recreate failed for "${title}": ${err.message}`);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ Cleanup complete. Archived ${archived}, recreated ${created}. Newest is now on top.`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

main().catch(err => {
  console.error(`❌ Cleanup failed: ${err.message}`);
  process.exit(1);
});
