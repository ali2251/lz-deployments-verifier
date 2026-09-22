/**
 * Stellar collector. The DVN is a Soroban contract; its view functions are read by
 * simulating an invocation (nothing is signed or submitted).
 */
import { getAddress } from 'viem';
import type { Destination } from '../types.js';
import type { ChainSnapshot, PathwaySnapshot } from './policy.js';
import { createJsonRpc, loadSdk, openRun } from './run.js';

const stellar = loadSdk('@stellar/stellar-sdk');
// not part of the SDK's public exports
const { specFromWasm } = loadSdk('./node_modules/@stellar/stellar-sdk/lib/cjs/contract/wasm_spec_parser.js');
const { xdr } = stellar;

const SOROBAN_RPC = 'https://mainnet.sorobanrpc.com';
const RETRY = { attempts: 4, timeoutMs: 20_000, paceMs: 0, backoffMs: (failures: number) => 1000 * failures };

const run = openRun();
const rpc = createJsonRpc(run, SOROBAN_RPC, RETRY);

/** The inventory stores the contract id as hex; Soroban addresses it as a "C..." strkey. */
const contractIdHex: string = run.input('deployment').config.contractAddresses.stellar;
const contractAddress: string = stellar.StrKey.encodeContract(Buffer.from(contractIdHex.slice(2).padStart(64, '0'), 'hex'));

async function readLedgerEntry(evidenceName: string, key: any): Promise<any> {
  const { entries } = await rpc(evidenceName, 'getLedgerEntries', { keys: [key.toXDR('base64')] });
  if (entries?.length !== 1) throw new Error('Stellar contract missing');
  return xdr.LedgerEntryData.fromXDR(entries[0].xdr, 'base64');
}

// --- network and deployment: load the contract instance, then its WASM for the function signatures ---
const network = await rpc('stellar-network', 'getNetwork', {});
if (network.passphrase !== stellar.Networks.PUBLIC) throw new Error('Wrong Stellar network');

const instanceKey = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: new stellar.Address(contractAddress).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent,
  }),
);
const instance = (await readLedgerEntry('stellar-instance', instanceKey)).contractData.val.instance;

const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: instance.executable.wasmHash }));
const wasm = (await readLedgerEntry('stellar-wasm', codeKey)).contractCode.code;
const spec = new stellar.contract.Spec(specFromWasm(wasm));

// A simulation needs a source account. The contract's own deposit address is one that is known to exist.
const storage: Array<[any, any]> = instance.storage.map((entry: any) => [
  stellar.scValToNative(entry.key),
  stellar.scValToNative(entry.val),
]);
run.save('stellar-storage', storage);
const sourceAccount: string | undefined = storage.find(([key]) => key[0] === 'DepositAddress')?.[1];
if (!sourceAccount) throw new Error('No Stellar source account');

/** Simulates contract.<functionName>(args) and returns the decoded return value. */
async function invoke(evidenceName: string, functionName: string, args: Record<string, unknown> = {}): Promise<any> {
  const call = new stellar.Contract(contractAddress).call(functionName, ...spec.funcArgsToScVals(functionName, args));
  const transaction = new stellar.TransactionBuilder(new stellar.Account(sourceAccount, '0'), {
    fee: '100',
    networkPassphrase: stellar.Networks.PUBLIC,
  })
    .addOperation(call)
    .setTimeout(300)
    .build();

  const simulation = await rpc(evidenceName, 'simulateTransaction', { transaction: transaction.toXDR() });
  if (simulation.error) throw new Error(simulation.error);
  const returnValue = simulation.results?.[0]?.xdr;
  if (!returnValue) throw new Error('No return value');
  return stellar.scValToNative(xdr.ScVal.fromXDR(returnValue, 'base64'));
}

// --- worker: each view function is saved as stellar-<function>.json ---
const view = (functionName: string) => invoke(`stellar-${functionName}`, functionName);
const worker = {
  address: contractAddress,
  get_signers: await view('get_signers'),
  threshold: await view('threshold'),
  paused: await view('paused'),
  allowlist_size: await view('allowlist_size'),
  default_multiplier_bps: await view('default_multiplier_bps'),
  message_libs: await view('message_libs'),
  price_feed: await view('price_feed'),
  worker_fee_lib: await view('worker_fee_lib'),
};
const signerAddresses: string[] = worker.get_signers.map((signer: Uint8Array) =>
  getAddress('0x' + Buffer.from(signer).toString('hex')),
);
run.save('stellar-decoded', { ...worker, signerAddresses });
console.log('Stellar live signers:', signerAddresses.join(', '));

if (!worker.price_feed || !worker.worker_fee_lib || !worker.message_libs?.length) {
  throw new Error('Incomplete Stellar fee dependencies');
}

async function readPathway(dst: Destination): Promise<PathwaySnapshot> {
  const pathway: PathwaySnapshot = { dst: dst.name, eid: dst.eid };
  try {
    const dstConfig = await invoke(`stellar-dst-${dst.eid}`, 'dst_config', { dst_eid: dst.eid });
    if (!dstConfig) {
      pathway.configStatus = 'MISSING';
    } else {
      pathway.gas = String(dstConfig.gas);
      pathway.floorMarginUSD = String(dstConfig.floor_margin_usd);
      pathway.multiplierBps = dstConfig.multiplier_bps;
      pathway.configStatus = BigInt(pathway.gas) > 0n && pathway.floorMarginUSD === '0' ? 'PASS' : 'FAIL';
    }
  } catch (err: any) {
    pathway.configStatus = 'ERROR';
    pathway.configError = err.message;
  }
  try {
    // the sample quote: an empty 81-byte packet header, a zero payload hash, 1 confirmation, no options
    const fee = await invoke(`stellar-quote-${dst.eid}`, 'get_fee', {
      send_lib: worker.message_libs[0],
      sender: sourceAccount,
      dst_eid: dst.eid,
      packet_header: Buffer.alloc(81),
      payload_hash: Buffer.alloc(32),
      confirmations: 1n,
      options: Buffer.alloc(0),
    });
    pathway.feeRaw = String(fee);
    pathway.quoteStatus = 'PASS';
  } catch (err: any) {
    pathway.quoteStatus = 'FAIL';
    pathway.error = err.message;
  }
  return pathway;
}

const snapshot: ChainSnapshot = {
  ...run.snapshot(contractAddress),
  signerAddresses,
  quorum: worker.threshold,
  paused: worker.paused,
  allowlistSize: worker.allowlist_size,
  defaultMultiplierBps: worker.default_multiplier_bps,
  pathways: [],
  checks: { network: true, deployed: true, feeDependencies: true },
};

// --- destinations: saved after each one, so an interrupted run leaves its evidence behind ---
for (const dst of run.destinations('stellar')) {
  const pathway = await readPathway(dst);
  snapshot.pathways.push(pathway);
  run.save('stellar-final', snapshot);
  console.log('stellar ->', dst.name, pathway.configStatus, pathway.quoteStatus);
}

snapshot.completedAt = new Date().toISOString();
run.save('stellar-final', snapshot);
