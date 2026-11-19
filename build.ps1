param([string]$OutputName = 'TwinLog.exe')

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (Test-Path -LiteralPath "$PSScriptRoot/.tools/go/bin/go.exe") {
    $env:PATH = "$PSScriptRoot/.tools/go/bin;" + $env:PATH
}
$env:PATH = "$env:USERPROFILE/go/bin;" + $env:PATH
$package = Get-Content -LiteralPath "$PSScriptRoot/frontend/package.json" -Raw | ConvertFrom-Json
$project = Get-Content -LiteralPath "$PSScriptRoot/wails.json" -Raw | ConvertFrom-Json
if ($project.info.productVersion -ne $package.version) {
    throw 'wails.json productVersion must match frontend/package.json version'
}
if ([System.IO.Path]::GetFileName($OutputName) -ne $OutputName -or
    $OutputName.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
    -not $OutputName.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputName must be an exe filename without a directory'
}
$targetExe = [System.IO.Path]::GetFullPath("$PSScriptRoot/build/bin/$OutputName")
if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $targetExe }) {
    throw 'TwinLog is running. Save notes and exit normally before building.'
}
go test ./...
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
wails build -o $OutputName
exit $LASTEXITCODE
