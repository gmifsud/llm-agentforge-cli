<#
.SYNOPSIS
    Archives agent skills for portability or exports them for Perplexity Computer.

.DESCRIPTION
    Collects skills from three sources:
      - Skill Vault        (C:\Repos\LLM\llm-skill-vault)
      - Matt Pocock Skills (C:\Repos\LLM\llm-skills-mattpocock)
      - Gemini Global      (~\.gemini\config\skills)

    Modes:
      1. Default / Zip mode: Archives all skills into zipped bundles.
      2. -PerplexityMode: Formats each skill for direct Perplexity upload:
         - Single-file skills -> exported as <skill-name>.md
         - Multi-file skills  -> compressed as individual <skill-name>.zip (with SKILL.md at zip root)

.PARAMETER PerplexityMode
    Exports skills in Perplexity Computer's exact upload format.

.PARAMETER MaxFilesPerChunk
    For bundled zip mode: Maximum files per chunk zip (0 = single bundle zip).

.PARAMETER OutputDir
    Directory to write the output to. Defaults to .\archives in the script's parent repo.

.EXAMPLE
    # Export for Perplexity Computer upload:
    .\archive-skills.ps1 -PerplexityMode

.EXAMPLE
    # Create multi-skill bundled zip(s):
    .\archive-skills.ps1 -MaxFilesPerChunk 100
#>

param(
    [switch]$PerplexityMode,
    [int]$MaxFilesPerChunk = 0,
    [string]$OutputDir = ""
)

# -- Configuration -----------------------------------------------------------
$sources = @(
    @{
        Name = "skill-vault"
        Path = "C:\Repos\LLM\llm-skill-vault"
        Exclude = @(".git")
    },
    @{
        Name = "skills-mattpocock"
        Path = "C:\Repos\LLM\llm-skills-mattpocock"
        Exclude = @(".git", ".out-of-scope")
    },
    @{
        Name = "gemini-global-skills"
        Path = "$env:USERPROFILE\.gemini\config\skills"
        Exclude = @()
    }
)

$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"

