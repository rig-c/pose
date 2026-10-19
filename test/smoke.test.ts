/**
 * rig-c/pose#260: the install smoke holds the wave to the bytes the tests pin. The smoke itself
 * needs the registry (it installs rig-c), so it runs in CI's `install` job and after a publish, not
 * here; what this file holds is that the two copies of the pinned figure cannot drift apart, and that
 * the registry confirmation runs the smoke rather than stopping at --version.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('the smoke pins the wave to the hash test/retarget.test.ts holds', () => {
  const smoke = /^WAVE_SHA256=([0-9a-f]{64})$/m.exec(read('scripts/smoke_install.sh'));
  expect(smoke).not.toBeNull();
  // The public example's motion with no flags, as the retarget suite pins it.
  const pinned = /\[\[\], '([0-9a-f]{64})'\]/.exec(read('test/retarget.test.ts'));
  expect(pinned).not.toBeNull();
  expect(smoke![1]).toBe(pinned![1]!);
});

test('the registry confirmation and CI both run the smoke', () => {
  expect(read('scripts/confirm_registry.sh')).toContain('exec bash "$(dirname "$0")/smoke_install.sh" "@rig-c/pose@$version" "$version"');
  expect(read('.github/workflows/ci.yml')).toContain('bash scripts/smoke_mutants.sh "$d"/*.tgz');
});
