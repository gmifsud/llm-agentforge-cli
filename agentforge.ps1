<#
.SYNOPSIS
  agentforge — bootstrap a repo with a token-optimised CLAUDE.md / AGENTS.md
  and a junction/symlink to the shared skill vault.

.DESCRIPTION
  Cross-platform (PowerShell 5.1+ and PowerShell 7+ / pwsh).
  Idempotent. Non-destructive unless -Force.

.PARAMETER Command
  init   — create the agent doc + skills link in the target project
  link   — (re)create only the skills link
  doctor — diagnose the bootstrap state of a project
  help   — show this help

.PARAMETER Path
  Project root. Defaults to current working directory.

.PARAMETER Target
  claude  — CLAUDE.md  + .claude/skills            (default)
  codex   — AGENTS.md  + .codex/skills
  generic — AGENTS.md  + .agents/skills
  all     — all three

.PARAMETER Name
  Project name used in the template. Defaults to leaf folder name.

.PARAMETER Stack
  Free-form stack description (e.g. "TypeScript / .NET 8 / SQL Server").

.PARAMETER VaultRoot
  Path to the skills vault. Defaults to $env:AGENTFORGE_VAULT_ROOT,
  then to C:\Repos\LLM\llm-skill-vault\skills (Windows) or ~/repos/LLM/llm-skill-vault/skills (Unix).

.PARAMETER LinkType
  junction (Windows default), symlink (Unix default), copy, or none.

.PARAMETER DryRun
  Print actions without performing them.

.PARAMETER Force
  Overwrite existing CLAUDE.md / AGENTS.md and replace existing skills link.

.EXAMPLE
  pwsh agentforge.ps1 init -Path C:\Repos\LLM\my-new-app -Name my-new-app -Stack "TypeScript / Vite"

.EXAMPLE
  pwsh agentforge.ps1 init -Target all -DryRun

.EXAMPLE
  pwsh agentforge.ps1 doctor -Path .
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('init', 'link', 'doctor', 'help')]
    [string]$Command = 'help',

    [string]$Path,

    [ValidateSet('claude', 'codex', 'generic', 'all')]
    [string]$Target = 'claude',

    [string]$Name,
    [string]$Stack = '<fill in>',
    [string]$Owner = $env:USERNAME,
    [string]$BuildCmd = '<build>',
    [string]$TestCmd  = '<test>',
    [string]$RunCmd   = '<run>',

    [string]$VaultRoot,

    [ValidateSet('junction', 'symlink', 'copy', 'none', 'auto')]
    [string]$LinkType = 'auto',

    [switch]$DryRun,
    [switch]$Force
)

# ---------- platform helpers ----------
function Test-IsWindows {
    if (Get-Variable -Name IsWindows -Scope Global -ErrorAction SilentlyContinue) {
        return [bool]$IsWindows
    }
    return $env:OS -eq 'Windows_NT'
}

$Script:OnWindows = Test-IsWindows
$Script:ScriptDir = Split-Path -Parent $PSCommandPath

# ---------- defaults ----------
if (-not $Path) { $Path = (Get-Location).Path }
$resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
if ($resolved) { $Path = $resolved.Path }
if (-not $Name) { $Name = Split-Path -Leaf $Path }

if (-not $VaultRoot) {
    if ($env:AGENTFORGE_VAULT_ROOT) {
        $VaultRoot = $env:AGENTFORGE_VAULT_ROOT
    } elseif ($Script:OnWindows) {
        $VaultRoot = 'C:\Repos\LLM\llm-skill-vault\skills'
    } else {
        $VaultRoot = (Join-Path $HOME 'repos/LLM/llm-skill-vault/skills')
    }
}

if ($LinkType -eq 'auto') {
    $LinkType = if ($Script:OnWindows) { 'junction' } else { 'symlink' }
}

