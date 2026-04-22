// Formatting helpers. The historical `popIdFromAddress` / `addressFromPopId`
// pair existed from a time when the on-chain identity was a bytes32 `popId`
// (see the deleted `contracts/lib/PopId.sol`). The contract refactor dropped
// that abstraction — every Solidity signature now takes `address` directly —
// so the off-chain code standardises on `address` too. This file retains only
// display helpers.
export function short(addr: string): string {
  if (!addr) return "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}
