<#
  Headless keepalive for abot on WSL.

  WSL2 shuts the VM down when no session is attached (abot dies ~20s after boot).
  This registers a scheduled task that, at Windows startup, launches WSL, runs the
  idempotent boot script, then holds the VM open with `tail -f /dev/null`.

  Trigger = AtStartup + LogonType Password (RunLevel Highest) so it runs
  headless — survives logout and needs no interactive login. You will be asked
  for the Windows account password once (stored by Task Scheduler, encrypted).

  Standalone use:
    powershell -ExecutionPolicy Bypass -File .\windows\install-keepalive.ps1 -Distro Ubuntu
#>
[CmdletBinding()]
param(
  [string]$Distro  = "Ubuntu",
  [string]$WinUser = $env:USERNAME,
  [string]$TaskName = "abot-keepalive"
)
$ErrorActionPreference = "Stop"

$bootCmd = "bash ~/_abot/scripts/abot-boot-wsl.sh >> ~/abot-boot.log 2>&1; exec tail -f /dev/null"
$wslArgs = "-d $Distro -- bash -lc `"$bootCmd`""

$action  = New-ScheduledTaskAction -Execute "wsl.exe" -Argument $wslArgs
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3

Write-Host "Enter the Windows password for '$WinUser' (needed so abot runs when logged off):" -ForegroundColor Cyan
$sec = Read-Host -AsSecureString
$pw  = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -RunLevel Highest -User $WinUser -Password $pw | Out-Null

Write-Host "Registered task '$TaskName' (AtStartup, runs whether logged on or not)." -ForegroundColor Green
Write-Host "Start it now without rebooting:  schtasks /run /tn $TaskName"
Write-Host "Remove it:  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
