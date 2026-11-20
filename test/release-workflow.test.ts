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
  with?: Record<string, string | number>;
  env?: Record<string, string>;
}
interface Workflow {
  jobs: Record<string, { steps: Step[]; strategy?: unknown; if?: string }>;
}

const text = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'release.yml'), 'utf8');
const workflow = (): Workflow => Bun.YAML.parse(text) as Workflow;
const commit = '1'.repeat(40);
const earlier = '2'.repeat(40);
const tagObject = '3'.repeat(40);
const mismatch = 'PROVENANCE_SHA_MISMATCH';
const unresolved = 'RELEASE_TAG_UNRESOLVED';
const pinned = '${{ needs.release.outputs.sha }}';

interface Scenario {
  name: string;
  event?: string;
  ref?: string;
  local?: string;
  ancestor?: string;
  packageVersion?: string;
  tag?: string;
  inputTag?: string;
  inputVersion?: string;
  dryRun?: boolean;
  sha?: string;
  resolved?: string;
  kind?: string;
  apiExit?: string;
  releaseExit?: string;
  served?: string;
  latest?: string;
  rule?: string;
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
  { name: 'invalid pushed tag', tag: '../heads/main', rule: 'RELEASE_TAG_FORM', apiReads: 0 },
  { name: 'prerelease tag refused', tag: 'v1.2.3-rc.1', rule: 'RELEASE_TAG_FORM', apiReads: 0 },
  { name: 'branch push refused', ref: 'refs/heads/main', rule: 'RELEASE_REF_NOT_TAG', apiReads: 0 },
  { name: 'matching tag dispatch', event: 'workflow_dispatch' },
  { name: 'annotated tag dispatch', event: 'workflow_dispatch', kind: 'tag' },
  { name: 'dispatch SHA mismatch', event: 'workflow_dispatch', sha: earlier, rule: mismatch },
  { name: 'dispatch ref mismatch', event: 'workflow_dispatch', ref: 'refs/heads/main', rule: 'RELEASE_REF_NOT_TAG', apiReads: 0 },
  { name: 'both dispatch inputs', event: 'workflow_dispatch', inputTag: 'bad', inputVersion: '1.2.3', rule: 'RELEASE_DISPATCH_INPUT', apiReads: 0 },
  { name: 'neither dispatch input', event: 'workflow_dispatch', inputTag: '', rule: 'RELEASE_DISPATCH_INPUT', apiReads: 0 },
  { name: 'invalid dispatch tag', event: 'workflow_dispatch', inputTag: 'main', rule: 'RELEASE_TAG_FORM', apiReads: 0 },
  { name: 'already served push', served: '1.2.3', rule: 'RELEASE_ALREADY_PUBLISHED' },
  { name: 'already served dispatch', event: 'workflow_dispatch', served: '1.2.3', rule: 'RELEASE_ALREADY_PUBLISHED' },
  { name: 'push below latest', latest: '1.2.4', rule: 'RELEASE_TAG_BELOW_LATEST' },
  { name: 'dispatch below latest', event: 'workflow_dispatch', latest: '1.2.4', rule: 'RELEASE_TAG_BELOW_LATEST' },
  { name: 'fetched tag mismatch', local: earlier, rule: mismatch },
  { name: 'off-main tag', ancestor: '1', rule: 'RELEASE_TAG_NOT_ON_MAIN' },
  { name: 'package version mismatch', packageVersion: '1.2.4', rule: 'RELEASE_TAG_VERSION_MISMATCH' },
  { name: 'dry_run tag dispatch on main skips real publish even when version is served', event: 'workflow_dispatch', dryRun: true, ref: 'refs/heads/main', sha: earlier, served: '1.2.3' },
  { name: 'dry_run tag dispatch on tag ref skips real publish', event: 'workflow_dispatch', dryRun: true, ref: 'refs/tags/v1.2.3', served: '1.2.3' },
  { name: 'dry_run main SHA dispatch skips real publish', event: 'workflow_dispatch', dryRun: true, ref: 'refs/heads/main', inputTag: commit, served: '1.2.3' },
  { name: 'dry_run PR branch dispatch targeting main SHA skips real publish', event: 'workflow_dispatch', dryRun: true, ref: 'refs/heads/jinni/504-release-dry-run', sha: earlier, inputTag: commit, served: '1.2.3' },
  { name: 'dry_run default main SHA dispatch skips real publish', event: 'workflow_dispatch', dryRun: true, ref: 'refs/heads/main', inputTag: '', served: '1.2.3' },
  { name: 'dry_run refuses version input', event: 'workflow_dispatch', dryRun: true, ref: 'refs/heads/main', inputVersion: '1.2.3', rule: 'RELEASE_DISPATCH_INPUT', apiReads: 0 },
  { name: 'dry_run refuses non-vX.Y.Z non-SHA tag', event: 'workflow_dispatch', dryRun: true, ref: 'refs/heads/main', inputTag: 'v1.2.3-rc.1', rule: 'RELEASE_TAG_FORM', apiReads: 0 },
  { name: 'dry_run refuses mismatched tag ref', event: 'workflow_dispatch', dryRun: true, ref: 'refs/tags/v0.0.1', rule: 'RELEASE_REF_NOT_TAG', apiReads: 0 },
  { name: 'dry_run refuses off-main SHA', event: 'workflow_dispatch', dryRun: true, ref: 'refs/heads/main', inputTag: commit, ancestor: '1', rule: 'RELEASE_TAG_NOT_ON_MAIN' },
];

