# Design Studio 캡처 v2

현재 보고 있는 웹페이지를 **스크립트 없는 정지 화면 HTML 파일 하나**로 저장하는 북마클릿입니다.
저장한 파일은 스튜디오의 [내 PC 에서 html 파일 불러오기]로 엽니다.

v1(원본 북마클릿)을 분석하면서 찾은 결함 10개와 재구축 중 추가로 발견한 결함 8개를 반영해 다시 작성했습니다.

---

## 1. 빠른 시작

| 목적 | 방법 |
|---|---|
| 설치 | `dist/install.html` 을 브라우저로 열고 **DS 캡처** 버튼을 북마크바로 드래그 |
| 수동 설치 | 북마크를 새로 만들고 URL 칸에 `dist/bookmarklet.txt` 내용을 붙여넣기 |
| 빌드 | `npm install` → `npm run build` |
| 테스트 | `npm test` (빌드 + 회귀 테스트, 결과는 `test/out/report.md`) |

요구 환경: Node.js 20 이상. 북마클릿 자체는 Chrome/Edge 최신 버전 기준으로 검증했습니다(아래 5장).

---

## 2. 폴더 구조

```
design-studio-capture/
├── src/capture.js              # 북마클릿 원본 소스 (주석 포함, 사람이 읽고 고치는 파일)
├── scripts/build.mjs           # terser 압축 → javascript: URL 생성
├── dist/
│   ├── bookmarklet.txt         # 북마크 URL 에 넣는 최종 결과물
│   ├── bookmarklet.min.js      # 압축된 JS (디버깅용)
│   └── install.html            # 드래그 설치 페이지
├── legacy/original-bookmarklet.txt   # v1 원본 (회귀 비교용)
└── test/
    ├── run-tests.mjs           # Playwright 회귀 테스트 (v1 vs v2 동일 조건 비교)
    ├── server.mjs              # 2-origin 픽스처 서버 (4101: 사이트, 4102: CDN 역할)
    └── fixtures/               # 검증용 페이지 (generate_html.py 로 HTML 재생성)
```

---

## 3. 처리 파이프라인

```
[1단계: 동기]  원본 DOM 복제 ─ 원본/사본 1:1 짝 맞춤(querySelectorAll 순서)
                 ├ Shadow Root  → <template shadowrootmode="open"> (재귀)
                 ├ canvas       → <img src="data:image/png…">
                 ├ input/textarea/select → 현재 상태를 속성으로 기록 (비밀번호 제외)
                 ├ iframe       → sandbox + srcdoc 자리표시 (요소 유지 → 페이지 CSS 그대로 적용)
                 ├ object/embed → 같은 크기의 자리표시 박스
                 └ style/link   → 2단계 작업 큐에 등록
               정화(sanitize) → <head> 정비(charset, base, 출처 메타)
[2단계: 비동기] 스타일시트별 직렬화 (병렬)
                 ├ 읽을 수 있음 → CSSOM(cssRules) 직렬화, @import 재귀 인라인
                 ├ 교차 출처    → fetch(쿠키 미전송) 로 원문 받아 인라인
                 ├ url()        → "그 CSS 파일 위치" 기준 절대경로
                 ├ :defined     → 치환 (스크립트 없는 파일에서 웹 컴포넌트가 숨지 않게)
                 └ @font-face   → 페이지가 실제로 받은 폰트만 data: URL 로 내장
               원래 <link>/<style> 자리에 <style> 로 교체 → cascade 순서 보존
[3단계]       doctype 원형 + outerHTML → Blob 다운로드 → 결과 토스트
```

---

## 4. 개선 내역

### 4-1. 분석 단계에서 찾은 결함 (10건)

