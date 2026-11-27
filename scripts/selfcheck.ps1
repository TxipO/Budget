# Weekly health check (data integrity + backup freshness). Alerts via Telegram, silent when OK.
# Replaced the unattended `claude -p` selfcheck: no AI, no commits, no pushes to prod.
Set-Location (Split-Path $PSScriptRoot -Parent)
& node scripts/weekly-check.mjs
exit $LASTEXITCODE
