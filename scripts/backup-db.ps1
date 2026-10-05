# Runs the real (Postgres) backup and appends to backups\backup.log. Exit code = node's.
$project = "C:\Users\doter\Budget"
Set-Location $project
$log = Join-Path $project "backups\backup.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

"===== $(Get-Date -Format s) =====" | Out-File $log -Append -Encoding utf8
$out = & node scripts/backup-db.mjs 2>&1
$code = $LASTEXITCODE
$out | Out-File $log -Append -Encoding utf8
$out | Write-Host

# Keep the log small (last 200 lines)
if ((Get-Item $log).Length -gt 100KB) { Get-Content $log -Tail 200 | Set-Content $log -Encoding utf8 }
exit $code
