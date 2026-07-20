<#
  abot Windows installer (A안: WSL + headless keepalive).

  What it does:
    1. Verifies WSL2 + a distro (installs Ubuntu if missing -> reboot needed).
    2. Copies this abot-dist into WSL at ~/_abot.
    3. Runs scripts/setup-wsl.sh (node, ttyd, tmux, auth, roster).
    4. Exposes the dashboard via Tailscale (serve for tailnet, funnel for public).
    5. Registers a headless keepalive scheduled task (survives logout/reboot).

  Run in an ELEVATED PowerShell (Run as Administrator), from the abot-dist folder:
    powershell -ExecutionPolicy Bypass -File .\windows\install.ps1

  Re-runnable. Skips steps already done.
#>
[CmdletBinding()]
param(
  [string]$Distro   = "Ubuntu",
  [string]$Alias    = "host1",
  [string]$TailnetUrl = "",            # e.g. https://host1.YOUR-TAILNET.ts.net:9443/
  [int]   $ServePort  = 9443,          # tailnet Serve HTTPS port
  [int]   $FunnelPort = 0,             # 0 = no public Funnel; else 443/8443/10000
  [switch]$SkipKeepalive
)

$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }

# --- admin check -----------------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run this in an elevated PowerShell (Run as Administrator)." }

$DistRoot = Split-Path -Parent $PSScriptRoot   # abot-dist/

# --- 1. WSL ----------------------------------------------------------------
Step "WSL check"
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) { throw "wsl.exe not found. Install: 'wsl --install' then reboot, re-run." }
$distros = (wsl.exe -l -q) -replace "`0","" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($distros -notcontains $Distro) {
  Warn "Distro '$Distro' not installed. Installing (a reboot may be required)..."
  wsl.exe --install -d $Distro
  Warn "If this is a fresh WSL install, REBOOT and re-run this script."
  return
}
$WinUser = $env:USERNAME
Write-Host "distro=$Distro  windowsUser=$WinUser"

# --- 2. copy files into WSL ~/_abot ---------------------------------------
Step "Copy abot-dist into WSL (~/_abot)"
$srcWsl = (wsl.exe -d $Distro wslpath -a "$DistRoot").Trim()
wsl.exe -d $Distro -- bash -lc "mkdir -p ~/_abot && cp -r '$srcWsl'/. ~/_abot/ && chmod +x ~/_abot/scripts/*.sh && echo copied to ~/_abot"

# --- 3. setup inside WSL ---------------------------------------------------
Step "WSL setup (node, ttyd, tmux, auth, roster)"
$pub = ""
if ($FunnelPort -gt 0 -and $TailnetUrl) {
  $pub = ($TailnetUrl -replace ":$ServePort/?$", ":$FunnelPort/")
}
$envPrefix = "ABOT_HOST_ALIAS='$Alias'"
if ($TailnetUrl) { $envPrefix += " ABOT_SELF_URL='$TailnetUrl'" }
if ($pub)        { $envPrefix += " ABOT_SELF_PUBLIC_URL='$pub'" }
wsl.exe -d $Distro -- bash -lc "$envPrefix bash ~/_abot/scripts/setup-wsl.sh"

# --- 4. start + Tailscale expose ------------------------------------------
Step "Start abot-web in WSL"
wsl.exe -d $Distro -- bash -lc "ABOT_HOST_ALIAS='$Alias' bash ~/_abot/scripts/abot-boot-wsl.sh"

Step "Tailscale expose"
$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (Test-Path $ts) {
  & $ts serve --bg --https=$ServePort "http://127.0.0.1:17900"
  Write-Host "tailnet Serve on :$ServePort -> 127.0.0.1:17900"
  if ($FunnelPort -gt 0) {
    & $ts funnel --bg --https=$FunnelPort "http://127.0.0.1:17900"
    Write-Host "public Funnel on :$FunnelPort (id/pw required)"
  }
} else {
  Warn "Tailscale not found at $ts. Expose manually: tailscale serve --bg --https=$ServePort http://127.0.0.1:17900"
}

# --- 5. headless keepalive -------------------------------------------------
if (-not $SkipKeepalive) {
  Step "Headless keepalive scheduled task"
  & "$PSScriptRoot\install-keepalive.ps1" -Distro $Distro -WinUser $WinUser
}

Step "Done"
Write-Host "Dashboard (tailnet): $TailnetUrl"
if ($pub) { Write-Host "Dashboard (public): $pub" }
Write-Host "Login: see the 'generated login' line above (or ~/.abot-auth inside WSL)."
Write-Host "Edit the host roster to add other machines: WSL ~/.abot/hosts.json"
