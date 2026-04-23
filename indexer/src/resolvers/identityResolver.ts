/**
 * Account identifiers used by the indexer are just the H160 wallet
 * address, 0x-prefixed and lowercased. The term `account` matches the
 * Solidity parameter name used across the contracts.
 *
 * There used to be a separate `popId` concept here (see the deleted
 * `contracts/lib/PopId.sol`) but the contract refactor dropped it —
 * every on-chain signature now takes `address` directly, so the
 * off-chain code standardises on that too.
 */
export function normalizeAccount(address: string): string {
  return address.toLowerCase();
}

/**
 * Default 0xEE-suffix fallback that `pallet-revive` uses when an H160 hasn't
 * been explicitly mapped. MetaMask users' canonical AccountId32 is this
 * padded form. Native Substrate users who called `map_account` get a real
 * AccountId32 recorded in `revive.originalAccount[h160]` — query that first,
 * fall back to `paddedAccountId32FromH160` if the storage entry is empty.
 *
 * See `canonicalAccountId32FromH160` in `chain/polkadot.ts` for the
 * combined resolver (storage query + fallback).
 */
export function paddedAccountId32FromH160(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "").padStart(40, "0");
  return "0x" + hex + "ee".repeat(12);
}
