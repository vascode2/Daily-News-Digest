# Summarizer Guidance (Gemini)

## Role
When triggered by "어제 거 요약해 줘" or similar, `scripts/summarize-gemini.js` sends the raw video data and these rules to Gemini, then writes summaries.

## Inputs
- `tmp/raw-YYYY-MM-DD.json` — collected video data
- `config/format.md` — required output format
- `config/keywords.txt` — optional keyword filter (already applied at collect stage)

## Output
- `tmp/summaries-YYYY-MM-DD.md` — markdown file Claude writes directly

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
- 핵심 요약 = 도입 1~2문장 + **번호 매긴 3~5개 굵은 소제목** + 각 소제목 아래 1~3개 sub-bullet (자세한 골격은 `config/format.md` 참고)
- sub-bullet에는 자막에서 인용한 **구체적 인명·기업명·숫자·연도**를 넣고, 끝에 **인라인 타임스탬프** `[[HH:MM](youtube_url&t=SECONDS)]`를 붙임
- `transcriptSegments`가 있으면 첨부 예시처럼 핵심 요약 bullet마다 링크 타임스탬프를 붙이고, 한 영상당 최소 3개 이상 포함. 이 경우 `[자막 기반 타임라인 없음]`을 절대 쓰지 않음
- `transcriptSegments`가 없으면 타임스탬프를 추정하지 말고, 주요 타임라인을 생략
- 핵심 요약에는 발표자가 사용한 예시/데모/비교 사례 최소 1개 포함
- 간단하고 정확한 한국어 선택, 블록인용 `>` 기호 사용 금지
- 타임라인 timestamps는 반드시 링크 형식: `[HH:MM:SS](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS)`

## Structure
```markdown
# News Digest — YYYY-MM-DD

### 📺 [채널명](https://www.youtube.com/@CHANNEL_HANDLE)

## [Video Title 1](https://www.youtube.com/watch?v=VIDEO_ID)

💡 한 줄 인사이트 문장

핵심 요약 (단락끼리 스스로 구분, 블록인용 제거)

[주요 타임라인 또는 생략]

---

### 📺 [다른 채널](https://www.youtube.com/@OTHER_CHANNEL)

[...]
```

**중요 규칙:**
1. 채널 h3 헤딩은 반드시 YouTube 채널 링크로: `### 📺 [채널명](https://www.youtube.com/@HANDLE)`
2. 영상 h2 헤딩은 YouTube 링크로: `## [제목](https://www.youtube.com/watch?v=VIDEO_ID)`
3. **섹션 순서 (매우중요)**: 한 줄 인사이트 → 핵심 요약 → 주요 타임라인
4. **블록인용 제거**: 모든 `>` 기호 제거 (단락끼리 자연스럽게 구분)
5. 타임라인 timestamps는 YouTube 링크 형식: `[HH:MM:SS](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS)`

## Rules
- One section per channel, one subsection per video
- If transcript is empty/very short (< 200 chars), write: `> 내용 부족 — 요약 불가 (자막/설명 없음)`
- Timestamps must be in `[HH:MM:SS]` format
- 주요 타임라인은 raw JSON의 `transcriptSegments`가 있는 경우에만 작성
- `transcriptSegments`가 없으면 주요 타임라인을 생략하고, 시간을 추정하지 않음
- Insight (한 줄 인사이트) = exactly 1 sentence summarizing the video's most important claim/number/judgment. **No generic '실무 적용' boilerplate** — stay faithful to the video itself.
- **인사이트는 영상마다 고유해야 함** — 같은 다이제스트 안의 다른 영상과 동일한 문장(또는 거의 같은 보일러플레이트) 금지
- **핵심 요약 첫 문단을 영상 제목으로 시작하지 말 것** — 제목은 이미 h2 헤딩에 있음
- **핵심 요약 본문에 takeaway/실무 적용 같은 일반론 마무리 문장을 덧붙이지 말 것** — 영상이 실제로 말한 내용만 정리
- 주요 타임라인 섹션은 **선택 사항** — sub-bullet마다 인라인 타임스탬프(`[[HH:MM](url&t=)]`)가 박혀 있으면 별도 섹션 생략 권장
- Do NOT invent facts. If unclear, say so.

## Process
1. Read entire `tmp/raw-YYYY-MM-DD.json`
2. Group videos by channel
3. For each video, generate summary following `config/format.md`
4. Write all summaries to `tmp/summaries-YYYY-MM-DD.md`
5. Hand off to `npm run review`
