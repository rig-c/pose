/**
 * rig-c/pose#377 (1.0 gate ⑤ of #217): the README's known-limits list is read here, offline — it is
 * there, every bullet names exactly one issue, and no issue is named twice. Whether each issue is
 * still open and parked needs the network, so CI asks that in its own step
 * (`bun scripts/scope_issues.ts`); its judgement, `refusal`, is held here on planted states.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { END, START, parkedLimits, refusal } from '../scripts/scope_issues.ts';

const README = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8');
const link = (n: number) => `[#${n}](https://github.com/rig-c/pose/issues/${n})`;
const list = (...bullets: string[]) => `# x\n\n${START} test -->\n${bullets.join('\n')}\n${END}\n`;

test('control: the README names each known limit once, each on its own issue', () => {
  const { limits, problems } = parkedLimits(README);
  expect(problems).toEqual([]);
  expect(limits.length).toBeGreaterThan(0);
  expect(new Set(limits.map((l) => l.issue)).size).toBe(limits.length);
});

test('control: a well-formed planted list reads back its issues in order', () => {
  const { limits, problems } = parkedLimits(list(`- **A.** a (${link(1)}).`, '', `- **B.** b (${link(2)}).`));
  expect(problems).toEqual([]);
  expect(limits.map((l) => [l.title, l.issue])).toEqual([['A', 1], ['B', 2]]);
});

test('planted: the list missing is refused by name', () => {
  const cut = README.split('\n').filter((l) => !l.startsWith(START) && l.trim() !== END).join('\n');
  expect(parkedLimits(cut).problems).toEqual([expect.stringContaining('SCOPE_LIST_MISSING')]);
  expect(parkedLimits(`${START} x -->\n- **A.** a (${link(1)}).\n`).problems[0]).toContain('SCOPE_LIST_MISSING');
});

test('planted: an empty list is refused by name', () => {
  expect(parkedLimits(list()).problems).toEqual([expect.stringContaining('SCOPE_EMPTY')]);
});

test('planted: a bullet with no issue, or with two, is refused naming its line and title', () => {
  const none = parkedLimits(list(`- **A.** a (${link(1)}).`, '- **No issue.** nothing holds it.'));
  expect(none.problems).toEqual(['SCOPE_ISSUE: README line 5 ("No issue") names 0 rig-c/pose issue link(s); a limit rests on exactly one']);
  // A bare "#33" or another repository's issue is not a link to this one's.
  expect(parkedLimits(list('- **Bare.** see #33.')).problems[0]).toContain('names 0');
  expect(parkedLimits(list('- **Other.** ([#3](https://github.com/rig-c/parts/issues/3)).')).problems[0]).toContain('names 0');
  expect(parkedLimits(list(`- **Two.** (${link(1)}, ${link(2)}).`)).problems[0]).toContain('names 2');
});

test('planted: an issue named twice is refused naming both lines', () => {
  const { problems } = parkedLimits(list(`- **A.** a (${link(7)}).`, `- **B.** b (${link(7)}).`));
  expect(problems).toEqual(['SCOPE_DUPLICATE: README line 5 ("B") names #7, which line 4 already names']);
});

test('planted: a link whose text and target differ, and a line that is not a bullet, are refused', () => {
  expect(parkedLimits(list('- **A.** ([#33](https://github.com/rig-c/pose/issues/34)).')).problems[0]).toContain('SCOPE_LINK');
  expect(parkedLimits(list(`A paragraph (${link(1)}).`)).problems[0]).toContain('SCOPE_NOT_A_BULLET');
});

test('planted: the real README with a bullet stripped of its issue, or duplicated, goes red', () => {
  const { limits } = parkedLimits(README);
  const lines = README.split('\n');
  const first = limits[0]!;
  const stripped = lines.map((l, i) => (i === first.line - 1 ? l.replace(/\s*\(\[#\d+\]\([^)]*\)\)/, '') : l)).join('\n');
  expect(parkedLimits(stripped).problems).toEqual([expect.stringContaining(`SCOPE_ISSUE: README line ${first.line}`)]);
  const doubled = [...lines.slice(0, first.line), lines[first.line - 1]!, ...lines.slice(first.line)].join('\n');
  expect(parkedLimits(doubled).problems).toEqual([expect.stringContaining(`names #${first.issue}, which line ${first.line} already names`)]);
});

test("the network half's judgement: open and parked holds a limit; closed, unlabelled or a pull request does not", () => {
  expect(refusal(33, { state: 'open', labels: ['parked', 'feature'], pull: false })).toBeNull();
  expect(refusal(46, { state: 'closed', labels: ['parked'], pull: false })).toBe('SCOPE_ISSUE_STATE: #46 is closed');
  expect(refusal(9, { state: 'open', labels: ['next'], pull: false })).toBe('SCOPE_ISSUE_STATE: #9 is not labelled parked (labels: next)');
  expect(refusal(9, { state: 'closed', labels: [], pull: true })).toBe(
    'SCOPE_ISSUE_STATE: #9 is a pull request and is closed and is not labelled parked (labels: none)',
  );
});

test('CI runs the network half, with its closed control', () => {
  const ci = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  expect(ci).toMatch(/run: bun scripts\/scope_issues\.ts --closed-control \d+\n/);
  expect(ci).toContain('GH_TOKEN: ${{ github.token }}');
});
