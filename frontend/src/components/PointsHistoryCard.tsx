import { useEffect, useState } from "react";
import type { ContractBundle } from "../lib/contracts";
import { Section } from "./Section";

interface Entry {
  idx: number;
  amount: number;
  block: number;
  reason: string;
  vouchId: number;
}

const REASON_LABEL: Record<string, string> = {
  stake_deposit:         "First-stake bonus",
  stake_first:           "First-stake bonus",
  vouch_given:           "Vouch given · resolved",
  vouch_received:        "Vouch received · credited",
  vouch_penalty:         "Vouch failure · clawback",
  opengov_vote:          "OpenGov vote attributed",
  transfer_band:         "Transfer volume · band crossed",
  transfer_counterparty: "Transfer · new counterparty",
  loan_band:             "Loan repaid",
  loan_late_minor:       "Loan late · minor",
  loan_late_major:       "Loan late · major",
  loan_partial_default:  "Loan · partial default",
  loan_full_default:     "Loan · full default",
  inactivity:            "Inactivity penalty",
};

function sourceLabel(reason: string): string {
  if (reason.startsWith("stake_"))   return "StakingVault";
  if (reason.startsWith("vouch_"))   return "VouchRegistry";
  if (reason === "opengov_vote")     return "AssetHub OpenGov";
  if (reason.startsWith("transfer_"))return "Indexer · transfer feed";
  if (reason.startsWith("loan_"))    return "Indexer · loan feed";
  if (reason === "inactivity")       return "Indexer · decay job";
  return "PointsLedger";
}

export function LedgerSection({
  bundle,
  account,
}: {
  bundle: ContractBundle;
  account: string;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const len: bigint = await bundle.ledger.historyLength(account);
        const n = Number(len);
        if (n === 0) {
          if (!stop) setEntries([]);
          return;
        }
        const max = Math.min(n, 25);
        const from = n - max;
        const rows = await Promise.all(
          Array.from({ length: max }, (_, i) => bundle.ledger.historyAt(account, from + i))
        );
        if (stop) return;
        setEntries(
          rows
            .map((r: any, i: number) => ({
              idx: from + i,
              amount: Number(r.amount),
              block: Number(r.timestamp),
              reason: r.reason,
              vouchId: Number(r.relatedVouchId),
            }))
            .reverse()
        );
      } catch {}
    }
    load();
    const h = setInterval(load, 15_000);
    return () => { stop = true; clearInterval(h); };
  }, [bundle, account]);

  return (
    <Section num="03" title="Points ledger" sub={`${entries.length} shown`}>
      {entries.length === 0 ? (
        <div className="empty">No point events yet. Stake to write the first entry.</div>
      ) : (
        <div className="ledger">
          <div className="ledgerHead">
            <span>Idx</span>
            <span>Event</span>
            <span>Source</span>
            <span>Block</span>
            <span>Δ</span>
          </div>
          {entries.map((e) => (
            <div className="ledgerRow" key={e.idx}>
              <span className="idx">{e.idx.toString().padStart(3, "0")}</span>
              <span className="reason">{REASON_LABEL[e.reason] ?? e.reason}</span>
              <span className="src">{sourceLabel(e.reason)}</span>
              <span className="blk">{e.block.toLocaleString()}</span>
              <span className={`delta ${e.amount > 0 ? "pos" : e.amount < 0 ? "neg" : ""}`}>
                {e.amount > 0 ? "+" : ""}
                {e.amount}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
