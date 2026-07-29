import fs from "node:fs";
import path from "node:path";

/** Chromium's Linux sandbox needs a non-root user plus either unprivileged
 * user namespaces or a setuid-root chrome-sandbox helper. Root is refused
 * outright, Ubuntu 24.04+ restricts user namespaces by default, and a
 * user-writable install can't ship a setuid helper — in those environments
 * the browser has to launch with --no-sandbox or it won't start at all.
 * Renderers keep their seccomp layer either way. */
export function linuxSandboxAvailable(electronBinary: string): boolean {
  if (process.getuid?.() === 0) return false;
  try {
    const helper = path.join(path.dirname(electronBinary), "chrome-sandbox");
    const stat = fs.statSync(helper, { throwIfNoEntry: false });
    if (stat && stat.uid === 0 && (stat.mode & 0o4000) !== 0) return true;
  } catch {}
  try {
    const restricted = fs.readFileSync(
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
      "utf8",
    );
    if (restricted.trim() === "1") return false;
  } catch {}
  try {
    const clone = fs.readFileSync("/proc/sys/kernel/unprivileged_userns_clone", "utf8");
    if (clone.trim() === "0") return false;
  } catch {}
  return true;
}
