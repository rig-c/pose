/**
 * rig-c/pose#239: the paths a first run trips on say what to do. Four controls, one per
 * sentence, each asserting the exact line; beside each, a mutant that removes the sentence
 * and must make its control red. The public example's motion bytes do not move.
 *
 * Every run's working directory is a fresh temp directory, so the paths in the lines are the
 * relative ones a user types. Mutants are written under node_modules/.cache/ so that `@rig-c/core`
 * still resolves by walking up.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'cli.ts');
const MUTANTS = join(ROOT, 'node_modules', '.cache', 'rig-pose-mutants');
const WAVE = join(ROOT, 'examples', 'wave');
/** The wave's motion, byte for byte, as test/retarget.test.ts holds it. */
const WAVE_SHA256 = 'bd1ca2506217c21769169b884a306ad2defabaadecb93abd0572969291aa2e59';
const SLOW = 60_000;

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

/** A temp directory holding the wave's map and pose, and a copy of its rig with a slider that applies a motion spec's animation. */
function scratch(): string {
  // Real path: the CLI resolves --rig against its working directory, which the OS reports resolved.
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'rig-pose-paths-')));
  cpSync(join(WAVE, 'map.json'), join(d, 'map.json'));
  cpSync(join(WAVE, 'pose.json'), join(d, 'pose.json'));
  const rig = JSON.parse(readFileSync(join(WAVE, 'rig', 'rig.json'), 'utf8')) as { bones: Array<Record<string, unknown>>; constraints?: unknown[] };
  rig.bones.push({ name: 'dial', parent: 'root' }, { name: 'tag', parent: 'root' });
  rig.constraints = [{ name: 'turn_dial', type: 'slider', animation: 'turn', bone: 'dial', property: 'rotate' }];
  mkdirSync(join(d, 'dial'));
  writeFileSync(join(d, 'dial', 'rig.json'), JSON.stringify(rig, null, 2));
  writeFileSync(join(d, 'dial', 'motion.json'), JSON.stringify({ spec: 'rigc-motion/1', archetype: 'wave', cut: 'wave', easings: {}, animations: { turn: { duration: 1, tracks: [{ bone: 'tag', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: 1, v: [20] }] }] } } }, null, 2));
  return d;
}

