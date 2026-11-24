param(
    [string]$VsCodePath = "C:\Program Files\Microsoft VS Code"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $VsCodePath "Code.exe"))) {
    throw "VS Code not found at '$VsCodePath'. Pass -VsCodePath with the correct folder."
}

$extensionRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $extensionRoot
$destination = Join-Path $workspaceRoot "_test-runtime\vscode"

if (Test-Path (Join-Path $destination "Code.exe")) {
    Write-Host "Test runtime already present: $destination"
    exit 0
}

New-Item -ItemType Directory -Force -Path $destination | Out-Null

Write-Host "Copying VS Code from '$VsCodePath' to '$destination' ..."
robocopy $VsCodePath $destination /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null

# Robocopy exit codes 0-7 indicate success (8+ is an error).
if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path (Join-Path $destination "Code.exe"))) {
    throw "Copy finished but Code.exe is missing from '$destination'"
}

Write-Host "Test runtime ready: $destination"
Write-Host "This is a separate copy; the installed VS Code was not modified."
