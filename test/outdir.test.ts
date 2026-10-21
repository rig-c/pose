/**
 * rig-c/pose#284: every file a command writes goes into a directory the user named; one not there
 * yet is made (mkdir -p) and a line says so, and a parent that cannot be made — a file in the way,
 * or a directory this process cannot write into — is refused by name with nothing written. Each
 * planted parent beside the control that writes.
 *
 * Every run's working directory is a fresh temp directory, so the paths are the relative ones a
 * user types.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const WAVE = join(ROOT, 'examples', 'wave');
const SLOW = 60_000;

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

/** A fresh directory holding the wave's map, its pose, the pose before clean (`raw.json`), pelvis keys and a plain file `afile`. */
function scratch(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'rig-pose-outdir-')));
  const pose = readFileSync(join(WAVE, 'pose.json'), 'utf8');
  writeFileSync(join(d, 'pose.json'), pose);
  const raw = JSON.parse(pose) as Record<string, unknown>;
  delete raw.cleaned;
  writeFileSync(join(d, 'raw.json'), JSON.stringify(raw));
  writeFileSync(join(d, 'map.json'), readFileSync(join(WAVE, 'map.json')));
  writeFileSync(join(d, 'keys.json'), JSON.stringify({ spec: 'rig-pose-pelvis-keys/1', keys: [{ frame: 0, deg: 0 }, { frame: 72, deg: 5 }] }));
  writeFileSync(join(d, 'afile'), '');
  return d;
}

function run(cwd: string, args: string[]): Ran {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const lines = (r: Ran): string[] => `${r.stdout}${r.stderr}`.split('\n');
const fails = (r: Ran): string[] => lines(r).filter((l) => l.startsWith('FAIL  '));
/** Every entry of the scratch directory, so a refusal can be held to writing nothing. */
const tree = (d: string): string[] => readdirSync(d, { recursive: true }).map(String).sort();

/** One command's write: the args with its output under `out`, and what the run must leave there. */
const COMMANDS: Array<{ name: string; args: (out: string) => string[]; flag: string; slow?: boolean }> = [
  { name: 'clean --out', args: (out) => ['clean', '--pose', 'raw.json', '--out', out], flag: '--out' },
  { name: 'pelvis --out', args: (out) => ['pelvis', '--pose', 'raw.json', '--pelvis-keys', 'keys.json', '--out', out], flag: '--out' },
  { name: 'compare --report', args: (out) => ['compare', '--reference', 'pose.json', '--render', 'pose.json', '--map', 'map.json', '--report', out], flag: '--report' },
];

describe('#284: a file a command writes makes the directory it goes into, or is refused by name', () => {
  for (const c of COMMANDS) {
    test(`control: ${c.name} into a fresh nested path exits 0, makes it, and says so`, () => {
      const d = scratch();
      try {
        const r = run(d, c.args('n/e/s/t.json'));
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(lines(r)).toContain(`  made directory n/e/s — it did not exist; ${c.flag} n/e/s/t.json is written into it`);
        expect(existsSync(join(d, 'n', 'e', 's', 't.json'))).toBe(true);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
    test(`planted: ${c.name} under a file is refused by name; nothing written`, () => {
      const d = scratch();
      try {
        const before = tree(d);
        const r = run(d, c.args('afile/x/t.json'));
        expect(r.status).toBe(1);
        expect(fails(r)).toEqual([`FAIL  ARG_PATH: ${c.flag} afile/x/t.json — afile is a file, so directory afile/x cannot be made under it`]);
        expect(tree(d)).toEqual(before);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  }

  test('planted: a parent this process cannot write into is refused by name; nothing written', () => {
    // Root writes through a read-only mode, so the plant would not fire; nothing to hold then.
    if (process.getuid?.() === 0) return;
    const d = scratch();
    mkdirSync(join(d, 'ro'));
    chmodSync(join(d, 'ro'), 0o555);
    try {
      const r = run(d, ['clean', '--pose', 'raw.json', '--out', 'ro/x/t.json']);
      expect(r.status).toBe(1);
      expect(fails(r)).toEqual(['FAIL  ARG_PATH: --out ro/x/t.json — ro is not writable, so directory ro/x cannot be made under it']);
      expect(readdirSync(join(d, 'ro'))).toEqual([]);
    } finally {
      chmodSync(join(d, 'ro'), 0o755);
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  // rig-c/pose#323: an existing parent that cannot be written into is refused up front too — before,
  // only a parent still to make was checked, and the write threw EACCES after other outputs landed.
  const RO_EXISTING: Array<{ name: string; args: string[]; fail: string; absent: string[] }> = [
    {
      name: 'retarget --report (with --out writable)',
      args: ['retarget', '--rig', join(WAVE, 'rig'), '--map', 'map.json', '--pose', 'pose.json', '--out', 'ok/m.json', '--report', 'ro/r.json'],
      fail: 'FAIL  ARG_PATH: --report ro/r.json — ro is not writable',
      absent: ['ok'],
    },
    { name: 'clean --out', args: ['clean', '--pose', 'raw.json', '--out', 'ro/t.json'], fail: 'FAIL  ARG_PATH: --out ro/t.json — ro is not writable', absent: [] },
    { name: 'pelvis --out', args: ['pelvis', '--pose', 'raw.json', '--pelvis-keys', 'keys.json', '--out', 'ro/t.json'], fail: 'FAIL  ARG_PATH: --out ro/t.json — ro is not writable', absent: [] },
  ];
  for (const c of RO_EXISTING) {
    test(`planted: ${c.name} into an existing directory this process cannot write into is refused by name; nothing written`, () => {
      // Root writes through a read-only mode, so the plant would not fire; nothing to hold then.
      if (process.getuid?.() === 0) return;
      const d = scratch();
      mkdirSync(join(d, 'ro'));
      chmodSync(join(d, 'ro'), 0o555);
      try {
        const before = tree(d);
        const r = run(d, c.args);
        expect(r.status).toBe(1);
        expect(fails(r)).toEqual([c.fail]);
        expect(tree(d)).toEqual(before);
        for (const a of c.absent) expect(existsSync(join(d, a))).toBe(false);
      } finally {
        chmodSync(join(d, 'ro'), 0o755);
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  }

  test('control: retarget --out, --report and --build into a fresh directory where none of their parents exist writes all three', () => {
    const d = scratch();
    try {
      const r = run(d, ['retarget', '--rig', join(WAVE, 'rig'), '--map', 'map.json', '--pose', 'pose.json', '--out', 'a/b/c/m.json', '--report', 'x/y/r.json', '--build', 'p/q/b']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(existsSync(join(d, 'a', 'b', 'c', 'm.json'))).toBe(true);
      expect(existsSync(join(d, 'x', 'y', 'r.json'))).toBe(true);
      expect(existsSync(join(d, 'p', 'q', 'b', 'skeleton.model.json'))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('planted: retarget --build and --render under a file are refused up front, by name; nothing written', () => {
    const d = scratch();
    try {
      const before = tree(d);
      const r = run(d, ['retarget', '--rig', join(WAVE, 'rig'), '--map', 'map.json', '--pose', 'pose.json', '--out', 'ok/m.json', '--build', 'afile/b', '--render', 'afile/r/s']);
      expect(r.status).toBe(1);
      expect(fails(r)).toEqual([
        'FAIL  ARG_PATH: --build afile/b — afile is not a directory',
        'FAIL  ARG_PATH: --render afile/r/s — afile is a file, so directory afile/r cannot be made under it',
      ]);
      expect(r.stdout).toBe('');
      expect(tree(d)).toEqual(before);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});
