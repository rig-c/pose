/** Consumer coverage and lifecycle plants. No network, Git command, or publish. */
import { test, expect, mock } from 'bun:test';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync as spawn } from 'node:child_process';

// Optional private command receipt; never writes into the source checkout.
function spawnSync(command, args, options) {
  const result = spawn(command, args, options);
  if (process.env.TREE_VERDICT_COMMAND_LOG && result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    appendFileSync(process.env.TREE_VERDICT_COMMAND_LOG, JSON.stringify({
      utc: new Date().toISOString(), command: [command, ...args], exit: result.status,
      first_error: output.split('\n').find(line => /^(error:|[A-Z][A-Z0-9_]+:|Traceback)/.test(line)) ?? output.split('\n').find(Boolean) ?? 'nonzero exit with no output',
      expected: true,
    }) + '\n');
  }
  return result;
}
const tools = process.env.TREE_VERDICT_TOOLS;
if (!tools) throw new Error('TREE_VERDICT_TOOLS must name the workflow action pin');
const root = resolve(import.meta.dir, '..');
const load = name => import(pathToFileURL(join(tools, name)).href);
const { compileCoverage } = await load('planner.mjs');
const { lookup } = await load('lookup.mjs');
const { publishEnvelope, readPublishVerdict } = await load('publish.mjs');
const read = path => readFileSync(join(root, path), 'utf8');
const declaration = JSON.parse(read('scripts/tree-verdict.json'));
const plan = compileCoverage(declaration, read);
const ci = Bun.YAML.parse(read('.github/workflows/ci.yml'));
const release = Bun.YAML.parse(read('.github/workflows/release.yml'));
const lintConfig = JSON.parse(read('scripts/tree-verdict-workflows.json'));
const pin = 'rig-c/core/.github/actions/tree-verdict@149bca5fc828c60416283de0a1aa570ed33f385f';
const chain = 'bun run typecheck && bun run lint && bun run test';
const sha = c => c.repeat(40);
// Git's actual blob/tree object encoding; no checkout or Git executable needed.
function tree(byte) {
  const object = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest();
  return object('tree', Buffer.concat([Buffer.from('100644 probe\0'), object('blob', Buffer.from(byte))])).toString('hex');
}
function fixture(purpose = 'ci') {
  const c = { repository: 'rig-c/pose', sha: sha('a'), runId: 900, event: 'push', ref: purpose === 'publish' ? 'refs/tags/v1.2.3' : 'refs/heads/main', defaultBranch: 'main', workflow: declaration.workflow, gate: plan.gate, coverage: plan.coverage };
  const repo = { id: 1, full_name: c.repository };
  const run = { id: 800, run_number: 8, run_attempt: 1, workflow_id: 10, path: c.workflow, head_sha: sha('b'), status: 'completed', conclusion: 'success', event: 'pull_request', head_branch: 'feature', repository: repo, head_repository: repo,
    pull_requests: [{ number: 7, head: { sha: sha('b'), repo }, base: { repo } }] };
  const pr = { number: 7, state: 'closed', merged: true, merge_commit_sha: c.sha, head: { sha: sha('b'), repo }, base: { ref: 'main', repo } };
  const jobRows = Object.entries(plan.coverage.jobs).flatMap(([group, job]) => job.legs.map(leg => ({ name: leg.apiName, matrix: leg.matrix, group, run_id: 800, run_attempt: 1, head_sha: sha('b'), status: 'completed', conclusion: 'success' }))).map((row, index) => ({ ...row, id: 100 + index }));
  const receipt = { schema: 'tree-verdict/2', gate: plan.gate, verdict: 'success', repository: c.repository, workflow_path: c.workflow, workflow_id: 10, run_id: 800, run_attempt: 1, head_sha: sha('b'), tested_sha: sha('c'), tree: tree('a'), event: 'pull_request', pr: 7,
    jobs: structuredClone(jobRows), collector: { ...plan, jobId: 200 } };
  jobRows.push({ id: 200, name: plan.collectorName, run_id: 800, run_attempt: 1, head_sha: sha('b'), status: 'completed', conclusion: 'success' });
  const commits = new Map([c.sha, sha('b'), sha('c')].map(hash => [hash, { sha: hash, tree: { sha: tree('a') }, parents: [{ sha: sha('d') }] }]));
  const state = { c, run, pr, receipt, jobRows, commits, calls: [] };
  state.api = async path => {
    state.calls.push(path);
    if (state.apiError) throw new Error('planted API failure');
    if (path.includes('/compare/')) return { status: 'identical' };
    if (path.includes('/git/commits/')) return structuredClone(commits.get(path.split('/').at(-1)));
    if (path.endsWith('/actions/workflows/ci.yml')) return { id: 10, path: c.workflow, state: 'active' };
    if (path.includes(`/commits/${c.sha}/pulls?`)) return [{ number: 7 }];
    if (path.endsWith('/pulls/7')) return structuredClone(pr);
    if (path.includes('/runs?head_sha=')) {
      const rows = state.noRun || path.includes(`head_sha=${c.sha}`) ? [] : [run];
      return structuredClone({ total_count: rows.length, workflow_runs: rows });
    }
    if (path.includes('/attempts/') && path.includes('/jobs?')) return structuredClone({ total_count: jobRows.length, jobs: jobRows });
    if (path.endsWith('/actions/runs/800')) return structuredClone(run);
    if (path.includes('/git/trees/')) return { sha: path.split('/').at(-1).split('?')[0], truncated: false, tree: [] };
    throw new Error(`unexpected fixture route: ${path}`);
  };
  state.readReceipt = async () => structuredClone(state.receipt);
  return state;
}
function scratch(body) {
  const dir = mkdtempSync(join(tmpdir(), 'pose-tree-verdict-'));
  return Promise.resolve().then(() => body(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}
function fixturePackage(dir, fail = '') {
  const trace = join(dir, 'commands.jsonl');
  const scripts = Object.fromEntries(['typecheck', 'lint', 'test'].map(name => [name, `node command.cjs ${name}`]));
  scripts.prepublishOnly = 'node scripts/tree-verdict-prepublish.cjs';
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tree-verdict-fixture', private: true, scripts }));
  writeFileSync(join(dir, 'command.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(trace)}, process.argv[2]+'\\n'); if(process.argv[2]===${JSON.stringify(fail)}) process.exit(23);`);
  return () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [];
}
function gate(dir, body = chain, env = {}) {
  const result = spawnSync('/bin/sh', ['-c', body], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10000 });
  expect(result.error).toBeUndefined();
  return result;
}

test('the actual consumer planner covers the original chain once without certifying the custom shard runner', () => {
  expect(declaration.chain).toBe(chain);
  expect(declaration.commands.join(' && ')).toBe(chain);
  expect(Object.keys(plan.coverage.jobs)).toEqual(['ships']);
  expect(plan.coverage.jobs.ships.legs).toEqual([{ matrix: {}, apiName: 'ships fresh' }]);
  const commands = ci.jobs.ships.steps.map(s => s.run).filter(s => declaration.commands.includes(s));
  expect(commands.join(' && ')).toBe(chain);
  for (const command of declaration.commands) expect(commands.filter(c => c === command)).toHaveLength(1);
  const bad = path => path === declaration.workflow ? read(path).replace('      - run: bun run test\n', '') : read(path);
  expect(() => compileCoverage(declaration, bad)).toThrow('COVER_COMMAND');
});

test('all original protection names report fresh success or logged reuse; failures and skips cannot pass as fresh', () => {
  for (const id of ['test', 'ships']) {
    const reporter = ci.jobs[`${id}-status`];
    expect(reporter.name).toBe(id);
    expect(reporter.if).toBe('always()');
    expect(reporter.needs).toContain('tree-verdict');
    expect(reporter.needs).toContain(id);
    const body = reporter.steps[0].run;
    for (const result of ['success', 'failure', 'skipped', 'cancelled']) {
      const needs = Object.fromEntries(reporter.needs.map(dep => [dep, { result: dep === 'tree-verdict' ? 'success' : result }]));
      const run = spawnSync('/bin/sh', ['-c', body], { encoding: 'utf8', env: { ...process.env, LOOKUP_RESULT: 'success', REUSED: 'false', RESULTS: JSON.stringify(needs) } });
      expect(run.status).toBe(result === 'success' ? 0 : 1);
    }
    const reused = spawnSync('/bin/sh', ['-c', body], { encoding: 'utf8', env: { ...process.env, LOOKUP_RESULT: 'success', REUSED: 'true', SOURCE_RUN: '800', SOURCE_HEAD: sha('b'), SOURCE_TESTED: sha('c'), SOURCE_PR: '7' } });
    expect(reused.status).toBe(0);
    expect(reused.stdout).toContain(`Reused PR 7 head ${sha('b')} tested ${sha('c')} run 800`);
    const failedLookup = spawnSync('/bin/sh', ['-c', body], { encoding: 'utf8', env: { ...process.env, LOOKUP_RESULT: 'failure', REUSED: 'true' } });
    expect(failedLookup.status).not.toBe(0);
  }
  expect(ci.jobs.scope.name ?? 'scope').toBe('scope');
  const merger = ci.jobs.test.steps.find(step => step.env?.TEST_NEEDS);
  const projected = merger.env.TEST_NEEDS.replaceAll('${{ needs.checks.result }}', 'success').replaceAll('${{ needs.test-shards.result }}', 'success');
  expect(JSON.parse(projected)).toEqual({ checks: { result: 'success' }, 'test-shards': { result: 'success' } });
  for (const id of lintConfig.workflows[0].heavyJobs) {
    expect(ci.jobs[id].needs).toContain('tree-verdict');
    expect(ci.jobs[id].if).toContain("needs.tree-verdict.outputs.reused != 'true'");
  }
});

for (const purpose of ['ci', 'publish']) {
  for (const scenario of ['same tree', 'one-byte mismatch']) {
    test(`${purpose}: own compiled coverage and lookup, ${scenario}`, () => scratch(async dir => {
      const f = fixture(purpose), trace = fixturePackage(dir), logs = [];
      if (scenario === 'one-byte mismatch') {
        writeFileSync(join(dir, 'before'), 'a'); writeFileSync(join(dir, 'after'), 'b');
        expect(readFileSync(join(dir, 'before'))).toHaveLength(1);
        expect(readFileSync(join(dir, 'after'))).toHaveLength(1);
        expect(tree('a')).not.toBe(tree('b'));
        f.commits.get(f.c.sha).tree.sha = tree('b');
      }
      const result = await lookup(f.c, f.api, f.readReceipt, line => logs.push(line));
      expect(result.reused).toBe(scenario === 'same tree');
      if (purpose === 'publish' && result.reused) {
        const proof = join(dir, 'proof.json'); writeFileSync(proof, JSON.stringify(publishEnvelope(f.c, result)));
        expect(await readPublishVerdict(proof, f.c, f.api, f.readReceipt)).toBe(true);
      }
      if (!result.reused) {
        const commands = ci.jobs.ships.steps.map(s => s.run).filter(s => declaration.commands.includes(s));
        const run = gate(dir, commands.join(' && '));
        expect(run.status, run.stdout + run.stderr).toBe(0);
        expect(trace()).toEqual(['typecheck', 'lint', 'test']);
      } else expect(trace()).toEqual([]);
      if (scenario === 'one-byte mismatch') {
        expect(logs.join('\n')).toContain(`tree ${tree('b')} != PR head tree ${tree('a')}`);
        console.log(`PLANT ${purpose}: changed bytes=1; source tree=${tree('a')}; target tree=${tree('b')}; fallback commands=${trace().join(',')}; exit=0 (fixture commands, not the pose suite)`);
      }
    }));
  }
}

test('source hook without helper executes all three real Bun fixture commands and preserves first failure', () => scratch(dir => {
  const trace = fixturePackage(dir);
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts/tree-verdict.json'), JSON.stringify(declaration));
  writeFileSync(join(dir, 'scripts/tree-verdict-prepublish.cjs'), read('scripts/tree-verdict-prepublish.cjs'));
  const run = gate(dir, 'npm run prepublishOnly', { TREE_VERDICT_TOOLS: '', TREE_VERDICT_PATH: '', npm_config_cache: join(dir, 'npm-cache') });
  expect(run.status).toBe(0); expect(trace()).toEqual(['typecheck', 'lint', 'test']);
  rmSync(join(dir, 'commands.jsonl'));
  const helperMiss = gate(dir, 'npm run prepublishOnly', { TREE_VERDICT_TOOLS: tools, TREE_VERDICT_PATH: '', npm_config_cache: join(dir, 'npm-cache') });
  expect(helperMiss.status).toBe(0); expect(trace()).toEqual(['typecheck', 'lint', 'test']);
  expect(helperMiss.stdout).toContain('TREE_VERDICT_LIFECYCLE_FALLBACK');
  rmSync(join(dir, 'commands.jsonl'));
  fixturePackage(dir, 'lint');
  const failed = gate(dir, 'npm run prepublishOnly', { TREE_VERDICT_TOOLS: '', TREE_VERDICT_PATH: '', npm_config_cache: join(dir, 'npm-cache') });
  expect(failed.status).toBe(23); expect(trace()).toEqual(['typecheck', 'lint']);
}));

test('publication lint accepts the patch and rejects missing reader, unguarded work, and unguarded receipt upload', () => scratch(dir => {
  const lint = resolve(tools, '../../../scripts/lint_workflows.ts');
  const run = spawnSync(process.execPath, [lint, 'scripts/tree-verdict-workflows.json', root], { cwd: root, encoding: 'utf8' });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  for (const [name, mutate, error] of [
    ['reader', text => text.replace('        run: node "$TREE_VERDICT_TOOLS/lifecycle.mjs"', '        if: false\n        run: node "$TREE_VERDICT_TOOLS/lifecycle.mjs"'), 'WFL002'],
    ['guard', text => text.replace("    if: needs.tree-verdict.outputs.reused != 'true'", '    if: success()'), 'WFL001'],
    ['upload', text => text.replace("        if: ${{ steps.receipt.outputs.receipt-created == 'true' }}\n", ''), 'COVER_PRODUCER'],
  ]) {
    const target = join(dir, name); mkdirSync(join(target, '.github/workflows'), { recursive: true }); mkdirSync(join(target, 'scripts'));
    for (const path of ['.github/workflows/ci.yml', '.github/workflows/release.yml', 'scripts/tree-verdict.json', 'scripts/tree-verdict-workflows.json', 'package.json']) {
      const input = read(path); writeFileSync(join(target, path), mutate(input));
    }
    const failed = spawnSync(process.execPath, [lint, join(target, 'scripts/tree-verdict-workflows.json'), target], { encoding: 'utf8' });
    expect(failed.status).toBe(1); expect(failed.stdout + failed.stderr).toContain(error);
  }
}));

test('release gates both existing publications with the same pinned publish proof and preserves publisher identity', () => {
  const steps = release.jobs.publish.steps;
  const reuse = steps.find(s => s.id === 'reuse');
  const reader = steps.find(s => s.id === 'publication-reader');
  expect(reuse.uses).toBe(pin); expect(reuse.with.purpose).toBe('publish');
  expect(reader.if).toBeUndefined(); expect(reader['continue-on-error']).toBeUndefined();
  expect(reader.run).toBe('node "$TREE_VERDICT_TOOLS/lifecycle.mjs" --declaration scripts/tree-verdict.json --verdict-path "$TREE_VERDICT_PATH"');
  const publications = steps.filter(s => /\bnpm publish\b/.test(s.run ?? ''));
  expect(publications).toHaveLength(2);
  for (const step of publications) {
    expect(steps.indexOf(reader)).toBeLessThan(steps.indexOf(step));
    expect(step.env.TREE_VERDICT_PATH).toBe('${{ steps.reuse.outputs.verdict-path }}');
  }
  expect(publications[0].run).toContain('npm publish --provenance --access public');
  expect(publications[1].run).toContain('bun scripts/alias_tarball.ts pack --name rig-pose --out "$RUNNER_TEMP/pose-alias"');
  expect(release.jobs.publish.permissions['id-token']).toBe('write');
  expect(release.jobs.publish.environment).toBeUndefined();
  expect(release.jobs.publish['runs-on']).toBe('ubuntu-latest');
  expect(steps.find(s => s.name === 'Use an npm that speaks OIDC').run).toContain('npm@12.2.2');
  expect(steps.find(s => s.uses?.startsWith('actions/setup-node@')).with['registry-url']).toBe('https://registry.npmjs.org');
});

// The verified reader's live-checkout seam is fixture-only. It avoids ANY Git
// subprocess; hosted clean-checkout and artifact verification remain CI evidence.
test('actual lifecycle revalidates source proof, skips the whole chain, and runs all three commands after one-byte mismatch', () => scratch(async dir => {
  const f = fixture('publish'), trace = fixturePackage(dir), result = await lookup(f.c, f.api, f.readReceipt);
  expect(result.reused).toBe(true);
  const proof = join(dir, 'proof.json'), event = join(dir, 'event.json'), decl = join(dir, 'declaration.json');
  writeFileSync(proof, JSON.stringify(publishEnvelope(f.c, result)));
  writeFileSync(event, JSON.stringify({ repository: { full_name: f.c.repository, default_branch: 'main' } }));
  writeFileSync(decl, JSON.stringify(declaration));
  const checkout = () => ({ sha: f.c.sha, tree: f.commits.get(f.c.sha).tree.sha, root: dir });
  mock.module(join(tools, 'checkout.mjs'), () => ({ checkoutProof: checkout, unchangedCheckout: checkout }));
  try {
    const { lifecycle } = await load('lifecycle.mjs');
    const env = { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: f.c.repository, GITHUB_SHA: f.c.sha, GITHUB_RUN_ID: String(f.c.runId), GITHUB_EVENT_NAME: f.c.event, GITHUB_REF: f.c.ref, TREE_VERDICT_PATH: proof };
    const args = ['--declaration', decl, '--checkout', dir];
    const logs = [], transport = { api: f.api, readReceipt: f.readReceipt };
    expect(await lifecycle(args, env, transport, line => logs.push(line))).toBe(0);
    expect(trace()).toEqual([]);
    expect(logs.some(s => s.includes('TREE_VERDICT_LIFECYCLE_REUSED: run=800'))).toBe(true);
    f.commits.get(f.c.sha).tree.sha = tree('b');
    expect(await lifecycle(args, env, transport, line => logs.push(line))).toBe(0);
    expect(trace()).toEqual(['typecheck', 'lint', 'test']);
    expect(logs.some(s => s.includes('TREE_VERDICT_LIFECYCLE_FALLBACK'))).toBe(true);
    console.log('LIFECYCLE dry proof: real pinned reader; fresh mocked source jobs/receipt; checkout seam injected; Git/network/publish commands=0; reused commands=0; one-byte mismatch commands=3');
  } finally { mock.restore(); }
}));
