/**
 * Public RPC endpoints from the ethereum-lists/chains dataset (the data behind
 * chainlist.org), keyed by EVM chain id.
 *
 * Used as an automatic fallback layer beneath the LayerZero metadata RPCs, so a
 * chain whose metadata lists no endpoint — or a dead one — still gets tried
 * against whatever public infrastructure exists. Matching is by numeric chain id,
 * never by name, so there is no chance of resolving the wrong network.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Built artifact of ethereum-lists/chains. chainid.network serves the same file. */
const SOURCES = [
  'https://raw.githubusercontent.com/ethereum-lists/chains/gh-pages/chains.json',
  'https://chainid.network/chains.json',
];
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ChainlistIndex = Map<number, string[]>;

interface Options {
  cachePath: string;
  file?: string;
  refresh?: boolean;
  /** most public endpoints to keep per chain (they are tried in order, each costing a timeout) */
  perChain?: number;
}

function usableRpcs(entry: any, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of entry?.rpc ?? []) {
    if (typeof raw !== 'string') continue;
    // ${INFURA_API_KEY} style placeholders and websocket endpoints are no use to us
    if (!raw.startsWith('http')) continue;
    if (raw.includes('${')) continue;
    const url = raw.replace(/\/+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

export async function loadChainlist(opts: Options): Promise<ChainlistIndex> {
  const perChain = opts.perChain ?? 4;
  let raw: any[] | null = null;

  if (opts.file) {
    if (!existsSync(opts.file)) throw new Error(`--chainlist-file not found: ${opts.file}`);
    raw = JSON.parse(readFileSync(opts.file, 'utf8'));
  } else {
    const cached =
      !opts.refresh && existsSync(opts.cachePath) && Date.now() - statSync(opts.cachePath).mtimeMs < CACHE_TTL_MS;
    if (cached) {
      try {
        raw = JSON.parse(readFileSync(opts.cachePath, 'utf8'));
      } catch {
        /* refetch */
      }
    }
    if (!raw) {
      const errors: string[] = [];
      for (const url of SOURCES) {
        try {
          const res = await fetch(url, { headers: { accept: 'application/json' } });
          if (!res.ok) {
            errors.push(`${url}: HTTP ${res.status}`);
            continue;
          }
          raw = (await res.json()) as any[];
          mkdirSync(dirname(opts.cachePath), { recursive: true });
          writeFileSync(opts.cachePath, JSON.stringify(raw));
          break;
        } catch (err: any) {
          errors.push(`${url}: ${err?.message ?? err}`);
        }
      }
      if (!raw && existsSync(opts.cachePath)) {
        console.warn('! chainlist fetch failed — using stale cache');
        raw = JSON.parse(readFileSync(opts.cachePath, 'utf8'));
      }
      if (!raw) {
        console.warn(`! chainlist unavailable, continuing without it:\n    ${errors.join('\n    ')}`);
        return new Map();
      }
    }
  }

  const index: ChainlistIndex = new Map();
  for (const entry of raw ?? []) {
    const id = Number(entry?.chainId);
    if (!Number.isFinite(id)) continue;
    const rpcs = usableRpcs(entry, perChain);
    if (rpcs.length > 0) index.set(id, rpcs);
  }
  return index;
}

/** LayerZero metadata endpoints first (curated), public ones appended as failover. */
export function mergeRpcs(primary: string[], fallback: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of [...primary, ...fallback]) {
    const key = url.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}
