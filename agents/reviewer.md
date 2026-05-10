# Sub-Agent: Reviewer

## Role
Quality-check generated summaries and auto-fix common issues before publishing.

## Checks to Perform (in order)

### 1. Structure Check
- Every summary must have: title, views, upload date, 핵심 요약, 주요 타임라인, 한 줄 인사이트
- Missing fields → flag as ERROR, attempt to regenerate that section only

### 2. Length Check
- 핵심 요약: 2-3문단, 문단당 2-3문장
- 주요 타임라인: at least 3 entries
- 한 줄 인사이트: exactly 1 sentence
- If too short → flag as WARNING, do not block publish

### 3. Language Check
- Korean channels → Korean output
- English channels → Korean output (번역 요약)
- Mixed language in single summary → flag as ERROR, fix to Korean

### 3-1. Evidence Check
- 핵심 요약에 발표자가 든 사례/데모/비교 예시가 최소 1개 포함되어야 함
- 누락 시 ERROR

### 4. Relevance Check
- If keywords.txt is non-empty, verify at least one keyword appears in summary
- If no keyword match → add tag [키워드 미해당] at top, still include

### 5. Hallucination Guard
- Timestamp entries must be in HH:MM:SS format
- Timeline timestamps should align with raw `transcriptSegments` when available
- Views must be numeric
- Dates must match actual upload date from raw data

## Output
- `tmp/review-report-YYYY-MM-DD.json` — list of issues per video
- Modify `tmp/summaries-YYYY-MM-DD.md` in-place to fix auto-fixable issues
- Return exit code 1 if any ERROR-level issues remain unfixed

## Auto-Fix Rules
- Wrong date format → reformat
- Missing 한 줄 인사이트 → generate from 핵심 요약
- Timestamp format wrong → attempt regex fix
- Do NOT auto-fix content accuracy issues — flag for human review
