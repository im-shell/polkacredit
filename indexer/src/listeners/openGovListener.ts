import type { ApiPromise } from "@polkadot/api";
import { config } from "../config.js";
import { queries, tx } from "../db/index.js";
import { canonicalAccountId32FromH160, connectPolkadot } from "../chain/polkadot.js";
import { log } from "../util/log.js";

const SOURCE = "opengov";

// Refresh the h160→canonical-AccountId32 cache at most once per this many
// blocks. Mappings only change when a user calls `revive.map_account` /
// `revive.unmap_account`, so a slow refresh is fine.
const CACHE_REFRESH_BLOCKS = 50;

/**
 * Watches `convictionVoting.Voted` on Polkadot Hub / Passet Hub (AssetHub).
 *
 * Forward-keyed attribution:
 *
 *   for each PolkaCredit account (H160):
 *     canonical AccountId32 =
 *         revive.originalAccount[h160]        (if the user called map_account)
 *      OR h160 ++ 0xEE*12                     (default pallet-revive padding)
 *
 * We build a `canonical → account` map from the `accountentities` table and
 * attribute any vote whose voter appears in it. No reverse lookup, no
 * stripping, no event side-table. Users who never interact with PolkaCredit
 * contracts never appear in `accountentities`, so their OpenGov votes are
 * correctly ignored (no account to credit).
 */
export async function runOpenGovListener(signal?: AbortSignal) {
  if (!config.openGov.enabled) {
    log.info("opengov: disabled, skipping listener");
    return;
  }

  let api: ApiPromise;
  try {
    api = await connectPolkadot(config.openGov.wss);
  } catch (e) {
    log.error(`opengov: cannot connect to ${config.openGov.wss}: ${(e as Error).message}`);
    return;
  }
  log.info(`opengov: subscribed to ${config.openGov.wss}`);

  let canonicalToAccount = new Map<string, string>();
  let lastRefreshBlock = -Infinity;
  let cachedIdentityCount = -1;

  async function refreshCanonicalIndex(blockNumber: number) {
    const rows = queries.getAllAccounts.all();
    const identityCount = rows.length;
    const stale =
      blockNumber - lastRefreshBlock >= CACHE_REFRESH_BLOCKS ||
      identityCount !== cachedIdentityCount;
    if (!stale) return;

    const next = new Map<string, string>();
    await Promise.all(
      rows
        .filter((r) => r.evm_address)
        .map(async (r) => {
          try {
            const canonical = await canonicalAccountId32FromH160(api, r.evm_address!);
            next.set(canonical, r.account);
          } catch (e) {
            log.error(
              `opengov: canonical resolution failed for ${r.evm_address}: ${(e as Error).message}`
            );
          }
        })
    );
    canonicalToAccount = next;
    lastRefreshBlock = blockNumber;
    cachedIdentityCount = identityCount;
    log.info(
      `opengov: canonical cache refreshed at #${blockNumber} (${next.size} accounts)`
    );
  }

  const unsub = await api.rpc.chain.subscribeFinalizedHeads(async (head) => {
    if (signal?.aborted) return;
    const hash = head.hash;
    const blockNumber = head.number.toNumber();
    try {
      await refreshCanonicalIndex(blockNumber);
      const apiAt = await api.at(hash);
      const events = (await apiAt.query.system.events()) as any;
      const timestamp = Number(((await apiAt.query.timestamp?.now?.()) as any)?.toBigInt?.() ?? 0n);
      const timestampSeconds = Math.floor(timestamp / 1000);

      tx(() => {
        events.forEach((record: any) => {
          const { event } = record;
          if (event.section !== "convictionVoting" || event.method !== "Voted") return;
          const [voter, pollIndex, vote] = event.data;
          const voterHex = voter.toHex().toLowerCase();
          const account = canonicalToAccount.get(voterHex);
          if (!account) return;

          const voteJson = vote.toJSON();
          const standard = voteJson?.standard;
          const conviction = standard?.vote?.conviction ?? 0;
          const balance = Number(standard?.balance ?? 0) / 1e10;

          queries.insertRawEvent.run(
            SOURCE,
            "Voted",
            account,
            voterHex,
            config.evm.chainId,
            blockNumber,
            timestampSeconds,
            JSON.stringify({ pollIndex: pollIndex.toString(), conviction, dotCommitted: balance }),
            0,
            null,
            hash.toHex(),
            record.phase?.asApplyExtrinsic?.toNumber?.() ?? 0
          );
        });
      });
      queries.setCheckpoint.run(SOURCE, blockNumber);
    } catch (e) {
      log.error(`opengov: block ${blockNumber} error: ${(e as Error).message}`);
    }
  });

  await new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => {
      try {
        (unsub as unknown as () => void)();
      } catch {}
      api.disconnect();
      resolve();
    });
  });
}
