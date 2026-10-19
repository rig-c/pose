/**
 * rig-c/pose#243: `retarget` takes `--sequence` for `--pose` and `--animation` for `--name`, the names
 * the rest of the toolchain uses. Controls: the public example through each pair writes the same motion
 * bytes as the first names; a pair that disagrees is refused with the exact line, beside a mutant that
 * removes the check and must make that control red; a pair that agrees is accepted; `--help` lists both.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const RIG = join(ROOT, 'examples', 'wave', 'rig');
const MAP = join(ROOT, 'examples', 'wave', 'map.json');
const POSE = join(ROOT, 'examples', 'wave', 'pose.json');
/** The wave's motion, byte for byte, as test/retarget.test.ts holds it. */
const WAVE_SHA256 = 'bd1ca2506217c21769169b884a306ad2defabaadecb93abd0572969291aa2e59';
const SLOW = 60_000;

interface Ran {
  status: number;
  out: string;
  stdout: string;
  stderr: string;
}

/** One retarget of the wave into a fresh directory; `args` names the sequence and the animation. */
function wave(cli: string, args: string[]): Ran {
  const d = mkdtempSync(join(tmpdir(), 'rig-pose-alias-'));
  const out = join(d, 'motion.json');
  const r = spawnSync(process.execPath, [cli, 'retarget', '--rig', RIG, '--map', MAP, '--out', out, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, out, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

const CONFLICT = (cli: string): void => {
  const other = join(tmpdir(), 'rig-pose-alias-other.json');
  cpSync(POSE, other);
  const r = wave(cli, ['--pose', POSE, '--sequence', other]);
  expect(r.status).toBe(2);
  expect(r.stderr).toBe(`rig-pose retarget: --pose "${POSE}" and --sequence "${other}" are both given and differ; --sequence is another name for --pose, so give one (rig-pose --help)\n`);
  expect(existsSync(r.out)).toBe(false);
  // Given the other way round, the line still names the flag first.
  const n = wave(cli, ['--sequence', POSE, '--animation', 'wave', '--name', 'dance']);
  expect(n.status).toBe(2);
  expect(n.stderr).toBe('rig-pose retarget: --name "dance" and --animation "wave" are both given and differ; --animation is another name for --name, so give one (rig-pose --help)\n');
  expect(existsSync(n.out)).toBe(false);
};

describe('retarget: --sequence and --animation are --pose and --name (#243)', () => {
  test('control: the wave through each pair writes the same bytes', () => {
    const first = wave(CLI, ['--pose', POSE]);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(sha(first.out)).toBe(WAVE_SHA256);
    const shared = wave(CLI, ['--sequence', POSE]);
    expect(shared.status, shared.stdout + shared.stderr).toBe(0);
    expect(sha(shared.out)).toBe(WAVE_SHA256);
    // A named animation: the first names, the shared names, and one of each, byte for byte.
    const named = [['--pose', POSE, '--name', 'hello'], ['--sequence', POSE, '--animation', 'hello'], ['--sequence', POSE, '--name', 'hello'], ['--pose', POSE, '--animation', 'hello']].map((a) => wave(CLI, a));
    for (const r of named) expect(r.status, r.stdout + r.stderr).toBe(0);
    const bytes = named.map((r) => readFileSync(r.out, 'utf8'));
    expect(bytes[0]).toContain('"hello"');
    for (const b of bytes) expect(b).toBe(bytes[0]!);
  }, SLOW * 3);

  test('control: a flag and its alias with the same value are accepted', () => {
    const r = wave(CLI, ['--pose', POSE, '--sequence', POSE, '--name', 'dance', '--animation', 'dance']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(sha(r.out)).toBe(WAVE_SHA256);
  }, SLOW);

  test('control: a flag and its alias with different values are refused naming both, nothing written', () => CONFLICT(CLI), SLOW);

  test('mutant: the check removed, the conflict control is red', () => {
    mkdirSync(MUTANTS, { recursive: true });
    const d = mkdtempSync(join(MUTANTS, 'm-'));
    try {
      cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
      cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
      const src = readFileSync(join(ROOT, 'cli.ts'), 'utf8');
      const from = '      throw new Usage(`${own} "${ownV}" and ${alias} "${aliasV}" are both given and differ; ${alias} is another name for ${own}, so give one`);\n';
      expect(src).toContain(from);
      writeFileSync(join(d, 'cli.ts'), src.replace(from, ''));
      expect(() => CONFLICT(join(d, 'cli.ts'))).toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW * 2);

  test('the first names keep their refusals: a flag given twice, and neither name given', () => {
    const twice = wave(CLI, ['--pose', POSE, '--pose', POSE]);
    expect(twice.status).toBe(2);
    expect(twice.stderr).toBe('rig-pose retarget: --pose is given twice (rig-pose --help)\n');
    const none = wave(CLI, []);
    expect(none.status).toBe(2);
    expect(none.stderr).toBe('rig-pose retarget: --sequence (or --pose) is required (rig-pose --help)\n');
  });

  test('--help lists both names of each, the shared name first', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const help = r.stdout.split('\n');
    expect(help).toContain('  rig-pose retarget --rig <rig> --map <map.json> --sequence <pose.json> --out <motion.json> [--animation dance] [flags]');
    // Read in retarget's section: clean's own --pose row comes before it.
    const from = help.indexOf('retarget');
    expect(from).toBeGreaterThan(0);
    const at = (prefix: string): number => help.findIndex((l, i) => i > from && l.startsWith(prefix));
    for (const [shared, first] of [['  --sequence <file> ', '  --pose <file> '], ['  --animation <name> ', '  --name <name> ']] as const) {
      expect(at(shared)).toBeGreaterThan(from);
      expect(at(first)).toBeGreaterThan(at(shared));
    }
  });
});
