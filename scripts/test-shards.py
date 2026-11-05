#!/usr/bin/env python3
"""Three serial shards and a dependency-free JUnit/coverage merger.

The TypeScript companion parses source without importing tests. The merger uses
only stdlib and the source-bound plan independently produced by the checks job.
"""
import argparse
import collections
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
BASELINE = json.loads((HERE / 'test-shards-baseline.json').read_text())
TEST = re.compile(r'[._](?:test|spec)\.[cm]?[jt]sx?$')


def refuse(code, detail):
    raise ValueError(f'{code}: {detail}')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    if not path.is_file():
        refuse('MISSING_ARTIFACT', path.name)
    return json.loads(path.read_text())


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def discover(root):
    return sorted(p.relative_to(root).as_posix() for p in (root / 'test').rglob('*') if p.is_file() and TEST.search(p.name))


def coverage(expected, actual):
    counts = collections.Counter(actual)
    for f in sorted(set(actual) - set(expected)):
        refuse('UNKNOWN_FILE', f)
    for f in expected:
        if not counts[f]:
            refuse('OMITTED_FILE', f)
        if counts[f] != 1:
            refuse('DUPLICATE_FILE', f'{f}: assigned {counts[f]} times, required 1')


def make_plan(root, output):
    subprocess.run(['bun', str(HERE / 'test-shards.ts'), 'plan', str(root), str(output)], check=True)
    return load(output)


def run_shard(root, shard_id, output, head):
    output.mkdir(parents=True, exist_ok=True)
    if any((output / f).exists() for f in ['plan.json', 'result.json', 'timings.json', 'junit.xml']):
        refuse('OUTPUT_NOT_EMPTY', 'use a fresh per-run artifact directory')
    plan = make_plan(root, output / 'plan.json')
    shard = next(s for s in plan['shards'] if s['id'] == shard_id)
    files = shard['files']
    command = ['bun', 'test', *('./' + f for f in files),
               '--timings=' + str(output / 'timings.json'), '--update-timings',
               '--reporter=junit', '--reporter-outfile=' + str(output / 'junit.xml')]
    observed = []
    env = dict(os.environ, FORCE_COLOR='0', NO_COLOR='1')
    # Each matrix job has a separate checkout, temp directory and package cache.
    for name in ['tmp', 'npm', 'pose404']:
        (output / name).mkdir(exist_ok=True)
    env.update(TMPDIR=str(output / 'tmp'), npm_config_cache=str(output / 'npm'), POSE404_OUTPUT=str(output / 'pose404'))
    started = time.monotonic()
    with (output / 'console.log').open('w') as log:
        if files:
            process = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in process.stdout:
                log.write(line)
                print(line, end='', flush=True)
                clean = re.sub(r'\x1b\[[0-9;]*m', '', line).strip()
                if clean.endswith(':') and TEST.search(clean[:-1]):
                    observed.append(clean[:-1].removeprefix('./'))
            exit_code = process.wait()
        else:
            # Passing no paths would run the whole suite. An empty shard runs no Bun command.
            exit_code = 0
            save(output / 'timings.json', {'version': 1, 'files': {}})
            (output / 'junit.xml').write_text('<testsuites tests="0" failures="0" skipped="0"/>\n')
    elapsed = time.monotonic() - started
    save(output / 'observed.json', observed)
    save(output / 'result.json', {'id': shard_id, 'head': head, 'planDigest': plan['digest'], 'files': files,
                                'exit': exit_code, 'commandSeconds': elapsed, 'command': command if files else []})
    return exit_code


def identity(case):
    file = case.attrib.get('file', '')
    if file == 'test/retarget-later.test.ts':
        file = 'test/retarget.test.ts'
    return file, case.attrib.get('classname', ''), case.attrib['name']


def baseline_matches(root, universe):
    return set(universe) == set(BASELINE['files']) and all(
        (root / f).is_file() and digest(root / f) == sha for f, sha in BASELINE['originalInputs'].items())


