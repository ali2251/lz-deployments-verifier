import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. Default inputs, caches and reports are resolved against it, not the cwd. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const fromRoot = (...segments: string[]): string => resolve(ROOT, ...segments);
