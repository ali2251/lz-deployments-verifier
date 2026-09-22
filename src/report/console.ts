/** Console output: progress lines, the chain table, -v/-vv detail, and the findings list. */
import type { Expected } from '../config.js';
import type { ChainResult, Finding, PathwayRow, Severity } from '../types.js';
import { byName, isConfigOnly, isNotable, median, pathwayStats, totals, usd } from './summary.js';

// ---------------------------------------------------------------------------
// styling
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const style = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = style('2');
const bold = style('1');
const red = style('31');
const green = style('32');
const yellow = style('33');
const cyan = style('36');
const grey = style('90');

/** Fit `text` to exactly `width` columns, truncating if needed. */
function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

const STATUS_LABEL: Record<ChainResult['status'], string> = {
  OK: green('PASS'),
  FAIL: red('FAIL'),
  ERROR: yellow('ERR '),
  SKIPPED: grey('SKIP'),
};

function severityLabel(severity: Severity): string {
  if (severity === 'FAIL') return red('FAIL');
  if (severity === 'ERROR') return yellow('ERR ');
  if (severity === 'WARN') return yellow('WARN');
  return dim('INFO');
}

function groupBy<T>(items: T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item)) ?? [];
    group.push(item);
    groups.set(key(item), group);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// progress, printed as each chain finishes
// ---------------------------------------------------------------------------

export function printProgress(result: ChainResult, done: number, total: number, verbose: number): void {
  let status = 'ERR ';
  if (result.status === 'FAIL') status = 'FAIL';
  if (result.status === 'OK') status = isConfigOnly(result) ? 'CONFIG' : 'ok  ';

  const passed = result.findings.filter((f) => f.severity === 'PASS').length;
  const detail = verbose > 0 ? `  ${passed} checks passed, ${pathwayStats(result).configured} pathways  ${result.rpc ?? ''}` : '';
  console.log(`  [${String(done).padStart(2)}/${total}] ${status} ${result.name.padEnd(14)}${detail}`);
}

// ---------------------------------------------------------------------------
// chain table
// ---------------------------------------------------------------------------

const TABLE_HEADER =
  `${pad('', 4)}  ${pad('chain', 16)} ${pad('eid', 7)} ${pad('signers', 9)} ` +
  `${pad('dst cfg', 9)} ${pad('floor!=0', 9)} ${pad('median fee', 14)}`;

/** The signer column is "ok" only if a signer was confirmed and no multisig check failed or errored. */
function signersVerified(result: ChainResult): boolean {
  const confirmed = result.findings.some((f) => f.check === 'multisig.signer' && f.severity === 'PASS');
  const problem = result.findings.some((f) => f.check.startsWith('multisig') && ['FAIL', 'ERROR'].includes(f.severity));
  return confirmed && !problem;
}

function tableRow(result: ChainResult): string {
  const name = pad(result.name, 16);
  const eid = pad(String(result.eid ?? '?'), 7);

  if (result.status === 'SKIPPED') return `${STATUS_LABEL.SKIPPED}  ${name} ${dim(result.skipReason ?? '')}`;

  if (result.status === 'ERROR' && result.pathways.length === 0) {
    const why = result.findings.find((f) => f.severity === 'ERROR');
    const reason = `${why?.check ?? 'unreachable'} — ${(why?.detail ?? '').split('\n')[0]}`;
    return `${STATUS_LABEL.ERROR}  ${name} ${eid} ${dim(reason)}`;
  }

  const stats = pathwayStats(result);
  const status = result.status === 'OK' && isConfigOnly(result) ? 'CONFIG' : STATUS_LABEL[result.status];
  const signers = signersVerified(result) ? pad('ok', 9) : red(pad('MISMATCH', 9));
  const configured = pad(`${stats.configured}/${stats.total}`, 9);
  const floors = stats.nonZeroFloor === 0 ? pad('0', 9) : red(pad(String(stats.nonZeroFloor), 9));
  return `${status}  ${name} ${eid} ${signers} ${configured} ${floors} ${pad(usd(median(stats.feesUsd)), 14)}`;
}

