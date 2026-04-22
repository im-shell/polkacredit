import { ethers } from "ethers";
import { contracts, head, provider } from "../chain/evm.js";
import { queries, tx } from "../db/index.js";
import { log } from "../util/log.js";

/**
 * Listens to PolkaCredit contract events on the EVM chain and mirrors them
 * into the indexer DB. Identities are discovered implicitly — the first time
 * we see a Staked / VouchCreated / PointsMinted event for an EVM address we
 * upsert a pop_identities row. The column name `pop_id` is historical
 * (predates the PopId.sol removal); stored values are plain 20-byte EVM
 * addresses throughout the pipeline.
 */

const SOURCE = "polkacredit";
const MAX_BLOCKS_PER_BATCH = 2000;

interface Addresses {
  vault: string;
  vouch: string;
  ledger: string;
  score: string;
  dispute: string | null;
}

interface Interfaces {
  vault: ethers.Interface;
  vouch: ethers.Interface;
  ledger: ethers.Interface;
  score: ethers.Interface;
  dispute: ethers.Interface | null;
}

async function loadAddresses(): Promise<Addresses> {
  return {
    vault: (await contracts.stakingVault.getAddress()).toLowerCase(),
    vouch: (await contracts.vouchRegistry.getAddress()).toLowerCase(),
    ledger: (await contracts.pointsLedger.getAddress()).toLowerCase(),
    score: (await contracts.scoreRegistry.getAddress()).toLowerCase(),
    dispute: contracts.disputeResolver
      ? (await contracts.disputeResolver.getAddress()).toLowerCase()
      : null,
  };
}

function buildInterfaces(): Interfaces {
  return {
    vault: new ethers.Interface(contracts.stakingVault.interface.fragments),
    vouch: new ethers.Interface(contracts.vouchRegistry.interface.fragments),
    ledger: new ethers.Interface(contracts.pointsLedger.interface.fragments),
    score: new ethers.Interface(contracts.scoreRegistry.interface.fragments),
    dispute: contracts.disputeResolver
      ? new ethers.Interface(contracts.disputeResolver.interface.fragments)
      : null,
  };
}

interface Decoded {
  name: string;
  args: any;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number;
  address: string; // lowercased
}

async function fetchTimestamp(blockNumber: number): Promise<number> {
  const b = await provider.getBlock(blockNumber);
  return b?.timestamp ?? Math.floor(Date.now() / 1000);
}

export async function processPolkaCreditBlocks(
  from: number,
  to: number,
  addresses: Addresses,
  ifaces: Interfaces
): Promise<number> {
  const addressToIface: Record<string, ethers.Interface> = {
    [addresses.vault]: ifaces.vault,
    [addresses.vouch]: ifaces.vouch,
    [addresses.ledger]: ifaces.ledger,
    [addresses.score]: ifaces.score,
  };
  if (addresses.dispute && ifaces.dispute) {
    addressToIface[addresses.dispute] = ifaces.dispute;
  }

  const logs = await provider.getLogs({
    fromBlock: from,
    toBlock: to,
    address: Object.keys(addressToIface),
  });

  // Prefetch timestamps for unique blocks
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];
  const timestamps = new Map<number, number>();
  await Promise.all(
    uniqueBlocks.map(async (b) => timestamps.set(b, await fetchTimestamp(b)))
  );

  const decoded: Decoded[] = [];
  for (const logEntry of logs) {
    const lcAddr = logEntry.address.toLowerCase();
    const iface = addressToIface[lcAddr];
    if (!iface) continue;
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...logEntry.topics], data: logEntry.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    decoded.push({
      name: parsed.name,
      args: parsed.args,
      txHash: logEntry.transactionHash,
      logIndex: logEntry.index,
      blockNumber: logEntry.blockNumber,
      blockTimestamp: timestamps.get(logEntry.blockNumber) ?? Math.floor(Date.now() / 1000),
      address: lcAddr,
    });
  }

  // Persist in a single synchronous transaction
  tx(() => {
    for (const ev of decoded) handle(ev, addresses);
  });
  return decoded.length;
}

