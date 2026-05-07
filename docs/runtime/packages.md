---
title: Packages
---

패키지는 String에서 앱과 도구를 배포하는 단위다.
하나의 SFMD 문서(또는 문서 디렉토리)가 하나의 패키지다.

---

## 디렉토리 구조

```
~/.string/
├── config.json                    # 전역 설정 + 패키지 레지스트리
├── packages/                      # 설치된 패키지 파일
│   ├── weather/
│   │   └── string.md               # 앱 엔트리포인트
│   └── gmail/
│       └── string.md
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
| `packages/{name}/` | 패키지 소스 (문서 파일) | `string.md`, 멀티페이지 앱의 하위 `.md` |
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
    "weather": "file:///home/user/.string/packages/weather/string.md",
    "gmail": "file:///home/user/.string/packages/gmail/string.md"
  },
  "tools": {
    "translate": "file:///home/user/.string/packages/translate/string.md"
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
/install ./weather.md                   # 로컬 파일
/install --app ./weather.md             # 명시적으로 앱
/install --tool ./translate.md          # 명시적으로 도구
/install https://example.com/a.md       # 단일 마크다운 URL
/install https://hub.example/api/install/cookbook/weather  # install manifest URL
/install --link https://hub.example/api/install/cookbook/weather  # URL 단축키로 등록 (로컬 복사 X)
/install --as weather-2 ./other.md      # 로컬 이름 강제 지정
/install                                # 현재 열린 문서를 설치
```

**동작:**
1. 소스를 로드 (로컬 파일, 단일 markdown URL, 또는 install manifest URL — [install-manifest.md](./install-manifest.md))
2. frontmatter에서 `name`, `namespace`, `type` 파싱
3. 충돌 검사 ((namespace, name) 기준 — 아래 "충돌 처리")
4. **원자적 설치:** `packages/.{name}.tmp/`에 staging → 모든 파일 검증/복사 성공 후에만 `packages/{name}/`로 atomic rename. 실패 시 staging 삭제, 기존 설치본 그대로
5. `config.json`에 레지스트리 등록

**타입 판별 우선순위:**
1. `--app` / `--tool` 플래그 (명시적)
2. frontmatter `type` 필드
3. install manifest의 frontmatter
4. 모두 없으면 에러 + 안내

**이름 결정 (로컬 레지스트리 키):**
1. `--as <local-name>` 플래그 (명시적)
2. frontmatter `name` 필드
3. 없으면 파일명에서 파생 (`weather.md` → `weather`)

**충돌 처리:**

이미 같은 로컬 이름으로 설치된 패키지가 있으면 frontmatter의
`(namespace, name)`을 비교한다.

- 같은 (namespace, name) → **재설치**로 간주, 덮어쓰기 (버전 업그레이드)
- 다른 (namespace, name) → **충돌**로 간주, 거부. 메시지에 `--as`로 다른 이름 사용하거나 기존 것을 `/uninstall`하라는 안내

이 덕분에 `cookbook/weather`와 `stringhub/weather`처럼 같은 `name`을 쓰는
다른 publisher의 앱을 `--as`만 다르게 주면 나란히 설치할 수 있다.

**플래그:**

| 플래그 | 효과 |
|--------|------|
| `--app` / `--tool` | frontmatter `type` 명시적 override |
| `--as <local-name>` | 로컬 레지스트리 키 강제 지정. 같은 (ns, name) 충돌 회피용 |
| `--link` | URL을 그대로 레지스트리에 등록, 로컬 복사 안 함. `/open app:<name>`마다 publisher 서버에서 fetch. http(s) URL 전용 |

### /uninstall

```
/uninstall weather                 # 패키지 제거
/uninstall translate
```