// No inherited credentials or service executables: unrecognised calls fail closed.
const mocks: Record<string, string> = {
  gh: `printf 'gh %s\\n' "$*" >> "$MOCK_TRACE"
if [ "$1" = api ]; then
  case "$*" in
    "api repos/$REPO/commits/refs%2Ftags%2F$MOCK_TAG --jq .sha") printf '%s\\n' "$MOCK_COMMIT";;
    "api repos/$REPO/commits/$MOCK_COMMIT --jq .sha") printf '%s\\n' "$MOCK_COMMIT";;
    "api repos/$REPO/commits/tags%2F$MOCK_TAG --jq .sha")
      if [ "$MOCK_KIND" = tag ]; then echo 'HTTP 422: No commit found for short tag ref' >&2; exit 1; fi
      printf '%s\\n' "$MOCK_COMMIT";;
    "api repos/$REPO/git/ref/tags/$MOCK_TAG --jq .sha")
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
  git: `printf 'git %s\\n' "$*" >> "$MOCK_TRACE"
case "$1" in
  rev-parse) printf '%s\\n' "$MOCK_LOCAL";;
  merge-base) exit "$MOCK_ANCESTOR";;
  show) printf '{"name":"@rig-c/pose","version":"%s"}\\n' "$MOCK_PACKAGE_VERSION";;
  *) exit 97;;
esac
`,
  npm: `printf 'npm %s\\n' "$*" >> "$MOCK_TRACE"
if [ "$1" = publish ]; then exit 0; fi
if [ "$1" = pack ]; then mkdir -p "$5"; printf 'mock-tarball' > "$5/rig-c-pose-1.2.3.tgz"; echo rig-c-pose-1.2.3.tgz; exit 0; fi
[ "$1" = view ] && [ "$3" = version ] || exit 92
case "$2" in
  @rig-c/pose@*) [ -n "$MOCK_SERVED" ] || exit 1; printf '%s\\n' "$MOCK_SERVED";;
  @rig-c/pose) printf '%s\\n' "$MOCK_LATEST";;
  *) exit 96;;
esac
`,
  bun: `printf 'bun %s\\n' "$*" >> "$MOCK_TRACE"
