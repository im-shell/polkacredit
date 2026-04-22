/**
 * Index a Hydration mainnet address and compute a PolkaCredit score from
 * whatever on-chain activity we find in a recent block window.
 *
 * This is a pragmatic mapping — PolkaCredit's contracts aren't deployed on
 * Hydration, so we translate native Hydration events into the synthetic
 * event shape pointsCalculator expects:
 *
 *   staking.StakeAdded                    → polkacredit.Staked   (first time only)
 *   convictionVoting.Voted (Standard)     → opengov.Voted
 *   balances.Transfer where addr is from  → polkacredit.TransferVolumeThreshold
 *                                           emitted when cumulative USD volume
 *                                           crosses a band (SPEC §2.5)
 *
 * Caveats:
 *   - HDX→USD needs a price. Default HDX_USD=0.025. Override via env.
 *   - SPEC governance gate says "≥5 DOT". On Hydration we enforce ≥5 HDX
 *     instead; flag via OPENGOV_MIN=<n> if you want a different floor.
 *   - The SPEC inactivity penalty is disabled here because N blocks is far
 *     inside the 90-day grace window.
 *
 * Run with:
 *   npx tsx src/scripts/indexAddressFromHydration.ts \
 *     [--address <ss58>] [--blocks <n>] [--concurrency <n>]
 *
 * Env:
 *   HYDRATION_WSS   default wss://rpc.hydradx.cloud
 *   HDX_USD         default 0.025
 *   OPENGOV_MIN     default 5 (HDX, not DOT — see caveats above)
 *   OUT             default indexer/fixtures/<addr>-last<N>.json
 */

import { ApiPromise, WsProvider } from "@polkadot/api";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computePoints,
  pointsForTransferBand,
  type EventInput,
} from "../calculators/pointsCalculator.js";
import { computeScore } from "../calculators/scoreCalculator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── args ───────────────────────────────────────────────────────────
function argOr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const ADDRESS = argOr(
  "address",
  "12p8TxkyfmQBaSLooHA1NWRVjv7R8qgWfvKbVabEoH41L8jJ"
);
const BLOCKS = Number(argOr("blocks", "1000"));
const CONCURRENCY = Number(argOr("concurrency", "20"));
const WSS = process.env.HYDRATION_WSS ?? "wss://rpc.hydradx.cloud";
const HDX_USD = Number(process.env.HDX_USD ?? "0.025");
const HDX_DECIMALS = 12;
const OPENGOV_MIN = Number(process.env.OPENGOV_MIN ?? "5");
const OUT =
  process.env.OUT ??
  path.resolve(
    __dirname,
    "..",
    "..",
    "fixtures",
    `${ADDRESS}-last${BLOCKS}.json`
  );

// ─── helpers ────────────────────────────────────────────────────────
const addrHex = u8aToHex(decodeAddress(ADDRESS)).toLowerCase();
const addrPolkadotPrefix = encodeAddress(decodeAddress(ADDRESS), 0);
const addrHydrationPrefix = encodeAddress(decodeAddress(ADDRESS), 63);

function isSelf(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s.startsWith("0x")) return s === addrHex;
    return v === addrPolkadotPrefix || v === addrHydrationPrefix;
  }
  return false;
}

function eventRefsSelf(data: any): boolean {
  if (data == null) return false;
  if (Array.isArray(data)) return data.some(eventRefsSelf);
  if (typeof data === "object") return Object.values(data).some(eventRefsSelf);
  return isSelf(data);
}

function hdxToUsd(raw: bigint | number | string): number {
  const n =
    typeof raw === "bigint"
      ? Number(raw) / 10 ** HDX_DECIMALS
      : Number(raw) / 10 ** HDX_DECIMALS;
  return n * HDX_USD;
}

const TRANSFER_BANDS = [1_000, 10_000, 100_000, 1_000_000];

