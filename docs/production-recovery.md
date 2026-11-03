# Print-Form backup and recovery

## Architecture

- `printform-backup.timer` runs every six hours. The root-only script takes a PostgreSQL custom-format dump, verifies it with `pg_restore --list`, and backs it up with public uploads, private uploads, Nginx config, PM2 config, release commits, and encrypted `.env.production` to an S3-compatible restic repository. Restic encrypts before upload and deduplicates unchanged uploads.
- The S3 bucket must be in a separate fault domain from the VPS. Enable bucket versioning or immutable retention. Store the restic repository password and S3 credentials in a protected operator vault separate from the VPS and bucket. Local config `/etc/printform/backup.env` and the password file must be root-owned mode 0600.
- After a successful remote DB SHA256 readback and `restic check`, retain all snapshots for 2 days, 7 daily, 4 weekly, and 3 monthly. Retention is never run after failed backup.
- Targets: RPO <= 6 hours for DB and uploads; initial RTO target 4 hours, revised after a measured offsite drill. Perform a remote restore drill monthly and after material schema/storage changes.

## Install and verify

Install a pinned restic release. Configure `/etc/printform/backup.env` with `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` without placing secrets in Git or shell history. Initialize the remote repository once with `restic init`. Install the scripts at `/opt/printform-ops` and systemd units from `ops/systemd`. Create `/var/backups/printform` and `/var/lib/printform` mode 0700. Run `systemctl daemon-reload`, then `systemctl start printform-backup.service`. Require a `backup_verified` record, remote snapshot ID, successful remote DB readback, and `restic snapshots` before enabling `printform-backup.timer`. `flock` prevents overlap.

The local monitor runs every five minutes. It checks DB readiness, Nginx, PostgreSQL, PM2, disk and inode use (80% warning, 90% critical), backup age >8 hours, payment expiry last success >3 minutes, CDEK sync last success >30 minutes, and three consecutive job failures. It reports only alert codes to an optional HTTPS webhook in root-only `/etc/printform/monitor.env`. A local monitor cannot report whole-VPS failure; configure an **external** uptime monitor for `https://print-form.ru/api/health` and a catalog page, connected to an operator alert channel. Test a notification before declaring monitoring ready. Historical CDEK sync 400 for an old order should not generate a case-level alert; new active shipment repeated failures need a separate operational alert.

Nginx logrotate is installed by OS. Install `ops/logrotate/printform-pm2` for PM2 logs and test with `logrotate -d` before activation. Review journal size periodically. Do not reboot automatically for pending OS updates.

## Restore drill: only from remote

1. Record UTC start, selected remote snapshot ID, and its timestamp. Use the operator vault to supply restic credentials. Do not use the VPS original copy as the source.
2. `restic restore <snapshot> --target /srv/printform-restore-<timestamp>` into a directory not served by Nginx. Compare restored DB SHA256 to the encrypted snapshot manifest. Compare representative public/private file SHA256 values to `restic dump` from that same snapshot. Never restore private files into the public alias.
3. Create a new `printform_restore_test_<timestamp>` DB. Run `pg_restore --no-owner --no-acl -d <restore-db> <database.dump>`. Check schema, migration table, and aggregate counts for users, orders, payments, products, returns, chats against the backup timestamp. Do not print PII.
4. If safe provider-disabled application startup is possible, bind a temporary backend to `127.0.0.1:4100`, using only restored DB/files and no YooKassa/CDEK credentials or background jobs. Check `/health`, `/ready`, catalog and read-only order/seller queries. Do not expose it via DNS.
5. Record DB, file and application restore duration. Add new-server provisioning time to derive measured RTO. Stop temporary process. Verify absolute paths before dropping only the named temporary DB and removing only the named restore directory. Keep the remote backup.

## Full VPS loss

Provision a patched Ubuntu server; allow only SSH, 80, 443. Install matching PostgreSQL, Node, npm, PM2, Nginx and restic. Clone pinned backend/frontend commits from Git. Restore credentials separately from the protected vault. Restore the selected remote snapshot, PostgreSQL, public uploads and private uploads to their distinct paths with proper ownership. Validate Nginx config with `nginx -t`; never publish private storage. Build code, apply only migrations absent from restored DB, start PM2/Nginx. Check local health/readiness, catalog, login and read-only order/seller pages before DNS switch. Verify provider webhook settings without creating provider objects. Reconcile orders/payments written after the backup timestamp before reopening transactions. YooKassa remains TEST unless separately approved.
