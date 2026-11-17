$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (Test-Path -LiteralPath "$PSScriptRoot/.tools/go/bin/go.exe") {
    $env:PATH = "$PSScriptRoot/.tools/go/bin;" + $env:PATH
}
$env:PATH = "$env:USERPROFILE/go/bin;" + $env:PATH
if (-not (Get-Command wails -ErrorAction SilentlyContinue)) {
    throw 'Wails not found. Run: go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1'
}
wails dev
exit $LASTEXITCODE
