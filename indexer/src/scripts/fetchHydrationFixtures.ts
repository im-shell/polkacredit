/**
 * Fetch a snapshot of real Hydration mainnet data for use as a test fixture.
 *
 * Connects to the public Hydration RPC, pulls chain metadata, the finalized
 * head, and events from the most recent N blocks, then writes them to
 * indexer/fixtures/hydration-mainnet.json. Tests can load the fixture
 * instead of hitting the network.
 *
 * Run with:   npx tsx src/scripts/fetchHydrationFixtures.ts
 *
 * Env overrides:
 *   HYDRATION_WSS     (default wss://rpc.hydradx.cloud)
 *   FIXTURE_BLOCKS    (default 10)  number of recent blocks to capture
 *   FIXTURE_OUT       (default indexer/fixtures/hydration-mainnet.json)
 */

import { ApiPromise, WsProvider } from "@polkadot/api";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WSS = process.env.HYDRATION_WSS ?? "wss://rpc.hydradx.cloud";
const BLOCKS = Number(process.env.FIXTURE_BLOCKS ?? 10);
const OUT =
  process.env.FIXTURE_OUT ??
  path.resolve(__dirname, "..", "..", "fixtures", "hydration-mainnet.json");

type CapturedEvent = {
  section: string;
  method: string;
  phase: string;
  data: unknown;
};

type CapturedBlock = {
  number: number;
  hash: string;
  parentHash: string;
  stateRoot: string;
  extrinsicsRoot: string;
  timestampMs: number | null;
  events: CapturedEvent[];
};

async function main() {
  console.log(`connecting to ${WSS} …`);
  const provider = new WsProvider(WSS);
  const api = await ApiPromise.create({ provider });

  const [chain, nodeName, nodeVersion, properties, genesisHash, runtime] =
    await Promise.all([
      api.rpc.system.chain(),
      api.rpc.system.name(),
      api.rpc.system.version(),
      api.rpc.system.properties(),
      api.rpc.chain.getBlockHash(0),
      api.rpc.state.getRuntimeVersion(),
    ]);

  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const finalizedHeader = await api.rpc.chain.getHeader(finalizedHash);
  const finalizedNumber = finalizedHeader.number.toNumber();

  console.log(`chain            : ${chain.toString()}`);
  console.log(`node             : ${nodeName.toString()} v${nodeVersion.toString()}`);
  console.log(`genesis          : ${genesisHash.toHex()}`);
  console.log(`specVersion      : ${runtime.specVersion.toNumber()}`);
  console.log(`finalized head   : #${finalizedNumber} ${finalizedHash.toHex()}`);
  console.log(`capturing        : ${BLOCKS} blocks back from head`);
  console.log("");

  // Walk back from the finalized head, oldest first in output.
  const numbers: number[] = [];
  for (let i = BLOCKS - 1; i >= 0; i--) numbers.push(finalizedNumber - i);

  const blocks: CapturedBlock[] = [];
  // Counters across the captured window — useful for quick fixture assertions.
  const eventCounts = new Map<string, number>();
  const transferSamples: Array<{
    block: number;
    from: string;
    to: string;
    amount: string;
  }> = [];

  for (const n of numbers) {
    const hash = await api.rpc.chain.getBlockHash(n);
    // Avoid api.rpc.chain.getBlock — this @polkadot/api build can't decode
    // Hydration's current extrinsic format (unsigned v5). Header + events
    // is all the fixture needs.
    const [header, apiAt] = await Promise.all([
      api.rpc.chain.getHeader(hash),
      api.at(hash),
    ]);

    const eventsCodec = (await apiAt.query.system.events()) as unknown as any;
    const tsCodec = (await (apiAt.query.timestamp?.now as any)?.()) as any;
    const timestampMs =
      tsCodec && typeof tsCodec.toBigInt === "function"
        ? Number(tsCodec.toBigInt())
        : null;

    const events: CapturedEvent[] = eventsCodec.map((record: any) => {
      const key = `${record.event.section}.${record.event.method}`;
      eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);

      // Snapshot a handful of Transfers for a convenient assertion surface.
      if (
        key === "balances.Transfer" ||
        key === "tokens.Transfer" ||
        key === "currencies.Transferred"
      ) {
        if (transferSamples.length < 20) {
          const j: any = record.event.data.toJSON();
          transferSamples.push({
            block: n,
            from: String(j?.from ?? j?.[0] ?? ""),
            to: String(j?.to ?? j?.[1] ?? ""),
            amount: String(j?.amount ?? j?.value ?? j?.[2] ?? ""),
          });
        }
      }

      return {
        section: record.event.section,
        method: record.event.method,
        phase: record.phase.toString(),
        data: record.event.data.toJSON(),
      };
    });

    blocks.push({
      number: n,
      hash: hash.toHex(),
      parentHash: header.parentHash.toHex(),
      stateRoot: header.stateRoot.toHex(),
      extrinsicsRoot: header.extrinsicsRoot.toHex(),
      timestampMs,
      events,
    });

    console.log(`  #${n}  ${events.length} events`);
  }

  const sortedCounts = [...eventCounts.entries()].sort((a, b) => b[1] - a[1]);

  const fixture = {
    capturedAt: new Date().toISOString(),
    source: WSS,
    chain: chain.toString(),
    node: { name: nodeName.toString(), version: nodeVersion.toString() },
    genesisHash: genesisHash.toHex(),
    runtime: {
      specName: runtime.specName.toString(),
      specVersion: runtime.specVersion.toNumber(),
      implVersion: runtime.implVersion.toNumber(),
      transactionVersion: runtime.transactionVersion.toNumber(),
    },
    properties: properties.toJSON(),
    finalized: {
      number: finalizedNumber,
      hash: finalizedHash.toHex(),
    },
    window: {
      fromBlock: numbers[0],
      toBlock: numbers[numbers.length - 1],
      blockCount: numbers.length,
    },
    eventCounts: Object.fromEntries(sortedCounts),
    transferSamples,
    blocks,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2));

  const totalEvents = blocks.reduce((a, b) => a + b.events.length, 0);
  console.log("");
  console.log(`wrote ${OUT}`);
  console.log(
    `  ${blocks.length} blocks, ${totalEvents} events, ${sortedCounts.length} distinct event types, ${transferSamples.length} transfer samples`
  );
  console.log("  top event types:");
  for (const [k, v] of sortedCounts.slice(0, 8)) {
    console.log(`    ${v.toString().padStart(4)} × ${k}`);
  }

  await api.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
