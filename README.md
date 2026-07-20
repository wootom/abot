# abot — personal web terminal gateway for tmux

Access your existing **tmux** sessions (running Claude, Codex, shells, whatever)
from any browser — phone, tablet, another PC — over your Tailscale network.
abot puts a small dashboard in front of [`ttyd`](https://github.com/tsl0922/ttyd)
so you can pick a host, pick a tmux session, and type (with a Korean/voice-friendly
composer box). It never runs arbitrary shell commands of its own — it only attaches
to tmux and sends a small set of safe keys.

This is a **handoff package**: personal hostnames/credentials have been stripped
and everything host-specific is config-driven.

## The one hard requirement

abot wraps **tmux**, which is Unix-only. On **Windows the stack runs inside WSL2**
(Ubuntu). Tailscale runs on Windows and forwards to WSL's localhost. That's the
supported Windows topology:

```
Browser ──HTTPS──> Tailscale (Windows) ──> 127.0.0.1:17900 (WSL) ──> abot-web
                                                                       └─> ttyd ─> tmux ─> your work
```

You need, per host: **WSL2 + Ubuntu**, **Tailscale**, and (installed automatically)
node, ttyd, tmux.

## Quick start (Windows)

1. Install [Tailscale](https://tailscale.com/) and sign in. Note this machine's
   MagicDNS name, e.g. `pca.YOUR-TAILNET.ts.net`.
2. Copy this `abot-dist` folder onto the Windows PC.
3. Open **PowerShell as Administrator** in the folder and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 `
     -Alias pcA `
     -TailnetUrl "https://pca.YOUR-TAILNET.ts.net:9443/" `
     -FunnelPort 0
   ```

   - `-Alias` — this host's short name (shown on the dashboard).
   - `-TailnetUrl` — this host's `:9443` URL.
   - `-FunnelPort 0` — no public exposure (tailnet only). Use `8443` (or `443`/`10000`)
     to also expose publicly via Tailscale Funnel — see **Mutual access** below.

The installer sets up WSL, generates a login, exposes the dashboard, and installs
the **headless keepalive** so abot survives logout and reboot. It prints the login
and URL at the end.

Open the URL on your phone/PC, log in, done.

## Mutual access (several machines seeing each other)

The dashboard's host switcher reads a roster file: **`~/.abot/hosts.json`** inside
WSL (see `config/hosts.example.json`). Put every participating host in it so each
dashboard can jump to the others:

```json
[
  { "label": "pcA", "href": "https://pca.YOUR-TAILNET.ts.net:9443/", "publicHref": "https://pca.YOUR-TAILNET.ts.net:8443/" },
  { "label": "pcB", "href": "https://pcb.YOUR-TAILNET.ts.net:9443/", "publicHref": "https://pcb.YOUR-TAILNET.ts.net:8443/" }
]
```

Two cases decide `href` vs `publicHref`:

- **Same person, several machines** → they're on **one tailnet**. Use tailnet
  `:9443` URLs (`href`). No public exposure needed. Safest.
- **Different people** (different tailnets) → they can't reach each other's
  `:9443`. Expose each host with **Tailscale Funnel** (`-FunnelPort 8443`) and share
  the login. This puts a terminal on the public internet — **use a strong shared
  password** and turn Funnel off when unused:
  `tailscale funnel --https=8443 off`.

The dashboard auto-picks: when you're on a `:9443` (tailnet) page it links peers by
`href`; otherwise it uses `publicHref`.

## Auth

- Login is a form + signed session cookie (works with mobile password managers).
- Credentials live in WSL `~/.abot-auth` (`user:pass`, chmod 600), generated on
  setup. **To share one login across hosts, copy the same `~/.abot-auth` to each.**
- Basic Auth also works for `curl`/API.

## Managing the service

Inside WSL:
```bash
bash ~/_abot/scripts/abot-web-start-wsl.sh   # start (idempotent)
bash ~/_abot/scripts/abot-web-stop.sh        # stop
```
Windows keepalive task:
```powershell
schtasks /run    /tn abot-keepalive          # start now (no reboot)
schtasks /query  /tn abot-keepalive
Unregister-ScheduledTask -TaskName abot-keepalive -Confirm:$false   # remove
```

## Files

| Path | What |
|---|---|
| `server/abot-web.js` | the dashboard + tmux API + ttyd proxy (single source) |
| `config/hosts.example.json` | host roster template |
| `.env.example` | optional env overrides |
| `scripts/setup-wsl.sh` | one-time WSL deps + auth + roster |
| `scripts/abot-web-start-wsl.sh` / `abot-boot-wsl.sh` / `abot-web-stop.sh` | run control |
| `windows/install.ps1` | Windows one-shot installer |
| `windows/install-keepalive.ps1` | headless keepalive scheduled task |
| `MANUAL.md` | end-user button reference |

## Security notes

- Never share `~/.abot-auth` or `~/.abot-session-secret` from *your* machine — each
  host generates its own (the session secret) and you set your own login.
- Public Funnel = a terminal on the internet. Strong password, close when idle.
- abot exposes only safe keys (`C-c`, `Escape`, `C-u`, paste/enter) — no arbitrary
  command-exec endpoint.
