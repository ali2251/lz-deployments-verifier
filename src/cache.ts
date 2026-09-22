/** JSON file cache for the metadata and chainlist downloads. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Read a cached download. Returns null when the file is missing, unparsable, or older
 * than `maxAgeMs`. Omit `maxAgeMs` to accept a stale cache as a last resort.
 */
export function readCache<T>(path: string, maxAgeMs = Infinity): T | null {
  if (!existsSync(path)) return null;
  if (Date.now() - statSync(path).mtimeMs >= maxAgeMs) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeCache(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
