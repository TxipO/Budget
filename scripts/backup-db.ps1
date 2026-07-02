$project = "C:\Users\doter\Budget"
$db      = Join-Path $project "prisma\budget.db"

if (-not (Test-Path $db)) {
  Write-Host "[backup] DB not found at $db, skipping" -ForegroundColor Yellow
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmm'

# Local backup (fast restore, survives accidental deletion / bad import)
$localDir = Join-Path $project "backups"
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
Copy-Item $db (Join-Path $localDir "budget-$stamp.db") -Force

# Offsite backup on OneDrive (survives disk failure / stolen laptop)
$oneDrive = Join-Path $env:USERPROFILE "OneDrive\BudgetBackups"
if (Test-Path (Join-Path $env:USERPROFILE "OneDrive")) {
  New-Item -ItemType Directory -Force -Path $oneDrive | Out-Null
  Copy-Item $db (Join-Path $oneDrive "budget-$stamp.db") -Force
}

# Keep last 30 local backups, last 90 OneDrive backups
Get-ChildItem "$localDir\budget-*.db" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 30 | Remove-Item -Force
if (Test-Path $oneDrive) {
  Get-ChildItem "$oneDrive\budget-*.db" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 90 | Remove-Item -Force
}

Write-Host "[backup] $stamp -> local + $(if (Test-Path $oneDrive) {'OneDrive'} else {'OneDrive skipped'})" -ForegroundColor Green
