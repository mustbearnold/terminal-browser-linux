import fs from "node:fs";
import path from "node:path";

/** Chromium's Linux sandbox needs either unprivileged user namespaces or a
 * setuid-root chrome-sandbox helper. Ubuntu 24.04+ restricts the former by
 * default and a user-writable install can't provide the latter, so when
 * neither is available the browser has to run unsandboxed or it won't start.
 * Renderer processes still get the seccomp layer either way. */
export function linuxSandboxAvailable(): boolean {
  try {
    const helper = path.join(path.dirname(process.execPath), "chrome_sandbox");
    const setuidHelper = path.join(path.dirname(process.execPath), "chrome-sandbox");
    for (const candidate of [setuidHelper, helper]) {
      const stat = fs.statSync(candidate, { throwIfNoEntry: false });
      if (stat && stat.uid === 0 && (stat.mode & 0o4000) !== 0) return true;
    }
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
