/** The convenience name carries the scoped package's files; every exception is planted. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AliasTarballError, packInto } from '../scripts/alias_tarball.ts';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const script = join(ROOT, 'scripts/alias_tarball.ts');
const work = mkdtempSync(join(tmpdir(), 'pose-alias-test-'));
const fixture = join(work, 'fixture');
const manifest = { name: '@rig-c/pose', version: '1.2.3', files: ['payload.bin'], bin: { 'rig-pose': './payload.bin' } };
let primary: string;
let alias: string;
const run = (cmd: string, args: string[], cwd = ROOT, env = process.env) => {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 30000 });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`, stdout: result.stdout ?? '' };
};
const cli = (...args: string[]) => run(process.execPath, [script, ...args]);
function tar(tree: string, name: string): string {
  const path = join(work, `${name}.tgz`);
  const made = run('tar', ['-czf', path, '-C', tree, 'package']);
  expect(made.status, made.out).toBe(0);
  return path;
}
function plant(name: string, mutate: (tree: string) => void): string {
  const tree = join(work, name);
  mkdirSync(tree);
  expect(run('tar', ['-xzf', alias, '-C', tree]).status).toBe(0);
  mutate(join(tree, 'package'));
  return tar(tree, name);
}

beforeAll(() => {
  mkdirSync(fixture);
  writeFileSync(join(fixture, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(fixture, 'payload.bin'), Buffer.from([0, 1, 2, 255]));
  primary = packInto(fixture, work);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

test('pack control: same files and bytes except the name; source stays unchanged', () => {
  const before = readFileSync(join(fixture, 'package.json'), 'utf8');
  const made = cli('pack', '--name', 'rig-pose', '--out', join(work, 'out'), '--tarball', primary);
  expect(made.status, made.out).toBe(0);
  alias = made.stdout.trim();
  expect(readFileSync(join(fixture, 'package.json'), 'utf8')).toBe(before);
  const same = cli('compare', primary, alias);
  expect(same.status, same.out).toBe(0);
  expect(same.out).toContain('ALIAS_SAME_CONTENT');
  expect(same.out).toContain('rig-pose@1.2.3');
  expect(same.out).toContain('@rig-c/pose@1.2.3');
  expect(same.out).toContain('2 file(s)');
  console.log(same.out.trim());
});

// npm supplies these flags to a real lifecycle child, as publish does. The
// dry-run control must still write the private fixture tarballs, never publish.
for (const dryRun of [false, true]) {
  test(`pack under a publish lifecycle${dryRun ? ' with dry-run' : ''} writes and compares real tarballs`, () => {
    const dir = join(work, dryRun ? 'lifecycle-dry' : 'lifecycle');
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'alias-lifecycle-control', version: '1.0.0', private: true,
      scripts: { prepublishOnly: 'bun probe.ts' },
    }));
    writeFileSync(join(dir, 'probe.ts'), `
      import { packAlias, packInto } from ${JSON.stringify(script)};
      const primary = packInto(${JSON.stringify(fixture)}, ${JSON.stringify(join(dir, 'primary'))});
      const made = packAlias('rig-pose', ${JSON.stringify(join(dir, 'alias'))}, primary);
      console.log('LIFECYCLE_PACK: ' + made.comparison.files + ' files, ' + made.comparison.faults.length + ' faults');
    `);
    const flags = ['--provenance', '--access', 'public', ...(dryRun ? ['--dry-run'] : [])];
    const made = run('npm', ['run', 'prepublishOnly', ...flags], dir);
    expect(made.status, made.out).toBe(0);
    expect(made.out).toContain('LIFECYCLE_PACK: 2 files, 0 faults');
  });
}

test('pack refuses successful stdout without a tarball and a failed npm by name', () => {
  const bin = join(work, 'pack-mock-bin');
  mkdirSync(bin);
  const npm = join(bin, 'npm');
  for (const status of [0, 7]) {
    // A claimed filename (including npm's JSON output) cannot stand in for bytes.
    writeFileSync(npm, `#!/bin/sh\nprintf '%s\\n' '{"@rig-c/pose":{"filename":"claimed.tgz"}}'\nexit ${status}\n`);
    chmodSync(npm, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous}`;
    try {
      expect(() => packInto(fixture, join(work, `no-tarball-${status}`))).toThrow(AliasTarballError);
      expect(() => packInto(fixture, join(work, `no-tarball-${status}`))).toThrow(`exited ${status} and left 0 new tarball(s); one was required`);
    } finally {
      process.env.PATH = previous;
    }
  }
});

for (const kind of ['byte', 'missing', 'extra', 'version', 'format'] as const) {
  test(`planted ${kind} difference is refused by path with exit 1`, () => {
    const broken = plant(kind, (tree) => {
      if (kind === 'byte') writeFileSync(join(tree, 'payload.bin'), Buffer.from([0, 1, 3, 255]));
      if (kind === 'missing') rmSync(join(tree, 'payload.bin'));
      if (kind === 'extra') writeFileSync(join(tree, 'extra.txt'), 'extra');
      if (kind === 'version') {
        const path = join(tree, 'package.json');
        writeFileSync(path, readFileSync(path, 'utf8').replace('1.2.3', '1.2.4'));
      }
      if (kind === 'format') {
        const path = join(tree, 'package.json');
        writeFileSync(path, readFileSync(path, 'utf8').replace('"version":', '"version" :'));
      }
    });
    const compared = cli('compare', primary, broken);
    expect(compared.status, compared.out).toBe(1);
    expect(compared.out).toContain('FAIL  ALIAS_SAME_CONTENT');
    expect(compared.out).toContain(kind === 'extra' ? 'package/extra.txt' : kind === 'version' || kind === 'format' ? 'package/package.json' : 'package/payload.bin');
    if (kind === 'byte') expect(compared.out).toContain('first parting at byte 2');
    console.log(`PLANT ${kind}: exit ${compared.status}\n${compared.out.trim()}`);
  });
}

test('the scoped tarball cannot be passed off as its own alias', () => {
  const compared = cli('compare', primary, primary);
  expect(compared.status, compared.out).toBe(1);
  expect(compared.out).toContain('not under another name');
});

test('pack refuses an unsupported alias and unreadable input by name', () => {
  const wrong = cli('pack', '--name', 'other', '--out', work, '--tarball', primary);
  expect(wrong.status, wrong.out).toBe(2);
  expect(wrong.out).toContain('rig-pose');
  const bad = join(work, 'bad.tgz');
  writeFileSync(bad, 'not a tarball');
  expect(cli('compare', primary, bad).status).toBe(2);
});

test('release publishes the alias after the unchanged scoped step, with OIDC and matching rc tag', () => {
  const text = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const wf = Bun.YAML.parse(text) as { jobs: { release: { permissions: Record<string, string>; steps: { name?: string; run?: string; if?: string }[] } } };
  const steps = wf.jobs.release.steps;
  const scoped = steps.findIndex((step) => step.name === 'Publish to npm');
  const at = steps.findIndex((step) => step.name === 'Publish the alias rig-pose');
  expect(at).toBeGreaterThan(scoped);
  expect(at).toBeLessThan(steps.findIndex((step) => step.name === 'Confirm the published package installs and runs'));
  expect(wf.jobs.release.permissions['id-token']).toBe('write');
  expect(steps[at].if).toBe(steps[scoped].if);
  const bin = join(work, 'mock-bin');
  mkdirSync(bin);
  // This test executes the workflow's own body. The only external operations are closed mocks.
  for (const [name, body] of Object.entries({
    bun: 'printf "bun %s\\n" "$*" >> "$TRACE"; [ "$PACK_EXIT" = 0 ] || exit "$PACK_EXIT"; printf "%s\\n" "$ALIAS_TGZ"',
    npm: 'printf "npm %s\\n" "$*" >> "$TRACE"',
    node: 'printf "%s\\n" "$VERSION"',
  })) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
    chmodSync(path, 0o755);
  }
  for (const version of ['1.2.3', '1.2.3-rc.1']) {
    for (const packExit of ['0', '2']) {
      const trace = join(work, 'publish.trace');
      writeFileSync(trace, '');
      const tgz = join(work, 'alias with space.tgz');
      const result = run('/bin/bash', ['-e', '-o', 'pipefail', '-c', steps[at].run!], ROOT, {
        PATH: `${bin}:${process.env.PATH}`, TRACE: trace, VERSION: version, PACK_EXIT: packExit, ALIAS_TGZ: tgz, RUNNER_TEMP: work,
      });
      const calls = readFileSync(trace, 'utf8');
      expect(result.status, result.out).toBe(packExit === '0' ? 0 : 2);
      expect(calls).toContain('bun scripts/alias_tarball.ts pack --name rig-pose --out ');
      if (packExit === '0') expect(calls).toContain(`npm publish ${tgz} --provenance --access public${version.includes('-') ? ' --tag rc' : ''}\n`);
      else expect(calls).not.toContain('npm publish');
    }
  }
});