// ─── main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`address          : ${ADDRESS}`);
  console.log(`  hex            : ${addrHex}`);
  console.log(`  ss58 (prefix 0): ${addrPolkadotPrefix}`);
  console.log(`  ss58 (prefix 63): ${addrHydrationPrefix}`);
  console.log(`window           : last ${BLOCKS} finalized blocks`);
  console.log(`HDX/USD          : ${HDX_USD}`);
  console.log(`RPC              : ${WSS}`);
  console.log("");

  const api = await ApiPromise.create({ provider: new WsProvider(WSS) });
  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const finalizedHeader = await api.rpc.chain.getHeader(finalizedHash);
  const headNumber = finalizedHeader.number.toNumber();
  const from = headNumber - BLOCKS + 1;
  console.log(`finalized head   : #${headNumber}`);
  console.log(`scanning         : #${from}..#${headNumber}\n`);

  type Matched = {
    block: number;
    blockHash: string;
    timestampMs: number | null;
    section: string;
    method: string;
    data: any;
  };

  // Batched block fetches — each batch: getBlockHash + getHeader + events + timestamp.
  const matched: Matched[] = [];
  let scanned = 0;

  async function scanBlock(n: number): Promise<Matched[]> {
    const hash = await api.rpc.chain.getBlockHash(n);
    const apiAt = await api.at(hash);
    const [eventsCodec, tsCodec] = await Promise.all([
      apiAt.query.system.events() as any,
      (apiAt.query.timestamp?.now as any)?.() ?? Promise.resolve(null),
    ]);
    const timestampMs =
      tsCodec && typeof (tsCodec as any).toBigInt === "function"
        ? Number((tsCodec as any).toBigInt())
        : null;

    const hit: Matched[] = [];
    (eventsCodec as any).forEach((rec: any) => {
      const data = rec.event.data.toJSON();
      if (!eventRefsSelf(data)) return;
      hit.push({
        block: n,
        blockHash: hash.toHex(),
        timestampMs,
        section: rec.event.section,
        method: rec.event.method,
        data,
      });
    });
    return hit;
  }

  const numbers: number[] = [];
  for (let n = from; n <= headNumber; n++) numbers.push(n);

  for (let i = 0; i < numbers.length; i += CONCURRENCY) {
    const batch = numbers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(scanBlock));
    for (const arr of results) matched.push(...arr);
    scanned += batch.length;
    process.stdout.write(
      `  scanned ${scanned}/${numbers.length}   matches=${matched.length}\r`
    );
  }
  process.stdout.write("\n\n");
  matched.sort((a, b) => a.block - b.block);

  // ─── categorise & translate to EventInput shape ───
  console.log(`matched events   : ${matched.length}`);
  const tally = new Map<string, number>();
  for (const m of matched) {
    const k = `${m.section}.${m.method}`;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  if (tally.size === 0) {
    console.log("  (none — try a larger --blocks window)");
  } else {
    for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v.toString().padStart(4)} × ${k}`);
    }
  }
  console.log("");

  const popId = addrHex;
  const synthetic: EventInput[] = [];

  // 1) staking.StakeAdded → Staked (once)
  let seenStake = false;
  for (const m of matched) {
    if (m.section === "staking" && m.method === "StakeAdded" && !seenStake) {
      synthetic.push({
        source: "polkacredit",
        event_type: "Staked",
        pop_id: popId,
        block_number: m.block,
        block_timestamp: Math.floor((m.timestampMs ?? 0) / 1000),
        data: {},
      });
      seenStake = true;
    }
  }

  // 2) convictionVoting.Voted — require conviction ≥ 1 and locked balance ≥ OPENGOV_MIN HDX.
  //    vote byte encoding: low nibble = conviction (0..6), high bit = aye/nay.
  for (const m of matched) {
    if (m.section !== "convictionVoting" || m.method !== "Voted") continue;
    const [voter, _pollIndex, voteObj] = m.data as [string, unknown, any];
    if (!isSelf(voter)) continue;

    const std = voteObj?.standard;
    if (!std) continue; // skip Split/SplitAbstain for this mapping
    const voteByte =
      typeof std.vote === "string" ? parseInt(std.vote, 16) : Number(std.vote);
    const conviction = voteByte & 0x0f;
    const balanceHdx =
      Number(BigInt(std.balance ?? 0)) / 10 ** HDX_DECIMALS;
    if (conviction < 1 || balanceHdx < OPENGOV_MIN) continue;

    synthetic.push({
      source: "opengov",
      event_type: "Voted",
      pop_id: popId,
      block_number: m.block,
      block_timestamp: Math.floor((m.timestampMs ?? 0) / 1000),
      data: { conviction, dotCommitted: balanceHdx },
    });
  }

  // 3) balances.Transfer outgoing → cumulative USD → band-crossing events.
  let cumUsd = 0;
  const bandsEmitted = new Set<number>();
  for (const m of matched) {
    if (m.section !== "balances" || m.method !== "Transfer") continue;
    const [fromAddr, _to, amount] = m.data as [string, string, string | number];
    if (!isSelf(fromAddr)) continue; // count outflows as "volume sent"
    const usd = hdxToUsd(
      typeof amount === "string" ? BigInt(amount) : BigInt(Math.trunc(Number(amount)))
    );
    cumUsd += usd;
    for (const band of TRANSFER_BANDS) {
      if (cumUsd >= band && !bandsEmitted.has(band)) {
        bandsEmitted.add(band);
        synthetic.push({
          source: "polkacredit",
          event_type: "TransferVolumeThreshold",
          pop_id: popId,
          block_number: m.block,
          block_timestamp: Math.floor((m.timestampMs ?? 0) / 1000),
          data: { band },
        });
      }
    }
  }

  synthetic.sort((a, b) => a.block_number - b.block_number);

  // ─── score ───
  const points = computePoints(synthetic, headNumber);
  const score = computeScore(points);

  console.log("=== translated to calculator shape ===");
  if (synthetic.length === 0) {
    console.log("  (no scoreable events for this address in this window)");
  } else {
    for (const s of synthetic) {
      console.log(
        `  #${s.block_number}  ${s.source}.${s.event_type}  ${JSON.stringify(s.data)}`
      );
    }
  }
  console.log("");
  console.log(`cumulative outbound transfer USD: $${cumUsd.toFixed(2)}`);
  console.log(
    `  next transfer-band target: ${
      TRANSFER_BANDS.find((b) => !bandsEmitted.has(b)) ?? "all crossed"
    } (${pointsForTransferBand(
      TRANSFER_BANDS.find((b) => !bandsEmitted.has(b)) ?? 0
    )} pts)`
  );
  console.log("");
  console.log(`POINTS  : ${points}`);
  console.log(`SCORE   : ${score} / 850`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        source: WSS,
        address: ADDRESS,
        popId,
        window: { fromBlock: from, toBlock: headNumber, blockCount: BLOCKS },
        pricing: { hdxUsd: HDX_USD, openGovMinHdx: OPENGOV_MIN },
        rawMatches: matched,
        synthetic,
        cumulativeOutboundUsd: cumUsd,
        points,
        score,
      },
      null,
      2
    )
  );
  console.log(`\nwrote ${OUT}`);

  await api.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
