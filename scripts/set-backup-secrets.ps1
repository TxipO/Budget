$ErrorActionPreference = 'Stop'
$repo = 'TxipO/Budget'

function Stop-WithError($msg) {
    Write-Host ''
    Write-Host "ПОМИЛКА: $msg" -ForegroundColor Red
    exit 1
}

# gh з PATH, інакше повний шлях
$gh = 'gh'
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    $gh = 'C:\Program Files\GitHub CLI\gh.exe'
    if (-not (Test-Path $gh)) { Stop-WithError 'GitHub CLI (gh) не знайдено. Встанови його з https://cli.github.com і запусти скрипт ще раз.' }
}

# 1. Корінь репозиторію = тека над scripts
Set-Location (Split-Path -Parent $PSScriptRoot)

# 2. Авторизація в GitHub (якщо ще нема)
$ErrorActionPreference = 'Continue'
& $gh auth status 2>$null | Out-Null
$loggedIn = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = 'Stop'
if (-not $loggedIn) {
    Write-Host 'Зараз відкриється браузер: скопіюй 8-значний код із цього вікна, встав його на сторінці GitHub і натисни Authorize' -ForegroundColor Yellow
    & $gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'Не вдалося увійти в GitHub. Запусти скрипт ще раз.' }
}

# 3. DATABASE_URL з .env (значення ніколи не друкується)
if (-not (Test-Path '.env')) { Stop-WithError 'Файл .env не знайдено в корені проєкту.' }
$line = Get-Content '.env' -Encoding UTF8 | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
if (-not $line) { Stop-WithError 'У файлі .env немає рядка DATABASE_URL=.' }
$db = ($line -replace '^\s*DATABASE_URL\s*=', '').Trim().Trim('"').Trim("'").Trim()
if ($db -notmatch '^postgres(ql)?://') { Stop-WithError 'DATABASE_URL у .env має неправильний вигляд (має починатися з postgres:// або postgresql://).' }

# 4. Секрет DATABASE_URL
& $gh secret set DATABASE_URL --repo $repo --body $db
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Не вдалося записати секрет DATABASE_URL.' }

# 5. Ключ шифрування: 32 випадкові байти, base64
$bytes = New-Object byte[] 32
[Security.Cryptography.RNGCryptoServiceProvider]::Create().GetBytes($bytes)
$pass = [Convert]::ToBase64String($bytes)
$passFile = Join-Path $env:USERPROFILE 'Documents\budget-backup-passphrase.txt'
Set-Content -Path $passFile -Value $pass -Encoding ASCII
& $gh secret set BACKUP_PASSPHRASE --repo $repo --body $pass
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Не вдалося записати секрет BACKUP_PASSPHRASE.' }

# 6. Запуск бекапу
& $gh workflow run db-backup.yml --repo $repo --ref master
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Секрети записано, але не вдалося запустити бекап. Запусти його вручну: GitHub, вкладка Actions, db-backup.' }

# 7. Готово
Write-Host ''
Write-Host 'Готово: обидва секрети записані, бекап запущено. Ключ шифрування збережено у Документи\budget-backup-passphrase.txt — перенеси його в менеджер паролів і видали файл.' -ForegroundColor Green