# ---------- target matrix ----------
$Targets = @{
    claude  = @{ Doc = 'CLAUDE.md';  Dir = '.claude';  Tmpl = 'CLAUDE.md.tmpl' }
    codex   = @{ Doc = 'AGENTS.md';  Dir = '.codex';   Tmpl = 'AGENTS.md.tmpl' }
    generic = @{ Doc = 'AGENTS.md';  Dir = '.agents';  Tmpl = 'AGENTS.md.tmpl' }
}

function Get-TargetSet {
    param([string]$T)
    if ($T -eq 'all') { return $Targets.Keys }
    return @($T)
}

# ---------- logging ----------
function Write-Step  { param([string]$msg) Write-Host "→ $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Warn2 { param([string]$msg) Write-Host "! $msg" -ForegroundColor Yellow }
function Write-Err2  { param([string]$msg) Write-Host "✗ $msg" -ForegroundColor Red }
function Write-Dry   { param([string]$msg) Write-Host "(dry) $msg" -ForegroundColor DarkGray }

# ---------- core ops ----------
function Render-Template {
    param(
        [string]$TemplatePath,
        [hashtable]$Vars
    )
    if (-not (Test-Path -LiteralPath $TemplatePath)) {
        throw "Template not found: $TemplatePath"
    }
    $content = Get-Content -LiteralPath $TemplatePath -Raw
    foreach ($k in $Vars.Keys) {
        $content = $content.Replace('${' + $k + '}', [string]$Vars[$k])
    }
    return $content
}

function New-AgentDoc {
    param(
        [string]$ProjectRoot,
        [hashtable]$TargetCfg
    )
    $tmplPath = Join-Path (Join-Path $Script:ScriptDir 'templates') $TargetCfg.Tmpl
    $outPath  = Join-Path $ProjectRoot $TargetCfg.Doc

    if ((Test-Path -LiteralPath $outPath) -and -not $Force) {
        Write-Warn2 "$($TargetCfg.Doc) already exists — skipping (use -Force to overwrite)"
        return
    }

    $vars = @{
        PROJECT_NAME   = $Name
        TECH_STACK     = $Stack
        OWNER          = $Owner
        REPO_ROOT      = $ProjectRoot
        BOOTSTRAP_DATE = (Get-Date -Format 'yyyy-MM-dd')
        BUILD_CMD      = $BuildCmd
        TEST_CMD       = $TestCmd
        RUN_CMD        = $RunCmd
    }

    $rendered = Render-Template -TemplatePath $tmplPath -Vars $vars

    if ($DryRun) {
        Write-Dry "would write $outPath ($([Math]::Round($rendered.Length/1024,1)) KB)"
        return
    }
    Set-Content -LiteralPath $outPath -Value $rendered -Encoding UTF8 -NoNewline:$false
    Write-Ok "wrote $($TargetCfg.Doc)"
}

function New-SkillsLink {
    param(
        [string]$ProjectRoot,
        [hashtable]$TargetCfg
    )
    $dotDir   = Join-Path $ProjectRoot $TargetCfg.Dir
    $linkPath = Join-Path $dotDir 'skills'

    if (-not (Test-Path -LiteralPath $VaultRoot)) {
        Write-Err2 "Vault root does not exist: $VaultRoot"
        return
    }

    if (-not (Test-Path -LiteralPath $dotDir)) {
        if ($DryRun) { Write-Dry "would mkdir $dotDir" }
        else { New-Item -ItemType Directory -Path $dotDir -Force | Out-Null }
    }

    if (Test-Path -LiteralPath $linkPath) {
        if (-not $Force) {
            Write-Warn2 "$($TargetCfg.Dir)/skills already exists — skipping (use -Force to replace)"
            return
        }
        if ($DryRun) { Write-Dry "would remove existing $linkPath" }
        else {
            # Remove-Item handles junctions/symlinks/dirs/files
            Remove-Item -LiteralPath $linkPath -Recurse -Force
        }
    }

    switch ($LinkType) {
        'junction' {
            if (-not $Script:OnWindows) {
                Write-Err2 "junction not supported on non-Windows; falling back to symlink"
                $effectiveType = 'symlink'
            } else { $effectiveType = 'junction' }
        }
        default { $effectiveType = $LinkType }
    }

    if ($DryRun) {
        Write-Dry "would create $effectiveType: $linkPath -> $VaultRoot"
        return
    }

    try {
        switch ($effectiveType) {
            'junction' {
                New-Item -ItemType Junction -Path $linkPath -Target $VaultRoot | Out-Null
            }
            'symlink' {
                # Requires admin or Developer Mode on Windows for SymbolicLink
                New-Item -ItemType SymbolicLink -Path $linkPath -Target $VaultRoot | Out-Null
            }
            'copy' {
                Copy-Item -LiteralPath $VaultRoot -Destination $linkPath -Recurse -Force
            }
            'none' {
                Write-Warn2 "LinkType=none — skipping skills link"
                return
            }
        }
        Write-Ok "linked $($TargetCfg.Dir)/skills ($effectiveType) -> $VaultRoot"
    } catch {
        Write-Err2 "failed to create ${effectiveType}: $_"
        if ($effectiveType -eq 'symlink' -and $Script:OnWindows) {
            Write-Warn2 "Symlinks on Windows need admin or Developer Mode. Use -LinkType junction instead."
        }
    }
}

function Invoke-Init {
    Write-Step "agentforge init"
    Write-Host "  Project : $Name ($Path)"
    Write-Host "  Target  : $Target"
    Write-Host "  Vault   : $VaultRoot"
    Write-Host "  Link    : $LinkType"
    if ($DryRun) { Write-Host "  Mode    : DRY RUN" -ForegroundColor Yellow }
    Write-Host ""

    if (-not (Test-Path -LiteralPath $Path)) {
        if ($DryRun) { Write-Dry "would create project root $Path" }
        else { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
    }

    foreach ($t in (Get-TargetSet $Target)) {
        Write-Step "target: $t"
        $cfg = $Targets[$t]
        New-AgentDoc    -ProjectRoot $Path -TargetCfg $cfg
        New-SkillsLink  -ProjectRoot $Path -TargetCfg $cfg
    }
}

function Invoke-Link {
    Write-Step "agentforge link"
    foreach ($t in (Get-TargetSet $Target)) {
        Write-Step "target: $t"
        New-SkillsLink -ProjectRoot $Path -TargetCfg $Targets[$t]
    }
}

function Invoke-Doctor {
    Write-Step "agentforge doctor"
    Write-Host "  Project : $Path"
    Write-Host "  Vault   : $VaultRoot"
    Write-Host ""

    if (-not (Test-Path -LiteralPath $VaultRoot)) {
        Write-Err2 "vault not found: $VaultRoot"
    } else {
        $skillCount = (Get-ChildItem -LiteralPath $VaultRoot -Directory -ErrorAction SilentlyContinue).Count
        Write-Ok "vault present ($skillCount skill folders)"
    }

    foreach ($t in $Targets.Keys) {
        $cfg = $Targets[$t]
        $doc = Join-Path $Path $cfg.Doc
        $lnk = Join-Path (Join-Path $Path $cfg.Dir) 'skills'
        $docOk = Test-Path -LiteralPath $doc
        $lnkOk = Test-Path -LiteralPath $lnk

        $line = "{0,-8}  doc:{1}  link:{2}" -f $t, ($(if ($docOk) {'✓'} else {'·'})), ($(if ($lnkOk) {'✓'} else {'·'}))
        Write-Host "  $line"

        if ($lnkOk) {
            try {
                $item = Get-Item -LiteralPath $lnk -Force
                if ($item.LinkType) {
                    Write-Host "             ↳ $($item.LinkType) → $($item.Target)" -ForegroundColor DarkGray
                }
            } catch { }
        }
    }
}

function Show-Help {
    Get-Help $PSCommandPath -Detailed | Out-String | Write-Host
}

# ---------- dispatch ----------
switch ($Command) {
    'init'   { Invoke-Init }
    'link'   { Invoke-Link }
    'doctor' { Invoke-Doctor }
    'help'   { Show-Help }
}
