import { queries } from "../db/index.js";
import { ethers } from "ethers";

/**
 * Given an EVM address on the PolkaCredit chain itself, look up the PoP id.
 */
export function resolvePopIdFromEvm(address: string): string | null {
  const row = queries.getPopIdForEvmAddress.get(address.toLowerCase());
  return row?.pop_id ?? null;
}

/**
 * Mirror of the on-chain `PopId.fromAddress` library:
 *   popId = bytes32(uint256(uint160(addr)))
 * i.e. the address, zero-padded on the left to 32 bytes.
 *
 * Use this when the indexer needs to derive a popId without going through the
 * DB (for example, to seed lookups for an address it has never seen before).
 */
export function popIdFromAddress(address: string): string {
  return ethers.zeroPadValue(address.toLowerCase(), 32);
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