def merge(root, plan_path, artifacts, output, head, needs=None):
    started = time.monotonic()
    if needs is not None:
        if set(needs) != {'checks', 'test-shards'} or any(v.get('result') != 'success' for v in needs.values()):
            refuse('PREREQUISITE_FAILED', json.dumps(needs, sort_keys=True))
    plan = load(plan_path)
    universe = discover(root)
    coverage(universe, plan['files'])
    coverage(universe, [f for s in plan['shards'] for f in s['files']])
    for f, sha in plan['inputs'].items():
        if not (root / f).is_file() or digest(root / f) != sha:
            refuse('SOURCE_CHANGED', f)
    current_inputs = sorted(p.relative_to(root).as_posix() for d in ['test', 'src', 'examples'] for p in (root / d).rglob('*') if p.is_file()) + ['cli.ts', 'package.json', 'bun.lock']
    if set(current_inputs) != set(plan['inputs']):
        refuse('SOURCE_CHANGED', 'plan input inventory differs from current tree')
    dirs = sorted(p for p in artifacts.iterdir() if p.is_dir())
    results = [load(p / 'result.json') for p in dirs]
    coverage(universe, [f for r in results for f in r['files']])
    ids = [r['id'] for r in results]
    if collections.Counter(ids) != collections.Counter(s['id'] for s in plan['shards']):
        refuse('SHARD_RESULTS', f'found shard IDs {ids}, required {[s["id"] for s in plan["shards"]]}')
    cases, after, seconds = [], {}, []
    for directory, result in zip(dirs, results):
        expected = next(s for s in plan['shards'] if s['id'] == result['id'])
        if result['files'] != expected['files']:
            refuse('SHARD_ASSIGNMENT', str(result['id']))
        if result['head'] != head or result['planDigest'] != plan['digest']:
            refuse('STALE_RESULT', str(result['id']))
        if result['exit'] != 0:
            refuse('SHARD_FAILED', f'shard {result["id"]}: exit {result["exit"]}')
        observed = load(directory / 'observed.json')
        if observed != expected['files']:
            refuse('OBSERVED_FILES', f'shard {result["id"]}: observed order/multiset differs')
        timings = load(directory / 'timings.json')
        coverage(expected['files'], list(timings['files']))
        for f, ms in timings['files'].items():
            if not isinstance(ms, (int, float)) or not math.isfinite(ms) or ms < 0:
                refuse('TIMING_VALUE', f)
            after[f] = ms
        xml_path = directory / 'junit.xml'
        if not xml_path.is_file():
            refuse('MISSING_ARTIFACT', 'junit.xml')
        junit = ET.parse(xml_path).getroot()
        found = list(junit.iter('testcase'))
        if int(junit.attrib['tests']) != len(found):
            refuse('JUNIT_COUNT', f'shard {result["id"]}')
        if any(int(junit.attrib.get(k, 0)) for k in ['failures', 'errors', 'skipped']) or any(e.tag in ['failure', 'error', 'skipped'] for e in junit.iter()):
            refuse('JUNIT_FAILED', f'shard {result["id"]}')
        for case in found:
            if case.attrib.get('file') not in expected['files']:
                refuse('JUNIT_FILE', case.attrib.get('file', 'missing'))
        cases.extend(found)
        seconds.append(result['commandSeconds'])
    # This PR's body-preserving source transform must retain the full identity
    # multiset. New test files or changed other source inputs make this an old
    # reference, not an evergreen magic count. Coverage still applies to every file.
    baseline_applies = baseline_matches(root, universe)
    actual = collections.Counter(identity(c) for c in cases)
    if baseline_applies:
        if len(cases) != BASELINE['tests']:
            refuse('BASELINE_TEST_COUNT', f'{len(cases)} found, {BASELINE["tests"]} required for these inputs')
        expected = collections.Counter((c['file'], c['classname'], c['name']) for c in BASELINE['identities'])
        if actual != expected:
            refuse('TEST_IDENTITIES', 'same-source JUnit identity multiset changed (file provenance normalized only for the permitted sibling)')
    output.mkdir(parents=True, exist_ok=True)
    counts = collections.Counter(c.attrib['file'] for c in cases)
    table = '| File | Before native s | After native s | Tests |\n| --- | ---: | ---: | ---: |\n'
    for f in sorted(universe, key=lambda f: (-after[f], f)):
        before = BASELINE['beforeMs'].get(f)
        table += f'| `{f}` | {before / 1000 if before is not None else "unmeasured"} | {after[f] / 1000:.3f} | {counts[f]} |\n'
    summary = {'head': head, 'tests': len(cases), 'files': len(universe), 'baselineIdentityGateApplied': baseline_applies,
               'longestTestCommandSeconds': max(seconds, default=0), 'mergeScriptSeconds': time.monotonic() - started,
               'timingBoundary': 'Command/script times exclude Actions setup/upload. Acceptance uses longest complete shard job plus complete aggregate job from Actions.',
               'referenceCiSeconds': 735.69, 'targetCiSeconds': 300}
    save(output / 'summary.json', summary)
    save(output / 'after-timings.json', after)
    (output / 'before-after.md').write_text(table)
    print(f'MERGED {len(cases)} tests across {len(universe)} files; baseline identities {"required and equal" if baseline_applies else "reference only: source changed"}')
    print(table)
    return summary