// ---------------------------------------------------------------------------
// -v / -vv detail: what was actually read and which checks passed
// ---------------------------------------------------------------------------

function printWorker(result: ChainResult, expected: Expected): void {
  const worker = result.worker;
  if (!worker) return;

  let nativePrice = '';
  if (worker.nativeTokenPriceUSD !== null) {
    // keep four decimals of the price while it is still a bigint, then print two
    const price = Number(BigInt(worker.nativeTokenPriceUSD) / (expected.usdDenominator / 10000n)) / 10000;
    nativePrice = dim(`  native ≈ $${price.toFixed(2)}`);
  }
  const allowlist = worker.allowlistSize === '0' ? dim(' (open)') : red(' (GATED)');
  const vid = worker.vid === null ? '' : ` · vid ${worker.vid}`;

  console.log(`    ${pad('quorum', 18)} ${worker.quorum} of ${worker.signerSize} signer(s)`);
  console.log(`    ${pad('priceFeed', 18)} ${worker.priceFeed}${nativePrice}`);
  console.log(`    ${pad('workerFeeLib', 18)} ${worker.workerFeeLib}`);
  console.log(
    `    ${pad('worker', 18)} ${worker.defaultMultiplierBps} bps default · allowlist ${worker.allowlistSize}${allowlist}` +
      ` · paused ${worker.paused}${vid}`,
  );
}

/** Every check that ran, grouped by name so 49 identical pathway passes read as one line. */
function printChecks(findings: Finding[]): void {
  console.log(`    ${dim('checks')}`);
  for (const group of groupBy(findings, (f) => f.check)) {
    const first = group[0]!;
    const passed = group.filter((f) => f.severity === 'PASS').length;
    const failed = group.filter((f) => f.severity === 'FAIL').length;
    const other = group.length - passed - failed;

    let verdict = green('ok');
    if (failed > 0) verdict = red(`${failed} FAIL`);
    else if (other > 0 && passed === 0) verdict = yellow(`${other} skipped`);

    let summary = '';
    if (group.length > 1) summary = dim(` (${passed}/${group.length} passed)`);
    else if (first.severity === 'PASS' && first.actual) summary = dim(` ${first.actual}`);

    console.log(`      ${pad(first.check, 30)} ${verdict}${summary}`);

    // say exactly why anything that didn't pass didn't pass
    for (const finding of group.filter(isNotable)) {
      const why = [
        finding.dst ? `-> ${finding.dst}` : '',
        finding.expected !== undefined ? `expected=${finding.expected}` : '',
        finding.actual !== undefined ? `actual=${finding.actual}` : '',
      ].filter(Boolean);
      if (why.length) console.log(`        ${dim(why.join(' '))}`);
      if (finding.detail) for (const line of finding.detail.split('\n')) console.log(`        ${dim(line.trim())}`);
    }
  }
}

function printPathwayTable(pathways: PathwayRow[]): void {
  const columns = (dst: string, eid: string, gas: string, multiplier: string, floor: string, fee: string, feeUsd: string) =>
    `${pad(dst, 16)} ${pad(eid, 7)} ${pad(gas, 10)} ${pad(multiplier, 8)} ${floor} ${pad(fee, 18)} ${pad(feeUsd, 10)}`;

  console.log(`    ${dim('pathways')}`);
  console.log(`      ${dim(columns('destination', 'eid', 'gas', 'multBps', pad('floorUSD', 22), 'fee', 'usd'))}`);
  for (const p of [...pathways].sort((a, b) => a.dst.localeCompare(b.dst))) {
    const floor = pad(p.floorMarginUSD?.toString() ?? '-', 22);
    console.log(
      '      ' +
        columns(
          p.dst,
          String(p.dstEid),
          p.gas?.toString() ?? '-',
          p.multiplierBps?.toString() ?? '-',
          p.floorMarginUSD ? red(floor) : floor,
          p.feeNative ?? (p.error ? 'error' : '-'),
          usd(p.feeUsd),
        ),
    );
  }
}

