# get-plugins.ps1 - populate tools/plugins/ with the latest Il2CppInspector plugin set.
#
# Only needed if header generation fails with a protection/plugin error. For
# RotMG with already-decrypted metadata, an EMPTY plugins/ folder is normally
# enough, so you usually never have to run this.
#
#   powershell -ExecutionPolicy Bypass -File tools/get-plugins.ps1
$dest = $PSScriptRoot
$temp = New-TemporaryFile | Rename-Item -NewName { $_ -replace 'tmp$', 'zip' } -PassThru
Invoke-WebRequest -OutFile $temp `
    'https://github.com/djkaty/Il2CppInspectorPlugins/releases/latest/download/plugins.zip'
Expand-Archive -Path $temp -DestinationPath $dest -Force
Remove-Item $temp
Write-Host "Plugins extracted into $dest\plugins"
