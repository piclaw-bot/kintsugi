import { shellQuote } from "@kintsugi/core";
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardian } from './lifecycle';

async function ready(file: string) {
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) return;
    await Bun.sleep(20);
  }
  throw Error(`Guardian child did not start: ${file}`);
}

for (const event of ['EOF', 'deadline', 'SIGTERM', 'child exit'] as const) {
  test(`remote guardian cleans its lease after ${event}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'serve-sim-lease-test-'));
    const root = join(directory, 'owned');
    const marker = join(directory, 'cleaned');
    const foreign = join(directory, 'other-workspace');
    writeFileSync(foreign, 'leave me alone');
    const script = `mkdir -p ${shellQuote(root)}; echo $$ > ${shellQuote(join(root, 'pid'))}; ${event === 'child exit' ? 'sleep 0.2; exit 7' : 'exec sleep 60'}`;
    const cleanup = `printf cleaned > ${shellQuote(marker)}`;
    const process = Bun.spawn(['perl', '-e', guardian, root, script, cleanup, event === 'deadline' ? '0.2' : '10'], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
    try {
      await ready(join(root, 'pid'));
      const pid = readFileSync(join(root, 'pid'), 'utf8').trim();
      if (event === 'EOF') process.stdin.end();
      if (event === 'SIGTERM') process.kill('SIGTERM');
      expect(await process.exited).toBe(event === 'child exit' ? 7 : 0);
      expect(Bun.spawnSync(['kill', '-0', pid], {stderr: 'pipe'}).exitCode).not.toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('cleaned');
      expect(existsSync(root)).toBe(false);
      expect(existsSync(`${root}.lock`)).toBe(false);
      expect(readFileSync(foreign, 'utf8')).toBe('leave me alone');
    } finally {
      process.kill();
      rmSync(directory, {recursive: true, force: true});
    }
  }, 10000);
}

test('another invocation cannot clean or take over an active lease', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'serve-sim-lease-lock-'));
  const root = join(directory, 'owned');
  const script = `mkdir -p ${shellQuote(root)}; touch ${shellQuote(join(root, 'ready'))}; exec sleep 60`;
  const first = Bun.spawn(['perl', '-e', guardian, root, script, 'true', '10'], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
  try {
    await ready(join(root, 'ready'));
    const second = Bun.spawn(['perl', '-e', guardian, root, 'true', `rm -r ${shellQuote(root)}`, '10'], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
    expect(await second.exited).not.toBe(0);
    expect(existsSync(join(root, 'ready'))).toBe(true);
    first.stdin.end();
    expect(await first.exited).toBe(0);
  } finally {
    first.kill();
    rmSync(directory, {recursive: true, force: true});
  }
}, 10000);
