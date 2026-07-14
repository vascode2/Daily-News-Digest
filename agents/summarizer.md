# Summarizer Guidance (Gemini)

## Role
When triggered by "어제 거 요약해 줘" or similar, `scripts/summarize-gemini.js` sends the raw video data and these rules to Gemini, then writes summaries.

## Inputs
- `tmp/raw-YYYY-MM-DD.json` — collected video data
- `config/format.md` — required output format
- `config/keywords.txt` — optional keyword filter (already applied at collect stage)

## Output
- `tmp/summaries-YYYY-MM-DD.md` — markdown file Gemini writes directly

## Audience & Tone
The user wants a concise Korean morning briefing for general news with a light economy/markets tilt.

Topics of interest:
- Korean and global macroeconomy, markets, rates, currencies, real estate, and household finance
- Major policy, geopolitics, industry, and technology stories that can move the economy
- Explanatory journalism that clarifies why a story matters, not just what happened
- 오건영 appearances on selected channels; summarize only the videos collected by the pipeline

Tone:
- Korean output, fact-focused, sober, and useful for a quick morning scan
- Avoid partisan framing unless the video itself explicitly discusses competing political claims
- Separate speaker claims from confirmed facts when the transcript is argumentative or speculative

## Language & Format Rules
- Korean channels (e.g., @dekilab, @bitgapnam) → **Korean output**
- English channels (e.g., @careerhackeralex, @aiDotEngineer) → **Korean summary** (translate to Korean)
- 영상 h2 제목도 한국어로 작성. raw JSON 제목이 영어 자동 번역으로 들어왔으면 자막 맥락을 바탕으로 자연스럽게 한국어로 되돌리고, 링크 URL은 그대로 유지
- 핵심 요약 = 도입 1~2문장 + **번호 매긴 3~5개 굵은 소제목** + 각 소제목 아래 1~3개 sub-bullet (자세한 골격은 `config/format.md` 참고)
- sub-bullet에는 자막 또는 `geminiTimestampNotes`에서 확인한 **구체적 인명·기업명·숫자·연도**를 넣고, 끝에 **인라인 타임스탬프** `[HH:MM](youtube_url&t=SECONDS)`를 하나만 붙임
- `transcriptSegments`가 있으면 핵심 요약 bullet에 링크 타임스탬프를 한 영상당 최소 3개 이상 포함하고, **주요 타임라인** 섹션도 3~6개 작성. 이 경우 `[자막 기반 타임라인 없음]`을 절대 쓰지 않음
- `transcriptSegments`가 없지만 `geminiTimestampNotes`가 있으면 해당 notes의 seconds/label을 사용해 인라인 타임스탬프와 **주요 타임라인**을 작성
- 둘 다 없으면 타임스탬프를 추정하지 말고, 주요 타임라인을 생략
- 핵심 요약에는 발표자가 사용한 예시/데모/비교 사례가 있으면 최소 1개 포함. 없는 경우 억지로 만들지 말고 구체 명사/숫자/타임스탬프 중심으로 정리
- `이 주식`, `이 종목`, `이 섹터`, `3가지`, `딱 4개`, `수혜주`, `유망섹터` 같은 제목형 티저 표현을 답처럼 반복하지 말고 실제 종목·회사·섹터·정책명을 찾아 씀. 영상이 끝까지 공개하지 않으면 `영상에서 구체명은 공개하지 않음`이라고 명시
- 간단하고 정확한 한국어 선택, 블록인용 `>` 기호 사용 금지
- 타임라인 timestamps는 반드시 링크 형식: `[HH:MM:SS](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS)`

## Structure
```markdown
# News Digest — YYYY-MM-DD

### 📺 [채널명](https://www.youtube.com/@CHANNEL_HANDLE)

## [한국어 영상 제목](https://www.youtube.com/watch?v=VIDEO_ID)

💡 한 줄 인사이트 문장

핵심 요약 (단락끼리 스스로 구분, 블록인용 제거)

[주요 타임라인 또는 생략]

---

### 📺 [다른 채널](https://www.youtube.com/@OTHER_CHANNEL)

[...]
```

**중요 규칙:**
1. 채널 h3 헤딩은 반드시 YouTube 채널 링크로: `### 📺 [채널명](https://www.youtube.com/@HANDLE)`
2. 영상 h2 헤딩은 한국어 제목 + YouTube 링크로: `## [한국어 제목](https://www.youtube.com/watch?v=VIDEO_ID)`
3. **섹션 순서 (매우중요)**: 한 줄 인사이트 → 핵심 요약 → 주요 타임라인
4. **블록인용 제거**: 모든 `>` 기호 제거 (단락끼리 자연스럽게 구분)
5. 타임라인 timestamps는 YouTube 링크 형식: `[HH:MM:SS](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS)`

## Rules
- One section per channel, one subsection per video
- If transcript is empty/very short, summarize conservatively from title/description only, clearly saying when details are not available. Do not invent timestamps.
- Timestamps must be in `[HH:MM:SS]` format
- 주요 타임라인은 raw JSON의 `transcriptSegments` 또는 `geminiTimestampNotes`가 있는 경우 작성
- `transcriptSegments`와 `geminiTimestampNotes`가 모두 없으면 주요 타임라인을 생략하고, 시간을 추정하지 않음
- Insight (한 줄 인사이트) = exactly 1 sentence summarizing the video's most important claim/number/judgment. **No generic '실무 적용' boilerplate** — stay faithful to the video itself.
- **인사이트는 영상마다 고유해야 함** — 같은 다이제스트 안의 다른 영상과 동일한 문장(또는 거의 같은 보일러플레이트) 금지
- **핵심 요약 첫 문단을 영상 제목으로 시작하지 말 것** — 제목은 이미 h2 헤딩에 있음
- **핵심 요약 본문에 takeaway/실무 적용 같은 일반론 마무리 문장을 덧붙이지 말 것** — 영상이 실제로 말한 내용만 정리
- 주요 타임라인 섹션은 `transcriptSegments` 또는 `geminiTimestampNotes`가 있는 경우 작성. 인라인 타임스탬프가 있어도 별도 섹션을 유지
- Do NOT invent facts. If unclear, say so.

## Process
1. Read entire `tmp/raw-YYYY-MM-DD.json`
2. Generate each video summary independently so the model resolves teaser phrases and concrete details per video
3. Group completed video summaries by channel
4. Write all summaries to `tmp/summaries-YYYY-MM-DD.md`
5. Hand off to `npm run review`
