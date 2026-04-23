import express, { Request, Response } from "express";
import { db, queries } from "../db/index.js";
import { contracts } from "../chain/evm.js";
import { config } from "../config.js";
import { log } from "../util/log.js";

/**
 * Read-only API for external consumers + verifiers.
 *
 * The on-chain ScoreRegistry is the authoritative source; this API is a
 * convenience that also serves the raw event log a verifier uses to
 * independently re-run the points calculator and cross-check the indexer.
 * Dispute evidence (`InvalidEvent`) references on-chain `PointsLedger`
 * history entries directly by index, so there's no off-chain commitment
 * to serve.
 */
export function buildApi() {
  const app = express();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/score/:account", async (req, res) => {
    const account = req.params.account;
    try {
      const [score, updatedAt] = await (contracts.scoreRegistry as any).getScore(account);
      const pending = (await (contracts.scoreRegistry as any).getPendingProposal(account)) as any;
      res.json({
        account,
        onChain: { score: Number(score), updatedAt: Number(updatedAt) },
        pending: {
          status: Number(pending.status),
          proposalId: Number(pending.id),
          score: Number(pending.score),
          totalPoints: Number(pending.totalPoints),
          sourceBlockHeight: Number(pending.sourceBlockHeight),
          sourceBlockHash: pending.sourceBlockHash,
          proposedAt: Number(pending.proposedAt),
        },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/balance/:account", async (req, res) => {
    const account = req.params.account;
    try {
      const b = (await (contracts.pointsLedger as any).getBalance(account)) as any;
      res.json({
        account,
        total: Number(b.total),
        earned: Number(b.earned),
        burned: Number(b.burned),
        locked: Number(b.locked),
        available: Number(b.available),
        lastUpdated: Number(b.lastUpdated),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/events/:account", (req, res) => {
    const account = req.params.account;
    const events = db
      .prepare(
        `SELECT id, source, event_type, block_number, block_timestamp, points_awarded, reason_code, tx_hash
         FROM raw_events
         WHERE account = ?
         ORDER BY block_number DESC
         LIMIT 200`
      )
      .all(account);
    res.json({ account, events });
  });

  // Retained for back-compat — the indexer's notion of `account` is just
  // the caller's lowercased EVM address, so this endpoint echoes its input.
  app.get("/identity/:evmAddress", (req, res) => {
    const evmAddress = req.params.evmAddress.toLowerCase();
    res.json({ evmAddress: req.params.evmAddress, account: evmAddress });
  });

  app.get("/accounts", (_req, res) => {
    const rows = queries.getAllAccounts.all();
    res.json({ accounts: rows });
  });

  app.get("/deployment", (_req, res) => {
    res.json(config.deployment);
  });

  // ─── v1 verification API ───

  /**
   * GET /api/v1/score/:account/proposal/latest
   * The latest proposal we've indexed for this account, regardless of status.
   */
  app.get("/api/v1/score/:account/proposal/latest", (req, res) => {
    const row = queries.getLatestProposalByAccount.get(req.params.account);
    if (!row) return res.status(404).json({ error: "no proposal" });
    res.json(row);
  });

  /**
   * GET /api/v1/score/:account/events
   * Raw, time-ordered event log a verifier re-runs through the points
   * calculator to cross-check the indexer. No commitment — truth is the
   * on-chain PointsLedger; this is only a convenience over the DB mirror.
   */
  app.get("/api/v1/score/:account/events", (req, res) => {
    const account = req.params.account;
    const events = db
      .prepare(
        `SELECT id, source, event_type, chain_id, block_number, log_index,
                points_awarded, reason_code, data, tx_hash
           FROM raw_events
          WHERE account = ?
            AND points_awarded != 0
          ORDER BY chain_id, block_number, log_index`
      )
      .all(account);
    res.json({ account, events });
  });

  return app;
}

// If run directly, boot the server.
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildApi();
  app.listen(config.api.port, () => {
    log.info(`api: listening on http://127.0.0.1:${config.api.port}`);
  });
}
