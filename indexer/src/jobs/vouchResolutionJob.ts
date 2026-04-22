import { contracts, signer } from "../chain/evm.js";
import { db } from "../db/index.js";
import { log } from "../util/log.js";

/**
 * Vouch resolution job. For every Active vouch whose window has closed
 * (plus the on-chain RESOLVE_GRACE buffer), call
 * `VouchRegistry.resolveVouch(vouchId)` so both sides see the outcome
 * promptly and the voucher's stake either returns or is slashed.
 *
 * `resolveVouch` is permissionless, but without a proactive caller a
 * vouch sits in Active state indefinitely and the voucher can't recover
 * their committed stake. The indexer calls it for all users so the
 * frontend never needs a "Resolve" button.
 *
 * Source of truth for which vouches exist is the `raw_events` table,
 * where the listener has recorded every `VouchCreated` event with its
 * `vouchId` in the data JSON.
 *
 * We deliberately fetch the current on-chain state for each candidate
 * before attempting resolution — the vouch might have been resolved by
 * someone else (e.g. the voucher via a block explorer), or defaulted
 * via `reportDefault`, so a blind call could waste gas.
 */
export async function runVouchResolutionJob(): Promise<void> {
  if (!signer) return; // no key to pay for resolve txs
  if (!contracts.vouchRegistry) return;

  const head = await contracts.pointsLedger.runner!.provider!.getBlockNumber();

  // Pull every VouchCreated event. This scales fine for project-size
  // deployments (tens to hundreds of lifetime vouches). For larger
  // deployments, add a materialised `vouch_records` table populated by
  // the listener.
  const rows = db
    .prepare<
      [],
      { data: string }
    >("SELECT data FROM raw_events WHERE event_type = 'VouchCreated'")
    .all();

  if (rows.length === 0) return;

  const RESOLVE_GRACE = Number(
    await (contracts.vouchRegistry as any).RESOLVE_GRACE()
  );

  let resolved = 0;
  let skipped = 0;
  for (const row of rows) {
    let vouchId: bigint;
    try {
      const d = JSON.parse(row.data);
      if (d.vouchId === undefined || d.vouchId === null) continue;
      vouchId = BigInt(d.vouchId);
    } catch {
      continue;
    }

    try {
      // Status enum on-chain: None=0, Active=1, Succeeded=2, Failed=3, Defaulted=4
      const v = (await (contracts.vouchRegistry as any).getVouch(vouchId)) as {
        status: bigint;
        expiresAt: bigint;
      };
      if (Number(v.status) !== 1 /* Active */) {
        skipped++;
        continue;
      }
      if (head < Number(v.expiresAt) + RESOLVE_GRACE) {
        skipped++;
        continue;
      }

      const tx = await (contracts.vouchRegistry as any).resolveVouch(vouchId);
      await tx.wait();
      log.info(`vouch resolve: vouchId=${vouchId} tx=${tx.hash}`);
      resolved++;
    } catch (e) {
      // Common losers: Active-by-index got resolved between our read and
      // call (front-run race), or a default was reported. Either way the
      // on-chain state is correct and the indexer will pick it up on the
      // next listener pass.
      log.error(
        `vouch resolve: vouchId=${vouchId} failed: ${(e as Error).message}`
      );
    }
  }

  if (resolved > 0 || skipped > 0) {
    log.info(
      `vouch resolve job: ${resolved} resolved, ${skipped} skipped (window open or already closed)`
    );
  }
}
