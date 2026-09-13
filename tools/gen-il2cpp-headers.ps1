<#
.SYNOPSIS
  Regenerate the six IL2CPP headers the internal DLL depends on, straight from
  the live game, using the Il2CppInspector CLI built into this tools/ folder.

.DESCRIPTION
  Pipeline:
    1. Locate GameAssembly.dll (same search order as the client's ExaltFinder,
       so it "just works" for a Deca-launcher install - no config needed).
    2. Run tools/Il2CppInspector.exe against the decrypted metadata to emit a
       C++ scaffold into a temp folder.
    3. Copy only the six il2cpp-*.h from <scaffold>/appdata into
       internal/src/game/generated/, then verify all six landed.

  Only the headers are taken; the rest of the scaffold (framework/, user/, the
  .vcxproj/.sln) is discarded - the real project lives in internal/.

.PARAMETER GameAssembly
  Full path to GameAssembly.dll. If omitted, auto-located (see search order).

.PARAMETER Metadata
  Path to the (decrypted) global-metadata .dat. Default: tools/global-metadata.decrypted.dat

.PARAMETER Inspector
  Path to the Il2CppInspector CLI exe. Default: tools/Il2CppInspector.exe

.PARAMETER OutDir
  Where the six headers are written. Default: internal/src/game/generated

.PARAMETER KeepScaffold
  Keep the temp scaffold folder instead of deleting it (for debugging).
#>
[CmdletBinding()]
param(
    [string]$GameAssembly,
    [string]$Metadata,
    [string]$Inspector,
    [string]$OutDir,
    [switch]$KeepScaffold
)

$ErrorActionPreference = 'Stop'
$toolsDir = $PSScriptRoot
$repoRoot = Resolve-Path (Join-Path $toolsDir '..')

if (-not $Metadata)   { $Metadata   = Join-Path $toolsDir 'global-metadata.decrypted.dat' }
if (-not $Inspector)  { $Inspector  = Join-Path $toolsDir 'Il2CppInspector.exe' }
if (-not $OutDir)     { $OutDir     = Join-Path $repoRoot 'internal\src\game\generated' }

$requiredHeaders = @(
    'il2cpp-types.h',
    'il2cpp-functions.h',
    'il2cpp-types-ptr.h',
    'il2cpp-api-functions.h',
    'il2cpp-api-functions-ptr.h',
    'il2cpp-metadata-version.h'
)

function Fail($msg) { Write-Host "[gen-headers] ERROR: $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host "[gen-headers] $msg" }

# --- Validate inputs ---------------------------------------------------------
if (-not (Test-Path $Inspector)) { Fail "Il2CppInspector CLI not found at: $Inspector" }
if (-not (Test-Path $Metadata))  { Fail "Metadata not found at: $Metadata" }

# The CLI refuses to start without a plugins/ folder next to it (empty is fine
# for RotMG once metadata is already decrypted). Create it if missing.
$pluginsDir = Join-Path (Split-Path $Inspector -Parent) 'plugins'
if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir | Out-Null }

# --- Locate GameAssembly.dll (ExaltFinder order) -----------------------------
if (-not $GameAssembly) {
    $home_ = [Environment]::GetFolderPath('UserProfile')
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { $localAppData = Join-Path $home_ 'AppData\Local' }

    $candidates = @(
        $env:ROTMG_PATH,
        (Join-Path $localAppData 'RealmOfTheMadGod\Production'),
        (Join-Path $home_ 'Documents\RealmOfTheMadGod\Production'),
        'C:\Program Files (x86)\Steam\steamapps\common\RotMG Exalt',
        'C:\Program Files\Steam\steamapps\common\RotMG Exalt',
        'D:\Steam\steamapps\common\RotMG Exalt',
        'D:\SteamLibrary\steamapps\common\RotMG Exalt',
        'E:\Steam\steamapps\common\RotMG Exalt',
        'E:\SteamLibrary\steamapps\common\RotMG Exalt'
    )
    foreach ($dir in $candidates) {
        if (-not $dir) { continue }
        $ga  = Join-Path $dir 'GameAssembly.dll'
        $exe = Join-Path $dir 'RotMG Exalt.exe'
        if ((Test-Path $ga) -and (Test-Path $exe)) { $GameAssembly = $ga; break }
    }
    if (-not $GameAssembly) {
        Fail "Could not auto-locate GameAssembly.dll. Set ROTMG_PATH to your RotMG Exalt folder or pass -GameAssembly."
    }
}
if (-not (Test-Path $GameAssembly)) { Fail "GameAssembly.dll not found at: $GameAssembly" }

Info "GameAssembly : $GameAssembly"
Info "Metadata     : $Metadata"
Info "Output       : $OutDir"

# --- Run the generator into a temp scaffold ----------------------------------
$scaffold = Join-Path ([IO.Path]::GetTempPath()) ("re-il2cpp-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scaffold | Out-Null
$cppOut = Join-Path $scaffold 'cpp'

Info "Generating C++ scaffold (this takes ~10-20s)..."
& $Inspector --select-outputs -i $GameAssembly -m $Metadata --cpp-out $cppOut
if ($LASTEXITCODE -ne 0) {
    if (-not $KeepScaffold) { Remove-Item $scaffold -Recurse -Force -ErrorAction SilentlyContinue }
    Fail "Il2CppInspector exited with code $LASTEXITCODE. If it reported a protection/plugin error, run tools/get-plugins.ps1 to populate plugins/ and retry."
}

# --- Verify + copy the six headers -------------------------------------------
$appdata = Join-Path $cppOut 'appdata'
if (-not (Test-Path $appdata)) {
    if (-not $KeepScaffold) { Remove-Item $scaffold -Recurse -Force -ErrorAction SilentlyContinue }
    Fail "Scaffold has no appdata/ folder - CLI output layout unexpected at: $cppOut"
}

$missing = @()
foreach ($h in $requiredHeaders) {
    if (-not (Test-Path (Join-Path $appdata $h))) { $missing += $h }
}
if ($missing.Count -gt 0) {
    if (-not $KeepScaffold) { Remove-Item $scaffold -Recurse -Force -ErrorAction SilentlyContinue }
    Fail "Generation succeeded but these headers are missing: $($missing -join ', ')"
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
foreach ($h in $requiredHeaders) {
    Copy-Item (Join-Path $appdata $h) (Join-Path $OutDir $h) -Force
}

# Surface the detected metadata version as a sanity anchor.
$verLine = (Select-String -Path (Join-Path $OutDir 'il2cpp-metadata-version.h') -Pattern '__IL2CPP_METADATA_VERSION\s+(\d+)').Matches.Value
Info "Copied 6 headers -> $OutDir"
if ($verLine) { Info "Detected $verLine" }

if (-not $KeepScaffold) { Remove-Item $scaffold -Recurse -Force -ErrorAction SilentlyContinue }
else { Info "Scaffold kept at: $scaffold" }

Write-Host "[gen-headers] OK" -ForegroundColor Green
