/** #376: the running CLI and emitted regression reports, beside #262's static audit. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
export const releasing = (): string => readFileSync(join(ROOT, 'RELEASING.md'), 'utf8');

function section(text: string, heading: string): string {
  const start = text.indexOf(`### ${heading}\n`);
  if (start < 0) throw new Error(`SURFACE_TABLE: RELEASING.md has no ${JSON.stringify(heading)} section`);
  const end = text.indexOf('\n### ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** A status is required in the table itself; a mention in surrounding prose is not a decision. */
export function surfaceRows(text: string): { flags: string[]; fields: string[] } {
  const flags = [...section(text, 'Flags').matchAll(/^\| `([a-z]+)` \| `(--[a-z0-9-]+)` \| (?:promised|courtesy) \|/gm)]
    .map((m) => `${m[1]} ${m[2]}`);
  for (const line of section(text, 'Exit codes, commands and formats').split('\n')) {
    if (!/^\| `rig-pose --/.test(line) || !/\| (?:promised|courtesy) \|/.test(line)) continue;
    for (const m of line.split('|')[1]!.matchAll(/--[a-z0-9-]+/g)) flags.push(`rig-pose ${m[0]}`);
  }
  const fields = [...section(text, "The report's top-level keys").matchAll(/^\| `([A-Za-z0-9]+)` \| (?:promised|courtesy) \|/gm)]
    .map((m) => m[1]!);
  for (const line of section(text, "The report's nested fields").split('\n')) {
    if (!/^\| .* \| (?:promised|courtesy) \|/.test(line)) continue;
    for (const m of line.split('|')[1]!.matchAll(/`([^`]+)`/g)) fields.push(m[1]!);
  }
  return { flags, fields };
}

export function helpCommands(help: string): string[] {
  const commands = [...new Set([...help.matchAll(/^  rig-pose ([a-z][a-z-]*)\b/gm)].map((m) => m[1]!))];
  if (commands.length === 0) throw new Error('SURFACE_HELP: --help printed no commands in Usage');
  return commands;
}

/** Read flag declarations, including paired declarations and Usage, but not flags cited in prose. */
export function helpFlags(help: string): string[] {
  const commands = helpCommands(help);
  const flags = new Set<string>();
  let command: string | null = null;
  for (const line of help.split('\n')) {
    const usage = /^  rig-pose (.*)/.exec(line);
    if (usage !== null) {
      const cmd = commands.find((name) => usage[1]!.startsWith(`${name} `));
      for (const m of usage[1]!.matchAll(/--[a-z0-9-]+/g)) flags.add(`${cmd ?? 'rig-pose'} ${m[0]}`);
      continue;
    }
    if (/^\S/.test(line)) command = commands.find((name) => line === name || line.startsWith(`${name} (`)) ?? null;
    if (command !== null && /^  --/.test(line)) {
      // A description starts after two spaces. Single spaces separate paired flags and their arguments.
      const declaration = line.trimStart().split(/\s{2,}/)[0]!;
      for (const m of declaration.matchAll(/--[a-z0-9-]+/g)) flags.add(`${command} ${m[0]}`);
    }
  }
  for (const name of commands) {
    if (![...flags].some((flag) => flag.startsWith(`${name} `))) throw new Error(`SURFACE_HELP: command ${name} has no flag declarations`);
  }
  return [...flags].sort();
}

export function runHelp(args: string[], cli = join(ROOT, 'cli.ts')): string {
  const run = spawnSync(process.execPath, [cli, ...args, '--help'], { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`SURFACE_HELP: rig-pose ${[...args, '--help'].join(' ')} exited ${run.status}: ${run.stderr}`);
  return run.stdout;
}

function missing(kind: string, observed: readonly string[], listed: readonly string[]): string[] {
  return [...new Set(observed)].sort().flatMap((name) => {
    const n = listed.filter((item) => item === name).length;
    return n === 1 ? [] : [`SURFACE_UNLISTED_${kind}: ${name}: ${n} classification row(s) in RELEASING.md; expected exactly 1 promised or courtesy`];
  });
}

export function auditHelp(help: string, text: string): string[] {
  return missing('FLAG', helpFlags(help), surfaceRows(text).flags);
}

/** [] traverses every array row; * is one explicitly documented record key, never a subtree. */
export function reportFields(report: unknown, listed: readonly string[] = []): string[] {
  const fields = new Set<string>();
  const records = new Set(listed.filter((field) => field.endsWith('.*')).map((field) => field.slice(0, -2)));
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      for (const row of value) visit(row, `${path}[]`);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        const name = records.has(path) ? '*' : key;
        const next = path === '' ? name : `${path}.${name}`;
        fields.add(next);
        visit(item, next);
      }
    }
  };
  visit(report, '');
  return [...fields].sort();
}

export function auditReport(report: unknown, text: string): string[] {
  const listed = surfaceRows(text).fields;
  return missing('FIELD', reportFields(report, listed), listed);
}

/** All reports just emitted by the regression fixtures, before independent continuity/diff assertions. */
export function assertReportSurfaces(reports: readonly (readonly [string, Record<string, unknown>])[]): void {
  const text = releasing();
  const problems: string[] = [];
  for (const [name, report] of reports) {
    if (report.spec !== 'rig-pose-report/1') throw new Error(`SURFACE_REPORT: ${name}: expected rig-pose-report/1, found ${String(report.spec)}`);
    const fields = reportFields(report, surfaceRows(text).fields);
    console.log(`SURFACE_REPORT ${name}: ${report.frames} frames; ${fields.length} fields; sha256 ${createHash('sha256').update(JSON.stringify(report)).digest('hex')}\n${fields.join('\n')}`);
    problems.push(...auditReport(report, text).map((problem) => `${problem} (${name})`));
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
}