| # | v1 문제 | v2 해결 방법 |
|---|---|---|
| 1 | 외부 CSS 를 인라인하면서 `url(../fonts/…)` 가 페이지 기준으로 재해석 → 폰트·배경 깨짐 | 시트별로 `sheet.href` 기준 절대경로 변환. `@font-face` 폰트는 data: URL 로 내장해 오프라인에서도 표시 |
| 2 | `<link>` 는 남기고 내용을 `<head>` 끝에 또 넣어 같은 CSS 가 두 번 적용, cascade 순서 틀어짐 | 원래 `<link>` 자리를 `<style>` 로 **교체** (media·title 속성 유지) |
| 3 | 교차 출처 CDN CSS 는 `catch` 에서 조용히 누락 | `fetch` 로 원문을 받아 인라인. 그래도 안 되면 `<link>` 를 절대경로로 남기고 토스트·콘솔에 알림 |
| 4 | Shadow DOM 내용 누락 | Declarative Shadow DOM 으로 직렬화 (중첩 Shadow Root 재귀 처리) |
| 5 | `adoptedStyleSheets` 누락 | 문서·Shadow Root 의 adopted 시트를 cascade 위치에 맞춰 `<style>` 로 삽입 |
| 6 | 입력 중인 값 소실 | value·checked·selected·textarea 내용을 속성으로 기록 (비밀번호는 제외) |
| 7 | `<canvas>` 공백 | `toDataURL()` 로 `<img>` 대체. 교차 출처 이미지로 오염된 canvas 는 읽을 수 없어 개수만 보고 |
| 8 | 원본 `<base>` 무시 | `document.baseURI` 사용, 원본 `<base target>` 유지 |
| 9 | CSP `<meta>` 가 남아 주입한 `<style>` 차단 | CSP·refresh·set-cookie meta 제거 |
| 10 | Blob URL 미해제 | 60초 뒤 `revokeObjectURL` (즉시 해제하면 다운로드가 취소되는 브라우저 대응) |

### 4-2. 재구축 중 추가로 찾은 결함 (8건)

| # | v1 문제 | 영향 | v2 해결 방법 |
|---|---|---|---|
| A | 문자 인코딩 선언을 그대로 둔 채 UTF-8 로 저장 | **Shift_JIS·EUC-KR 페이지가 전부 깨짐** (일본 사이트에 치명적) | 기존 charset 선언 제거, `<meta charset="utf-8">` 을 문서 맨 앞에 삽입 |
| B | `crossorigin` 만 지우고 `integrity` 는 남김 | SRI 가 걸린 CDN CSS(Bootstrap 공식 CDN 스니펫 등)가 캡처 파일에서 차단 | 인라인하므로 해당 없음. 남는 `<link>` 도 `integrity` 함께 제거 |
| C | `<!DOCTYPE html>` 을 강제로 붙임 | doctype 없는 레거시 페이지가 quirks → 표준 모드로 바뀌어 레이아웃 변경 | 원본 doctype 그대로 재현 (없으면 없음) |
| D | 다운로드 링크를 `document.body` 에 붙여 클릭 | 문서 단위 클릭 위임(SPA 라우터, pjax 등)이 `preventDefault` 하면 **다운로드 자체가 안 됨** | 토스트의 closed Shadow DOM 안에서 클릭 → 바깥 리스너는 `<a>` 를 볼 수 없음 |
| E | iframe 을 그대로 둠 | 캡처 파일을 열면 **iframe 안의 원격 스크립트가 실행됨** (테스트에서 확인) | `sandbox` + `srcdoc` 자리표시로 교체 |
| F | form `action` 유지 | 캡처 파일에서 제출 버튼을 누르면 실제 서버로 전송 | `action`·`formaction` 제거 |
| G | 비밀번호 `value`, CSRF 토큰(meta, hidden input)이 파일에 그대로 남음 | 캡처 파일을 공유하면 유출 경로 | 비밀번호 값 제거, 이름에 csrf/token/session 등이 들어간 meta·hidden input 값 비움 |
| H | 커스텀 엘리먼트가 스크립트 없이 `:defined` 가 되지 않음 | `x-foo:not(:defined){visibility:hidden}` (웹 컴포넌트 라이브러리 권장 패턴)에 걸려 **컴포넌트가 사라짐** | CSS 의 `:not(:defined)` / `:defined` 치환 |

### 4-3. 그 밖의 개선

