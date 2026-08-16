# Guardrail: forbidden raw-access patterns in feature/GUI code (Windows host).
#
# PowerShell mirror of check-raw-access.sh — same four checks, same scope
# (features/ + gui/ only), same `raw-access-ok` same-line escape hatch on
# check 2. Run by build-and-test.bat after a successful MSBuild. Exits 1 on
# any hit so the build gate fails; 0 when clean.
#
# The sanctioned homes for the primitives (core/runtime/MemRead.h,
# core/il2cpp/Il2CppContainers.*, platform/hooks/Il2CppHook.*, core/runtime/*)
# are intentionally out of scope: this only ratchets features/ and gui/.

$ErrorActionPreference = 'Stop'
$root  = Resolve-Path (Join-Path $PSScriptRoot '..\src')
$scope = @((Join-Path $root 'features'), (Join-Path $root 'gui')) |
    Where-Object { Test-Path $_ }
$fail = $false

# Collect *.cpp/*.h under the scoped roots once.
$files = Get-ChildItem -Path $scope -Recurse -File -Include *.cpp, *.h -ErrorAction SilentlyContinue

function Check-Pattern {
    param(
        [string]   $Label,
        [string]   $Pattern,
        [scriptblock] $LineFilter = $null   # optional: return $true to KEEP (report) a line
    )
    $hits = $files | Select-String -Pattern $Pattern -AllMatches
    if ($LineFilter) { $hits = $hits | Where-Object { & $LineFilter $_.Line } }
    if ($hits) {
        Write-Host "FORBIDDEN [$Label]:"
        foreach ($h in $hits) { Write-Host ("{0}:{1}:{2}" -f $h.Path, $h.LineNumber, $h.Line.Trim()) }
        $script:fail = $true
    }
}

# 1. Local pointer-validity copies (use Mem::AddrOk).
Check-Pattern 'local AddrOk' 'bool (AddrOk|AddrValid)\('

# 2. Open-coded offset reads (use Mem::TryRead/ReadOr or Game:: wrappers).
#    Kept hot-loop reads with a same-line `raw-access-ok` marker are exempt.
Check-Pattern 'raw offset read' 'reinterpret_cast<[^>]*>\([^;]*RuntimeOffsets::' `
    { param($line) $line -notmatch 'raw-access-ok' }

# 3. Private IL2CPP container layout constants (use Il2CppC::).
Check-Pattern 'dict layout consts' 'kDict_|kOffDict|OFF_DICT_|kEntryStride|kEntrySize|OFF_ARR_|kArr_(MaxLen|Data)'

# 4. Bare MinHook installs (use Il2CppHook::InstallMinHook).
Check-Pattern 'bare MH_CreateHook' 'MH_CreateHook'

if ($fail) { exit 1 } else { exit 0 }
