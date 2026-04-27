# Packages

패키지는 String에서 앱과 도구를 배포하는 단위다.
하나의 SFMD 문서(또는 문서 디렉토리)가 하나의 패키지다.

---

## 디렉토리 구조

```
~/.string/
├── config.json                    # 전역 설정 + 패키지 레지스트리
├── packages/                      # 설치된 패키지 파일
│   ├── weather/
│   │   └── index.md               # 앱 엔트리포인트
│   └── gmail/
│       └── index.md
└── apps/                          # 앱별 persistent state ($var)
    ├── weather/
    │   └── env.json               # app:weather의 $var
    └── gmail/
        ├── env.json               # app:gmail의 $var
        ├── work/
        │   └── env.json           # app:gmail:work의 $var
        └── personal/
            └── env.json           # app:gmail:personal의 $var
```

### 역할 분리

| 디렉토리 | 내용 | 예시 |
|-----------|------|------|
| `packages/{name}/` | 패키지 소스 (문서 파일) | `index.md`, 멀티페이지 앱의 하위 `.md` |
| `apps/{name}/` | 런타임 상태 (`$var`) | `env.json` — 토큰, 설정값 등 |
| `config.json` | 전역 레지스트리 + 전역 `$var` | 어떤 앱/도구가 설치되어 있는지 |

패키지 소스와 런타임 상태는 분리된다.
`/uninstall`로 패키지를 삭제해도 `apps/` 아래 상태는 남을 수 있고,
반대로 상태를 초기화해도 패키지 소스는 유지된다.

---

## config.json

전역 설정 파일. 패키지 레지스트리와 전역 환경변수를 담는다.

```json
{
  "apps": {
    "weather": "file:///home/user/.string/packages/weather/index.md",
    "gmail": "file:///home/user/.string/packages/gmail/index.md"
  },
  "tools": {
    "translate": "file:///home/user/.string/packages/translate/index.md"
  },
  "env": {
    "LANG": "ko",
    "DEFAULT_CITY": "Seoul"
  }
}
```

| 키 | 용도 |
|----|------|
| `apps` | 앱 이름 → 엔트리포인트 URI 매핑 |
| `tools` | 도구 이름 → 엔트리포인트 URI 매핑 |
| `env` | 전역 `$var` (모든 세션에서 접근 가능) |

---

## 패키지 설치

### /install

```
/install ./weather.md              # 로컬 파일에서 설치
/install --app ./weather.md        # 명시적으로 앱으로 설치
/install --tool ./translate.md     # 명시적으로 도구로 설치
/install https://example.com/a.md  # URL에서 설치
/install                           # 현재 열린 문서를 설치
```

**동작:**
1. 소스 문서를 로드 (로컬 파일 또는 HTTP)
2. frontmatter에서 `name`과 `type` 파싱
3. `~/.string/packages/{name}/index.md`로 복사
4. `config.json`에 레지스트리 등록

**타입 판별 우선순위:**
1. `--app` / `--tool` 플래그 (명시적)
2. frontmatter `type` 필드
3. 둘 다 없으면 에러 + 안내

**이름 결정:**
1. frontmatter `name` 필드
2. 없으면 파일명에서 파생 (`weather.md` → `weather`)

### /uninstall

```
/uninstall weather                 # 패키지 제거
/uninstall translate
```

**동작:**
1. `config.json`에서 레지스트리 항목 삭제
2. `~/.string/packages/{name}/` 디렉토리 삭제
3. `apps/{name}/` (런타임 상태)는 삭제하지 않음

---

## 패키지 해석 (Resolution)

### 앱

`app:name` 타겟으로 접근할 때:

```
1. config.json의 apps[name] → URI로 직접 로드
```

현재는 `config.json` 레지스트리만 참조한다.
등록되지 않은 이름은 에러.

### 도구

`/tool:name` 호출 시:

```
1. ./tools/{name}.md               ← 워크스페이스 로컬
2. ~/.string/tools/{name}.md       ← 글로벌 설치 (직접 배치)
3. config.json의 tools[name]       ← /install로 설치한 것
4. 레지스트리 (원격)               ← 미래
```

워크스페이스 로컬이 최우선. 프로젝트별 커스터마이징 가능.

---

## 패키지 문서 구조

### 싱글 페이지 (기본)

대부분의 앱과 모든 도구:

```
packages/weather/
└── index.md
```

