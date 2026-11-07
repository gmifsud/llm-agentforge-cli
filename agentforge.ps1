<#
.SYNOPSIS
  agentforge — thin PowerShell forwarder to the Node core (src/cli/main.js).

.DESCRIPTION
  All logic lives in the Node core; this script only locates node and forwards
  every argument unchanged. Both spellings work:
    agentforge init -Path C:\Repos\app -Target claude -DryRun
    agentforge init --path C:\Repos\app --target claude --dry-run
  Run `agentforge help` for the full command list. Exit code is the core's.
#>
$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'src' 'cli' 'main.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "agentforge: node was not found on PATH (Node.js 20+ is required)" -ForegroundColor Red
    exit 1
}
& node $entry @args
exit $LASTEXITCODE
