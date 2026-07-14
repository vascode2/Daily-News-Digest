# Daily News Digest — Project Guide

## Purpose
Automatically collect, summarize, and publish Korean general-news and economy-leaning YouTube summaries every morning. Summarization runs through the Google Gemini API from `scripts/summarize-gemini.js` (default model: `gemini-3.5-flash`, fallback `gemini-2.5-flash` → `gemini-2.5-flash-lite` → `gemini-2.0-flash`). A Claude summarizer (`scripts/summarize-claude.js`, `npm run summarize`) remains available for manual/ad-hoc use.

## Tech Stack
- Runtime: Node.js v22+
- YouTube data: yt-dlp (CLI tool)
- AI summarization: Google Gemini API via `scripts/summarize-gemini.js` (Claude summarizer `scripts/summarize-claude.js` retained for manual/ad-hoc use)
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
npm run summarize:gemini
```
Reads the latest `tmp/raw-{key}.json`, `config/format.md`, and `agents/summarizer.md`, then writes `tmp/summaries-{key}.md` using Gemini (`gemini-3.5-flash` by default). To use the Claude summarizer instead, run `npm run summarize`.

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

## Environment Variables
```
GEMINI_API_KEY=your_gemini_api_key             # Required for npm run summarize:gemini (the default summarizer)
GEMINI_MODEL=gemini-3.5-flash                  # Optional preferred model; falls back to gemini-2.5-flash → gemini-2.5-flash-lite → gemini-2.0-flash
GEMINI_FALLBACK_MODELS=gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash  # Optional override for the Gemini fallback chain
GEMINI_YOUTUBE_FALLBACK=true                   # Optional: Gemini path can fall back to YouTube URL input when transcripts are missing
NOTION_TOKEN=secret_...                        # Optional: enables Notion publishing
NOTION_PAGE_ID=your_32_character_notion_page_id  # News Digest parent page
ANTHROPIC_API_KEY=sk-ant-...                   # Optional: only for the manual Claude summarizer (npm run summarize); or use CLAUDE_CODE_OAUTH_TOKEN
CLAUDE_MODEL=claude-sonnet-4-6                 # Optional: preferred model for the manual Claude summarizer
CLAUDE_FALLBACK_MODELS=...                     # Optional: comma-separated override of the Claude fallback chain
```
The active summarizer is Google Gemini (`gemini-3.5-flash` → `gemini-2.5-flash` → `gemini-2.5-flash-lite` → `gemini-2.0-flash`). The GitHub Actions workflows run `npm run summarize:gemini` and need only `GEMINI_API_KEY`. A Claude summarizer (`scripts/summarize-claude.js`, `npm run summarize`) is kept for manual runs; it uses `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` and has its own Gemini fallback.

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
