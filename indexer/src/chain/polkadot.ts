import { ApiPromise, WsProvider } from "@polkadot/api";
import { paddedAccountId32FromH160 } from "../resolvers/identityResolver.js";

export async function connectPolkadot(wss: string): Promise<ApiPromise> {
  const provider = new WsProvider(wss);
  return ApiPromise.create({ provider, noInitWarn: true });
}

/**
 * Resolve an H160 account to its canonical 32-byte AccountId32 on AssetHub.
 *
 * Two cases, one query:
 *   1. Native Substrate user who called `map_account` — their real sr25519
 *      AccountId32 is stored in `revive.originalAccount[h160]`.
 *   2. MetaMask-only user — no entry in `originalAccount`; their canonical
 *      identity is the deterministic 0xEE-padded fallback `h160 ++ 0xEE*12`.
 *
 * Returns a lowercased 0x-prefixed 66-char hex string.
 */
export async function canonicalAccountId32FromH160(
  api: ApiPromise,
  h160: string
): Promise<string> {
  const mapped = await (api.query as any).revive?.originalAccount?.(h160);
  if (mapped && mapped.isSome !== false && mapped.toString() !== "") {
    // `originalAccount` returns the raw value when populated; Option-wrapped
    // storage returns the inner AccountId32 via toHex() on .unwrap().
    const raw = typeof mapped.isSome === "boolean" && mapped.isSome
      ? mapped.unwrap().toHex()
      : mapped.toHex?.();
    if (raw && raw.length === 66 && raw !== "0x" + "00".repeat(32)) {
      return raw.toLowerCase();
    }
  }
  return paddedAccountId32FromH160(h160);
}
