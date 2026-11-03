#!/usr/bin/env python3
"""Local operational checks. JSON status is safe for journald; webhook is optional."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen

BACKUP_STATE = Path('/var/lib/printform/backup-state.json')
JOB_STATE = Path('/var/www/printform/monitor-state')
CONFIG = Path('/etc/printform/monitor.env')
STATE = Path('/var/lib/printform/monitor-state.json')
ACCESS_LOG = Path('/var/log/nginx/access.log')


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def timestamp(value):
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    return 0.0


def recent_http_errors(path: Path, now: float):
    """Count recent 5xx statuses without recording URLs, IPs, or request bodies."""
    total = errors = 0
    try:
        with path.open('rb') as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - 10 * 1024 * 1024))
            for line in handle:
                match = re.search(rb'\[([^]]+)\] "[^"]+" (\d{3}) ', line)
                if not match:
                    continue
                try:
                    at = datetime.strptime(match.group(1).decode('ascii'), '%d/%b/%Y:%H:%M:%S %z').timestamp()
                except ValueError:
                    continue
                if 0 <= now - at <= 300:
                    total += 1
                    errors += int(match.group(2)) >= 500
    except OSError:
        return None
    return total, errors


def assess(now: float, backup, payment, cdek, disk, inode, ready, services, pm2, http=None, restart_loop=False):
    alerts = []
    if not ready:
        alerts.append('db_readiness_failed')
    for name, ok in services.items():
        if not ok:
            alerts.append(f'{name}_down')
    if not pm2:
        alerts.append('backend_pm2_down')
    if restart_loop:
        alerts.append('backend_restart_loop')
    if http is not None and http[1] >= 5 and (http[0] < 20 or http[1] / http[0] >= 0.05):
        alerts.append('http_5xx_spike')
    for name, value in (('disk', disk), ('inode', inode)):
        if value >= 90:
            alerts.append(f'{name}_critical')
        elif value >= 80:
            alerts.append(f'{name}_warning')
    if not backup or now - timestamp(backup.get('lastSuccessAt')) > 8 * 3600:
        alerts.append('verified_backup_stale')
    for name, state, max_age in (('payment_expiry', payment, 180), ('cdek_sync', cdek, 1800)):
        if not state or now - timestamp(state.get('lastSuccessAt')) > max_age:
            alerts.append(f'{name}_stale')
        elif state.get('consecutiveFailures', 0) >= 3:
            alerts.append(f'{name}_repeated_failure')
    return alerts


def command_ok(*command):
    return subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def backend_process():
    result = subprocess.run(['runuser', '-u', 'deploy', '--', 'pm2', 'jlist'],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode:
        return False, 0
    try:
        for item in json.loads(result.stdout):
            if item.get('name') == 'printform-backend':
                return item.get('pm2_env', {}).get('status') == 'online', int(item.get('pm2_env', {}).get('restart_time', 0))
        return False, 0
    except (ValueError, TypeError):
        return False, 0


def check(previous=None):
    os.umask(0o077)
    now = time.time()
    usage = shutil.disk_usage('/')
    disk = round(100 * usage.used / usage.total)
    stat = os.statvfs('/')
    inode = round(100 * (1 - stat.f_favail / stat.f_files)) if stat.f_files else 0
    try:
        with urlopen('http://127.0.0.1:4000/ready', timeout=5) as response:
            ready = response.status == 200
    except Exception:
        ready = False
    services = {name: command_ok('systemctl', 'is-active', '--quiet', name) for name in ('nginx', 'postgresql')}
    pm2, restart_count = backend_process()
    prior_count = (previous or {}).get('pm2RestartCount')
    recent = now - timestamp((previous or {}).get('checkedAt')) <= 15 * 60
    restart_loop = isinstance(prior_count, int) and recent and restart_count - prior_count >= 3
    alerts = assess(now, read_json(BACKUP_STATE), read_json(JOB_STATE / 'payment-expiry.json'),
                    read_json(JOB_STATE / 'cdek-sync.json'), disk, inode, ready, services, pm2,
                    recent_http_errors(ACCESS_LOG, now), restart_loop)
    return {'checkedAt': int(now), 'status': 'ok' if not alerts else 'alert',
            'alerts': alerts, 'diskPercent': disk, 'inodePercent': inode,
            'pm2RestartCount': restart_count}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true', help='perform checks; default is read-only dry run')
    args = parser.parse_args()
    if not args.run:
        print(json.dumps({'event': 'monitor_dry_run', 'webhookConfigured': CONFIG.exists()}))
        return
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    previous = read_json(STATE) or {}
    result = check(previous)
    print(json.dumps(result))
    # A webhook is only sent for a new alert set, avoiding one notification per timer run.
    result['lastNotifiedAlerts'] = previous.get('lastNotifiedAlerts', [])
    if result['alerts'] and result['alerts'] != previous.get('lastNotifiedAlerts') and CONFIG.exists():
        settings = {}
        for line in CONFIG.read_text(encoding='utf-8').splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                settings[key.strip()] = value.strip()
        url = settings.get('ALERT_WEBHOOK_URL')
        if url and url.startswith('https://'):
            request = Request(url, data=json.dumps({'service': 'printform', 'alerts': result['alerts']}).encode(),
                              headers={'Content-Type': 'application/json'}, method='POST')
            with urlopen(request, timeout=10) as response:
                if response.status >= 300:
                    raise RuntimeError('alert delivery failed')
            result['lastNotifiedAlerts'] = result['alerts']
    elif not result['alerts']:
        result['lastNotifiedAlerts'] = []
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(result), encoding='utf-8')
    tmp.replace(STATE)
    if result['alerts']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
