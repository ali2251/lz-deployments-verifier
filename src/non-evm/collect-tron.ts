/**
 * Tron collector. The Tron DVN is the EVM contract behind TronGrid's Ethereum-style
 * JSON-RPC, so it is read with the same ABI as the EVM verifier.
 */
import { decodeFunctionResult, encodeFunctionData, getAddress, type Hex } from 'viem';
import { dvnAbi } from '../abi.js';
import type { ChainSnapshot, PathwaySnapshot } from './policy.js';
import { createJsonRpc, openRun } from './run.js';

const TRON_RPC = 'https://api.trongrid.io/jsonrpc';
const TRON_MAINNET_CHAIN_ID = 728126428n;
// TronGrid's public endpoint is rate limited: 1.2s between requests, 5s before a retry
const RETRY = { attempts: 5, timeoutMs: 15_000, paceMs: 1200, backoffMs: () => 3800 };

/** The sample quote: confirmations 1, a placeholder sender, no options. */
const QUOTE_CONFIRMATIONS = 1n;
const QUOTE_SENDER = '0x000000000000000000000000000000000000dEaD';
const QUOTE_OPTIONS = '0x';

const run = openRun();
const rpc = createJsonRpc(run, TRON_RPC, RETRY);
const { address: rawAddress, source: addressSource } = run.input('tron-address-source');
const address = getAddress(rawAddress);
const expectedSigners: string[] = run.input('expected').chains.tron.signers;

type DvnFunction = Extract<(typeof dvnAbi)[number], { type: 'function' }>['name'];

/** eth_call a DVN view function. `evidenceSuffix` keeps per-argument evidence files apart. */
async function read(functionName: DvnFunction, args: readonly unknown[] = [], evidenceSuffix = ''): Promise<any> {
  const data = encodeFunctionData({ abi: dvnAbi, functionName, args } as any);
  const result: Hex = await rpc(`tron-${functionName}${evidenceSuffix}`, 'eth_call', [{ to: address, data }, 'latest']);
  return decodeFunctionResult({ abi: dvnAbi, functionName, data: result } as any);
}

async function readPathway(dst: { name: string; eid: number }): Promise<PathwaySnapshot> {
  const pathway: PathwaySnapshot = { dst: dst.name, eid: dst.eid };
  try {
    const [gas, multiplierBps, floorMarginUSD] = await read('dstConfig', [dst.eid], `-${dst.eid}`);
    Object.assign(pathway, { gas, multiplierBps, floorMarginUSD });
    pathway.configStatus = gas > 0n && floorMarginUSD === 0n ? 'PASS' : 'FAIL';
  } catch (err: any) {
    pathway.configStatus = 'ERROR';
    pathway.configError = err.message;
  }
  try {
    pathway.feeRaw = await read('getFee', [dst.eid, QUOTE_CONFIRMATIONS, QUOTE_SENDER, QUOTE_OPTIONS], `-${dst.eid}`);
    pathway.quoteStatus = 'PASS';
  } catch (err: any) {
    pathway.quoteStatus = 'FAIL';
    pathway.error = err.message;
  }
  return pathway;
}

// --- network and deployment ---
const chainId = await rpc('tron-chainId', 'eth_chainId', []);
if (BigInt(chainId) !== TRON_MAINNET_CHAIN_ID) throw new Error('Wrong Tron network');
const code = await rpc('tron-code', 'eth_getCode', [address, 'latest']);
if (!code || code === '0x') throw new Error('No bytecode');

// --- worker ---
const worker = {
  quorum: await read('quorum'),
  signerSize: await read('signerSize'),
  paused: await read('paused'),
  allowlistSize: await read('allowlistSize'),
  defaultMultiplierBps: await read('defaultMultiplierBps'),
  priceFeed: await read('priceFeed'),
  workerFeeLib: await read('workerFeeLib'),
  vid: await read('vid'),
};

// --- signers: the contract has no signer list, so check the count plus each expected member ---
const signerMembership: Record<string, boolean> = {};
for (const signer of expectedSigners) signerMembership[signer] = await read('signers', [signer], `-${signer}`);
const isActive = (signer: string) => signerMembership[signer] === true;
const signerSetMatchesExpected = String(worker.signerSize) === String(expectedSigners.length) && expectedSigners.every(isActive);
console.log('Tron expected signer set matches:', signerSetMatchesExpected);

const isNonZero = (value: unknown) => typeof value === 'string' && !/^0x0+$/.test(value);
const snapshot: ChainSnapshot & Record<string, unknown> = {
  ...run.snapshot(address),
  addressSource,
  ...worker,
  expectedSigners,
  signerMembership,
  signerSetMatchesExpected,
  signerAddresses: expectedSigners.filter(isActive),
  pathways: [],
  checks: { network: true, deployed: true, feeDependencies: isNonZero(worker.priceFeed) && isNonZero(worker.workerFeeLib) },
};

// --- destinations: saved after each one, so an interrupted run leaves its evidence behind ---
for (const dst of run.destinations('tron')) {
  const pathway = await readPathway(dst);
  snapshot.pathways.push(pathway);
  run.save('tron-final', snapshot);
  console.log('tron ->', dst.name, pathway.configStatus, pathway.quoteStatus);
}

snapshot.completedAt = new Date().toISOString();
run.save('tron-final', snapshot);
