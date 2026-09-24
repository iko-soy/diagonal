/**
 * `brew upgrade` swaps the unpacked extension's folder for the new release, but the browser keeps running
 * the old code until someone clicks reload. An unpacked extension serves its files straight from disk, so
 * the worker can read the manifest that is on disk now and reload itself when it is newer.
 */
export const UPDATE_CHECK_MINUTES = 2;
export const TRIED_KEY = "selfUpdateTried";

export interface DiskCheck {
  /** Version of the code running now. */
  running: string;
  /** Version in manifest.json on disk, if it could be read. */
  onDisk?: string;
  /** background.js on disk could be read too, so the folder is not mid-copy. */
  filesReady: boolean;
  /** On-disk version a reload was already tried for; never try the same one twice. */
  lastTried?: string;
}

/** Dotted numeric versions ("2026.9.24.512" vs "2026.09.24.0512"): <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n));
  const pb = b.split(".").map((n) => Number(n));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const VERSION = /^\d+(\.\d+){0,3}$/;

export function shouldReload(c: DiskCheck): boolean {
  if (!c.filesReady || !c.onDisk || !VERSION.test(c.onDisk) || !VERSION.test(c.running)) return false;
  if (c.lastTried === c.onDisk) return false;
  return compareVersions(c.onDisk, c.running) > 0;
}

/** Reads the on-disk manifest and background.js, bypassing any cache. */
export async function readDisk(fetchImpl: typeof fetch, url: (path: string) => string): Promise<Pick<DiskCheck, "onDisk" | "filesReady">> {
  try {
    const [m, bg] = await Promise.all([
      fetchImpl(url("manifest.json"), { cache: "no-store" }),
      fetchImpl(url("background.js"), { cache: "no-store" }),
    ]);
    if (!m.ok || !bg.ok) return { filesReady: false };
    const manifest = (await m.json()) as { version?: unknown };
    const body = await bg.text();
    return { onDisk: typeof manifest.version === "string" ? manifest.version : undefined, filesReady: body.length > 0 };
  } catch {
    return { filesReady: false };
  }
}
