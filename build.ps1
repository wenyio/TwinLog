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
$targetExe = [System.IO.Path]::GetFullPath("$PSScriptRoot/build/bin/TwinLog.exe")
if (Get-Process TwinLog -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $targetExe }) {
    throw 'TwinLog is running. Save notes and exit normally before building.'
}
go test ./...
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
wails build
exit $LASTEXITCODE