function handle(ev: Decoded, addr: Addresses) {
  if (ev.address === addr.vault) {
    const account: string | undefined = ev.args.account;
    if (!account) return; // defensive — skip events we can't identify
    ensureIdentity(account, ev.blockNumber);
    insertRaw(ev, ev.name, account, null, {
      amount: ev.args.amount?.toString(),
      stakedAt: ev.args.stakedAt?.toString(),
    });
    return;
  }
  if (ev.address === addr.vouch) {
    const voucher: string | undefined = ev.args.voucher;
    const vouchee: string | undefined = ev.args.vouchee;
    if (voucher) ensureIdentity(voucher, ev.blockNumber);
    if (vouchee) ensureIdentity(vouchee, ev.blockNumber);
    insertRaw(ev, ev.name, voucher ?? vouchee ?? null, null, {
      vouchId: ev.args.vouchId?.toString(),
      voucher,
      vouchee,
    });
    return;
  }
  if (ev.address === addr.ledger) {
    const account: string | undefined = ev.args.account;
    if (!account) return;
    ensureIdentity(account, ev.blockNumber);
    const amount = Number(ev.args.amount ?? 0);
    const reason: string = ev.args.reason ?? "";
    const sign = ev.name === "PointsMinted" ? +1 : ev.name === "PointsBurned" ? -1 : 0;
    insertRaw(ev, ev.name, account, null, { amount, reason }, sign * amount, reason);
    if (sign !== 0) bumpBalance(account, sign * amount, ev.blockNumber);
    return;
  }
  if (ev.address === addr.score) {
    // ScoreRegistry events all carry the subject as `account` — per the
    // Solidity struct field name. ethers v6 exposes args under their
    // Solidity parameter name, so `ev.args.account` is how we read it.
    const account: string | undefined = ev.args.account;

    // Mirror ScoreRegistry lifecycle events into score_proposals for the API.
    if (ev.name === "ScoreProposed") {
      // proposeScore rows are written by the indexer's own scoreJob at submit
      // time. This event serves as a cross-check; nothing to do here beyond
      // raw_events mirroring.
      insertRaw(ev, ev.name, account ?? null, null, {
        proposalId: ev.args.proposalId?.toString(),
        score: ev.args.score?.toString(),
        // Layer A: anchored block hash captured at propose time.
        sourceBlockHash: ev.args.sourceBlockHash,
        sourceBlockHeight: ev.args.sourceBlockHeight?.toString(),
      });
      return;
    }
    if (ev.name === "ScoreFinalized") {
      const pid = Number(ev.args.proposalId);
      queries.markProposalFinalized.run(ev.blockNumber, pid);
      insertRaw(ev, ev.name, account ?? null, null, {
        proposalId: pid,
        score: ev.args.score?.toString(),
      });
      return;
    }
    if (ev.name === "ScoreDisputed") {
      const pid = Number(ev.args.proposalId);
      queries.markProposalDisputed.run(pid);
      insertRaw(ev, ev.name, account ?? null, null, {
        proposalId: pid,
        disputeId: ev.args.disputeId?.toString(),
      });
      return;
    }
    if (ev.name === "ProposalRejected") {
      const pid = Number(ev.args.proposalId);
      queries.markProposalRejected.run(pid);
      insertRaw(ev, ev.name, account ?? null, null, { proposalId: pid });
      return;
    }
    if (ev.name === "ProposalSuperseded") {
      const pid = Number(ev.args.proposalId);
      queries.markProposalSuperseded.run(pid);
      insertRaw(ev, ev.name, account ?? null, null, { proposalId: pid });
      return;
    }
    if (ev.name === "ScoreCorrected") {
      insertRaw(ev, ev.name, account ?? null, null, {
        oldScore: ev.args.oldScore?.toString(),
        correctedScore: ev.args.correctedScore?.toString(),
      });
      return;
    }
    return;
  }
  if (addr.dispute && ev.address === addr.dispute) {
    // DisputeResolver events carry the subject as `account`. Reading the
    // Solidity parameter name is how ethers v6 exposes it.
    const account: string | undefined = ev.args.account;
    if (ev.name === "DisputeCreated") {
      const disputeOnChainId = Number(ev.args.disputeId);
      const proposalOnChainId = Number(ev.args.proposalId);
      // Enum order must match DisputeResolver.ClaimType. Layer A added
      // WrongTotalPointsSum at index 3.
      const claimTypeMap = [
        "missing_event",
        "invalid_event",
        "wrong_arithmetic",
        "wrong_total_points_sum",
      ];
      const claimType = claimTypeMap[Number(ev.args.claimType)] ?? "unknown";
      if (account) {
        // Look up the local proposal row id for FK.
        const prop = queries.getLatestProposalByPop.get(account);
        if (prop && prop.on_chain_id === proposalOnChainId) {
          queries.insertDispute.run(
            disputeOnChainId,
            prop.id,
            account,
            String(ev.args.disputer).toLowerCase(),
            claimType
          );
        }
      }
      insertRaw(ev, ev.name, account ?? null, null, {
        disputeId: disputeOnChainId,
        proposalId: proposalOnChainId,
        claimType,
      });
      return;
    }
    if (ev.name === "DisputeResolved") {
      const disputeOnChainId = Number(ev.args.disputeId);
      const disputerWon: boolean = ev.args.disputerWon;
      queries.resolveDisputeDb.run(
        disputerWon ? "disputer_wins" : "proposer_wins",
        disputeOnChainId
      );
      insertRaw(ev, ev.name, account ?? null, null, {
        disputeId: disputeOnChainId,
        disputerWon,
      });
      return;
    }
    return;
  }
}