mkdir -p "$6"
printf '%s/rig-pose-1.2.3.tgz\\n' "$6"
`,
};

function check(wf: Workflow, scenario: Scenario): void {
  const steps = wf.jobs.release.steps;
  const targetAt = steps.findIndex((step) => step.id === 'target');
  const target = steps[targetAt];
  const publishSteps = wf.jobs.publish.steps;
  const checkoutAt = publishSteps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
  const relayAt = publishSteps.findIndex((step) => step.id === 'target');
  const publishing = publishSteps.filter((step) => /\bnpm publish\b/.test(step.run ?? ''));
  const offlineStep = publishSteps.find((step) => step.name === 'Configure isolated offline npm for rehearsal');
  const summaryStep = publishSteps.find((step) => step.name === 'Write dry-run summary');
  const confirmStep = publishSteps.find((step) => step.name === 'Confirm the published package installs and runs');
  expect(targetAt).toBeGreaterThanOrEqual(0);
  expect(relayAt).toBeGreaterThan(checkoutAt);
  expect(publishSteps[checkoutAt].with?.ref).toBe(pinned);
  expect(target['continue-on-error']).toBeUndefined();
  expect(publishing).toHaveLength(3);
  expect(publishSteps.indexOf(publishing[0])).toBeGreaterThan(relayAt);
  expect(target.run).toBeString();
  expect(offlineStep?.run).toContain('npm config set offline true --location=user');
  expect(offlineStep?.env?.HOME).toBe('${{ runner.temp }}/pose-npm-dry-run');
  expect(publishing[2].env?.HOME).toBe(offlineStep?.env?.HOME);
  expect(publishSteps.indexOf(offlineStep!)).toBeLessThan(publishSteps.indexOf(publishing[2]));
  expect(summaryStep?.run).toBeString();
  expect(confirmStep?.run).toBeString();

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
    symlinkSync('/bin/mkdir', join(bin, 'mkdir'));
    symlinkSync(process.execPath, join(bin, 'node'));
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/tree-verdict.json'), readFileSync(join(import.meta.dir, '..', 'scripts/tree-verdict.json'), 'utf8'));
    const trace = join(dir, 'calls.txt');
    const outputFile = join(dir, 'outputs.txt');
    const publishOutputFile = join(dir, 'publish-outputs.txt');
    const summaryFile = join(dir, 'summary.md');
    writeFileSync(trace, '');
    writeFileSync(outputFile, '');
    writeFileSync(publishOutputFile, '');
    writeFileSync(summaryFile, '');
    const tag = scenario.tag ?? 'v1.2.3';
    const event = scenario.event ?? 'push';
    const sha = scenario.sha ?? commit;
    // The manually cut tag predates this step; refusals must retain it.
    const cut = join(dir, 'already-cut-tag.txt');
    const cutBytes = `${tag}\n${commit}\n`;
    writeFileSync(cut, cutBytes);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: tag.slice(1) }));
    const env = {
      PATH: bin, MOCK_TRACE: trace, MOCK_COMMIT: scenario.resolved ?? commit,
      MOCK_KIND: scenario.kind ?? 'commit', MOCK_OBJECT: tagObject, MOCK_API_EXIT: scenario.apiExit ?? '0',
      MOCK_RELEASE_EXIT: scenario.releaseExit ?? '0', MOCK_SERVED: scenario.served ?? '', MOCK_LATEST: scenario.latest ?? '1.2.2',
      EVENT: event, MOCK_TAG: tag, MOCK_LOCAL: scenario.local ?? commit,
      MOCK_ANCESTOR: scenario.ancestor ?? '0', MOCK_PACKAGE_VERSION: scenario.packageVersion ?? tag.slice(1),
      INPUT_TAG: scenario.inputTag ?? tag, INPUT_VERSION: scenario.inputVersion ?? '',
      INPUT_DRY_RUN: scenario.dryRun ? 'true' : '', RUNNER_TEMP: dir,
      REPO: 'mock/pose', GITHUB_SHA: sha, GITHUB_REF: scenario.ref ?? `refs/tags/${tag}`,
      GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile,
    };
    const run = (body: string, extraEnv: Record<string, string> = {}) => spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', body], {
      cwd: dir, encoding: 'utf8', timeout: 10000, env: { ...env, ...extraEnv },
    });
    const resolved = run(target.run ?? '');
    expect(resolved.error).toBeUndefined();
    const outputs = Object.fromEntries(readFileSync(outputFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('=')));
    const output = `${resolved.stdout}${resolved.stderr}`;
    expect(resolved.status, output).toBe(scenario.rule === undefined ? 0 : 1);
    if (scenario.rule !== undefined) {
      expect(output).toContain(`::error::${scenario.rule}:`);
      expect(outputs).toEqual({});
      if (scenario.rule === mismatch && scenario.local === undefined) {
        expect(output).toContain(sha);
        expect(output).toContain(commit);
        expect(output).toContain('the tag remains cut');
        expect(output).toContain(`gh workflow run release.yml --ref ${tag} -f tag=${tag}`);
      }
    } else if (scenario.dryRun) {
      expect(outputs).toEqual({ publish: 'true', dry_run: 'true', tag, sha: commit });
    } else {
      expect(outputs).toEqual({ publish: 'true', tag, sha: commit });
    }
    // Follow the workflow's condition, executing its publish job steps against npm's mock.
    if (resolved.status === 0 && outputs.publish === 'true') {
      const relayed = run(publishSteps[relayAt].run ?? '', {
        DRY_RUN: outputs.dry_run ?? '', GITHUB_OUTPUT: publishOutputFile,
      });
      expect(relayed.error).toBeUndefined();
      expect(relayed.status).toBe(0);
      const publishOutputs = Object.fromEntries(
        readFileSync(publishOutputFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('=')),
      );
      const stepRuns = (step: Step | undefined): boolean => {
        if (!step) return false;
        if (step.if === undefined) return true;
        if (step.if === "${{ steps.target.outputs.dry_run != 'true' }}") return publishOutputs.dry_run !== 'true';
        if (step.if === "${{ steps.target.outputs.dry_run == 'true' }}") return publishOutputs.dry_run === 'true';
        throw new Error(`unsupported publish step condition: ${step.if}`);
      };
      if (scenario.dryRun) {
        expect(stepRuns(confirmStep)).toBe(false);
        expect(stepRuns(offlineStep)).toBe(true);
        expect(stepRuns(summaryStep)).toBe(true);
        for (const step of publishing.filter(stepRuns)) {
          const published = run(step.run ?? '');
          expect(published.error).toBeUndefined();
          expect(published.status, `${published.stdout}${published.stderr}`).toBe(0);
        }
        const summarized = run(summaryStep?.run ?? '', {
          TAG_NAME: outputs.tag, TARGET_SHA: outputs.sha, TREE_VERDICT_PATH: '',
        });
        expect(summarized.status, `${summarized.stdout}${summarized.stderr}`).toBe(0);
        const summary = readFileSync(summaryFile, 'utf8');
        expect(summary).toContain('Release dry run (`dry_run=true`)');
        expect(summary).toContain('TREE_VERDICT_LIFECYCLE_FALLBACK: gate=pose-full/1');
        expect(summary).toMatch(/sha512-[A-Za-z0-9+/=]+/);
        const proofFile = join(dir, 'verified.json');
        writeFileSync(proofFile, JSON.stringify({ schema: 'tree-verdict-verified/2', run_id: 800, tested_sha: commit }));
        const reusedSummary = run(summaryStep?.run ?? '', {
          TAG_NAME: outputs.tag, TARGET_SHA: outputs.sha, TREE_VERDICT_PATH: proofFile,
        });
        expect(reusedSummary.status, `${reusedSummary.stdout}${reusedSummary.stderr}`).toBe(0);
        expect(readFileSync(summaryFile, 'utf8')).toContain(`TREE_VERDICT_LIFECYCLE_REUSED: run=800 testedSHA=${commit} gate=pose-full/1`);
      } else {
        expect(publishing.filter(stepRuns)).toEqual([publishing[0], publishing[1]]);
        expect(stepRuns(confirmStep)).toBe(true);
        expect(stepRuns(offlineStep)).toBe(false);
        expect(stepRuns(summaryStep)).toBe(false);
        const published = run(publishing[0].run ?? '');
        expect(published.error).toBeUndefined();
        expect(published.status, `${published.stdout}${published.stderr}`).toBe(0);
      }
    }
    const calls = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean);
    const api = calls.filter((line) => line.startsWith('gh api '));
    expect(api).toHaveLength(scenario.apiReads ?? 1);
    if (event === 'push') {
      expect(api.every((line) => line === `gh api repos/mock/pose/commits/refs%2Ftags%2F${tag} --jq .sha`)).toBe(true);

    }
    const publishes = calls.filter((line) => line.startsWith('npm publish '));
    expect(publishes).toEqual(scenario.rule === undefined
      ? [scenario.dryRun ? 'npm publish rig-c-pose-1.2.3.tgz --dry-run --access public' : 'npm publish --provenance --access public'] : []);
    expect(readFileSync(cut, 'utf8')).toBe(cutBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('release push provenance (#354)', () => {
  for (const scenario of scenarios) test(scenario.name, () => check(workflow(), scenario), 15000);

  // Mutants are parsed copies only; the checked-in workflow is never modified.
  const dryRunScenario = scenarios.find((s) => s.dryRun && s.rule === undefined)!;
  const plants = [
    { name: 'comparison reversed', from: '"$GITHUB_SHA" != "$tag_sha"', to: '"$GITHUB_SHA" = "$tag_sha"', scenario: scenarios[0] },
    { name: 'lookup failure ignored', from: 'if ! tag_sha=', to: 'if tag_sha=', scenario: scenarios[4] },
    { name: 'short SHA accepted', from: '^[0-9a-f]{40}$', to: '^[0-9a-f]{7,40}$', scenario: { name: 'short SHA', sha: commit.slice(0, 7), resolved: commit.slice(0, 7), rule: unresolved } },
    { name: 'annotated short ref fails', from: 'commits/refs%2Ftags%2F$release_tag', to: 'commits/tags%2F$release_tag', scenario: scenarios[1] },
    { name: 'refs API returns annotated object', from: 'commits/refs%2Ftags%2F$release_tag', to: 'git/ref/tags/$release_tag', scenario: scenarios[1] },
    { name: 'publish emitted before refusal', from: 'if [ "$GITHUB_SHA" != "$tag_sha" ]; then', to: 'echo "publish=true" >> "$GITHUB_OUTPUT"; if [ "$GITHUB_SHA" != "$tag_sha" ]; then', scenario: scenarios[2] },
    { name: 'checkout resolves mutable tag again', from: pinned, to: '${{ steps.target.outputs.tag }}', scenario: scenarios[0] },
    { name: 'recovery loses tag ref', from: 'release.yml --ref $release_tag -f tag=$release_tag', to: 'release.yml -f tag=$release_tag', scenario: scenarios[2] },
    {
      name: 'canonical publish lacks dry_run guard',
      from: "      - name: Publish to npm\n        if: ${{ steps.target.outputs.dry_run != 'true' }}",
      to: '      - name: Publish to npm',
      scenario: dryRunScenario,
    },
    {
      name: 'alias publish lacks dry_run guard',
      from: "      - name: Publish the alias rig-pose\n        if: ${{ steps.target.outputs.dry_run != 'true' }}",
      to: '      - name: Publish the alias rig-pose',
      scenario: dryRunScenario,
    },
    {
      name: 'confirm step lacks dry_run guard',
      from: "      - name: Confirm the published package installs and runs\n        if: ${{ steps.target.outputs.dry_run != 'true' }}",
      to: '      - name: Confirm the published package installs and runs',
      scenario: dryRunScenario,
    },
  ];
  for (const plant of plants) {
    test(`catches mutant: ${plant.name}`, () => {
      expect(text.split(plant.from)).toHaveLength(2);
      const changed = Bun.YAML.parse(text.replace(plant.from, plant.to)) as Workflow;
      expect(() => check(changed, plant.scenario)).toThrow();
    }, 15000);
  }
});

test('tag-only publication keeps trusted-publisher identity and confirmation isolation', () => {
  const wf = Bun.YAML.parse(text) as {
    on: { push: { tags: string[]; branches?: string[] }; workflow_dispatch: { inputs: Record<string, { required: boolean; type?: string; default?: unknown }> } };
    permissions: Record<string, string>;
    jobs: Record<string, { permissions: Record<string, string>; environment?: string; if?: string; 'runs-on': string }>;
  };
  expect(wf.on.push).toEqual({ tags: ['v*'] });
  expect(wf.on.workflow_dispatch.inputs.tag.required).toBe(false);
  expect(wf.on.workflow_dispatch.inputs.version.required).toBe(false);
  expect(wf.on.workflow_dispatch.inputs.dry_run).toMatchObject({ required: false, default: false, type: 'boolean' });
  expect(wf.permissions).toEqual({});
  for (const [name, job] of Object.entries(wf.jobs)) {
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.environment).toBeUndefined();
    expect(job.permissions.contents).toBe('read');
    if (name === 'publish') {
      expect(job.permissions).toEqual({
        contents: 'read', actions: 'read', 'pull-requests': 'read', 'id-token': 'write',
      });
    } else {
      expect(job.permissions.actions).toBeUndefined();
      expect(job.permissions['pull-requests']).toBeUndefined();
      expect(job.permissions['id-token']).toBeUndefined();
    }
    for (const [permission, access] of Object.entries(job.permissions)) {
      if (access === 'write') expect([name, permission]).toEqual(['publish', 'id-token']);
    }
    expect(job.permissions.issues).toBeUndefined();
  }
  expect(wf.jobs.publish.if).toBe("${{ needs.release.outputs.publish == 'true' }}");
  expect(wf.jobs.confirm.if).toBe("${{ github.event_name == 'workflow_dispatch' && !inputs.dry_run && inputs.version != '' && inputs.tag == '' }}");
  expect(text).toContain('npm install -g npm@12.2.2');
});

test('PR CI exercises the source lifecycle and both release pack paths on publishing npm', () => {
  const ci = readFileSync(join(import.meta.dir, '..', '.github/workflows/ci.yml'), 'utf8');
  const wf = Bun.YAML.parse(ci) as Workflow;
  const steps = wf.jobs.ships.steps;
  const node = steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
  expect(node?.with?.['node-version']).toEqual(22);
  expect(node?.with?.['registry-url']).toBe('https://registry.npmjs.org');
  const commands = steps.map((s) => s.run ?? '').join('\n');
  expect(commands).toContain('npm install -g npm@12.2.2');
  expect(commands).toContain('bun install --frozen-lockfile');
  const original = ['bun run typecheck', 'bun run lint', 'bun run test'];
  const suiteInvocation = /\bbun\s+run\s+(?:typecheck|lint|test)\b/g;
  expect(Array.from(commands.match(suiteInvocation) ?? [])).toEqual(original);
  expect(steps.filter((step) => /\bbun\s+run\s+(?:typecheck|lint|test)\b/.test(step.run ?? '')).map((step) => step.run)).toEqual(original);
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  expect(manifest.scripts.prepublishOnly).toBe('node scripts/tree-verdict-prepublish.cjs');
  const declaration = JSON.parse(readFileSync(join(import.meta.dir, '..', 'scripts/tree-verdict.json'), 'utf8')) as { chain: string; commands: string[] };
  expect(declaration.chain).toBe('bun run typecheck && bun run lint && bun run test');
  expect(declaration.commands).toEqual(original);

  // The consumer controls belong to the unsharded PR checks, not a test shard.
  expect(wf.jobs.checks.strategy).toBeUndefined();
  expect(wf.jobs.checks.if).toBe("needs.tree-verdict.outputs.reused != 'true'");
  const controls = wf.jobs.checks.steps.filter((step) => step.run === 'bun test scripts/tree-verdict.test.mjs');
  expect(controls).toHaveLength(1);
  expect(controls[0].if).toBeUndefined();
  expect(controls[0]['continue-on-error']).toBeUndefined();
  expect(controls[0].env?.TREE_VERDICT_TOOLS).toBe('${{ steps.verdict-tools.outputs.tooling-path }}');
  const toolingAt = wf.jobs.checks.steps.findIndex((step) => step.id === 'verdict-tools');
  expect(toolingAt).toBeGreaterThanOrEqual(0);
  expect(wf.jobs.checks.steps[toolingAt].uses).toBe('rig-c/core/.github/actions/tree-verdict@149bca5fc828c60416283de0a1aa570ed33f385f');
  expect(toolingAt).toBeLessThan(wf.jobs.checks.steps.indexOf(controls[0]));
  expect(commands).toContain('npm pack --dry-run --json');
  expect(commands).toContain('bun scripts/alias_tarball.ts pack --name rig-pose');
  expect(commands).toContain('npm pack "$alias_tgz" --dry-run --json');
  expect(commands).not.toContain('npm publish');
});
