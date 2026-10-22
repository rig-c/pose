/**
 * rig-c/pose#377 (1.0 gate ⑤ of #217): the README's known-limits list, one bullet per limit, each
 * resting on one open issue labelled `parked`.
 *
 * Two halves read the same list through `parkedLimits`:
 * - `test/scope.test.ts`, offline: the list is there, every bullet names exactly one issue, and no
 *   issue is named twice. The suite never touches the network.
 * - this file run as a script, in CI: every issue the list names is open and labelled `parked`, read
 *   through `gh api`. A closed issue is a line that outlived its reason.
 *
 *   bun scripts/scope_issues.ts [--readme <file>] [--closed-control <n>]
 *
 * `--closed-control <n>` names an issue known to be closed. It is judged by the same code before
 * the verdict and must come back refused, so a green verdict means the reader can see a closed
 * issue, not merely that nothing answered.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const START = '<!-- parked-limits:';
export const END = '<!-- /parked-limits -->';
const REPO = 'rig-c/pose';
const LINK = /\[#(\d+)\]\(https:\/\/github\.com\/rig-c\/pose\/issues\/(\d+)\)/g;

export interface Limit {
  line: number;
  title: string;
  issue: number;
}

/** The list's bullets and their issues, or every problem with it, each naming the line. */
export function parkedLimits(readme: string): { limits: Limit[]; problems: string[] } {
  const lines = readme.split('\n');
  const problems: string[] = [];
  const limits: Limit[] = [];
  const starts = lines.flatMap((l, i) => (l.startsWith(START) ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === END ? [i] : []));
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) {
    problems.push(
      `SCOPE_LIST_MISSING: README needs exactly one "${START} …" line followed by one "${END}" line; found ${starts.length} start(s) and ${ends.length} end(s)${starts.length === 1 && ends.length === 1 ? ', the end before the start' : ''}`,
    );
    return { limits, problems };
  }
  const seen = new Map<number, number>();
  for (let i = starts[0]! + 1; i < ends[0]!; i++) {
    const text = lines[i]!;
    if (text.trim() === '') continue;
    const n = i + 1;
    if (!text.startsWith('- ')) {
      problems.push(`SCOPE_NOT_A_BULLET: README line ${n} is inside the known-limits list and is not a "- " bullet: ${text.slice(0, 60)}`);
      continue;
    }
    const title = /^- \*\*(.+?)\.?\*\*/.exec(text)?.[1] ?? text.slice(2, 50);
    const links = [...text.matchAll(LINK)];
    if (links.length !== 1) {
      problems.push(`SCOPE_ISSUE: README line ${n} ("${title}") names ${links.length} ${REPO} issue link(s); a limit rests on exactly one`);
      continue;
    }
    const [, shown, target] = links[0]!;
    if (shown !== target) {
      problems.push(`SCOPE_LINK: README line ${n} ("${title}") shows #${shown} and links issue ${target}`);
      continue;
    }
    const issue = Number(target);
    const first = seen.get(issue);
    if (first !== undefined) {
      problems.push(`SCOPE_DUPLICATE: README line ${n} ("${title}") names #${issue}, which line ${first} already names`);
      continue;
    }
    seen.set(issue, n);
    limits.push({ line: n, title, issue });
  }
  if (limits.length === 0 && problems.length === 0) problems.push(`SCOPE_EMPTY: the known-limits list (README line ${starts[0]! + 1}) has no bullets`);
  return { limits, problems };
}

/** One issue's state and labels, through `gh api` (GH_TOKEN in CI). */
function readIssue(n: number): { state: string; labels: string[]; pull: boolean } {
  const r = Bun.spawnSync(['gh', 'api', `repos/${REPO}/issues/${n}`]);
  if (r.exitCode !== 0) throw new Error(`gh api repos/${REPO}/issues/${n} exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  const j = JSON.parse(r.stdout.toString()) as { state: string; labels: Array<{ name: string }>; pull_request?: unknown };
  return { state: j.state, labels: j.labels.map((l) => l.name), pull: j.pull_request !== undefined };
}

/** Why the issue cannot hold a limit, or null when it can: open, an issue rather than a pull request, labelled `parked`. */
export function refusal(n: number, i: { state: string; labels: string[]; pull: boolean }): string | null {
  const why: string[] = [];
  if (i.pull) why.push('is a pull request');
  if (i.state !== 'open') why.push(`is ${i.state}`);
  if (!i.labels.includes('parked')) why.push(`is not labelled parked (labels: ${i.labels.join(', ') || 'none'})`);
  return why.length === 0 ? null : `SCOPE_ISSUE_STATE: #${n} ${why.join(' and ')}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const k = args.indexOf(name);
    return k === -1 ? undefined : args[k + 1];
  };
  const readmePath = opt('--readme') ?? join(import.meta.dir, '..', 'README.md');
  const control = opt('--closed-control');
  const { limits, problems } = parkedLimits(readFileSync(readmePath, 'utf8'));
  if (problems.length > 0) {
    for (const p of problems) console.log(p);
    process.exit(1);
  }
  if (control !== undefined) {
    const n = Number(control);
    const why = refusal(n, readIssue(n));
    if (why === null) {
      console.log(`control: #${n} was named as closed and the reader found it open and parked, so a green verdict below would mean nothing`);
      process.exit(1);
    }
    console.log(`  control  ${why} (refused, as it must be)`);
  }
  let bad = 0;
  for (const l of limits) {
    const why = refusal(l.issue, readIssue(l.issue));
    if (why === null) console.log(`  ok  #${l.issue} open, parked — README line ${l.line} "${l.title}"`);
    else {
      bad++;
      console.log(`${why} — README line ${l.line} "${l.title}" rests on it; drop the line or name the open issue that holds the limit`);
    }
  }
  console.log(`SCOPE: ${limits.length} limit(s) named, ${bad} resting on an issue that is not open and parked`);
  process.exit(bad === 0 ? 0 : 1);
}
