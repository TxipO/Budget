# Verify export fidelity against original Budget.xlsx
# Usage: powershell -File scripts\verify-export.ps1

$TMP   = "C:\Users\doter\AppData\Local\Temp\claude"
$ITERS = @("iter5_deep","iter8_final","iter9_comprehensive","iter10_broader","iter11_deep2","iter12_cf_and_data","iter13_xml_deep")

Write-Host "`n=== Downloading export ===" -ForegroundColor Cyan
Invoke-WebRequest -Uri "http://localhost:3000/api/export" -OutFile "$TMP\test_loop.xlsx"
Copy-Item "$TMP\test_loop.xlsx" "C:\Users\doter\AppData\Local\Temp\test_loop.xlsx" -Force
Write-Host "OK: file saved" -ForegroundColor Green

$totalFail = 0
foreach ($iter in $ITERS) {
    $out     = python "$TMP\$iter.py" 2>&1 | Out-String
    $summary = ($out -split "`n" | Where-Object { $_ -match "OK," } | Select-Object -Last 1).Trim()
    $fails   = ([regex]::Matches($out, "FAIL|ERROR")).Count + (($out -split "`n") | Where-Object { $_ -match "^\s+! " }).Count
    $hasErr  = $out -match "0 OK" -or $out -match "[1-9]\d* (vidmin|pomylok)"
    $color   = if ($fails -gt 0) { "Red" } else { "Green" }
    Write-Host "  $iter : $summary" -ForegroundColor $color
}

Write-Host ""
if ($totalFail -gt 0) {
    Write-Host "=== RESULT: $totalFail errors ===" -ForegroundColor Red
} else {
    Write-Host "=== RESULT: all checks OK ===" -ForegroundColor Green
}
exit $totalFail
