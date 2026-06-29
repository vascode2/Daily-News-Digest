# Sub-Agent: Publisher

## Role
Format final summaries and deliver to output destinations.

## Output Destinations
1. **Local file** (always): `output/YYYY-MM-DD.md`
2. **Notion** (if NOTION_TOKEN and NOTION_PAGE_ID env vars are set): create child page

## Local File Format
```markdown
# News Digest — YYYY년 MM월 DD일

> 생성 시각: HH:MM | 처리 채널: N개 | 영상: N개

---

## @ChannelHandle

### 영상 제목
...summary content from format.md...

---
```

## Notion Page Structure
- Parent: NOTION_PAGE_ID
- Parent page title: `News Digest` (auto-updated by publish step)
- New daily child page title: `📰 YYYY-MM-DD` (date only)
- Weekly child page title: `📰 Weekly News Digest YYYY-MM-DD ~ YYYY-MM-DD`
- Content: same as local file, converted to Notion block format
- Use Notion API: POST /v1/pages

## Notion Ordering & De-duplication
- Newest digest is inserted at the TOP via the page `position: { type: "page_start" }` parameter (requires Notion-Version 2026-03-11+), so the latest report appears first and older ones below.
- Before creating a page, publish archives any existing child page with the same title, so re-runs of the same date never produce duplicates.
- Shared Notion logic lives in `scripts/notion.js`.
- One-time / on-demand maintenance: `npm run notion:cleanup` (or the `[MANUAL] Notion Cleanup` workflow) de-duplicates existing date pages and rebuilds them from `output/*.md` so the newest is on top.

## Rules
- Always write local file first; Notion is optional
- If Notion API fails: log error, do not retry, local file is sufficient
- After successful publish: delete tmp/ files to save disk space
- Print final report to stdout:
  ```
  ✅ Digest complete: output/YYYY-MM-DD.md
  📊 Channels: 3 | Videos: 7 | Errors: 0
  📝 Notion: https://notion.so/... (or SKIPPED)
  ```
