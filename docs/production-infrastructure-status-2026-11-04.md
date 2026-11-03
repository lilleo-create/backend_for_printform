# Print-Form infrastructure P0 status — 2026-11-04

Status: **prepared, not production verified**. Production backend remains `5e7333c`, frontend `ad502d5`; YooKassa remains TEST. Launch P0 remains 8 open and readiness score remains 38/100. Do not close backup, restore or monitoring P0 from code presence alone.

## Read-only production audit

- Nine manual PostgreSQL custom dumps are on the same VPS, dated 2026-10-17 through 2026-11-03, 158–192 KB each. Eight were mode 0664; all nine were changed to 0600 and verified. PM2 dump was also changed to 0600. No backup contents, secrets or PII were printed.
- Public uploads: 40 files, 76,011,010 bytes. Private uploads: zero files at audit time. Nginx config and PM2 dump exist; `.env.production` is mode 0600.
- No automatic Print-Form backup timer/cron, no off-VPS destination credentials/config, no `restic`/`rclone`, no external alert channel detected. A backup only on this VPS does not satisfy launch readiness.
- Nginx/PostgreSQL active, PM2 backend online. Root filesystem 33% used, inodes 9%; approximately 1.3 GiB RAM available. Nginx logrotate exists; PM2 logrotate absent. OS had pending updates and reboot-required marker; no reboot performed.
- `/health` is static and currently 200; no DB probe. Payment expiry runs every 60 seconds and CDEK sync every 10 minutes in backend process without durable success state. A known historical CDEK sync failure must not generate repeated case alerts.

## Prepared changes

Branch `infra-backups-monitoring` contains encrypted restic/S3 backup script with PostgreSQL custom dump, `pg_restore --list`, remote DB SHA256 readback, representative public/private upload SHA256 readback, retention after verification, and lock; six-hour systemd timer; local monitor with DB readiness, service/PM2/disk/inode/5xx/job/backup checks; five-minute monitor timer; PM2 logrotate config; `/ready` DB probe; job heartbeat state; recovery runbook. No schema or business behavior change. Backup script dry-run on VPS showed expected scope and confirmed destination not configured; systemd unit syntax passed. Staged monitor correctly reported missing `/ready`, verified backup and job state before deployment. No timer was enabled.

## Verification

- Focused backend tests: 6/6 pass. Python backup/monitor tests: 8/8 pass. Backend build: pass. `git diff --check` on staged source: pass.
- Full backend suite with dummy test-only env: 240 pass, 17 fail. Without required env: 102 pass, 34 fail; the additional 17 are missing `JWT_SECRET`/other local env, not infrastructure regressions. The 17 remaining failures are in pre-existing order/review/seller/payout tests and need separate baseline triage before a production deployment claim.
- Production commits and local health rechecked: `5e7333c`, `ad502d5`, HTTP 200. Production application code and config remain unchanged. The permissions correction above is the only production modification.

## Blocking inputs and next gates

1. Provide or provision an S3-compatible bucket in a separate fault domain and a scoped access key. Put the key and restic password in root-only VPS config and an independent operator vault; do not send secrets in chat. Confirm bucket region/endpoint, versioning/retention and cost.
2. Choose an external operator alert destination (HTTPS webhook or existing monitor/email service) and an external HTTPS uptime monitor. Test delivery; a VPS-local journal is not an alert channel for whole-VPS outage.
3. Recheck production tree and make a fresh known-good manual PostgreSQL backup. Review full test baseline, merge/deploy backend code safely, install restic/systemd/logrotate. Run backup service once; require remote snapshot, remote hash verification and successful retention state before enabling timer.
4. Restore **that remote snapshot** into isolated DB and file directory, compare aggregate counts and hashes, and measure DB/files/app time. Stop and remove only verified temporary restore resources. Update RTO and P0/readiness scores only from these results.
