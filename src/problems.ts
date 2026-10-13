/**
 * Every refusal in this package is a list of named problems, collected and
 * thrown once, so one run names everything that is wrong.
 *
 * A problem's text names the object, the value found and the value required:
 * `MAP_BONE_EXISTS: chain "arm_r" — bone "sleeve_r9" is not in the rig; its bones are …`.
 */
export interface Problem {
  /** The rule, SCREAMING_SNAKE, stable across releases of a 0.x line only. */
  code: string;
  /** The object, the value found, the value required. */
  text: string;
}

export class Refusal extends Error {
  readonly problems: readonly Problem[];
  constructor(problems: readonly Problem[]) {
    super(problems.map(lineOf).join('\n'));
    this.name = 'Refusal';
    this.problems = problems;
  }
}

export function lineOf(p: Problem): string {
  return `${p.code}: ${p.text}`;
}

/** A collector: `add` while reading, `throwIfAny` once at the end. */
export class Problems {
  readonly list: Problem[] = [];
  add(code: string, text: string): void {
    this.list.push({ code, text });
  }
  get any(): boolean {
    return this.list.length > 0;
  }
  throwIfAny(): void {
    if (this.list.length > 0) throw new Refusal(this.list);
  }
}

/** A JSON value's type as a reader names it in a refusal. */
export function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  if (typeof v === 'string') return `the string ${JSON.stringify(v)}`;
  return `${typeof v} ${String(v)}`;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Refuse the keys of `obj` a reader does not know, by name, listing the ones it does. */
export function refuseUnknownKeys(problems: Problems, code: string, where: string, obj: Record<string, unknown>, known: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) problems.add(code, `${where} has a key this reader does not know: ${JSON.stringify(k)}; the keys it reads are ${known.join(', ')}`);
  }
}

/** Parse JSON text, refusing with the file and the parser's own message. */
export function parseJson(text: string, where: string, code: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Refusal([{ code, text: `${where} is not JSON: ${(e as Error).message}` }]);
  }
}
