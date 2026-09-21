param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$bundleDirectory = Join-Path $repoRoot 'src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis'
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'

if (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe')) {
    $env:PATH = "$cargoBin;$env:PATH"
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'cargo not found. Install Rust or add cargo.exe to PATH.'
}

Set-Location -LiteralPath $repoRoot
pnpm run build:win64:nsis

if ($LASTEXITCODE -ne 0) {
    throw "Build failed with exit code $LASTEXITCODE"
}

$installer = Get-ChildItem -LiteralPath $bundleDirectory -Filter '*_x64-setup.exe' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installer) {
    throw "No NSIS installer found in $bundleDirectory"
}

Write-Host "Installer: $($installer.FullName)"

if ($SkipInstall) {
    return
}

$process = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru

if ($process.ExitCode -ne 0) {
    throw "Installer failed with exit code $($process.ExitCode)"
}

Write-Host "Installed: AcaNomo"
