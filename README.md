# abot — tmux용 개인 웹 터미널 게이트웨이

기존 **tmux** 세션(Claude·Codex·셸 등 무엇이든)을 아무 브라우저 — 폰·태블릿·다른 PC — 에서
Tailscale 네트워크를 통해 이어서 씁니다. abot은 [`ttyd`](https://github.com/tsl0922/ttyd) 앞에
작은 대시보드를 두어 호스트 선택 → tmux 세션 선택 → 입력(한글·음성 친화 입력창 포함)을 하게 해줍니다.
자체적으로 임의 셸 명령을 실행하지 않습니다 — tmux에 붙어 안전한 키 몇 개만 보냅니다.

이 폴더는 **전달용 패키지**입니다. 개인 호스트명·자격증명은 제거됐고, 호스트별 설정은 전부 설정파일 기반입니다.

## 지원 플랫폼

| 플랫폼 | 실행 방식 | 자동시작 |
|---|---|---|
| **macOS** | 네이티브 (Homebrew: ttyd·tmux·node) | LaunchAgent (KeepAlive) |
| **Windows** | WSL2(Ubuntu) 안에서 실행, Tailscale은 Windows | 작업 스케줄러 headless keepalive |

핵심 제약: abot은 **tmux**를 감싸는데 tmux는 Unix 전용입니다. 그래서 **Windows에서는 WSL2 안에서** 스택이 돕니다.

---

## macOS 빠른 시작

1. [Tailscale](https://tailscale.com/) 설치 후 로그인. 이 Mac의 MagicDNS 이름 확인(예: `mac1.YOUR-TAILNET.ts.net`).
2. 이 `abot-dist` 폴더를 Mac에 복사.
3. 폴더에서 (sudo 아님, 일반 사용자로) 실행:

   ```bash
   bash macos/install.sh --alias mac1 \
     --url https://mac1.YOUR-TAILNET.ts.net:9443/ --funnel 0
   ```

   - `--alias` — 이 호스트의 짧은 이름(대시보드 표시)
   - `--url` — 이 호스트의 `:9443` 주소
   - `--funnel 0` — 공개 안 함(tailnet 전용). 공개도 하려면 `--funnel 8443`(아래 *상호 접속* 참고)

설치기가 ttyd·tmux·node 설치, 로그인 생성, LaunchAgent 등록(로그인 시 자동시작 + 크래시 시 재시작),
Tailscale 노출까지 하고 끝에 로그인/URL을 출력합니다.

## Windows 빠른 시작

1. [Tailscale](https://tailscale.com/) 설치·로그인. 이 PC의 MagicDNS 이름 확인(예: `pca.YOUR-TAILNET.ts.net`).
2. `abot-dist` 폴더를 Windows PC에 복사.
3. **관리자 권한 PowerShell**을 폴더에서 열고 실행:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 `
     -Alias pcA `
     -TailnetUrl "https://pca.YOUR-TAILNET.ts.net:9443/" `
     -FunnelPort 0
   ```

WSL 세팅, 로그인 생성, Tailscale 노출, **headless keepalive**(로그아웃·재부팅해도 유지) 등록까지 합니다.

## 상호 접속 (여러 대가 서로 보이게)

대시보드의 호스트 전환기는 roster 파일을 읽습니다 — **`~/.abot/hosts.json`**
(Windows는 WSL 안, Mac은 홈). `config/hosts.example.json` 참고. 참여 호스트를 모두 넣으면 각 대시보드에서 서로 이동 가능:

```json
[
  { "label": "mac1", "href": "https://mac1.YOUR-TAILNET.ts.net:9443/", "publicHref": "https://mac1.YOUR-TAILNET.ts.net:8443/" },
  { "label": "pcA",  "href": "https://pca.YOUR-TAILNET.ts.net:9443/",  "publicHref": "https://pca.YOUR-TAILNET.ts.net:8443/" }
]
```

`href` vs `publicHref` 선택 기준:

- **같은 사람, 여러 대** → 한 tailnet. tailnet `:9443`(`href`)만 쓰면 됨. 공개 불필요, 가장 안전.
- **서로 다른 사람** → tailnet이 다름 → 상대 `:9443`에 못 닿음. 각 호스트를 **Tailscale Funnel**(`--funnel 8443` / `-FunnelPort 8443`)로 공개하고 로그인 공유. 이는 **터미널을 공개 인터넷에 노출**하므로 **강한 공유 비밀번호** 필수, 안 쓸 때는 `tailscale funnel --https=8443 off`로 닫기.

대시보드는 자동 판별: `:9443`(tailnet) 페이지에 있으면 `href`로, 아니면 `publicHref`로 링크.

## 인증

- 로그인은 폼 + 서명 세션 쿠키(모바일 비밀번호 관리자와 호환).
- 자격증명은 `~/.abot-auth`(`user:pass`, chmod 600), 설치 시 생성. **여러 호스트에 같은 로그인을 쓰려면 같은 `~/.abot-auth`를 복사**.
- `curl`/API용 Basic Auth도 지원.

## 서비스 관리

**macOS**
```bash
bash ~/_abot/scripts/abot-web-start-mac.sh   # 수동 시작
bash ~/_abot/scripts/abot-web-stop.sh        # 정지
launchctl unload ~/Library/LaunchAgents/com.abot.web.plist   # 자동시작 끄기
launchctl load   ~/Library/LaunchAgents/com.abot.web.plist   # 켜기
```

**Windows (WSL 안)**
```bash
bash ~/_abot/scripts/abot-web-start-wsl.sh   # 시작(멱등)
bash ~/_abot/scripts/abot-web-stop.sh        # 정지
```
**Windows keepalive 작업**
```powershell
schtasks /run /tn abot-keepalive             # 지금 시작(재부팅 없이)
Unregister-ScheduledTask -TaskName abot-keepalive -Confirm:$false   # 제거
```

## 파일

| 경로 | 설명 |
|---|---|
| `server/abot-web.js` | 대시보드 + tmux API + ttyd 프록시(단일 소스) |
| `config/hosts.example.json` | 호스트 roster 예시 |
| `.env.example` | 선택 env 오버라이드 |
| `scripts/setup-mac.sh` / `setup-wsl.sh` | 일회성 의존성·인증·roster 세팅 |
| `scripts/abot-web-start-mac.sh` / `-wsl.sh` / `abot-boot-wsl.sh` / `abot-web-stop.sh` | 실행 제어 |
| `macos/install.sh` / `com.abot.web.plist.template` / `abot-launchd.sh` | macOS 설치·LaunchAgent |
| `windows/install.ps1` / `install-keepalive.ps1` | Windows 설치·keepalive |
| `MANUAL.md` | 사용자용 버튼 설명 |

## 보안 메모

- 내 machine의 `~/.abot-auth`·`~/.abot-session-secret`은 절대 공유 금지 — 각 호스트가 자기 것을 생성/설정.
- 공개 Funnel = 인터넷에 노출된 터미널. 강한 비밀번호, 안 쓸 때 닫기.
- abot은 안전한 키(`C-c`·`Escape`·`C-u`·붙여넣기·엔터)만 노출 — 임의 명령 실행 엔드포인트 없음.

---
---

# abot — personal web terminal gateway for tmux (English)

Access your existing **tmux** sessions (Claude, Codex, shells — anything) from any
browser — phone, tablet, another PC — over your Tailscale network. abot puts a small
dashboard in front of [`ttyd`](https://github.com/tsl0922/ttyd): pick a host, pick a
tmux session, type (with a Korean/voice-friendly composer box). It never runs
arbitrary shell commands of its own — it only attaches to tmux and sends a small set
of safe keys.

This is a **handoff package**: personal hostnames/credentials are stripped and every
host-specific value is config-driven.

## Supported platforms

| Platform | How it runs | Auto-start |
|---|---|---|
| **macOS** | native (Homebrew: ttyd·tmux·node) | LaunchAgent (KeepAlive) |
| **Windows** | inside WSL2 (Ubuntu); Tailscale on Windows | Task Scheduler headless keepalive |

Hard constraint: abot wraps **tmux**, which is Unix-only — so on **Windows the stack
runs inside WSL2**.

## macOS quick start

1. Install [Tailscale](https://tailscale.com/) and sign in. Note this Mac's MagicDNS
   name, e.g. `mac1.YOUR-TAILNET.ts.net`.
2. Copy this `abot-dist` folder onto the Mac.
3. From the folder (as your normal user, not sudo):

   ```bash
   bash macos/install.sh --alias mac1 \
     --url https://mac1.YOUR-TAILNET.ts.net:9443/ --funnel 0
   ```

   - `--alias` — this host's short name (shown on the dashboard)
   - `--url` — this host's `:9443` URL
   - `--funnel 0` — tailnet only. Use `--funnel 8443` to also expose publicly (see *Mutual access*).

The installer sets up ttyd/tmux/node, generates a login, installs a LaunchAgent
(start at login + restart on crash), exposes via Tailscale, and prints the login/URL.

## Windows quick start

1. Install [Tailscale](https://tailscale.com/), sign in. Note this PC's MagicDNS name,
   e.g. `pca.YOUR-TAILNET.ts.net`.
2. Copy `abot-dist` onto the Windows PC.
3. Open **PowerShell as Administrator** in the folder and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 `
     -Alias pcA `
     -TailnetUrl "https://pca.YOUR-TAILNET.ts.net:9443/" `
     -FunnelPort 0
   ```

Sets up WSL, generates a login, exposes via Tailscale, installs the **headless
keepalive** (survives logout/reboot).

## Mutual access (several machines seeing each other)

The dashboard's host switcher reads a roster: **`~/.abot/hosts.json`** (inside WSL on
Windows, home on Mac). See `config/hosts.example.json`. Put every participating host
in it so each dashboard can jump to the others.

- **Same person, several machines** → one tailnet. Use tailnet `:9443` URLs (`href`).
  Safest, no public exposure.
- **Different people** (different tailnets) → they can't reach each other's `:9443`.
  Expose each host with **Tailscale Funnel** and share the login. This puts a terminal
  on the public internet — **use a strong shared password**, close when idle
  (`tailscale funnel --https=8443 off`).

The dashboard auto-picks: on a `:9443` (tailnet) page it links peers by `href`,
otherwise by `publicHref`.

## Auth

- Form login + signed session cookie (works with mobile password managers).
- Credentials in `~/.abot-auth` (`user:pass`, chmod 600), generated on setup. To share
  one login across hosts, copy the same `~/.abot-auth` to each.
- Basic Auth also works for `curl`/API.

## Managing the service

**macOS**
```bash
bash ~/_abot/scripts/abot-web-start-mac.sh
bash ~/_abot/scripts/abot-web-stop.sh
launchctl unload ~/Library/LaunchAgents/com.abot.web.plist
launchctl load   ~/Library/LaunchAgents/com.abot.web.plist
```
**Windows (inside WSL)**
```bash
bash ~/_abot/scripts/abot-web-start-wsl.sh
bash ~/_abot/scripts/abot-web-stop.sh
```
```powershell
schtasks /run /tn abot-keepalive
Unregister-ScheduledTask -TaskName abot-keepalive -Confirm:$false
```

## Security notes

- Never share `~/.abot-auth` or `~/.abot-session-secret` from *your* machine — each host
  makes its own.
- Public Funnel = a terminal on the internet. Strong password, close when idle.
- abot exposes only safe keys (`C-c`, `Escape`, `C-u`, paste/enter) — no arbitrary
  command-exec endpoint.
