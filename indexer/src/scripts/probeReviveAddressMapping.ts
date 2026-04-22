/**
 * Probe the runtime's pallet-revive account-mapping surface on Polkadot Hub.
 *
 * Goal: figure out the exact API to resolve
 *       H160 → canonical AccountId32 (mapped or padded-fallback)
 * without guessing from docs. Print:
 *   - all storage items under api.query.revive
 *   - all extrinsics/dispatchables under api.tx.revive
 *   - all events under api.events.revive
 *   - all runtime APIs under api.call.reviveApi (if present)
 *   - a live sample call to whichever resolver we find, using a known
 *     mainnet voter address as the input (we also try the inverse).
 */

import { ApiPromise, WsProvider } from "@polkadot/api";

const WSS = process.argv[2] ?? "wss://polkadot-asset-hub-rpc.polkadot.io";
// A real OpenGov voter we observed in the earlier probe.
const KNOWN_NATIVE_VOTER =
  "0x7cd5336d50ec2652a90f89edaa708f0952cc7b4e95f16d3e632f4488a4e42423";

async function main() {
  console.log(`RPC: ${WSS}\n`);
  const api = await ApiPromise.create({
    provider: new WsProvider(WSS),
    noInitWarn: true,
  });

  const query = (api.query as any).revive;
  const tx = (api.tx as any).revive;
  const events = (api.events as any).revive;
  const calls = (api.call as any).reviveApi;

  console.log("── api.query.revive.*");
  if (!query) {
    console.log("  (pallet not present)");
  } else {
    for (const name of Object.keys(query).sort()) {
      const meta = query[name]?.creator?.meta;
      const ty =
        meta?.type?.toJSON?.() ??
        meta?.type?.toString?.() ??
        "?";
      console.log(`  ${name}  ::  ${JSON.stringify(ty).slice(0, 160)}`);
    }
  }

  console.log("\n── api.tx.revive.*");
  if (tx) {
    for (const name of Object.keys(tx).sort()) {
      console.log(`  ${name}`);
    }
  }

  console.log("\n── api.events.revive.*");
  if (events) {
    for (const name of Object.keys(events).sort()) {
      console.log(`  ${name}`);
    }
  }

  console.log("\n── api.call.reviveApi.*");
  if (calls) {
    for (const name of Object.keys(calls).sort()) {
      console.log(`  ${name}`);
    }
  } else {
    console.log("  (no reviveApi runtime API decorated)");
  }

  // Try the one we suspect exists:
  if (query?.originalAccount) {
    console.log("\n── live sample: revive.originalAccount(<h160>) for a MetaMask-style h160");
    const sampleH160 = "0x00000000000000000000000000000000000000aa";
    try {
      const r = await query.originalAccount(sampleH160);
      console.log(`  originalAccount(${sampleH160}) = ${r.toString()}`);
    } catch (e: any) {
      console.log(`  (failed: ${e.message})`);
    }
  }

  // Try forward lookup: native account → H160, if such a storage exists.
  for (const candidate of ["addressMap", "ethAddress", "accountMap", "mappedAddress"]) {
    if (query?.[candidate]) {
      console.log(`\n── live sample: revive.${candidate}(<native>)`);
      try {
        const r = await query[candidate](KNOWN_NATIVE_VOTER);
        console.log(`  ${candidate}(${KNOWN_NATIVE_VOTER}) = ${r.toString()}`);
      } catch (e: any) {
        console.log(`  (failed: ${e.message})`);
      }
    }
  }

  // If there's a runtime API for it, try each suspect name:
  if (calls) {
    for (const name of Object.keys(calls)) {
      if (!/addr|map|account/i.test(name)) continue;
      console.log(`\n── runtime api: reviveApi.${name}`);
      try {
        const r = await calls[name](KNOWN_NATIVE_VOTER);
        console.log(`  result = ${r.toString()}`);
      } catch (e: any) {
        console.log(`  (failed: ${e.message})`);
      }
    }
  }

  await api.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