**동작:**
1. `config.json`에서 레지스트리 항목 삭제
2. `~/.string/packages/{name}/` 디렉토리 삭제
3. **좀비 토픽 청소:** 해당 패키지를 가리키던 모든 토픽을 `/topics`에서 제거 (Map에서 삭제 — close만 하면 빈 shell이 누적됨). 출력에 정리된 토픽 이름이 함께 표시된다
4. `apps/{name}/` (런타임 상태)는 삭제하지 않음 — 같은 이름으로 재설치하면 환경변수가 그대로 살아 있다

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
└── string.md
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
├── string.md           # 엔트리포인트 (inbox)
├── compose.md         # 메일 작성
├── thread.md          # 쓰레드 보기
└── nav/
    └── main.md        # 네비게이션 메뉴
```

`string.md`가 항상 엔트리포인트. `app:gmail`로 접근하면
`string.md`가 열린다. 내부에서 `/open compose.md` 등으로
다른 페이지로 이동.

**로컬 설치 동작 (`/install ./gmail/`)**: `string.md` 옆에 있는
모든 `.md` 파일이 `packages/{name}/` 아래로 함께 복사된다.
Sub-directory 구조 (`nav/main.md` 같은)는 manifest 기반 설치에서
명시적으로 선언해야 한다 — 로컬 설치는 같은 디렉토리의
top-level `.md`만 자동으로 가져간다.

**원격 설치 동작 (manifest URL)**: publisher가 [install
manifest](./install-manifest.md)에 `files[]`를 선언해 놓으면
sub-directory 포함 모든 파일이 staging 디렉토리에 받아진 뒤
원자적으로 live 위치로 swap된다. 도중에 어느 한 파일이라도
실패하면 staging은 폐기되고 기존 설치본은 그대로 유지된다.

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
namespace: cookbook                  # publisher 식별자 — 충돌 검사용 (권장)
type: app                            # app 또는 tool (필수)
description: Gmail inbox management  # 설명
default: inbox                       # /open 시 자동 실행할 액션
env:                                 # 필요한 환경변수 선언
  - GMAIL_TOKEN: "OAuth access token"
---
```

| 필드 | 용도 | 필수 |
|------|------|------|
| `name` | 패키지 이름 (`/install` 시 기본 레지스트리 키) | 권장 |
| `namespace` | publisher 식별자. `(namespace, name)`이 패키지의 canonical identity. 두 publisher가 같은 `name`을 써도 namespace가 다르면 충돌 검사가 통과한다 | 권장 |
| `type` | `app` 또는 `tool` | `/install` 시 필요 |
| `description` | 설명 | 선택 |
| `default` | 기본 액션 ID. `/open`, `/refresh`, `/back` 시 자동 실행 | 선택 |
| `env` | 필요한 `$var` 선언 + 설명 | 선택 |

`name`과 `type`이 없으면 `/install` 시 플래그로 명시하거나
파일명에서 유추한다. `namespace`가 없는 패키지도 설치 가능하지만
같은 `name`을 쓰는 다른 패키지와 나란히 설치하기 어려워진다.

자세한 의미는 [SFMD Frontmatter](../sfmd/frontmatter.md) 참조.

---

## 실전 예시

### Weather 앱

```bash
# 설치 (또는 직접 ~/.string/packages/weather/string.md에 배치)
/install --app ./weather.md

# 사용
string app:weather '/act.now --city "Seoul"'
string app:weather '/act.forecast --city "London"'
```

### Gmail 앱

```bash
# 직접 배치
~/.string/packages/gmail/string.md

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
| Install manifest (HTTP source) | 구현 완료 ([스펙](./install-manifest.md)) |
| `--link` URL 단축키 설치 | 구현 완료 |
| `--as` 로컬 이름 override | 구현 완료 |
| (namespace, name) 충돌 검사 | 구현 완료 |
| 원자적 설치 (staging + atomic rename) | 구현 완료 |
| 패키지 버전 관리 | 미구현 |
| 의존성 (패키지 간 참조) | 미구현 |
| 서명 / 신뢰 체계 | 미구현 |

원격 레지스트리는 install manifest를 emit하는 임의의 HTTP source면
어디든 가능 (StringHub, 자체 GitHub Pages 등). 자세한 contract는
[install-manifest.md](./install-manifest.md).
