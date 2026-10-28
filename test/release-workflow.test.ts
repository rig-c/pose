/** Execute release.yml's own resolver and publish body with closed service mocks (#354). */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean | string;
  with?: Record<string, string>;
}
interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

const text = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'release.yml'), 'utf8');
const workflow = (): Workflow => Bun.YAML.parse(text) as Workflow;
const commit = '1'.repeat(40);
const earlier = '2'.repeat(40);
const tagObject = '3'.repeat(40);
const mismatch = 'PROVENANCE_SHA_MISMATCH';
const unresolved = 'RELEASE_TAG_UNRESOLVED';
const publishIf = "${{ steps.target.outputs.publish == 'true' }}";
const pinned = '${{ steps.target.outputs.sha || steps.target.outputs.tag }}';

interface Scenario {
  name: string;
  event?: string;
  created?: string;
  tag?: string;
  inputTag?: string;
  inputVersion?: string;
  sha?: string;
  resolved?: string;
  kind?: string;
  apiExit?: string;
  releaseExit?: string;
  served?: string;
  latest?: string;
  rule?: string;
  noRelease?: boolean;
  apiReads?: number;
}

const scenarios: Scenario[] = [
  { name: 'normal lightweight push publishes from the verified SHA' },
  { name: 'annotated push uses the full commits ref and peels its object', kind: 'tag' },
  { name: 'rerun refuses the earlier GITHUB_SHA and retains the cut tag', sha: earlier, rule: mismatch },
  { name: 'annotated object SHA is not its commit', kind: 'tag', sha: tagObject, rule: mismatch },
  { name: 'lookup failure refuses even a plausible SHA', apiExit: '1', rule: unresolved },
  ...['', 'null', commit.slice(0, 7), 'g'.repeat(40), `${commit}\n${earlier}`, `{"sha":"${commit}"}`].map((resolved) => ({
    name: `invalid resolved SHA ${JSON.stringify(resolved)}`, resolved, rule: unresolved,
  })),
  { name: 'invalid cut tag is refused before lookup', tag: '../heads/main', rule: unresolved, apiReads: 0 },
  { name: 'prerelease push retains the rc publish tag', tag: 'v1.2.3-rc.1' },
  ...['false', ''].map((created) => ({ name: `no release ${JSON.stringify(created)} skips lookup and publish`, created, tag: '', noRelease: true, apiReads: 0 })),
  { name: 'matching tag dispatch keeps its existing resolution', event: 'workflow_dispatch' },
  { name: 'annotated tag dispatch keeps its existing object resolution', event: 'workflow_dispatch', kind: 'tag', apiReads: 2 },
  { name: 'mismatching tag dispatch is still refused', event: 'workflow_dispatch', sha: earlier, rule: 'RELEASE_REF_NOT_TAG' },
  { name: 'both dispatch inputs are refused first', event: 'workflow_dispatch', inputTag: 'bad', inputVersion: '1.2.3', rule: 'RELEASE_DISPATCH_INPUT', apiReads: 0 },
  { name: 'neither dispatch input is refused', event: 'workflow_dispatch', inputTag: '', rule: 'RELEASE_DISPATCH_INPUT', apiReads: 0 },
  { name: 'invalid dispatch tag is refused', event: 'workflow_dispatch', inputTag: 'main', rule: 'RELEASE_TAG_FORM', apiReads: 0 },
  { name: 'unreleased dispatch tag is refused', event: 'workflow_dispatch', releaseExit: '1', rule: 'RELEASE_TAG_UNRELEASED', apiReads: 0 },
  { name: 'already published dispatch tag is refused', event: 'workflow_dispatch', served: '1.2.3', rule: 'RELEASE_ALREADY_PUBLISHED' },
  { name: 'dispatch below latest is refused', event: 'workflow_dispatch', latest: '1.2.4', rule: 'RELEASE_TAG_BELOW_LATEST' },
];