def controls(scratch):
    """Planted inputs invoke the same production CLI as the workflow."""
    scratch.mkdir(parents=True, exist_ok=True)
    (scratch / 'tmp').mkdir(exist_ok=True)
    os.environ['TMPDIR'] = str(scratch / 'tmp')
    report = []
    script = str(Path(__file__).resolve())
    head = 'control-head'

    def execute(label, args, expected=0, code=None):
        p = subprocess.run(args, capture_output=True, text=True)
        (scratch / (label + '.log')).write_text(p.stdout + p.stderr)
        report.append({'control': label, 'command': args, 'exit': p.returncode})
        if p.returncode != expected or (code and code not in p.stdout + p.stderr):
            refuse('CONTROL_FAILED', f'{label}: exit {p.returncode}; {p.stdout[-500:]} {p.stderr[-500:]}')
        print(f'CONTROL {label}: exit {p.returncode}' + (f' {code}' if code else ''))

    root = scratch / 'fixture'
    (root / 'test').mkdir(parents=True, exist_ok=True)
    for d in ['src', 'examples']:
        (root / d).mkdir(exist_ok=True)
    for f in ['cli.ts', 'bun.lock']:
        (root / f).write_text('')
    (root / 'package.json').write_text('{"type":"module"}')
    (root / 'test/a.test.ts').write_text('import {test,expect} from "bun:test"; export const n=1; test("a",()=>expect(n).toBe(1));\n')
    (root / 'test/bridge.ts').write_text('export {n} from "./a.test.ts";\n')
    (root / 'test/b.test.ts').write_text('import {test,expect} from "bun:test"; const {n}=await import("./bridge.ts"); test("b",()=>expect(n).toBe(1));\n')
    (root / 'test/c.spec.ts').write_text('import {test} from "bun:test"; test("c",()=>{});\n')
    plan_path = scratch / 'plan.json'
    plan = make_plan(root, plan_path)
    assert any(set(g) == {'test/a.test.ts', 'test/b.test.ts'} for g in plan['components'])
    artifacts = scratch / 'artifacts'
    for shard in plan['shards']:
        execute('run-' + str(shard['id']), [sys.executable, script, 'run', '--root', str(root), '--id', str(shard['id']), '--out', str(artifacts / str(shard['id'])), '--head', head])
    def merge_args(art=artifacts, rp=root, pp=plan_path):
        return [sys.executable, script, 'merge', '--root', str(rp), '--plan', str(pp), '--artifacts', str(art), '--out', str(scratch / 'merged'), '--head', head]
    execute('positive', merge_args())
    populated = [p for p in artifacts.iterdir() if load(p / 'result.json')['files']]
    for label, code in [('omitted', 'OMITTED_FILE'), ('duplicate', 'DUPLICATE_FILE'), ('unknown', 'UNKNOWN_FILE'), ('failed', 'SHARD_FAILED'), ('missing', 'MISSING_ARTIFACT')]:
        planted = scratch / label
        shutil.copytree(artifacts, planted)
        target = planted / populated[0].name
        r = load(target / 'result.json')
        if label == 'omitted': r['files'].pop()
        elif label == 'duplicate': r['files'].append(r['files'][0])
        elif label == 'unknown': r['files'].append('test/unknown.test.ts')
        elif label == 'failed': r['exit'] = 1
        elif label == 'missing': (target / 'junit.xml').unlink()
        save(target / 'result.json', r)
        execute(label, merge_args(planted), 1, code)
    execute('cancelled-prerequisite', merge_args() + ['--needs', '{"checks":{"result":"success"},"test-shards":{"result":"cancelled"}}'], 1, 'PREREQUISITE_FAILED')
    # A new file absent from the timing baseline must run, not be ignored or
    # rejected for failing an obsolete count.
    (root / 'test/new.test.ts').write_text('import {test} from "bun:test"; test("new",()=>{});\n')
    plan = make_plan(root, plan_path)
    assert 'test/new.test.ts' in plan['unmeasured']
    new_artifacts = scratch / 'new-artifacts'
    for shard in plan['shards']:
        execute('new-run-' + str(shard['id']), [sys.executable, script, 'run', '--root', str(root), '--id', str(shard['id']), '--out', str(new_artifacts / str(shard['id'])), '--head', head])
    execute('unmeasured-new-file', merge_args(new_artifacts))
    # Source-bound accepted-run fixtures exercise identity and count checks of
    # this PR through the production merger. Their zero timings are synthetic
    # controls, never presented as after measurements.
    real_root = Path.cwd()
    real_plan_path = scratch / 'real-plan.json'
    real_plan = make_plan(real_root, real_plan_path)
    if baseline_matches(real_root, real_plan['files']):
        snapshot = json.loads((HERE / 'test-shards-preservation.json').read_text())
        tail_names = {b['name'] for b in snapshot['blocks'] if b['file'] == 'test/retarget-later.test.ts'}
        synthetic = scratch / 'source-bound-artifacts'
        for shard in real_plan['shards']:
            target = synthetic / str(shard['id'])
            target.mkdir(parents=True)
            cases = []
            for row in BASELINE['identities']:
                file = row['file']
                if file == 'test/retarget.test.ts' and any(row['classname'] == n or row['classname'].startswith(n + ' > ') for n in tail_names):
                    file = 'test/retarget-later.test.ts'
                if file in shard['files']:
                    cases.append(dict(row, file=file))
            junit = ET.Element('testsuites', tests=str(len(cases)), failures='0', skipped='0')
            for row in cases:
                ET.SubElement(junit, 'testcase', row)
            ET.ElementTree(junit).write(target / 'junit.xml', encoding='unicode')
            save(target / 'result.json', dict(id=shard['id'], files=shard['files'], head=head, planDigest=real_plan['digest'], exit=0, commandSeconds=0))
            save(target / 'observed.json', shard['files'])
            save(target / 'timings.json', dict(version=1, files={f: 0 for f in shard['files']}))
        execute('source-bound-936', merge_args(synthetic, real_root, real_plan_path))
        for label, code in [('lost-count', 'BASELINE_TEST_COUNT'), ('same-count-wrong-identity', 'TEST_IDENTITIES')]:
            planted = scratch / label
            shutil.copytree(synthetic, planted)
            target = next(d / 'junit.xml' for d in planted.iterdir() if len(list(ET.parse(d / 'junit.xml').getroot())))
            xml = ET.parse(target)
            top = xml.getroot()
            if label == 'lost-count':
                top.remove(top[0])
                top.set('tests', str(int(top.attrib['tests']) - 1))
            else:
                top[0].set('name', 'planted different identity with unchanged count')
            xml.write(target, encoding='unicode')
            execute(label, merge_args(planted, real_root, real_plan_path), 1, code)
    else:
        print('CONTROL baseline-reference-only: source changed; old count/identity plants do not apply')
    # Body/name/omission/duplication/declaration plants pass through the exact
    # source-preservation gate used in checks, against copies outside the repo.
    real_root = Path.cwd()
    structure = json.loads((HERE / 'test-shards-preservation.json').read_text())
    original = (real_root / 'test/retarget.test.ts').read_text()
    start = original.index("test('" + structure['blocks'][0]['name'])
    end = original.index('\n});', start) + len('\n});')
    block = original[start:end]
    assert hashlib.sha256(block.encode()).hexdigest() == structure['blocks'][0]['sha256']
    for label in ['body-byte', 'renamed', 'omitted-block', 'duplicated-block', 'declaration-byte']:
        copy = scratch / ('preserve-' + label)
        (copy / 'test').mkdir(parents=True)
        for f in ['retarget.test.ts', 'retarget-later.test.ts', 'retarget-fixture.ts']:
            shutil.copyfile(real_root / 'test' / f, copy / 'test' / f)
        modified = original
        if label == 'body-byte': modified = original[:start] + block.replace('const rows =', 'const rows  =', 1) + original[end:]
        elif label == 'renamed': modified = original[:start] + block.replace('legacy report projection', 'renamed report projection', 1) + original[end:]
        elif label == 'omitted-block': modified = original[:start] + original[end:]
        elif label == 'duplicated-block': modified += '\n' + block + '\n'
        elif label == 'declaration-byte':
            fixture = copy / 'test/retarget-fixture.ts'
            fixture.write_text(fixture.read_text().replace('export const ROOT =', 'export const ROOT  =', 1))
        (copy / 'test/retarget.test.ts').write_text(modified)
        execute(label, ['bun', str(HERE / 'test-shards.ts'), 'preserve', str(copy)], 1, 'DECLARATION_BYTES' if label == 'declaration-byte' else 'BLOCK_BYTES_NAMES')
    # This single probe imports the real fixture: any accidental test
    # registration changes the observed count. Its temp ledger is drained once.
    probe = scratch / 'fixture-equivalence.test.ts'
    fixture_path = json.dumps(str(real_root / 'test/retarget-fixture.ts'))
    probe.write_text('import {test,expect} from "bun:test"; import {join} from "node:path"; import {rmSync} from "node:fs"; '
                     + 'import {ROOT,CLI,RIGC,MUTANTS,made,tempDir} from ' + fixture_path + ';\n'
                     + 'test("same-directory paths and shared temp ledger",()=>{'
                     + 'expect(ROOT).toBe(process.cwd()); expect(CLI).toBe(join(ROOT,"cli.ts"));'
                     + 'expect(RIGC).toBe(join(ROOT,"node_modules","@rig-c","core","bin","rigc.cjs"));'
                     + 'expect(MUTANTS).toBe(join(ROOT,"node_modules",".cache","rig-pose-mutants"));'
                     + 'expect(made).toHaveLength(0); const d=tempDir(); expect(made).toEqual([d]);'
                     + 'for(const p of made.splice(0))rmSync(p,{recursive:true,force:true}); expect(made).toHaveLength(0);});\n')
    execute('fixture-equivalence', ['bun', 'test', str(probe)])
    if '1 pass' not in (scratch / 'fixture-equivalence.log').read_text():
        refuse('FIXTURE_REGISTRATION', 'expected the probe to be the only registered test')
    save(scratch / 'controls.json', report)


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='command', required=True)
    for name in ['run', 'merge']:
        q = sub.add_parser(name)
        q.add_argument('--root', type=Path, default=Path.cwd())
        q.add_argument('--out', type=Path, required=True)
        q.add_argument('--head', required=True)
        if name == 'run': q.add_argument('--id', type=int, choices=[1, 2, 3], required=True)
        else:
            q.add_argument('--plan', type=Path, required=True)
            q.add_argument('--artifacts', type=Path, required=True)
            q.add_argument('--needs')
    q = sub.add_parser('controls')
    q.add_argument('--scratch', type=Path, required=True)
    a = p.parse_args()
    if a.command == 'run': return run_shard(a.root.resolve(), a.id, a.out.resolve(), a.head)
    if a.command == 'merge':
        merge(a.root.resolve(), a.plan, a.artifacts, a.out, a.head, json.loads(a.needs) if a.needs else None)
        return 0
    if a.command == 'controls': controls(a.scratch.resolve())
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, ET.ParseError, KeyError, StopIteration) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
