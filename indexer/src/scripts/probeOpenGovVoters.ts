/**
 * Probe: on Passet Hub (and optionally Polkadot Hub), sample recent
 * `convictionVoting.Voted` events and count how many voters use the
 * pallet-revive padded form (H160 ++ 0xEE*12) vs. native AccountId32.
 *
 * If the padded count is zero, MetaMask users cannot currently reach
 * OpenGov attribution under our forward-keyed design — the EVM signing
 * path to sr25519-style extrinsics isn't actually wired up for them.
 *
 * Usage:
 *   npx tsx src/scripts/probeOpenGovVoters.ts [--wss <endpoint>] [--blocks <n>]
 */

import { ApiPromise, WsProvider } from "@polkadot/api";

function argOr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const WSS = argOr("wss", "wss://asset-hub-paseo-rpc.n.dwellir.com");
const BLOCKS = Number(argOr("blocks", "20000"));
const CONCURRENCY = 25;

const PADDED_SUFFIX = "ee".repeat(12);

function isPadded(accountHex: string): boolean {
  return accountHex.toLowerCase().replace(/^0x/, "").endsWith(PADDED_SUFFIX);
}

async function main() {
  console.log(`RPC     : ${WSS}`);
  console.log(`window  : last ${BLOCKS} finalized blocks\n`);

  const api = await ApiPromise.create({
    provider: new WsProvider(WSS),
    noInitWarn: true,
  });

  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const finalizedHeader = await api.rpc.chain.getHeader(finalizedHash);
  const head = finalizedHeader.number.toNumber();
  const from = Math.max(1, head - BLOCKS + 1);
  console.log(`head    : #${head}`);
  console.log(`scanning: #${from}..#${head}\n`);

  let paddedVoters = 0;
  let nativeVoters = 0;
  let voted = 0;
  const paddedSamples: string[] = [];
  const nativeSamples: string[] = [];

  async function scan(n: number): Promise<void> {
    const hash = await api.rpc.chain.getBlockHash(n);
    const apiAt = await api.at(hash);
    const events = (await apiAt.query.system.events()) as any;
    events.forEach((rec: any) => {
      const { event } = rec;
      if (event.section !== "convictionVoting" || event.method !== "Voted") return;
      voted++;
      const accountHex = event.data[0].toHex();
      if (isPadded(accountHex)) {
        paddedVoters++;
        if (paddedSamples.length < 3) paddedSamples.push(accountHex);
      } else {
        nativeVoters++;
        if (nativeSamples.length < 3) nativeSamples.push(accountHex);
      }
    });
  }

  const numbers: number[] = [];
  for (let n = from; n <= head; n++) numbers.push(n);

  let scanned = 0;
  for (let i = 0; i < numbers.length; i += CONCURRENCY) {
    const batch = numbers.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(scan));
    scanned += batch.length;
    process.stdout.write(
      `  scanned ${scanned}/${numbers.length}   voted=${voted}  padded=${paddedVoters}  native=${nativeVoters}\r`
    );
  }
  process.stdout.write("\n\n");

  console.log("=== results ===");
  console.log(`total convictionVoting.Voted : ${voted}`);
  console.log(`  padded (H160++0xEE*12)     : ${paddedVoters}`);
  console.log(`  native AccountId32          : ${nativeVoters}`);
  if (paddedSamples.length) {
    console.log("\npadded samples:");
    for (const s of paddedSamples) console.log("  " + s);
  }
  if (nativeSamples.length) {
    console.log("\nnative samples:");
    for (const s of nativeSamples) console.log("  " + s);
  }

  await api.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
