$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (Test-Path -LiteralPath "$PSScriptRoot/.tools/go/bin/go.exe") {
    $env:PATH = "$PSScriptRoot/.tools/go/bin;" + $env:PATH
}
$env:PATH = "$env:USERPROFILE/go/bin;" + $env:PATH
go test ./...
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
wails build
exit $LASTEXITCODE
