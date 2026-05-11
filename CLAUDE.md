# Daily News Digest — Project Guide

## Purpose
Automatically collect, summarize, and publish Korean general-news and economy-leaning YouTube summaries every morning. Summarization runs through the Gemini API from `scripts/summarize-gemini.js`.

## Tech Stack
- Runtime: Node.js v22+
- YouTube data: yt-dlp (CLI tool)
- AI summarization: Gemini API via `scripts/summarize-gemini.js`
- Output: Markdown files + optional Notion API

## Workflow Overview
1. **Collect** (Node script) — yt-dlp fetches yesterday's videos + transcripts
2. **Summarize** (Node script + Gemini) — reads raw JSON, writes summaries following `config/format.md`
3. **Review** (Node script) — Validates structure and auto-fixes formatting
4. **Publish** (Node script) — Saves to `output/YYYY-MM-DD.md` and optionally Notion

## Trigger Phrases

### Daily — "어제 거 요약해 줘" / "daily news digest" / "run digest"
Yesterday only. Use `npm run collect` (single day).

### Weekly — "지난 일주일 요약해 줘" / "weekly digest" / "지난 7일"
Last 7 days. Use `npm run collect:week` instead of `npm run collect`. Everything else is identical — review.js and publish.js auto-detect the latest tmp file. Notion title is auto-formatted as "Weekly News Digest".

When the trigger fires, execute this sequence:

### Step 1: Collect
```bash
npm run collect           # daily (yesterday)
# or
npm run collect:week      # weekly (last 7 days)
```
Creates `tmp/raw-{key}.json` where key is either `YYYY-MM-DD` or `YYYY-MM-DD_to_YYYY-MM-DD`.

### Step 2: Summarize
```bash
npm run summarize
```
Reads the latest `tmp/raw-{key}.json`, `config/format.md`, and `agents/summarizer.md`, then writes `tmp/summaries-{key}.md` using Gemini.

### Step 3: Review
```bash
npm run review
```

### Step 4: Publish
```bash
npm run publish
```

### Step 5: Report
Tell the user the output file path, channel/video counts, and any errors.

## Sub-Agent Reference Files
- `agents/collector.md` — yt-dlp usage and data shape
- `agents/summarizer.md` — summarization tone, audience, language rules
- `agents/reviewer.md` — quality checks
- `agents/publisher.md` — output destinations

## Config Files
- `config/channels.txt` — One YouTube channel handle per line; optional follow filters use `@channel :: keyword`
- `config/format.md` — Required output format for each summary
- `config/keywords.txt` — Optional: only include videos matching these keywords

## Environment Variables (optional)
```
NOTION_TOKEN=secret_...       # Optional: enables Notion publishing
NOTION_PAGE_ID=your_32_character_notion_page_id  # News Digest parent page
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3-fast    # Optional override
```
**No ANTHROPIC_API_KEY needed** — summarization runs through Gemini.

## Error Handling
- yt-dlp fails for a channel → log error, skip channel, continue
- Transcript unavailable → use video description; do not invent timestamps
- Single channel failure must never crash the full pipeline

## Output Format
File: `output/YYYY-MM-DD.md`
- Header with date and stats
- One `### 📺 [channel]` section per channel
- One `## [video title]` per video
- Each video follows `config/format.md` structure exactly
