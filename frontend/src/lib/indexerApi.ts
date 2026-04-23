/**
 * Thin fetch wrapper around the indexer REST API.
 *
 * Base URL defaults to the local dev indexer; override via `VITE_INDEXER_URL`.
 */
const BASE =
  (import.meta.env.VITE_INDEXER_URL as string | undefined) ??
  "http://127.0.0.1:4000";

/**
 * Tell the indexer "this H160 is a user of ours" so the OpenGov listener
 * starts attributing votes from the address's canonical 32-byte form.
 *
 * The indexer computes the canonical form server-side (via
 * `revive.originalAccount` with a 0xEE-padded fallback) and stores both
 * the H160 and the 32-byte id. Safe to call repeatedly — the endpoint is
 * idempotent. Failures are logged but never thrown, since the app should
 * still work if the indexer is offline.
 */
export async function registerAccount(address: string): Promise<void> {
  try {
    await fetch(`${BASE}/api/v1/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
  } catch (e) {
    console.warn("indexer: account registration failed", e);
  }
}
