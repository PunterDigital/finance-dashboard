# Fails unless every .exe given shows build/icon.ico (compared at 32x32), not Electron's default icon.
# Usage: pwsh scripts/check-win-icon.ps1 <exe> [<exe> ...]
param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Exe)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$want = (New-Object System.Drawing.Icon((Join-Path $PSScriptRoot '..\build\icon.ico'), 32, 32)).ToBitmap()
$failed = $false
foreach ($f in $Exe) {
  $got = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path $f).Path).ToBitmap()
  $diff = 0
  for ($x = 0; $x -lt 32; $x++) {
    for ($y = 0; $y -lt 32; $y++) {
      $a = $want.GetPixel($x, $y); $b = $got.GetPixel($x, $y)
      if ([Math]::Abs($a.R - $b.R) + [Math]::Abs($a.G - $b.G) + [Math]::Abs($a.B - $b.B) + [Math]::Abs($a.A - $b.A) -gt 16) { $diff++ }
    }
  }
  Write-Output "${f}: $diff of 1024 pixels differ from build/icon.ico"
  if ($diff -gt 20) { $failed = $true }
}
if ($failed) { throw 'An executable does not use the app icon' }