function printChainDetail(result: ChainResult, expected: Expected, verbose: number): void {
  console.log('');
  console.log(`  ${cyan(result.name)} ${dim(`eid ${result.eid ?? '?'}  ${result.address}`)}`);
  if (result.status === 'SKIPPED') {
    console.log(`    ${dim(result.skipReason ?? 'skipped')}`);
    return;
  }

  if (result.rpc) console.log(`    ${pad('rpc', 18)} ${dim(result.rpc)}`);
  printWorker(result, expected);
  printChecks(result.findings);

  const fees = pathwayStats(result).feesUsd;
  if (fees.length > 0) {
    console.log(
      `    ${pad('fees', 18)} min ${usd(fees[0]!)} · median ${usd(median(fees))} · max ${usd(fees.at(-1)!)}` +
        dim(`  across ${fees.length} pathway(s)`),
    );
  }
  if (verbose >= 2 && result.pathways.length > 0) printPathwayTable(result.pathways);
}

// ---------------------------------------------------------------------------
// findings: everything that did not pass
// ---------------------------------------------------------------------------

function describeFinding(finding: Finding): string {
  const title = finding.dst ? `${finding.check} -> ${finding.dst}` : finding.check;
  let line = pad(title, 40);
  if (finding.expected !== undefined) line += ` expected=${finding.expected}`;
  if (finding.actual !== undefined) line += ` actual=${finding.actual}`;
  if (finding.detail) line += `\n        ${dim(finding.detail)}`;
  return line;
}

function printFindings(result: ChainResult): void {
  console.log('');
  console.log(`  ${cyan(result.name)} ${dim(`(eid ${result.eid ?? '?'}, ${result.address})`)}`);

  // collapse the same per-destination finding repeated across destinations into one line
  const sameProblem = (f: Finding) => `${f.check}|${f.expected ?? ''}|${f.dst ? '' : (f.actual ?? '')}`;
  const groups = groupBy(result.findings.filter(isNotable), sameProblem);
  for (const group of groups) {
    const first = group[0]!;
    if (group.length === 1 || !first.dst) {
      for (const finding of group) console.log(`    ${severityLabel(finding.severity)} ${describeFinding(finding)}`);
      continue;
    }
    const expected = first.expected !== undefined ? ` expected=${first.expected}` : '';
    console.log(`    ${severityLabel(first.severity)} ${pad(first.check, 34)} x${group.length}${expected}`);
    console.log(`        ${dim(group.map((f) => f.dst).join(', '))}`);
    if (first.detail) console.log(`        ${dim(first.detail)}`);
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function printConsole(results: ChainResult[], expected: Expected, verbose = 0): void {
  console.log('');
  if (results.some(isConfigOnly)) console.log('CONFIGURATION-ONLY results exclude live fee verification.');
  console.log(bold(`Canary DVN verification — deployment "${expected.deployment}"`));
  console.log(dim(`expected quorum ${expected.quorum} of ${expected.signers.length} signer(s): ${expected.signers.join(', ')}`));
  console.log('');

  console.log(bold(TABLE_HEADER));
  console.log(dim('-'.repeat(TABLE_HEADER.length)));
  for (const result of byName(results)) console.log(tableRow(result));

  if (verbose > 0) {
    console.log('');
    console.log(bold('Detail'));
    for (const result of byName(results)) printChainDetail(result, expected, verbose);
  }

  const withFindings = results.filter((r) => r.findings.some(isNotable));
  if (withFindings.length > 0) {
    console.log('');
    console.log(bold('Findings'));
    for (const result of withFindings) printFindings(result);
  }

  const t = totals(results);
  console.log('');
  console.log(
    bold('Summary  ') +
      `${t.ok} pass  ${t.fail} fail  ${t.error} error  ${t.skipped} skipped   ` +
      dim(`${t.pathwaysConfigured}/${t.pathways} pathways configured, ${t.failFindings} failing check(s)`),
  );
  console.log('');
}