```markdown
---
name: weather
type: app
description: Weather conditions and forecasts
---

# Weather

```act.now
CLI curl -s "wttr.in/{city}?format=%l:+%c+%t"
  city: string (required) "City name"
```
```

### 멀티 페이지 앱

복잡한 앱은 여러 `.md` 파일로 구성:

```
packages/gmail/
├── index.md           # 엔트리포인트 (inbox)
├── compose.md         # 메일 작성
├── thread.md          # 쓰레드 보기
└── nav/
    └── main.md        # 네비게이션 메뉴
```

`index.md`가 항상 엔트리포인트. `app:gmail`로 접근하면
`index.md`가 열린다. 내부에서 `/open compose.md` 등으로
다른 페이지로 이동.

---

## 환경변수 ($var) 스코프

패키지의 `$var`는 세션 이름에서 스코프가 결정된다.

| 세션 이름 | 스코프 | 저장 위치 |
|-----------|--------|-----------|
| `file:main` | 전역만 | `config.json` → `env` |
| `app:weather` | 전역 + 앱 | `apps/weather/env.json` |
| `app:gmail:work` | 전역 + 앱 + config | `apps/gmail/work/env.json` |

**캐스케이드 (가장 구체적이 우선):**

```
config (apps/gmail/work/env.json)
  ↓ 없으면
app (apps/gmail/env.json)
  ↓ 없으면
global (config.json → env)
```

같은 앱의 다른 config는 완전히 독립된 상태를 갖는다:

```
app:gmail:work     → apps/gmail/work/env.json     # 회사 토큰
app:gmail:personal → apps/gmail/personal/env.json  # 개인 토큰
```

### $var 설정

```
/set $API_KEY = "sk-..."           # 현재 스코프에 저장
/set $CITY = "Seoul"               # app 세션이면 앱 스코프에 저장
```

`/set`으로 설정한 `$var`는 디스크에 즉시 저장된다.
세션이 종료되어도 유지된다.

---

## Frontmatter 필수 필드

패키지로 배포할 문서의 frontmatter:

```yaml
---
name: gmail                          # 패키지 이름 (필수)
type: app                            # app 또는 tool (필수)
description: Gmail inbox management  # 설명
default: inbox                       # /open 시 자동 실행할 액션
env:                                 # 필요한 환경변수 선언
  - GMAIL_TOKEN: "OAuth access token"
---
```

| 필드 | 용도 | 필수 |
|------|------|------|
| `name` | 패키지 이름 (`/install` 시 디렉토리명) | 권장 |
| `type` | `app` 또는 `tool` | `/install` 시 필요 |
| `description` | 설명 | 선택 |
| `default` | 기본 액션 ID | 선택 |
| `env` | 필요한 `$var` 선언 + 설명 | 선택 |

`name`과 `type`이 없으면 `/install` 시 플래그로 명시하거나
파일명에서 유추한다.

---

## 실전 예시

### Weather 앱

```bash
# 설치 (또는 직접 ~/.string/packages/weather/index.md에 배치)
/install --app ./weather.md

# 사용
string app:weather '/act.now --city "Seoul"'
string app:weather '/act.forecast --city "London"'
```

### Gmail 앱

```bash
# 직접 배치
~/.string/packages/gmail/index.md

# 사용
string app:gmail '/act.profile'
string app:gmail '/act.inbox --max 5'
string app:gmail '/act.search --q "from:user@example.com"'

# config별 사용
string app:gmail:work '/act.inbox'
string app:gmail:personal '/act.inbox'
```

### 도구

```bash
# 설치
/install --tool ./translate.md

# 어디서든 호출 (컨텍스트 전환 없음)
/tool:translate --text "hello" --to "ko"
```

---

## 향후 계획

| 기능 | 상태 |
|------|------|
| 로컬 `/install`, `/uninstall` | 구현 완료 |
| `config.json` 레지스트리 | 구현 완료 |
| `$var` 스코프 캐스케이드 | 구현 완료 |
| 원격 레지스트리 (검색, 다운로드) | 미구현 |
| 패키지 버전 관리 | 미구현 |
| 의존성 (패키지 간 참조) | 미구현 |
| 서명 / 신뢰 체계 | 미구현 |

현재는 "파일 복사 + JSON 등록"의 단순한 구조.
원격 레지스트리가 추가되면 `@string/gmail` 같은 패키지명으로
설치하는 것도 가능해진다.
