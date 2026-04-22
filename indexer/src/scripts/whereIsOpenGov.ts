/**
 * Probe which chain currently hosts OpenGov pallets (`convictionVoting`,
 * `referenda`). Answers: "is OpenGov still on the relay, or has it moved
 * to AssetHub / Polkadot Hub under the Polkadot 2.0 minimal-relay plan?"
 *
 * Prints whether each pallet is decorated in the runtime metadata of:
 *   - Polkadot relay
 *   - Polkadot Hub (AssetHub)
 *   - Paseo relay
 *   - Passet Hub (Paseo AssetHub)
 *
 * Also prints the current referendum count per chain, if the pallet
 * exists, as a sanity check that it's not just present-but-dead.
 */

import { ApiPromise, WsProvider } from "@polkadot/api";

const TARGETS: { name: string; wss: string }[] = [
  { name: "Polkadot relay", wss: "wss://rpc.polkadot.io" },
  { name: "Polkadot Hub",   wss: "wss://polkadot-asset-hub-rpc.polkadot.io" },
  { name: "Paseo relay",    wss: "wss://paseo.rpc.amforc.com" },
  { name: "Passet Hub",     wss: "wss://asset-hub-paseo-rpc.n.dwellir.com" },
];

async function probe(name: string, wss: string): Promise<void> {
  console.log(`── ${name}  (${wss})`);
  let api: ApiPromise | null = null;
  try {
    api = await ApiPromise.create({
      provider: new WsProvider(wss),
      throwOnConnect: true,
      noInitWarn: true,
    });

    const header = await api.rpc.chain.getHeader();
    const runtime = api.runtimeVersion;
    console.log(`   runtime          : ${runtime.specName}/${runtime.specVersion}`);
    console.log(`   finalized head   : #${header.number.toNumber()}`);

    const hasConviction = !!(api.query as any).convictionVoting;
    const hasReferenda  = !!(api.query as any).referenda;
    console.log(`   convictionVoting : ${hasConviction ? "YES" : "no"}`);
    console.log(`   referenda        : ${hasReferenda ? "YES" : "no"}`);

    if (hasReferenda) {
      const count = await (api.query as any).referenda.referendumCount();
      console.log(`   referendumCount  : ${count.toString()}`);
    }
  } catch (e: any) {
    console.log(`   (error: ${e?.message ?? String(e)})`);
  } finally {
    if (api) await api.disconnect();
  }
  console.log("");
}

async function main() {
  for (const t of TARGETS) {
    await probe(t.name, t.wss);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
