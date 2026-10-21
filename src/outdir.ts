/**
 * Where a command's output goes (rig-c/pose#239, #284). A file a command writes goes into a
 * directory the user named: one that is not there yet is made just before the write (mkdir -p),
 * and a `made directory` line says so and which paths it holds. A file where a directory has to
 * be made, or a directory that cannot be written into, is refused by name (`ARG_PATH`) before
 * anything is read or written.
 */
import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Problems } from './problems.ts';

/** The directories to make before writing, each with the `<flag> <path>`s written into it, in the order named. */
export type OutDirs = Map<string, string[]>;

const writable = (dir: string): boolean => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Check where each named output lands: its directory is there and this process can write into it
 * (rig-c/pose#323), or the nearest existing ancestor is a directory this process can write into.
 * A miss is added to `p`; a directory still to make is added to `dirs`. A directory a flag names itself (--build, --render) is checked by its parent.
 */
export function planOutDirs(outputs: ReadonlyArray<readonly [string, string | undefined]>, p: Problems, dirs: OutDirs = new Map()): OutDirs {
  for (const [flag, path] of outputs) {
    if (path === undefined) continue;
    const dir = dirname(path);
    let up = dir;
    while (!existsSync(up) && dirname(up) !== up) up = dirname(up);
    if (!statSync(up).isDirectory()) p.add('ARG_PATH', up === dir ? `${flag} ${path} — ${dir} is not a directory` : `${flag} ${path} — ${up} is a file, so directory ${dir} cannot be made under it`);
    else if (!writable(up)) p.add('ARG_PATH', up === dir ? `${flag} ${path} — ${dir} is not writable` : `${flag} ${path} — ${up} is not writable, so directory ${dir} cannot be made under it`);
    else if (up !== dir) dirs.set(dir, [...(dirs.get(dir) ?? []), `${flag} ${path}`]);
  }
  return dirs;
}

/** Make each planned directory (mkdir -p) and print its line; run after the command is green, just before it writes. */
export function makeOutDirs(dirs: OutDirs, tell: (l: string) => void): void {
  for (const [dir, flags] of dirs) {
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    tell(madeLine(dir, flags));
  }
}

/** rig-c/pose#239: the line a directory this run made prints — the directory, and the paths that named it. */
export function madeLine(dir: string, flags: readonly string[]): string {
  return `  made directory ${dir} — it did not exist; ${flags.join(' and ')} ${flags.length === 1 ? 'is' : 'are'} written into it`;
}