# Resolve output directory
if (-not $OutputDir) {
    $scriptDir = $PSScriptRoot
    if (-not $scriptDir) {
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    $repoRoot = Split-Path -Parent $scriptDir
    if ($PerplexityMode) {
        $OutputDir = Join-Path $repoRoot "archives\perplexity_skills"
    } else {
        $OutputDir = Join-Path $repoRoot "archives"
    }
}

# Create output dir
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$stagingRoot = Join-Path $env:TEMP "skills-archive-staging-$timestamp"

# -- Helper: Copy source to staging ------------------------------------------
function Copy-SkillSource {
    param(
        [hashtable]$Source,
        [string]$Destination
    )

    $excludeArgs = @()
    foreach ($ex in $Source.Exclude) {
        $excludeArgs += $ex
    }

    Write-Host "  Copying $($Source.Name)..." -ForegroundColor Cyan

    $roboArgs = @($Source.Path, $Destination, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
    if ($excludeArgs.Count -gt 0) {
        $roboArgs += "/XD"
        $roboArgs += $excludeArgs
    }

    & robocopy @roboArgs | Out-Null
}

# -- Helper: Find all skill folders (by SKILL.md presence) -------------------
function Get-SkillFolders {
    param([string]$StagedPath)

    Get-ChildItem -Path $StagedPath -Recurse -Filter "SKILL.md" -File | ForEach-Object {
        $skillDir = $_.Directory
        $files = Get-ChildItem -Path $skillDir.FullName -Recurse -File
        [PSCustomObject]@{
            Name       = $skillDir.Name
            FullPath   = $skillDir.FullName
            SourceName = (Split-Path -Leaf $StagedPath)
            FileCount  = $files.Count
            Files      = $files
            SkillMd    = $_.FullName
        }
    }
}

# -- Main ---------------------------------------------------------------------
Write-Host ""
Write-Host "=========================================" -ForegroundColor Yellow
Write-Host "       Agent Skills Archiver             " -ForegroundColor Yellow
Write-Host "=========================================" -ForegroundColor Yellow
Write-Host ""

# Step 1: Stage all sources
Write-Host "[1/3] Staging skill sources..." -ForegroundColor Green
foreach ($source in $sources) {
    $dest = Join-Path $stagingRoot $source.Name
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-SkillSource -Source $source -Destination $dest
}

# Collect all skills across all sources
$allSkills = @()
foreach ($source in $sources) {
    $stagedPath = Join-Path $stagingRoot $source.Name
    $skills = Get-SkillFolders -StagedPath $stagedPath
    $allSkills += $skills
}

# Deduplicate skill names
$nameCount = @{}
foreach ($skill in $allSkills) {
    if (-not $nameCount.ContainsKey($skill.Name)) { $nameCount[$skill.Name] = 0 }
    $nameCount[$skill.Name]++
}
foreach ($skill in $allSkills) {
    if ($nameCount[$skill.Name] -gt 1) {
        $skill | Add-Member -NotePropertyName FlatName -NotePropertyValue "$($skill.Name)--$($skill.SourceName)" -Force
    } else {
        $skill | Add-Member -NotePropertyName FlatName -NotePropertyValue $skill.Name -Force
    }
}

$totalSkills = $allSkills.Count
$totalFiles = ($allSkills | Measure-Object -Property FileCount -Sum).Sum
Write-Host "  Found $totalSkills skills ($totalFiles total files)" -ForegroundColor Cyan

if ($PerplexityMode) {
    # ── Perplexity Export Mode ──────────────────────────────────────────────
    Write-Host ""
    Write-Host "[2/3] Formatting skills for Perplexity Computer..." -ForegroundColor Green

    # Clean destination folder
    if (Test-Path $OutputDir) {
        Remove-Item "$OutputDir\*" -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    }

    $mdCount = 0
    $zipCount = 0

    foreach ($skill in $allSkills) {
        if ($skill.FileCount -eq 1) {
            # Single file skill -> export directly as <flatname>.md
            $destMd = Join-Path $OutputDir "$($skill.FlatName).md"
            Copy-Item -Path $skill.SkillMd -Destination $destMd -Force
            $mdCount++
        } else {
            # Multi-file skill -> zip individually with SKILL.md at zip root
            $tempSkillZipDir = Join-Path $env:TEMP "perplexity-zip-$($skill.FlatName)-$timestamp"
            if (Test-Path $tempSkillZipDir) { Remove-Item $tempSkillZipDir -Recurse -Force }
            New-Item -ItemType Directory -Path $tempSkillZipDir -Force | Out-Null
            
            Copy-Item -Path "$($skill.FullPath)\*" -Destination $tempSkillZipDir -Recurse -Force -ErrorAction SilentlyContinue
            
            $destZip = Join-Path $OutputDir "$($skill.FlatName).zip"
            Compress-Archive -Path "$tempSkillZipDir\*" -DestinationPath $destZip -CompressionLevel Optimal
            
            Remove-Item $tempSkillZipDir -Recurse -Force -ErrorAction SilentlyContinue
            $zipCount++
        }
    }

    Write-Host "[3/3] Export complete!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Output Directory: $OutputDir" -ForegroundColor White
    Write-Host "  Standalone .md skills: $mdCount" -ForegroundColor White
    Write-Host "  Multi-file .zip skills: $zipCount" -ForegroundColor White
    Write-Host ""
    Write-Host "  To upload to Perplexity:" -ForegroundColor Yellow
    Write-Host "  1. Open Perplexity Computer -> Skills -> Upload Skills" -ForegroundColor Yellow
    Write-Host "  2. Drag & drop the files from: $OutputDir" -ForegroundColor Yellow

} elseif ($MaxFilesPerChunk -le 0) {
    # ── Single Bundle Zip Mode ──────────────────────────────────────────────
    Write-Host ""
    Write-Host "[2/3] Creating single combined archive..." -ForegroundColor Green

    $flatDir = Join-Path $env:TEMP "skills-flat-$timestamp"
    foreach ($skill in $allSkills) {
        $dest = Join-Path $flatDir $skill.FlatName
        Copy-Item -Path $skill.FullPath -Destination $dest -Recurse -Force
    }

    $archivePath = Join-Path $OutputDir "skills-archive-$timestamp.zip"
    Compress-Archive -Path "$flatDir\*" -DestinationPath $archivePath -CompressionLevel Optimal
    Remove-Item $flatDir -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host "[3/3] Done!" -ForegroundColor Green
    $size = (Get-Item $archivePath).Length / 1MB
    Write-Host ""
    Write-Host "  Archive: $archivePath" -ForegroundColor White
    Write-Host ("  Size:    {0:N2} MB" -f $size) -ForegroundColor White
    Write-Host "  Skills:  $totalSkills ($totalFiles files)" -ForegroundColor White
} else {
    # ── Chunked Bundle Zip Mode ──────────────────────────────────────────────
    Write-Host ""
    Write-Host "[2/3] Packing skills into multi-skill zips..." -ForegroundColor Green

    $chunkStaging = Join-Path $env:TEMP "skills-chunks-$timestamp"
    $chunks = @()
    $currentChunk = @()
    $currentFiles = 0

    foreach ($skill in $allSkills) {
        if ($currentFiles + $skill.FileCount -gt $MaxFilesPerChunk -and $currentChunk.Count -gt 0) {
            $chunks += ,@($currentChunk)
            $currentChunk = @()
            $currentFiles = 0
        }
        $currentChunk += $skill
        $currentFiles += $skill.FileCount
    }
    if ($currentChunk.Count -gt 0) { $chunks += ,@($currentChunk) }

    $totalChunks = $chunks.Count
    for ($i = 0; $i -lt $totalChunks; $i++) {
        $chunkNum = $i + 1
        $chunkSkills = $chunks[$i]
        $chunkFileCount = ($chunkSkills | Measure-Object -Property FileCount -Sum).Sum

        $chunkDir = Join-Path $chunkStaging "chunk-$chunkNum"
        New-Item -ItemType Directory -Path $chunkDir -Force | Out-Null

        foreach ($skill in $chunkSkills) {
            $destSkill = Join-Path $chunkDir $skill.FlatName
            Copy-Item -Path $skill.FullPath -Destination $destSkill -Recurse -Force
        }

        $chunkZip = Join-Path $OutputDir "skills-chunk-${chunkNum}-of-${totalChunks}_$timestamp.zip"
        Compress-Archive -Path "$chunkDir\*" -DestinationPath $chunkZip -CompressionLevel Optimal

        $chunkSizeMB = (Get-Item $chunkZip).Length / 1MB
        $skillNames = ($chunkSkills | Select-Object -First 3 | ForEach-Object { $_.FlatName }) -join ", "
        $more = if ($chunkSkills.Count -gt 3) { ", ..." } else { "" }

        Write-Host ("  Chunk {0}/{1}: {2} skills, {3} files ({4:N2} MB) - {5}{6}" -f $chunkNum, $totalChunks, $chunkSkills.Count, $chunkFileCount, $chunkSizeMB, $skillNames, $more) -ForegroundColor White
    }

    Remove-Item $chunkStaging -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host "  Output directory: $OutputDir" -ForegroundColor White
}

# Cleanup main staging
Remove-Item $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "All done!" -ForegroundColor Green
Write-Host ""
