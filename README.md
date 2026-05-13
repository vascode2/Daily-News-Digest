# Daily News Digest

> A morning briefing that turns Korean general-news and economy YouTube into one skimmable Notion page.

**[See the visual explanation ->](https://vascode2.github.io/Daily-News-Digest/)**
*(One-page walkthrough with a flowchart, inputs/outputs, and a mock digest preview.)*

---

Korean general-news and economy-leaning YouTube digest. Every morning at 6:30 AM New York time, GitHub Actions checks the configured channels, summarizes yesterday's videos with Anthropic Claude (Sonnet 4.6), and publishes a new child page under your configured Notion page.

## What It Watches

The main feed lives in [config/channels.txt](config/channels.txt):

- General news / economy channels are included normally.
- 오건영 follow channels use `@channel :: 오건영`, so only videos whose title, description, or transcript mentions 오건영 are collected.

Example:

```text
@understanding.
@3protv :: 오건영
```

Global filtering through [config/keywords.txt](config/keywords.txt) is still available, but it is usually better to leave that file commented out and use per-channel filters for people or recurring topics.

## Output Format

- Channel names, video titles, and transcript-based timestamps are clickable.
- Video display titles are Korean. If YouTube metadata arrives as an English auto-translation, the summarizer translates the h2 title back into Korean while keeping the YouTube link.
- When transcript timing data is available, key summary bullets include inline timestamp links like `[[02:02](https://www.youtube.com/watch?v=VIDEO_ID&t=122)]`.
- When transcript timing data is available, the main summary body must include at least 3 inline timestamp links. The separate `주요 타임라인` section is optional and usually omitted.
- When a video has only a description and no transcript segments, the digest does not invent timestamps.

## Daily Automation

The daily workflow is [.github/workflows/daily-digest.yml](.github/workflows/daily-digest.yml).

- Schedule: `30 10,11 * * *` with an in-workflow timezone gate
- Time: exactly 6:30 AM in `America/New_York` year-round; GitHub cron wakes at both UTC offsets and skips the non-6:30 AM run
- Notion parent page: stored privately as the `NOTION_PAGE_ID` GitHub secret

Manual workflows are also available:

- `[MANUAL] Weekly News Digest` for the last 7 days
- `[MANUAL] Channel News Digest` for one channel's recent videos

## Setup

1. Install local tools if testing on your machine:
   ```bash
   npm install
   ```

2. Add GitHub Actions secrets:

   | Name | Value |
   | --- | --- |
   | `ANTHROPIC_API_KEY` *or* `CLAUDE_CODE_OAUTH_TOKEN` | Anthropic API key (`sk-ant-...`) or Claude Code OAuth token |
   | `NOTION_TOKEN` | Notion integration token |
   | `NOTION_PAGE_ID` | Parent Notion page ID for News Digest |
   | `YOUTUBE_COOKIES_B64` | Base64 YouTube cookies for yt-dlp |

   Do not commit real token values or private page IDs to the repository.

   Optional repository variable:

   | Name | Default |
   | --- | --- |
   | `CLAUDE_MODEL` | `claude-sonnet-4-6` preferred; falls back to `claude-haiku-4-5` if unavailable |

   Override the chain via `CLAUDE_FALLBACK_MODELS` (comma-separated). The script prefers `ANTHROPIC_API_KEY` when present and otherwise uses `CLAUDE_CODE_OAUTH_TOKEN` against the Anthropic Messages API.

   The legacy Gemini-based summarizer is kept as `npm run summarize:gemini` for ad-hoc comparison; it requires `GEMINI_API_KEY`.

3. In Notion, share the News Digest page with the same integration used by `NOTION_TOKEN`.

4. Test from GitHub Actions by running `[AUTO] Daily News Digest` manually.

## Local Commands

```bash
npm run collect        # yesterday's videos
npm run collect:week   # last 7 days
npm run summarize      # generate tmp/summaries-*.md with Claude
npm run review         # validate latest tmp/summaries-*.md
npm run publish        # write output/ and publish to Notion if env vars are set
```

Single-channel mode ignores date and keyword filters:

```bash
node --env-file-if-exists=.env scripts/collect.js --channel @3protv --limit 5
```

In PowerShell, quote the handle: `--channel '@3protv'`.

## Folder Structure

```text
.
├── CLAUDE.md
├── agents/
├── config/
│   ├── channels.txt
│   ├── format.md
│   └── keywords.txt
├── scripts/
│   ├── collect.js
│   ├── summarize-claude.js
│   ├── summarize-gemini.js
│   ├── review.js
│   └── publish.js
├── .github/workflows/
└── output/
```

## Troubleshooting

**No videos collected** usually means either no watched channels uploaded yesterday, a handle is wrong, or YouTube cookies expired.

**Notion page not appearing** usually means the Notion parent page has not been shared with the integration token used by `NOTION_TOKEN`.

**오건영 videos missing** can happen when the host channel does not mention him in title, description, or transcript. Add more aliases after `::` if needed, separated by commas.