function retarget(cli: string, cwd: string, args: string[]): Ran {
  const r = spawnSync(process.execPath, [cli, 'retarget', '--map', 'map.json', '--pose', 'pose.json', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const lines = (r: Ran): string[] => `${r.stdout}${r.stderr}`.split('\n');
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Each case runs against a CLI and throws (an `expect`) when its sentence is not printed exactly. */
const CASES: Array<{ name: string; file: string; from: string; to: string; run: (cli: string) => void }> = [
  {
    name: '--out into a directory not there yet: it is made after green, and the line says so',
    file: 'src/run.ts',
    from: '      tell(madeLine(dir, flags));\n',
    to: '',
    run: (cli) => {
      const d = scratch();
      try {
        const r = retarget(cli, d, ['--rig', join(WAVE, 'rig'), '--out', 'run/after/motion.json']);
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(lines(r)).toContain('  made directory run/after — it did not exist; --out run/after/motion.json and --report run/after/motion.report.json are written into it');
        expect(sha(join(d, 'run', 'after', 'motion.json'))).toBe(WAVE_SHA256);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'RIG_GATE_BASE on a bare rig.json with a motion.json beside it names the directory form',
    file: 'src/run.ts',
    from: '${unreadMotionHint(a.rig, input.motion)}',
    to: '',
    run: (cli) => {
      const d = scratch();
      try {
        const r = retarget(cli, d, ['--rig', 'dial/rig.json', '--out', 'motion.json']);
        expect(r.status).toBe(1);
        expect(lines(r)).toContain(`FAIL  RIG_GATE_BASE: ${join(d, 'dial', 'rig.json')} with no motion spec is red under rigc build --profile spine before any animation is added (exit 1); dial/motion.json is beside it and was not read — --rig naming the rig.json reads no motion spec: pass --rig dial (the directory, which reads the motion.json beside its rig.json) or --base-motion dial/motion.json`);
        expect(existsSync(join(d, 'motion.json'))).toBe(false);
        // The form the line names is green and reads the rig's own animation.
        const dir = retarget(cli, d, ['--rig', 'dial', '--out', 'motion.json']);
        expect(dir.status, dir.stdout + dir.stderr).toBe(0);
        expect(lines(dir)).toContain('  wrote motion.json — animations: turn, dance');
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'a bare rig.json whose gate is green, with a motion.json beside it, says the rig\'s own animations are not in --out (#250)',
    file: 'src/run.ts',
    from: '    if (unread !== null) tell(`  MOTION ${unread}`);\n',
    to: '',
    run: (cli) => {
      const d = scratch();
      try {
        // The wave's rig, which gates green alone, beside a motion spec whose animation it would carry.
        mkdirSync(join(d, 'bare'));
        cpSync(join(WAVE, 'rig', 'rig.json'), join(d, 'bare', 'rig.json'));
        writeFileSync(join(d, 'bare', 'motion.json'), JSON.stringify({ spec: 'rigc-motion/1', archetype: 'wave', cut: 'wave', easings: {}, animations: { turn: { duration: 1, tracks: [{ bone: 'head', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: 1, v: [5] }] }] } } }, null, 2));
        const line = "  MOTION bare/motion.json is beside bare/rig.json and was not read — --rig naming the rig.json reads no motion spec, so --out carries none of the rig's own animations: pass --rig bare (the directory, which reads the motion.json beside its rig.json) or --base-motion bare/motion.json";
        for (const extra of [[], ['--summary']]) {
          const r = retarget(cli, d, ['--rig', 'bare/rig.json', '--out', 'motion.json', ...extra]);
          expect(r.status, r.stdout + r.stderr).toBe(0);
          expect(lines(r)).toContain(line);
          // No behaviour change: the motion is the wave's, byte for byte.
          expect(sha(join(d, 'motion.json'))).toBe(WAVE_SHA256);
        }
        // The forms the line names read the animation and say nothing.
        for (const args of [['--rig', 'bare'], ['--rig', 'bare/rig.json', '--base-motion', 'bare/motion.json']]) {
          const r = retarget(cli, d, [...args, '--out', 'with.json']);
          expect(r.status, r.stdout + r.stderr).toBe(0);
          expect(lines(r)).toContain('  wrote with.json — animations: turn, dance');
          expect(lines(r).some((l) => l.startsWith('  MOTION '))).toBe(false);
        }
        // A rig.json with no motion.json beside it says nothing either.
        const plain = retarget(cli, d, ['--rig', join(WAVE, 'rig', 'rig.json'), '--out', 'plain.json']);
        expect(plain.status, plain.stdout + plain.stderr).toBe(0);
        expect(lines(plain).some((l) => l.startsWith('  MOTION '))).toBe(false);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'no --report: the report is written beside the motion as <out>.report.json, and the line says it was the default',
    file: 'src/run.ts',
    from: "', beside --out by default; name another path with --report'",
    to: "''",
    run: (cli) => {
      const d = scratch();
      try {
        const r = retarget(cli, d, ['--rig', join(WAVE, 'rig'), '--out', 'wave.motion.json']);
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(lines(r)).toContain("  wrote wave.motion.report.json — the run's report (rig-pose-report/1), beside --out by default; name another path with --report");
        expect((JSON.parse(readFileSync(join(d, 'wave.motion.report.json'), 'utf8')) as { spec: string }).spec).toBe('rig-pose-report/1');
        expect(sha(join(d, 'wave.motion.json'))).toBe(WAVE_SHA256);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'a second --report to the same path names the mtime of the report it replaced',
    file: 'src/run.ts',
    from: '; it replaced the report there last written ${previous.toISOString()}',
    to: '',
    run: (cli) => {
      const d = scratch();
      try {
        const args = ['--rig', join(WAVE, 'rig'), '--out', 'motion.json', '--report', 'r.json'];
        const first = retarget(cli, d, args);
        expect(first.status, first.stdout + first.stderr).toBe(0);
        expect(lines(first)).toContain("  wrote r.json — the run's report (rig-pose-report/1)");
        const mtime = statSync(join(d, 'r.json')).mtime.toISOString();
        const second = retarget(cli, d, args);
        expect(second.status, second.stdout + second.stderr).toBe(0);
        expect(lines(second)).toContain(`  wrote r.json — the run's report (rig-pose-report/1); it replaced the report there last written ${mtime}`);
        expect(sha(join(d, 'motion.json'))).toBe(WAVE_SHA256);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    },
  },
];

describe('path refusals and notices name the fix (#239)', () => {
  for (const c of CASES) {
    test(`control: ${c.name}`, () => c.run(CLI), SLOW);
    test(`mutant: ${c.name} — the sentence removed, the control is red`, () => {
      mkdirSync(MUTANTS, { recursive: true });
      const d = mkdtempSync(join(MUTANTS, 'm-'));
      try {
        cpSync(join(ROOT, 'src'), join(d, 'src'), { recursive: true });
        cpSync(join(ROOT, 'cli.ts'), join(d, 'cli.ts'));
        cpSync(join(ROOT, 'package.json'), join(d, 'package.json'));
        const path = join(d, c.file);
        const before = readFileSync(path, 'utf8');
        expect(before.split(c.from)).toHaveLength(2);
        writeFileSync(path, before.replace(c.from, c.to));
        expect(() => c.run(join(d, 'cli.ts'))).toThrow();
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }, SLOW);
  }

  test('control: a file where a directory has to be made is refused by name, nothing written', () => {
    const d = scratch();
    try {
      writeFileSync(join(d, 'afile'), '');
      const r = retarget(CLI, d, ['--rig', join(WAVE, 'rig'), '--out', 'afile/x/motion.json', '--report', 'r.json']);
      expect(r.status).toBe(1);
      expect(lines(r).filter((l) => l.startsWith('FAIL  '))).toEqual(['FAIL  ARG_PATH: --out afile/x/motion.json — afile is a file, so directory afile/x cannot be made under it']);
      expect(r.stdout).toBe('');
      expect(existsSync(join(d, 'r.json'))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);

  test('control: a red run makes no directory', () => {
    const d = scratch();
    try {
      const r = retarget(CLI, d, ['--rig', 'dial/rig.json', '--out', 'run/after/motion.json']);
      expect(r.status).toBe(1);
      expect(existsSync(join(d, 'run'))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, SLOW);
});
