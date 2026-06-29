$project = "C:\Users\doter\Budget"
Set-Location $project

$logDir  = Join-Path $project ".claude\logs"
$logFile = Join-Path $logDir "selfcheck-$(Get-Date -Format 'yyyyMMdd-HHmm').log"

$prompt = @"
Run selfcheck on the budget tracker project at C:\Users\doter\Budget.
Follow the instructions in .claude/skills/selfcheck/SKILL.md exactly:
- Use Grep only, never read full files
- Run all 10 checks
- Fix every Critical immediately
- Commit and push all fixes with message starting with "Selfcheck fixes"
"@

Write-Host "[selfcheck] $(Get-Date -Format 'HH:mm') starting..." -ForegroundColor Cyan
claude -p $prompt 2>&1 | Tee-Object -FilePath $logFile
Write-Host "[selfcheck] done -> $logFile" -ForegroundColor Green

# Keep only last 10 logs
Get-ChildItem "$logDir\selfcheck-*.log" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Force