// No inherited credentials or service executables: unrecognised calls fail closed.
const mocks: Record<string, string> = {
  gh: `printf 'gh %s\\n' "$*" >> "$MOCK_TRACE"
if [ "$1" = api ]; then
  case "$*" in
    "api repos/$REPO/commits/refs%2Ftags%2F$CUT_TAG --jq .sha") printf '%s\\n' "$MOCK_COMMIT";;
    "api repos/$REPO/commits/tags%2F$CUT_TAG --jq .sha")
      if [ "$MOCK_KIND" = tag ]; then echo 'HTTP 422: No commit found for short tag ref' >&2; exit 1; fi
      printf '%s\\n' "$MOCK_COMMIT";;
    "api repos/$REPO/git/ref/tags/$CUT_TAG --jq .sha")
      if [ "$MOCK_KIND" = tag ]; then printf '%s\\n' "$MOCK_OBJECT"; else printf '%s\\n' "$MOCK_COMMIT"; fi;;
    "api repos/$REPO/git/ref/tags/$INPUT_TAG --jq .object.type + \\" \\" + .object.sha")
      if [ "$MOCK_KIND" = tag ]; then printf 'tag %s\\n' "$MOCK_OBJECT"; else printf 'commit %s\\n' "$MOCK_COMMIT"; fi;;
    "api repos/$REPO/git/tags/$MOCK_OBJECT --jq .object.sha") printf '%s\\n' "$MOCK_COMMIT";;
    *) exit 94;;
  esac
  exit "$MOCK_API_EXIT"
fi
[ "$*" = "release view $INPUT_TAG --repo $REPO" ] || exit 95
exit "$MOCK_RELEASE_EXIT"
`,
  npm: `printf 'npm %s\\n' "$*" >> "$MOCK_TRACE"
if [ "$1" = publish ]; then exit 0; fi
[ "$1" = view ] && [ "$3" = version ] || exit 92
case "$2" in
  @rig-c/pose@*) [ -n "$MOCK_SERVED" ] || exit 1; printf '%s\\n' "$MOCK_SERVED";;
  @rig-c/pose) printf '%s\\n' "$MOCK_LATEST";;
  *) exit 96;;
esac
`,
};

