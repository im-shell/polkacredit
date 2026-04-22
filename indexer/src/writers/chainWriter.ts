import { ethers } from "ethers";
import { contracts, signer } from "../chain/evm.js";
import { log } from "../util/log.js";

/**
 * Thin wrapper around the oracle write-path. Every mint / burn / propose
 * goes through `OracleRegistry`, which verifies M-of-N ECDSA signatures and
 * forwards to the authoritative `PointsLedger` / `ScoreRegistry` contracts.
 *
 * In the bootstrap configuration (N=1, threshold=1) this indexer holds the
 * single oracle keypair. When more oracles join, each node independently
 * signs the same payload and off-chain coordination (simple HTTP gossip,
 * libp2p, etc.) collects M signatures before any one node submits.
 */

function requireOracleSigner() {
  if (!signer) throw new Error("INDEXER_PRIVATE_KEY is required to write on-chain");
  if (!contracts.oracleRegistry) {
    throw new Error(
      "OracleRegistry address missing from deployment file — redeploy contracts so the indexer signs through the oracle layer"
    );
  }
}

/// Read the next nonce from OracleRegistry. Every submit consumes this value;
/// wrap each submit in a fresh read to avoid stale-nonce collisions between
/// concurrent jobs.
async function nextNonce(): Promise<bigint> {
  return (await (contracts.oracleRegistry as any).nextNonce()) as bigint;
}

/// EIP-191 "personal_sign" style hash. Matches the contract's manual prefix.
function ethSignedHash(payload: string): string {
  return ethers.hashMessage(ethers.getBytes(payload));
}

async function signPayload(payload: string): Promise<string> {
  // ethers v6 `signMessage` adds the EIP-191 prefix internally.
  return signer!.signMessage(ethers.getBytes(payload));
}

export async function mintPoints(account: string, amount: number, reason: string) {
  requireOracleSigner();
  if (amount <= 0) return;
  const nonce = await nextNonce();
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "string", "address", "uint64", "bytes32", "uint64"],
    [
      await contracts.oracleRegistry!.getAddress(),
      "submitMint",
      account,
      amount,
      ethers.keccak256(ethers.toUtf8Bytes(reason)),
      nonce,
    ]
  );
  const payloadHash = ethers.keccak256(payload);
  const sig = await signPayload(payloadHash);
  const tx = await (contracts.oracleRegistry as any).submitMint(
    account, amount, reason, nonce, [sig]
  );
  await tx.wait();
  log.info(`oracle: mint ${amount} pts → ${account.slice(0, 10)}… (${reason}) tx=${tx.hash}`);
  // reference unused-but-useful helper to avoid dead-code lint
  void ethSignedHash;
}

export async function burnPoints(account: string, amount: number, reason: string) {
  requireOracleSigner();
  if (amount <= 0) return;
  const nonce = await nextNonce();
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "string", "address", "uint64", "bytes32", "uint64"],
    [
      await contracts.oracleRegistry!.getAddress(),
      "submitBurn",
      account,
      amount,
      ethers.keccak256(ethers.toUtf8Bytes(reason)),
      nonce,
    ]
  );
  const payloadHash = ethers.keccak256(payload);
  const sig = await signPayload(payloadHash);
  const tx = await (contracts.oracleRegistry as any).submitBurn(
    account, amount, reason, nonce, [sig]
  );
  await tx.wait();
  log.info(`oracle: burn ${amount} pts ← ${account.slice(0, 10)}… (${reason}) tx=${tx.hash}`);
}

export interface ProposalSubmission {
  account: string;
  score: number;
  totalPoints: number;
  eventCount: number;
  sourceBlockHeight: number;
  algorithmVersion: number;
}

export interface SubmittedProposal {
  account: string;
  onChainId: number;
  txHash: string;
  proposedAtBlock: number;
}

/// Submit a single proposal via OracleRegistry. Returns the on-chain
/// `proposalId` parsed from the `ScoreProposed` event emitted by the
/// underlying ScoreRegistry.
export async function proposeScore(p: ProposalSubmission): Promise<SubmittedProposal> {
  requireOracleSigner();
  const nonce = await nextNonce();
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "address",
      "string",
      "address",
      "uint64",
      "int64",
      "uint32",
      "uint64",
      "uint16",
      "uint64",
    ],
    [
      await contracts.oracleRegistry!.getAddress(),
      "submitScore",
      p.account,
      p.score,
      p.totalPoints,
      p.eventCount,
      p.sourceBlockHeight,
      p.algorithmVersion,
      nonce,
    ]
  );
  const payloadHash = ethers.keccak256(payload);
  const sig = await signPayload(payloadHash);

  const tx = await (contracts.oracleRegistry as any).submitScore(
    p.account,
    p.score,
    p.totalPoints,
    p.eventCount,
    p.sourceBlockHeight,
    p.algorithmVersion,
    nonce,
    [sig]
  );
  const receipt = await tx.wait();

  // Parse the ScoreProposed event emitted by the inner ScoreRegistry.
  let onChainId = 0;
  for (const logEntry of receipt.logs) {
    try {
      const parsed = (contracts.scoreRegistry as any).interface.parseLog({
        topics: [...logEntry.topics],
        data: logEntry.data,
      });
      if (parsed?.name === "ScoreProposed") {
        onChainId = Number(parsed.args.proposalId);
        break;
      }
    } catch {
      // not a ScoreRegistry event
    }
  }

  log.info(`oracle: proposed score ${p.score} for ${p.account.slice(0, 10)}… (id=${onChainId}) tx=${tx.hash}`);
  return {
    account: p.account,
    onChainId,
    txHash: tx.hash,
    proposedAtBlock: receipt.blockNumber,
  };
}

export async function finalizeScore(account: string): Promise<{ txHash: string; block: number }> {
  requireOracleSigner();
  // finalizeScore is permissionless — call ScoreRegistry directly, no oracle
  // signature required. Anyone can promote a pending proposal after the
  // challenge window closes.
  const tx = await (contracts.scoreRegistry as any).finalizeScore(account);
  const receipt = await tx.wait();
  log.info(`chain: finalized score for ${account.slice(0, 10)}… tx=${tx.hash}`);
  return { txHash: tx.hash, block: receipt.blockNumber };
}

export async function reportDefault(vouchId: number) {
  requireOracleSigner();
  const tx = await (contracts.vouchRegistry as any).reportDefault(vouchId);
  await tx.wait();
  log.info(`chain: reported default vouchId=${vouchId} tx=${tx.hash}`);
}
