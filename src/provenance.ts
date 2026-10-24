/**
 * rig-c/pose#270: the record `retarget --build` writes beside the build —
 * `rig-pose-retarget/1`, what made it: this package's and rig-c's versions,
 * each input as given on the command line with the sha256 of the bytes the run
 * read, the sequence's own `source`, every retarget option as resolved, and the
 * author's `--reference` echoed verbatim when one was given. Pure: the caller
 * hashes and writes. No clock, no host, no path is normalised; a value the run
 * was not given is absent, never derived.
 */
import pkg from '../package.json' with { type: 'json' };

/** The record's file name inside the `--build` directory. */
export const PROVENANCE_FILE = 'retarget.json';
export const PROVENANCE_SPEC = 'rig-pose-retarget/1';

export interface ProvenanceInput {
  /** The path as given on the command line, and the sha256 (hex) of the file's bytes. */
  path: string;
  sha256: string;
}

export interface ProvenanceArgs {
  /** rig-c's version, as `rigcVersion()` read it from the gate's own launcher. */
  rigc: string;
  /** `--rig` as given; the hash is of the rig spec (`rig.json`) rigc gated. */
  rig: ProvenanceInput;
  map: ProvenanceInput;
  /** `--sequence` as given, with the document's `source` string verbatim. */
  sequence: ProvenanceInput & { source: string };
  /** The animation's name, then the report's `options` in their order. */
  name: string;
  options: Record<string, unknown>;
  /** `--reference` exactly as given; absent when it was not. */
  reference?: string;
  /** #408: every additional consumed input, only on an opted-in run. */
  shoulderLift?: { configuration: ProvenanceInput; rest: ProvenanceInput; painting: ProvenanceInput };
}

/** The record's text: fixed key order, 2-space JSON, a trailing newline. */
export function provenanceText(a: ProvenanceArgs): string {
  const record = {
    spec: PROVENANCE_SPEC,
    pose: { version: pkg.version },
    rigc: { version: a.rigc },
    inputs: {
      rig: { path: a.rig.path, sha256: a.rig.sha256 },
      map: { path: a.map.path, sha256: a.map.sha256 },
      sequence: { path: a.sequence.path, sha256: a.sequence.sha256, source: a.sequence.source },
      ...(a.shoulderLift === undefined ? {} : { shoulderLift: a.shoulderLift }),
    },
    flags: { name: a.name, ...a.options },
    ...(a.reference === undefined ? {} : { reference: a.reference }),
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}
