/**
 * Decides which RPC endpoints to try for a chain, in order:
 *   1. rpc-overrides.json, when it has an entry for the chain
 *   2. otherwise LayerZero metadata endpoints (curated), then public chainlist ones as failover
 * An override list may contain "@auto" to splice the automatic endpoints (2) back in.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { ChainlistIndex } from './chainlist.js';
import type { ChainInfo } from './metadata.js';

/** Sentinel in an override list meaning "and then whatever resolves automatically". */
export const AUTO_RPC = '@auto';

/** chain name -> endpoints to try, possibly including AUTO_RPC */
export type RpcOverrides = Record<string, string[]>;

/** Where a chain's endpoint list came from, for the startup summary. */
export type RpcOrigin = 'override' | 'metadata' | 'metadata+chainlist' | 'chainlist';

const ENV_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/gi;
const UNFILLED_KEY = /YOUR_KEY_HERE|YOUR_ALCHEMY_KEY|<API_KEY>|YOUR_KEY\b/i;

/**
 * rpc-overrides.json: { "<chain>": "https://..." } or { "<chain>": ["url1", "url2", "@auto"] }
 *
 * ${ENV_VAR} in a URL is replaced from the environment, so a key need never be written
 * to disk. URLs whose variable is unset, or that still hold a placeholder key, are dropped.
 */
export function loadRpcOverrides(path: string): RpcOverrides {
  if (!existsSync(path)) return {};
  const raw: Record<string, string | string[]> = JSON.parse(readFileSync(path, 'utf8'));
  const unsetVariables = new Set<string>();
  const unfilledHosts = new Set<string>();

  /** The usable URL, or null if it has to be dropped. */
  const substitute = (url: string): string | null => {
    if (url === AUTO_RPC) return url;

    let unresolved = false;
    const resolved = url.replace(ENV_PLACEHOLDER, (placeholder, name: string) => {
      const value = process.env[name];
      if (value) return value;
      unsetVariables.add(name);
      unresolved = true;
      return placeholder;
    });
    if (unresolved || resolved.includes('${')) return null;

    // tolerate pasting the full key (which already starts with alch_) into the alch_ slot
    const deduped = resolved.replace(/\/v2\/alch_alch_/, '/v2/alch_');
    if (UNFILLED_KEY.test(deduped)) {
      unfilledHosts.add(deduped.replace(/^(https?:\/\/[^/]+).*$/, '$1'));
      return null;
    }
    return deduped;
  };

  const overrides: RpcOverrides = {};
  for (const [chain, value] of Object.entries(raw)) {
    if (chain.startsWith('$')) continue; // "$comment" and friends
    const urls = (Array.isArray(value) ? value : [value]).map(substitute).filter((url) => url !== null);
    if (urls.length > 0) overrides[chain] = urls;
  }

  if (unsetVariables.size > 0) {
    console.warn(`! rpc-overrides: unset env var(s) ${[...unsetVariables].join(', ')} — those endpoints were dropped`);
  }
  if (unfilledHosts.size > 0) {
    console.warn(
      `! rpc-overrides: ${unfilledHosts.size} endpoint(s) still contain a placeholder key and were dropped.\n` +
        '  Replace YOUR_KEY_HERE with your Alchemy key (or set ALCHEMY_KEY in the environment).',
    );
  }
  return overrides;
}

/** Concatenate endpoint lists in priority order, dropping duplicates, keeping at most `max`. */
export function mergeRpcs(primary: string[], fallback: string[], max: number): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const url of [...primary, ...fallback]) {
    const key = url.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(url);
    if (merged.length >= max) break;
  }
  return merged;
}

export function resolveRpcs(
  chain: ChainInfo,
  override: string[] | undefined,
  chainlist: ChainlistIndex,
  maxAutoRpcs: number,
): { rpcs: string[]; origin: RpcOrigin } {
  const publicRpcs = chain.nativeChainId === null ? [] : (chainlist.get(chain.nativeChainId) ?? []);
  const autoRpcs = mergeRpcs(chain.rpcs, publicRpcs, maxAutoRpcs);

  if (override) {
    // explicit URLs never count against the cap on automatic ones
    const explicitCount = override.filter((url) => url !== AUTO_RPC).length;
    const expanded = override.flatMap((url) => (url === AUTO_RPC ? autoRpcs : [url]));
    return { rpcs: mergeRpcs(expanded, [], explicitCount + maxAutoRpcs), origin: 'override' };
  }

  let origin: RpcOrigin = 'metadata';
  if (chain.rpcs.length === 0) origin = 'chainlist';
  else if (publicRpcs.length > 0) origin = 'metadata+chainlist';
  return { rpcs: autoRpcs, origin };
}
