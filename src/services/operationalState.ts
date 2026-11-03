import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type JobName = 'payment-expiry' | 'cdek-sync';
type Run = { ok: boolean; counts?: Record<string, number> };
type State = {
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  counts: Record<string, number>;
};

const defaultDir = () => process.env.PRINTFORM_MONITOR_STATE_DIR || path.resolve(process.cwd(), '..', 'monitor-state');

export const recordJobRun = async (name: JobName, run: Run, dir = defaultDir(), at = new Date()): Promise<void> => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${name}.json`);
  let previous: State | null = null;
  try { previous = JSON.parse(await readFile(target, 'utf8')) as State; }
  catch { /* Initial run or stale invalid state. The monitor will see the next result. */ }
  const stamp = at.toISOString();
  const state: State = {
    lastAttemptAt: stamp,
    lastSuccessAt: run.ok ? stamp : previous?.lastSuccessAt ?? null,
    lastFailureAt: run.ok ? previous?.lastFailureAt ?? null : stamp,
    consecutiveFailures: run.ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
    counts: run.ok ? run.counts ?? {} : previous?.counts ?? {}
  };
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
};
