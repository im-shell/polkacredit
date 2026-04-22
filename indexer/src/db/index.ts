import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const db = new Database(config.db.file);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Apply schema on boot (idempotent via IF NOT EXISTS).
const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schemaSql);

export type PopId = string; // 0x-prefixed 32-byte hex

export interface PointBalanceRow {
  pop_id: PopId;
  total_points: number;
  earned_points: number;
  burned_points: number;
  locked_points: number;
  last_updated: number;
}

export interface RawEventRow {
  id: number;
  source: string;
  event_type: string;
  pop_id: PopId | null;
  wallet_address: string | null;
  chain_id: number | null;
  block_number: number;
  block_timestamp: number;
  data: string;
  points_awarded: number;
  reason_code: string | null;
  tx_hash: string | null;
  log_index: number | null;
}

export const queries = {
  // ─── indexer state ───
  getCheckpoint: db.prepare<[string], { last_block: number }>(
    "SELECT last_block FROM indexer_state WHERE source = ?"
  ),
  setCheckpoint: db.prepare(
    "INSERT INTO indexer_state (source, last_block) VALUES (?, ?) " +
      "ON CONFLICT(source) DO UPDATE SET last_block = excluded.last_block, last_updated = strftime('%s','now')"
  ),

  // ─── identity ───
  upsertIdentity: db.prepare(
    "INSERT INTO pop_identities (pop_id, evm_address, registered_at, dim_level) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(pop_id) DO UPDATE SET evm_address = excluded.evm_address"
  ),
  getAllIdentities: db.prepare<[], { pop_id: string; evm_address: string | null }>(
    "SELECT pop_id, evm_address FROM pop_identities WHERE is_active = 1"
  ),

  getPopIdForEvmAddress: db.prepare<[string], { pop_id: string }>(
    "SELECT pop_id FROM pop_identities WHERE evm_address = ? AND is_active = 1"
  ),

  // ─── raw events ───
  insertRawEvent: db.prepare(
    `INSERT OR IGNORE INTO raw_events
      (source, event_type, pop_id, wallet_address, chain_id, block_number, block_timestamp,
       data, points_awarded, reason_code, tx_hash, log_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),

  // ─── balances ───
  getBalance: db.prepare<[PopId], PointBalanceRow>(
    "SELECT * FROM point_balances WHERE pop_id = ?"
  ),
  upsertBalance: db.prepare(
    `INSERT INTO point_balances (pop_id, total_points, earned_points, burned_points, locked_points, last_updated)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(pop_id) DO UPDATE SET
       total_points = excluded.total_points,
       earned_points = excluded.earned_points,
       burned_points = excluded.burned_points,
       locked_points = excluded.locked_points,
       last_updated = excluded.last_updated`
  ),

  // ─── monthly caps ───
  bumpMonthlyCap: (popId: string, yearMonth: string, column: string) => {
    db.exec(
      `INSERT INTO monthly_caps (pop_id, year_month, ${column}) VALUES ('${popId}', '${yearMonth}', 1)
       ON CONFLICT(pop_id, year_month) DO UPDATE SET ${column} = ${column} + 1`
    );
  },
  getMonthlyCap: db.prepare<[string, string], Record<string, number>>(
    "SELECT opengov_points, vouches_made FROM monthly_caps WHERE pop_id = ? AND year_month = ?"
  ),

  // ─── score history ───
  insertScore: db.prepare(
    `INSERT INTO score_history (pop_id, score, total_points, computed_at, computation_hash)
     VALUES (?, ?, ?, ?, ?)`
  ),
  updateScorePublishedTx: db.prepare(
    "UPDATE score_history SET published_tx = ? WHERE id = ?"
  ),
  getLatestScore: db.prepare<[string], { score: number; computed_at: number; total_points: number }>(
    "SELECT score, computed_at, total_points FROM score_history WHERE pop_id = ? ORDER BY computed_at DESC LIMIT 1"
  ),

  // ─── proposals / disputes ───
  insertProposal: db.prepare(
    `INSERT INTO score_proposals
       (on_chain_id, pop_id, score, total_points,
        source_block_height, proposed_at_block, status, tx_hash)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ),
  markProposalFinalized: db.prepare(
    "UPDATE score_proposals SET status = 'finalized', finalized_at_block = ? WHERE on_chain_id = ?"
  ),
  markProposalSuperseded: db.prepare(
    "UPDATE score_proposals SET status = 'superseded' WHERE on_chain_id = ?"
  ),
  markProposalDisputed: db.prepare(
    "UPDATE score_proposals SET status = 'disputed' WHERE on_chain_id = ?"
  ),
  markProposalRejected: db.prepare(
    "UPDATE score_proposals SET status = 'rejected' WHERE on_chain_id = ?"
  ),
  getPendingProposalByPop: db.prepare<[string], {
    id: number;
    on_chain_id: number;
    score: number;
    total_points: number;
    proposed_at_block: number;
    status: string;
  }>(
    "SELECT id, on_chain_id, score, total_points, proposed_at_block, status FROM score_proposals WHERE pop_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
  ),
  getLatestProposalByPop: db.prepare<[string], {
    id: number;
    on_chain_id: number;
    score: number;
    total_points: number;
    proposed_at_block: number;
    finalized_at_block: number | null;
    status: string;
    tx_hash: string | null;
  }>(
    "SELECT id, on_chain_id, score, total_points, proposed_at_block, finalized_at_block, status, tx_hash FROM score_proposals WHERE pop_id = ? ORDER BY id DESC LIMIT 1"
  ),
  listPendingReadyToFinalize: db.prepare<[number], {
    id: number;
    on_chain_id: number;
    pop_id: string;
    proposed_at_block: number;
  }>(
    "SELECT id, on_chain_id, pop_id, proposed_at_block FROM score_proposals WHERE status = 'pending' AND proposed_at_block + ? <= (SELECT MAX(last_block) FROM indexer_state WHERE source = 'polkacredit')"
  ),

  insertDispute: db.prepare(
    `INSERT INTO disputes (on_chain_id, proposal_id, pop_id, disputer, claim_type)
     VALUES (?, ?, ?, ?, ?)`
  ),
  resolveDisputeDb: db.prepare(
    "UPDATE disputes SET status = ?, resolved_at = strftime('%s','now') WHERE on_chain_id = ?"
  ),
};

export function tx<T>(fn: () => T): T {
  const run = db.transaction(fn);
  return run();
}
