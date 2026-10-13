#!/usr/bin/env bun
/**
 * rig-pose — puts motion from a body-18 pose sequence onto a rig rig-c built.
 *
 * The command line is the interface for an agent that cannot see the rig: every
 * refusal names the rule, the object, the value found and the value required,
 * and the exit code says which kind of outcome it was (README, "Exit codes").
 */
import pkg from './package.json' with { type: 'json' };

const HELP = `rig-pose ${pkg.version} — motion from a pose sequence onto a rig-c rig

Usage:
  rig-pose retarget --rig <build> --map <map.json> --pose <pose.json> --out <motion.json> [--name <animation>]
  rig-pose --version
  rig-pose --help

Exit codes: 0 written, 1 refused (every reason printed), 2 bad invocation.
`;

export function main(argv: string[]): number {
  const [cmd] = argv;
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  process.stderr.write(`rig-pose: unknown command "${cmd}" — the commands are: retarget\n`);
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
