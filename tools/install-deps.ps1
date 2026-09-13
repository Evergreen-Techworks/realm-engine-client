<#
.SYNOPSIS
  Install the toolchain dependencies build-all.bat needs, via winget.

.DESCRIPTION
  Idempotent installer for the Realm Engine build prerequisites:
    * Visual Studio 2022 Build Tools with the C++ x64 (VCTools) workload
    * Node.js / npm
    * .NET 10 runtime (needed to run Il2CppInspector.exe)
    * tools/global-metadata.decrypted.dat  (downloaded)
    * tools/plugins/                        (empty folder the Inspector CLI wants)

  NOT handled (can't be):
    * tools/Il2CppInspector.exe  - bundle this yourself.
    * RotMG Exalt / GameAssembly.dll - install the game; the header generator
      auto-locates it via the ExaltFinder search order.

  Already-installed dependencies are detected with `winget list` and skipped,
  so re-running is safe. A large VS Build Tools install may require a new shell
  (or a reboot) before cl.exe/MSBuild appear on PATH.

.PARAMETER SkipVS
  Skip the Visual Studio Build Tools install (e.g. VS is already installed via
  the full IDE).

.PARAMETER MetadataUrl
  Where to fetch the decrypted metadata from.
#>
[CmdletBinding()]
param(
    [switch]$SkipVS,
    [string]$MetadataUrl = 'https://builds.him.is/latest/game_files/global-metadata.decrypted.dat'
)

$ErrorActionPreference = 'Stop'
$toolsDir = $PSScriptRoot
$repoRoot = Resolve-Path (Join-Path $toolsDir '..')

function Info($m) { Write-Host "[install-deps] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[install-deps] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[install-deps] WARN: $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[install-deps] ERROR: $m" -ForegroundColor Red; exit 1 }

# --- winget availability -----------------------------------------------------
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "winget not found. Install 'App Installer' from the Microsoft Store (Windows 10 1809+/11), then re-run."
}

# Returns $true if a winget package id is already installed.
function Test-WingetInstalled($id) {
    $out = winget list --id $id --exact --accept-source-agreements 2>$null
    return ($LASTEXITCODE -eq 0 -and ($out -join "`n") -match [regex]::Escape($id))
}

function Install-Winget($id, $name, [string[]]$extraArgs) {
    if (Test-WingetInstalled $id) {
        Ok "$name already installed ($id) - skipping."
        return
    }
    Info "Installing $name ($id)..."
    $args = @('install', '--id', $id, '--exact', '--silent',
              '--accept-package-agreements', '--accept-source-agreements')
    if ($extraArgs) { $args += $extraArgs }
    winget @args
    if ($LASTEXITCODE -ne 0) { Fail "winget failed to install $name (exit $LASTEXITCODE)." }
    Ok "$name installed."
}

# --- [1/5] Visual Studio 2022 Build Tools + C++ x64 workload ------------------
if ($SkipVS) {
    Info "[1/5] Skipping Visual Studio (-SkipVS)."
} else {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $haveVc = $false
    if (Test-Path $vswhere) {
        $inst = & $vswhere -latest -products * `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            -property installationPath 2>$null
        if ($inst) { $haveVc = $true }
    }
    if ($haveVc) {
        Ok "[1/5] VS C++ x64 tools already present ($inst) - skipping."
    } else {
        Info "[1/5] Installing VS 2022 Build Tools + C++ x64 workload (large, several GB)..."
        # The base package alone has no compilers; request the VCTools workload
        # by component id through --override.
        Install-Winget 'Microsoft.VisualStudio.2022.BuildTools' 'VS 2022 Build Tools' @(
            '--override',
            '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
        )
    }
}

# --- [2/5] Node.js / npm -----------------------------------------------------
Info "[2/5] Node.js / npm"
if (Get-Command npm -ErrorAction SilentlyContinue) {
    Ok "npm already on PATH - skipping Node.js."
} else {
    Install-Winget 'OpenJS.NodeJS.LTS' 'Node.js (LTS)'
}

# --- [3/5] .NET 10 runtime ---------------------------------------------------
Info "[3/5] .NET 10 runtime (for Il2CppInspector.exe)"
Install-Winget 'Microsoft.DotNet.Runtime.10' '.NET 10 runtime'

# --- [4/5] Decrypted metadata ------------------------------------------------
$metaPath = Join-Path $toolsDir 'global-metadata.decrypted.dat'
if (Test-Path $metaPath) {
    Ok "[4/5] Metadata already present - skipping download."
} else {
    Info "[4/5] Downloading metadata from $MetadataUrl ..."
    try {
        Invoke-WebRequest -Uri $MetadataUrl -OutFile $metaPath -UseBasicParsing
    } catch {
        Fail "Metadata download failed: $($_.Exception.Message)"
    }
    if ((Get-Item $metaPath).Length -lt 1024) {
        Remove-Item $metaPath -Force -ErrorAction SilentlyContinue
        Fail "Downloaded metadata looks too small - aborting."
    }
    Ok "Metadata -> $metaPath"
}

# --- [5/5] plugins/ folder + game presence check -----------------------------
$pluginsDir = Join-Path $toolsDir 'plugins'
if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir | Out-Null }
Ok "[5/5] tools/plugins/ ready."

if (-not (Test-Path (Join-Path $toolsDir 'Il2CppInspector.exe'))) {
    Warn "tools/Il2CppInspector.exe is missing - bundle it before building."
}

# Best-effort RotMG detection (same order gen-il2cpp-headers.ps1 uses).
$localAppData = $env:LOCALAPPDATA
if (-not $localAppData) { $localAppData = Join-Path $env:USERPROFILE 'AppData\Local' }
$gameCandidates = @(
    $env:ROTMG_PATH,
    (Join-Path $localAppData 'RealmOfTheMadGod\Production'),
    (Join-Path $env:USERPROFILE 'Documents\RealmOfTheMadGod\Production'),
    'C:\Program Files (x86)\Steam\steamapps\common\RotMG Exalt',
    'C:\Program Files\Steam\steamapps\common\RotMG Exalt',
    'D:\Steam\steamapps\common\RotMG Exalt',
    'D:\SteamLibrary\steamapps\common\RotMG Exalt',
    'E:\Steam\steamapps\common\RotMG Exalt',
    'E:\SteamLibrary\steamapps\common\RotMG Exalt'
)
$foundGame = $false
foreach ($d in $gameCandidates) {
    if ($d -and (Test-Path (Join-Path $d 'GameAssembly.dll'))) { $foundGame = $true; break }
}
if (-not $foundGame) {
    Warn "RotMG Exalt / GameAssembly.dll not found in the usual locations."
    Warn "Install the game, or set ROTMG_PATH, before running build-all.bat."
}

Write-Host ""
Ok "Dependencies ready. Open a NEW terminal (so PATH refreshes) and run build-all.bat."
