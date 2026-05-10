# Daily News Digest

Korean general-news and economy-leaning YouTube digest. Every morning at 7 AM EDT, GitHub Actions checks the configured channels, summarizes yesterday's videos with Claude Code, and publishes a new child page under the Notion page:

https://www.notion.so/News-Digest-35cafdd37e7e80ebba93c73610e65f33

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
- When transcript timing data is available, key summary bullets include inline timestamp links like `[[02:02](https://www.youtube.com/watch?v=VIDEO_ID&t=122)]`.
- When a video has only a description and no transcript segments, the digest does not invent timestamps; it marks `[자막 기반 타임라인 없음]` once in the summary.

## Daily Automation

The daily workflow is [.github/workflows/daily-digest.yml](.github/workflows/daily-digest.yml).

- Schedule: `0 11,12 * * *` with an in-workflow timezone gate
- Time: exactly 7 AM in `America/New_York` year-round; GitHub cron wakes at both UTC offsets and skips the non-7 AM run
- Notion parent page: `35cafdd37e7e80ebba93c73610e65f33`

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
   | `CLAUDE_CODE_OAUTH_TOKEN` | Token from `claude setup-token` |
   | `NOTION_TOKEN` | Notion integration token |
   | `YOUTUBE_COOKIES_B64` | Base64 YouTube cookies for yt-dlp |

   The workflow sets `NOTION_PAGE_ID` directly to the News Digest page ID.

3. In Notion, share the News Digest page with the same integration used by `NOTION_TOKEN`.

4. Test from GitHub Actions by running `[AUTO] Daily News Digest` manually.

## Local Commands

```bash
npm run collect        # yesterday's videos
npm run collect:week   # last 7 days
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
│   ├── review.js
│   └── publish.js
├── .github/workflows/
└── output/
```

## Troubleshooting

**No videos collected** usually means either no watched channels uploaded yesterday, a handle is wrong, or YouTube cookies expired.

**Notion page not appearing** usually means the Notion parent page has not been shared with the integration token used by `NOTION_TOKEN`.

**오건영 videos missing** can happen when the host channel does not mention him in title, description, or transcript. Add more aliases after `::` if needed, separated by commas.
