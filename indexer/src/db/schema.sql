-- PolkaCredit indexer schema (SQLite).
-- Mirrors the PostgreSQL schema in the system spec so migration is straightforward.

CREATE TABLE IF NOT EXISTS pop_identities (
    pop_id          TEXT PRIMARY KEY,
    evm_address     TEXT,
    registered_at   INTEGER NOT NULL,
    dim_level       INTEGER DEFAULT 1,
    is_active       INTEGER DEFAULT 1
);

-- NOTE: the previous `wallet_links` table (WalletRegistry-era EVM↔SS58
-- attestation store) has been removed. On Polkadot Hub the H160→AccountId32
-- mapping is deterministic (pallet-revive 0xEE-padding), and opt-in
-- sr25519↔H160 links live on-chain via `pallet-revive`'s `map_account` —
-- neither needs an indexer-side table.

CREATE TABLE IF NOT EXISTS raw_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    pop_id          TEXT,
    wallet_address  TEXT,
    chain_id        INTEGER,
    block_number    INTEGER NOT NULL,
    block_timestamp INTEGER NOT NULL,
    data            TEXT NOT NULL,          -- JSON payload
    points_awarded  INTEGER DEFAULT 0,
    reason_code     TEXT,
    tx_hash         TEXT,
    log_index       INTEGER,
    created_at      INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(source, tx_hash, log_index)      -- dedup on reorg / reprocess
);
CREATE INDEX IF NOT EXISTS idx_events_popid ON raw_events(pop_id, block_number);
CREATE INDEX IF NOT EXISTS idx_events_source ON raw_events(source, event_type);

CREATE TABLE IF NOT EXISTS point_balances (
    pop_id          TEXT PRIMARY KEY,
    total_points    INTEGER NOT NULL DEFAULT 0,
    earned_points   INTEGER NOT NULL DEFAULT 0,
    burned_points   INTEGER NOT NULL DEFAULT 0,
    locked_points   INTEGER NOT NULL DEFAULT 0,
    last_updated    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS score_history (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    pop_id            TEXT NOT NULL,
    score             INTEGER NOT NULL,
    total_points      INTEGER NOT NULL,
    computed_at       INTEGER NOT NULL,
    computation_hash  TEXT NOT NULL,
    published_tx      TEXT,
    created_at        INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_scores_popid ON score_history(pop_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS monthly_caps (
    pop_id          TEXT NOT NULL,
    year_month      TEXT NOT NULL,
    opengov_points  INTEGER DEFAULT 0,
    vouches_made    INTEGER DEFAULT 0,
    PRIMARY KEY (pop_id, year_month)
);

CREATE TABLE IF NOT EXISTS indexer_state (
    source        TEXT PRIMARY KEY,
    last_block    INTEGER NOT NULL,
    last_updated  INTEGER DEFAULT (strftime('%s','now'))
);

-- ─── Optimistic verification: proposals + disputes ───
--
-- Events that contributed to the score are read directly from PointsLedger
-- on-chain (via historyAt / sumHistoryUpTo). The indexer no longer commits
-- a Merkle root — dispute evidence references ledger entries by
-- `historyIndex`.

CREATE TABLE IF NOT EXISTS score_proposals (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    on_chain_id          INTEGER,                 -- ScoreRegistry proposalId
    pop_id               TEXT NOT NULL,
    score                INTEGER NOT NULL,
    total_points         INTEGER NOT NULL,
    source_block_height  INTEGER NOT NULL,
    proposed_at_block    INTEGER,                 -- block on-chain was submitted at
    finalized_at_block   INTEGER,
    status               TEXT NOT NULL DEFAULT 'pending',
        -- 'pending', 'finalized', 'disputed', 'rejected', 'superseded'
    tx_hash              TEXT,
    created_at           INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_proposals_popid ON score_proposals(pop_id, status);
CREATE INDEX IF NOT EXISTS idx_proposals_onchain ON score_proposals(on_chain_id);

CREATE TABLE IF NOT EXISTS disputes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    on_chain_id  INTEGER NOT NULL,
    proposal_id  INTEGER NOT NULL,               -- score_proposals.id
    pop_id       TEXT NOT NULL,
    disputer     TEXT NOT NULL,
    claim_type   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
        -- 'open', 'disputer_wins', 'proposer_wins'
    resolved_at  INTEGER,
    created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_disputes_proposal ON disputes(proposal_id);
