# Restoring a GitHub Actions DB backup

The daily workflow `.github/workflows/db-backup.yml` uploads one encrypted file per run (kept 90 days).

1. **Download**: GitHub repo -> Actions -> "DB backup" -> pick a run -> Artifacts -> `db-backup-<run id>` (a zip with `budget-YYYYMMDD-HHmm.json.gz.enc`). Unzip it.
2. **Decrypt** (passphrase = the `BACKUP_PASSPHRASE` repo secret; you are prompted for it):

   ```
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in budget-YYYYMMDD-HHmm.json.gz.enc -out budget-YYYYMMDD-HHmm.json.gz
   ```

3. **Restore**: follow the `RESTORE:` notes in the header of `scripts/backup-db.mjs`
   (empty DB via `prisma db push`, then `createMany` in FK order, reset sequences).
   Secrets (PIN hashes, Monobank/SpareBank tokens, webhook secrets) are nulled in the dump:
   after a restore, reconnect Monobank and SpareBank 1 and set the PIN again.

Delete the decrypted `.json.gz` when done; it holds all financial data.
