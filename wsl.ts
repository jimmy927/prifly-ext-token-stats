/**
 * Folders inside WSL, seen from a Windows host.
 *
 * prifly mirrors a WSL distribution's transcripts to Windows, and their
 * sessions' folders are the distribution's own (`/home/jimmy/src/odi`). On
 * Windows such a folder is `\\wsl.localhost\<distro>\home\jimmy\src\odi`, which
 * `node:fs` reads; git is run inside the distribution instead (`wsl.exe -d
 * <distro> -- git -C /home/...`): Windows' git refuses the share's owner
 * ("dubious ownership"), and reads it over 9P far slower.
 *
 * Only running distributions are tried, so a look never starts one, and
 * Docker Desktop's are left out. Elsewhere than Windows nothing is translated.
 */

import { existsSync } from "node:fs";

const IS_WINDOWS = process.platform === "win32";
/** How long the list of running distributions is trusted. */
const DISTROS_FOR_MS = 5 * 60_000;
const UNC = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i;

let distros: { names: string[]; at: number } | null = null;

/** `wsl.exe -l -q --running`, which answers in UTF-16. */
function readDistros(): string[] {
  try {
    const ran = Bun.spawnSync(["wsl.exe", "-l", "-q", "--running"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    if (ran.exitCode !== 0) return [];
    return Buffer.from(ran.stdout)
      .toString("utf16le")
      .split(/\r?\n/)
      .map((name) => name.replace(/\0/g, "").trim())
      .filter((name) => name !== "" && !name.startsWith("docker-desktop"));
  } catch {
    // No wsl.exe: no distributions.
    return [];
  }
}

function runningDistros(now = Date.now()): string[] {
  if (!IS_WINDOWS) return [];
  if (distros === null || now - distros.at > DISTROS_FOR_MS) {
    distros = { names: readDistros(), at: now };
  }
  return distros.names;
}

const uncOf = (distro: string, posix: string) =>
  `\\\\wsl.localhost\\${distro}${posix.replace(/\/+$/, "").replaceAll("/", "\\")}`;

/**
 * Where this host reads a folder: a WSL folder (`/home/...`) on Windows as
 * its `\\wsl.localhost\` path, in the first running distribution that has
 * its top folder; anything else as it is.
 */
export function hostPath(path: string): string {
  if (!IS_WINDOWS || !path.startsWith("/") || path.startsWith("//")) return path;
  const top = `/${path.split("/")[1] ?? ""}`;
  for (const distro of runningDistros()) {
    if (existsSync(uncOf(distro, top))) return uncOf(distro, path);
  }
  return path;
}

/** A `\\wsl.localhost\<distro>\...` path as its distribution and its path inside it; null for any other. */
export function wslTarget(path: string): { distro: string; posix: string } | null {
  const match = UNC.exec(path);
  if (match === null) return null;
  const [, distro = "", rest = ""] = match;
  return { distro, posix: rest === "" ? "/" : rest.replaceAll("\\", "/") };
}

/** A path a file inside `near`'s distribution names (`/home/...`), as this host reads it. */
export function besides(near: string, posix: string): string {
  const target = wslTarget(near);
  return target !== null && posix.startsWith("/") ? uncOf(target.distro, posix) : posix;
}