| 항목 | 내용 |
|---|---|
| `alert()` 제거 | 페이지를 멈추지 않는 토스트로 진행 상황과 결과 요약 표시 (클릭하면 닫힘) |
| 정화 범위 확대 | `template` 내부 재귀, 공백·제어문자·대소문자로 우회한 `javascript:`, `vbscript:`, `data:text/html`, SVG `<set>`/`<animate>` 로 href 바꾸기, `ping`, `nonce`, preload/prefetch |
| 폰트 용량 제어 | 일본어·한국어 웹폰트는 unicode-range 로 100개 넘게 쪼개져 있으므로 **페이지가 실제로 받은 서브셋만** 내장. 1개 2MB, 총 8MB 한도 |
| 파일명 | `capture-<호스트-경로>-<YYYYMMDD-HHmmss>.html` (같은 페이지 반복 캡처 시 `(1)` 붙는 문제 방지, 80자 제한) |
| 출처 기록 | `<meta name="ds-capture-source">`(쿼리스트링 제외), `ds-capture-time` |
| 중복 실행 방지 | 버튼 연타 시 두 번째 실행 무시 |
| 장애 격리 | 스타일시트 하나에서 예외가 나도 나머지는 계속 처리 |

---

## 5. 검증 결과

`npm test` 가 v1 과 v2 를 **같은 픽스처·같은 조건**에서 실행해 비교합니다.
환경: Playwright 1.56 번들 Chromium 141 (headless), 캡처 파일은 `file://` 로 다시 열어 검사.

| # | 항목 | v1 | v2 |
|---|---|---|---|
| 1 | Shift_JIS 페이지 문자 깨짐 없음 | FAIL | PASS |
| 2 | @font-face 폰트 로드 (CSS 상대경로) | FAIL | PASS |
| 3 | 배경 이미지 경로 = CSS 파일 기준 | FAIL | PASS |
| 4 | 동일 출처 @import | PASS | PASS |
| 5 | 교차 출처 CDN CSS | FAIL | PASS |
| 6 | CDN CSS 안의 @import | FAIL | PASS |
| 7 | CORS 불가 CDN (온라인) | FAIL | PASS |
| 8 | integrity(SRI) 걸린 CDN CSS | PASS | PASS |
| 9 | CSS-in-JS(insertRule) 스타일 | PASS | PASS |
| 10 | document.adoptedStyleSheets | FAIL | PASS |
| 11 | Shadow DOM 내용·스타일 | FAIL | PASS |
| 12 | :not(:defined) 로 숨겨지지 않음 | FAIL | PASS |
| 13 | canvas → 이미지 | FAIL | PASS |
| 14 | 입력값·체크·선택 상태 보존 | FAIL | PASS |
| 15 | submit 버튼 라벨 유지 | PASS | PASS |
| 16 | 비밀번호·CSRF 토큰 파일에 없음 | FAIL | PASS |
| 17 | script 0개 (template 포함) | FAIL | PASS |
| 18 | on* 속성 0개 (template 포함) | FAIL | PASS |
| 19 | javascript: URL 0개 (우회 표기 포함) | FAIL | PASS |
| 20 | iframe 무력화 (sandbox, src 없음) | FAIL | PASS |
| 21 | form action 제거 | FAIL | PASS |
| 22 | meta refresh 제거 | PASS | PASS |
| 23 | 동일 CSS 중복 적용 없음 | FAIL | PASS |
| 24 | 안내 UI 가 캡처에 섞이지 않음 | PASS | PASS |
| 25 | 화면에 안 쓰인 폰트는 내장 안 함 | FAIL | PASS |
| 26 | [오프라인] 폰트 내장 | FAIL | PASS |
| 27 | [오프라인] CDN CSS 내장 | FAIL | PASS |
| 28 | doctype 없는 quirks 모드 유지 | FAIL | PASS |
| 29 | 원본 `<base>` 기준 상대경로 | FAIL | PASS |
| 30 | CSP meta 가 있어도 스타일 적용 | FAIL | PASS |
| 31 | 클릭 가로채는 SPA 에서도 다운로드 | FAIL | PASS |

| 지표 | v1 | v2 |
|---|---|---|
| 통과 | 6 / 31 | **31 / 31** |
| 원본 화면 대비 픽셀 차이 | 19.53% | **0.98%** |
| 캡처 파일 크기 (픽스처) | 4KB | 472KB (폰트 357KB 내장 포함) |

v2 의 픽셀 차이 0.98% 는 의도된 자리표시(iframe, object), closed Shadow DOM, 오염된 canvas 영역입니다.
v1 에서 4번이 PASS 인 이유는 `<link>` 를 지우지 않아 온라인일 때 원본 CSS 가 다시 로드되기 때문입니다(중복 적용, 23번 FAIL).