function ensureIdentity(account: string, blockNumber: number) {
  // `account` is the ethers-decoded address — already EIP-55 checksummed,
  // which is our canonical storage form. The `pop_id` column name is
  // historical (dates to the deleted PopId.sol); the value stored is a
  // plain 20-byte address, same as `evm_address`.
  queries.upsertIdentity.run(account, account.toLowerCase(), blockNumber, 1);
}

function insertRaw(
  ev: Decoded,
  type: string,
  account: string | null,
  wallet: string | null,
  data: Record<string, any>,
  points = 0,
  reason: string | null = null
) {
  queries.insertRawEvent.run(
    SOURCE,
    type,
    account,
    wallet,
    null,
    ev.blockNumber,
    ev.blockTimestamp,
    JSON.stringify({ address: ev.address, ...data }),
    points,
    reason,
    ev.txHash,
    ev.logIndex
  );
}

function bumpBalance(account: string, delta: number, blockNumber: number) {
  const row = queries.getBalance.get(account);
  const total = (row?.total_points ?? 0) + delta;
  const earned = (row?.earned_points ?? 0) + (delta > 0 ? delta : 0);
  const burned = (row?.burned_points ?? 0) + (delta < 0 ? -delta : 0);
  const locked = row?.locked_points ?? 0;
  queries.upsertBalance.run(account, total, earned, burned, locked, blockNumber);
}

export async function runPolkaCreditListener(signal?: AbortSignal) {
  log.info("polkacredit: starting listener");
  const addresses = await loadAddresses();
  const ifaces = buildInterfaces();
  let checkpoint = queries.getCheckpoint.get(SOURCE)?.last_block ?? 0;

  while (!signal?.aborted) {
    try {
      const latest = await head();
      if (latest > checkpoint) {
        const to = Math.min(checkpoint + MAX_BLOCKS_PER_BATCH, latest);
        const n = await processPolkaCreditBlocks(checkpoint + 1, to, addresses, ifaces);
        if (n > 0) log.info(`polkacredit: processed ${n} events in blocks ${checkpoint + 1}..${to}`);
        queries.setCheckpoint.run(SOURCE, to);
        checkpoint = to;
        if (to < latest) continue;
      }
    } catch (e) {
      log.error(`polkacredit: loop error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 6000));
  }
}
