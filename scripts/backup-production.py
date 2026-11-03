#!/usr/bin/env python3
"""Encrypted, verified Print-Form backup. Default mode is read-only dry run."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.parse import unquote, urlparse

APP_ROOT = Path('/var/www/printform/backend')
CONFIG = Path('/etc/printform/backup.env')
STATE = Path('/var/lib/printform/backup-state.json')
LOCK = Path('/run/lock/printform-backup.lock')
STAGING = Path('/var/backups/printform')


def read_env(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        values[key.strip()] = value
    return values


def file_inventory(roots: list[Path]) -> tuple[int, int]:
    count = size = 0
    for root in roots:
        if root.is_file():
            count += 1
            size += root.stat().st_size
        elif root.is_dir():
            for directory, _, names in os.walk(root):
                for name in names:
                    item = Path(directory) / name
                    if item.is_file():
                        count += 1
                        size += item.stat().st_size
    return count, size


def run(command: list[str], env: dict[str, str], *, capture=False) -> subprocess.CompletedProcess:
    return subprocess.run(command, env=env, check=True,
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          stderr=subprocess.PIPE)


def remote_file_sha256(snapshot_id: str, source: Path, env: dict[str, str]) -> str:
    digest = hashlib.sha256()
    process = subprocess.Popen(['restic', 'dump', snapshot_id, str(source)], env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    assert process.stdout is not None
    for chunk in iter(lambda: process.stdout.read(1024 * 1024), b''):
        digest.update(chunk)
    if process.wait() != 0:
        raise RuntimeError('Remote DB read failed')
    return digest.hexdigest()


def sample_file(root: Path) -> Path | None:
    candidates = (Path(directory) / name for directory, _, names in os.walk(root) for name in names)
    regular = (item for item in candidates if item.is_file() and not item.is_symlink())
    return min(regular, key=lambda item: item.stat().st_size, default=None)


def db_environment(database_url: str) -> dict[str, str]:
    parsed = urlparse(database_url)
    if parsed.scheme not in ('postgresql', 'postgres') or not parsed.hostname or not parsed.path:
        raise ValueError('Invalid DATABASE_URL')
    result = os.environ.copy()
    result.update(PGHOST=parsed.hostname, PGPORT=str(parsed.port or 5432),
                  PGUSER=unquote(parsed.username or ''), PGPASSWORD=unquote(parsed.password or ''),
                  PGDATABASE=unquote(parsed.path.lstrip('/')))
    return result


def backup_scope(app_env: dict[str, str]) -> list[Path]:
    private = Path(app_env.get('PRIVATE_UPLOADS_DIR') or APP_ROOT / 'private-uploads').resolve()
    public = (APP_ROOT / 'uploads').resolve()
    if private == public or public in private.parents:
        raise ValueError('Private uploads resolve inside public uploads')
    return [public, private, APP_ROOT / '.env.production',
            Path('/etc/nginx/sites-available/print-form'),
            Path('/etc/nginx/sites-enabled/print-form'),
            Path('/home/deploy/.pm2/dump.pm2')]


def write_state(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = STATE.with_name(STATE.name + '.tmp')
    temporary.write_text(json.dumps(state), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(STATE)


def execute() -> None:
    import fcntl
    os.umask(0o077)
    started = time.monotonic()
    now = time.time()
    state = {'lastAttemptAt': int(now), 'lastSuccessAt': None, 'status': 'started'}
    if STATE.exists():
        try: state['lastSuccessAt'] = json.loads(STATE.read_text()).get('lastSuccessAt')
        except (ValueError, OSError): pass
    stage = 'config'
    try:
        config = read_env(CONFIG)
        required = ('RESTIC_REPOSITORY', 'RESTIC_PASSWORD_FILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY')
        if any(not config.get(key) for key in required):
            raise ValueError('Backup destination configuration incomplete')
        password_file = Path(config['RESTIC_PASSWORD_FILE'])
        if CONFIG.stat().st_uid != 0 or password_file.stat().st_uid != 0:
            raise PermissionError('Backup config/password file must be root-owned')
        if CONFIG.stat().st_mode & 0o077 or password_file.stat().st_mode & 0o077:
            raise PermissionError('Backup config/password file permissions must be 0600')
        app_env = read_env(APP_ROOT / '.env.production')
        db_env = db_environment(app_env['DATABASE_URL'])
        remote_env = os.environ.copy()
        remote_env.update({key: value for key, value in config.items() if key in required or key.startswith('AWS_') or key.startswith('RESTIC_')})
        scope = backup_scope(app_env)
        missing = [str(item) for item in scope if not item.exists()]
        if missing:
            raise FileNotFoundError('Required backup scope path missing')
        STAGING.mkdir(parents=True, exist_ok=True, mode=0o700)
        stage = 'lock'
        with open(LOCK, 'w', encoding='utf-8') as handle:
            try: fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise RuntimeError('Backup already running')
            write_state(state)
            with tempfile.TemporaryDirectory(prefix='run-', dir=STAGING) as temporary:
                work = Path(temporary)
                dump = work / 'database.dump'
                stage = 'pg_dump'
                run(['pg_dump', '-Fc', '-f', str(dump)], db_env)
                if dump.stat().st_size == 0: raise RuntimeError('Empty database dump')
                stage = 'pg_restore_list'
                run(['pg_restore', '--list', str(dump)], db_env)
                digest = hashlib.sha256(dump.read_bytes()).hexdigest()
                release = {}
                for name, repo in (('backend', APP_ROOT), ('frontend', Path('/var/www/printform/frontend'))):
                    release[name] = run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], os.environ.copy(), capture=True).stdout.decode().strip()
                (work / 'manifest.json').write_text(json.dumps({'createdAt': int(now), 'dbSha256': digest, 'release': release}), encoding='utf-8')
                (work / 'manifest.json').chmod(0o600)
                stage = 'remote_backup'
                output = run(['restic', 'backup', '--json', '--tag', 'printform-production', str(work), *map(str, scope)], remote_env, capture=True).stdout
                summaries = [json.loads(line) for line in output.splitlines() if line.startswith(b'{')]
                summary = next((item for item in reversed(summaries) if item.get('message_type') == 'summary'), None)
                snapshot_id = summary.get('snapshot_id') if summary else None
                if not snapshot_id: raise RuntimeError('Remote snapshot ID missing')
                stage = 'remote_verify'
                run(['restic', 'check'], remote_env)
                if remote_file_sha256(snapshot_id, dump, remote_env) != digest:
                    raise RuntimeError('Remote DB checksum mismatch')
                for root in scope[:2]:
                    representative = sample_file(root)
                    if representative:
                        local_hash = hashlib.sha256(representative.read_bytes()).hexdigest()
                        if remote_file_sha256(snapshot_id, representative, remote_env) != local_hash:
                            raise RuntimeError('Remote upload checksum mismatch')
                stage = 'retention'
                run(['restic', 'forget', '--tag', 'printform-production', '--group-by', 'tags', '--keep-within', '2d',
                     '--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '3', '--prune'], remote_env)
                file_count, bytes_total = file_inventory(scope)
                completed = int(time.time())
                state = {'lastAttemptAt': int(now), 'lastSuccessAt': completed, 'status': 'verified',
                         'snapshotId': snapshot_id, 'dbBytes': dump.stat().st_size,
                         'files': file_count, 'fileBytes': bytes_total,
                         'destinationId': hashlib.sha256(config['RESTIC_REPOSITORY'].encode()).hexdigest()[:12]}
                write_state(state)
                print(json.dumps({'event': 'backup_verified', **state, 'durationSeconds': round(time.monotonic() - started, 2)}))
    except Exception as error:
        if stage == 'lock' and isinstance(error, RuntimeError) and str(error) == 'Backup already running':
            print(json.dumps({'event': 'backup_skipped', 'reason': 'already_running'}))
            raise SystemExit(0)
        state.update(status='failed', failedStage=stage, errorType=type(error).__name__)
        write_state(state)
        print(json.dumps({'event': 'backup_failed', 'stage': stage, 'errorType': type(error).__name__}))
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true', help='perform backup; default is read-only dry run')
    args = parser.parse_args()
    if args.run:
        execute()
    else:
        print(json.dumps({'event': 'backup_dry_run', 'scope': [str(item) for item in backup_scope({})],
                          'configured': CONFIG.exists(), 'resticAvailable': bool(__import__('shutil').which('restic'))}))