---

## 6. 알려진 제한사항

| 항목 | 이유 | 대응 |
|---|---|---|
| closed Shadow DOM | 바깥에서 접근할 API 가 없음 | 호스트 요소만 남음 |
| 교차 출처 이미지를 그린 canvas | 브라우저 보안 정책(tainted canvas)으로 읽기 불가 | 빈 canvas 로 남음, 토스트에 개수 표시 |
| CORS 헤더 없는 CDN CSS | 읽을 수도 fetch 할 수도 없음 | `<link>` 절대경로 유지 → **온라인에서만** 적용 |
| CORS 헤더 없는 교차 출처 폰트 | fetch 불가 | 절대경로 유지. `file://` 에서 열면 폰트 요청은 CORS 가 필요하므로 표시 안 될 수 있음 |
| 이미지 | 용량 문제로 내장하지 않음 (절대 URL) | 오프라인·로그인 필요 이미지는 표시 안 됨 |
| 페이지 CSP 의 `connect-src` | 북마클릿의 fetch 도 페이지 CSP 를 따름 | 해당 CDN CSS 는 `<link>` 로 남음 |
| 스크롤 위치, `:hover` 상태, `<dialog>` 모달(top layer), WebGL(preserveDrawingBuffer=false) | DOM 에 상태가 남지 않음 | 미지원 |
| 브라우저 | Chromium 141 에서 자동 검증. Firefox·Safari 는 미검증 | 사용 전 한 번 수동 확인 권장 |

## 7. 스튜디오(로더) 쪽 참고사항

- Shadow DOM 은 `<template shadowrootmode="open">` 로 저장됩니다. **HTML 파서가 문서를 처음 읽을 때만** Shadow Root 로 붙습니다.
  - 동작: 파일을 직접 열기, `iframe.srcdoc`, `Document.parseHTMLUnsafe()`, `element.setHTMLUnsafe()`
  - 동작 안 함: `innerHTML`, 기본 옵션의 `DOMParser`
- 캡처 파일에는 `<meta name="ds-capture-source">`, `<meta name="ds-capture-time">` 가 들어 있어 스튜디오에서 원본 URL·캡처 시각을 표시할 수 있습니다.
- 자리표시 요소에는 `data-ds-placeholder`, canvas 변환 이미지에는 `data-ds-canvas`, 인라인된 외부 CSS 에는 `data-ds-href`(원본 URL) 속성이 붙습니다.

## 8. 보안 설계 요약

- 북마클릿이 보내는 네트워크 요청은 **페이지가 이미 참조하는 CSS·폰트에 대한 GET 뿐**이며, 교차 출처에는 쿠키를 보내지 않습니다(`credentials: 'omit'`). 외부로 데이터를 보내는 코드는 없습니다.
- 캡처 파일은 스크립트·이벤트 핸들러·위험 URL·iframe 원격 콘텐츠·폼 전송 대상이 모두 제거된 상태입니다.
- 민감값 제거는 **이름 패턴 기반**(`CONFIG.REDACT_NAME_RE`)입니다. 화면에 보이는 개인정보(고객명, 주소 등)는 그대로 캡처되므로 관리자 화면·고객 정보 화면의 캡처 파일은 공유에 주의하세요.

## 9. 설정값 (`src/capture.js` 상단 `CONFIG`)

| 키 | 기본값 | 설명 |
|---|---|---|
| `FETCH_TIMEOUT_MS` | 8000 | CDN CSS·폰트 요청 1건 타임아웃 |
| `MAX_IMPORT_DEPTH` | 4 | `@import` 재귀 한도 |
| `INLINE_FONTS` | true | 폰트 data: URL 내장 여부 |
| `FONT_MAX_BYTES` / `FONT_TOTAL_MAX_BYTES` | 2MB / 8MB | 폰트 내장 한도 |
| `REVOKE_DELAY_MS` | 60000 | Blob URL 해제 지연 |
| `REDACT_NAME_RE` | csrf, xsrf, token, nonce, authenticity, session, secret, api-key | 값을 비울 hidden input·meta 이름 패턴 |

변경 후 `npm run build` 로 `dist/` 를 다시 만드세요.
