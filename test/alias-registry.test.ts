/** Run the real confirmation scripts against a closed registry and executable. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
function confirm(overrides: Record<string, string> = {}): { status: number | null; out: string; trace: string } {
  const work = mkdtempSync(join(tmpdir(), 'pose-alias-registry-'));
  try {
    const scripts = join(work, 'scripts');
    const bin = join(work, 'bin');
    const temp = join(work, 'tmp');
    for (const dir of [scripts, bin, temp]) mkdirSync(dir);
    for (const file of ['confirm_registry.sh', 'smoke_alias.sh']) copyFileSync(join(ROOT, 'scripts', file), join(scripts, file));
    writeFileSync(join(scripts, 'smoke_install.sh'), 'printf "scoped smoke %s\\n" "$*" >> "$TRACE"; exit "$SCOPED_EXIT"\n');
    const npm = join(bin, 'npm');
    writeFileSync(npm, `#!/bin/bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$TRACE"
case "$1" in
  view)
    case "$2" in
      @rig-c/pose@1.2.3) exit 0;;
      rig-pose@1.2.3) exit "$ALIAS_VIEW_EXIT";;
      *) exit 94;;
    esac;;
  init)
    test -z "$(ls -A)" || exit 93
    printf '{}\\n' > package.json;;
  install)
    [ "$2" = rig-pose@1.2.3 ] || exit 92
    [ "$INSTALL_EXIT" = 0 ] || exit "$INSTALL_EXIT"
    mkdir -p node_modules/rig-pose node_modules/.bin
    printf '{"name":"%s","version":"%s"}\\n' "$PACKAGE_NAME" "$PACKAGE_VERSION" > node_modules/rig-pose/package.json
    cat > node_modules/.bin/rig-pose <<'CLI'
#!/bin/bash
printf 'cli %s\\n' "$*" >> "$TRACE"
case "$1" in
  --version) printf '%s\\n' "$CLI_VERSION";;
  --help) printf '%s\\n' "$HELP_TEXT"; exit "$HELP_EXIT";;
  *) exit 91;;
esac
CLI
    chmod +x node_modules/.bin/rig-pose;;
  *) exit 90;;
esac
`);
    chmodSync(npm, 0o755);
    const trace = join(work, 'trace');
    writeFileSync(trace, '');
    const result = spawnSync('bash', [join(scripts, 'confirm_registry.sh'), '1.2.3', '0'], {
      cwd: work, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temp, TRACE: trace,
        SCOPED_EXIT: '0', ALIAS_VIEW_EXIT: '0', INSTALL_EXIT: '0', PACKAGE_NAME: 'rig-pose', PACKAGE_VERSION: '1.2.3',
        CLI_VERSION: '1.2.3', HELP_TEXT: 'rig-pose usage', HELP_EXIT: '0', ...overrides },
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}`, trace: readFileSync(trace, 'utf8') };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('confirmation runs the scoped smoke then the alias install in an empty directory and help', () => {
  const r = confirm();
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain('ALIAS ok: rig-pose@1.2.3 installs into an empty directory');
  expect(r.trace.trim().split('\n')).toEqual([
    'npm view @rig-c/pose@1.2.3 version', 'scoped smoke @rig-c/pose@1.2.3 1.2.3',
    'npm view rig-pose@1.2.3 version', 'npm init -y', 'npm install rig-pose@1.2.3', 'cli --version', 'cli --help',
  ]);
});

test('scoped smoke failure remains fatal and never reaches alias confirmation', () => {
  const r = confirm({ SCOPED_EXIT: '1' });
  expect(r.status).toBe(1);
  expect(r.trace).not.toContain('npm view rig-pose');
});

test('an alias not served inside the wait exits 3 without installing it', () => {
  const r = confirm({ ALIAS_VIEW_EXIT: '1' });
  expect(r.status).toBe(3);
  expect(r.out).toContain('rig-pose@1.2.3 within 0 minute(s): confirmation NOT taken');
  expect(r.trace).not.toContain('npm install');
});

const defects: Record<string, Record<string, string>> = {
  install: { INSTALL_EXIT: '1' }, name: { PACKAGE_NAME: '@rig-c/pose' },
  version: { PACKAGE_VERSION: '1.2.4' }, executableVersion: { CLI_VERSION: '1.2.4' },
  helpExit: { HELP_EXIT: '1' }, helpText: { HELP_TEXT: '' },
};
for (const [kind, overrides] of Object.entries(defects)) {
  test(`alias ${kind} defect cannot be confirmed`, () => {
    const r = confirm(overrides);
    expect(r.status, r.out).toBe(1);
    expect(r.out).not.toContain('ALIAS ok');
  });
}
