# Sub-Agent: Collector

## Role
Fetch yesterday's YouTube video metadata and transcripts using yt-dlp.

## Inputs
- `config/channels.txt` — channel handle list
- Target date: yesterday (UTC)

## yt-dlp Commands
```bash
# Get video list for a channel uploaded yesterday
yt-dlp --flat-playlist --dump-json "https://www.youtube.com/@HANDLE/videos" \
  --match-filter "upload_date >= YYYYMMDD" \
  --dateafter yesterday --datebefore today

# Get transcript for a specific video
yt-dlp --write-auto-sub --sub-lang en,ko --skip-download \
  --write-info-json "https://www.youtube.com/watch?v=VIDEO_ID" \
  -o "tmp/%(id)s.%(ext)s"
```

## Output
Save to `tmp/raw-YYYY-MM-DD.json`:
```json
[
  {
    "channel": "@handle",
    "videoId": "abc123",
    "title": "Video Title",
    "views": 12345,
    "uploadDate": "2025-04-30",
    "transcript": "full transcript text...",
    "description": "video description",
    "duration": 1234,
    "hasTranscript": true
  }
]
```

## Rules
- Skip channels with 0 videos yesterday (no error)
- If transcript missing: set hasTranscript=false, use description field
- If channel fetch fails: log to stderr, continue to next channel
- Filter by config/keywords.txt if file exists and is non-empty
