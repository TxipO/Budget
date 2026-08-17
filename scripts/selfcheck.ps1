$project = "C:\Users\doter\Budget"
Set-Location $project

$logDir  = Join-Path $project ".claude\logs"
$logFile = Join-Path $logDir "selfcheck-$(Get-Date -Format 'yyyyMMdd-HHmm').log"

$prompt = @"
Run the weekly mechanical code sweep on the budget tracker project at C:\Users\doter\Budget.
Follow .claude/skills/fullreview/SKILL.md, STAGE 1 ONLY (the grep sweep) — this is
the `/fullreview quick` mode. Do not run stages 2-4 here; they are far too
expensive for an unattended weekly job and need a human in the loop.
- Use Grep only, never read a file in full
- Run every check in Stage 1's table
- Fix every Critical immediately
- Commit and push all fixes with message starting with "Selfcheck fixes"
"@

Write-Host "[selfcheck] $(Get-Date -Format 'HH:mm') starting..." -ForegroundColor Cyan
claude -p $prompt 2>&1 | Tee-Object -FilePath $logFile
Write-Host "[selfcheck] done -> $logFile" -ForegroundColor Green

# Keep only last 10 logs
Get-ChildItem "$logDir\selfcheck-*.log" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Force