function check(wf: Workflow, scenario: Scenario): void {
  const steps = wf.jobs.release.steps;
  const targetAt = steps.findIndex((step) => step.id === 'target');
  const target = steps[targetAt];
  const checkoutAt = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
  const publishing = steps.filter((step) => /\bnpm publish\b/.test(step.run ?? ''));
  expect(targetAt).toBeGreaterThanOrEqual(0);
  expect(checkoutAt).toBeGreaterThan(targetAt);
  expect(steps[checkoutAt].if).toBe(publishIf);
  expect(steps[checkoutAt].with?.ref).toBe(pinned);
  expect(target['continue-on-error']).toBeUndefined();
  expect(publishing).toHaveLength(2);
  expect(publishing[0].if).toBe(publishIf);
  expect(steps.indexOf(publishing[0])).toBeGreaterThan(checkoutAt);
  expect(target.run).toBeString();

  const dir = mkdtempSync(join(tmpdir(), 'pose-release-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const [name, body] of Object.entries(mocks)) {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}`);
      chmodSync(path, 0o755);
    }
    symlinkSync('/usr/bin/grep', join(bin, 'grep'));
    symlinkSync(process.execPath, join(bin, 'node'));
    const trace = join(dir, 'calls.txt');
    const outputFile = join(dir, 'outputs.txt');
    writeFileSync(trace, '');
    writeFileSync(outputFile, '');
    const tag = scenario.tag ?? 'v1.2.3';
    const event = scenario.event ?? 'push';
    const sha = scenario.sha ?? commit;
    // release-please's cut predates this step; refusal must not remove it.
    const cut = join(dir, 'already-cut-tag.txt');
    const cutBytes = `${tag}\n${commit}\n`;
    writeFileSync(cut, cutBytes);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: tag.slice(1) }));
    const env = {
      PATH: bin, MOCK_TRACE: trace, MOCK_COMMIT: scenario.resolved ?? commit,
      MOCK_KIND: scenario.kind ?? 'commit', MOCK_OBJECT: tagObject, MOCK_API_EXIT: scenario.apiExit ?? '0',
      MOCK_RELEASE_EXIT: scenario.releaseExit ?? '0', MOCK_SERVED: scenario.served ?? '', MOCK_LATEST: scenario.latest ?? '1.2.2',
      EVENT: event, CREATED: scenario.created ?? 'true', CUT_TAG: tag,
      INPUT_TAG: scenario.inputTag ?? tag, INPUT_VERSION: scenario.inputVersion ?? '',
      REPO: 'mock/pose', GITHUB_SHA: sha, GITHUB_REF: event === 'push' ? 'refs/heads/main' : `refs/tags/${tag}`,
      GITHUB_OUTPUT: outputFile,
    };
    const run = (body: string) => spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', body], {
      cwd: dir, encoding: 'utf8', timeout: 5000, env,
    });
    const resolved = run(target.run ?? '');
    expect(resolved.error).toBeUndefined();
    const outputs = Object.fromEntries(readFileSync(outputFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('=')));
    const output = `${resolved.stdout}${resolved.stderr}`;
    expect(resolved.status, output).toBe(scenario.rule === undefined ? 0 : 1);
    if (scenario.rule !== undefined) {
      expect(output).toContain(`::error::${scenario.rule}:`);
      expect(outputs).toEqual({});
      if (scenario.rule === mismatch) {
        expect(output).toContain(sha);
        expect(output).toContain(commit);
        expect(output).toContain('the tag remains cut');
        expect(output).toContain(`gh workflow run release.yml --ref ${tag} -f tag=${tag}`);
      }
    } else if (scenario.noRelease) {
      expect(outputs).toEqual({ publish: 'false' });
    } else {
      expect(outputs).toEqual(event === 'push' ? { publish: 'true', tag, sha: commit } : { publish: 'true', tag });
    }
    // Follow the workflow's condition, executing its real publish body against npm's mock.
    if (resolved.status === 0 && outputs.publish === 'true') {
      const published = run(publishing[0].run ?? '');
      expect(published.error).toBeUndefined();
      expect(published.status, `${published.stdout}${published.stderr}`).toBe(0);
    }
    const calls = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean);
    const api = calls.filter((line) => line.startsWith('gh api '));
    expect(api).toHaveLength(scenario.apiReads ?? 1);
    if (event === 'push') {
      expect(api.every((line) => line === `gh api repos/mock/pose/commits/refs%2Ftags%2F${tag} --jq .sha`)).toBe(true);
      expect(calls.every((line) => line.startsWith('gh api ') || line.startsWith('npm publish '))).toBe(true);
    }
    const publishes = calls.filter((line) => line.startsWith('npm publish '));
    expect(publishes).toEqual(scenario.rule === undefined && !scenario.noRelease
      ? [`npm publish --provenance --access public${tag.includes('-') ? ' --tag rc' : ''}`] : []);
    expect(readFileSync(cut, 'utf8')).toBe(cutBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('release push provenance (#354)', () => {
  for (const scenario of scenarios) test(scenario.name, () => check(workflow(), scenario));

  // Mutants are parsed copies only; the checked-in workflow is never modified.
  const plants = [
    { name: 'comparison reversed', from: '"$GITHUB_SHA" != "$tag_sha"', to: '"$GITHUB_SHA" = "$tag_sha"', scenario: scenarios[0] },
    { name: 'lookup failure ignored', from: 'if ! tag_sha=', to: 'if tag_sha=', scenario: scenarios[4] },
    { name: 'short SHA accepted', from: '^[0-9a-f]{40}$', to: '^[0-9a-f]{7,40}$', scenario: { name: 'short SHA', sha: commit.slice(0, 7), resolved: commit.slice(0, 7), rule: unresolved } },
    { name: 'annotated short ref fails', from: 'commits/refs%2Ftags%2F$CUT_TAG', to: 'commits/tags%2F$CUT_TAG', scenario: scenarios[1] },
    { name: 'refs API returns annotated object', from: 'commits/refs%2Ftags%2F$CUT_TAG', to: 'git/ref/tags/$CUT_TAG', scenario: scenarios[1] },
    { name: 'publish emitted before refusal', from: 'if [ "$GITHUB_SHA" != "$tag_sha" ]; then', to: 'echo "publish=true" >> "$GITHUB_OUTPUT"; if [ "$GITHUB_SHA" != "$tag_sha" ]; then', scenario: scenarios[2] },
    { name: 'checkout resolves mutable tag again', from: pinned, to: '${{ steps.target.outputs.tag }}', scenario: scenarios[0] },
    { name: 'recovery loses tag ref', from: 'release.yml --ref $CUT_TAG -f tag=$CUT_TAG', to: 'release.yml -f tag=$CUT_TAG', scenario: scenarios[2] },
  ];
  for (const plant of plants) {
    test(`catches mutant: ${plant.name}`, () => {
      expect(text.split(plant.from)).toHaveLength(2);
      const changed = Bun.YAML.parse(text.replace(plant.from, plant.to)) as Workflow;
      expect(() => check(changed, plant.scenario)).toThrow();
    });
  }
});
