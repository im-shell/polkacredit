import { useEffect, useState } from "react";
import type { ContractBundle } from "../lib/contracts";

interface Entry {
  amount: number;
  timestamp: number;
  reason: string;
  vouchId: number;
}

export function PointsHistoryCard({
  bundle,
  account,
}: {
  bundle: ContractBundle;
  account: string;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const len: bigint = await bundle.ledger.historyLength(account);
        const n = Number(len);
        const max = Math.min(n, 25);
        const from = n - max;
        const rows = await Promise.all(
          Array.from({ length: max }, (_, i) => bundle.ledger.historyAt(account, from + i))
        );
        if (stop) return;
        setEntries(
          rows
            .map((r: any) => ({
              amount: Number(r.amount),
              timestamp: Number(r.timestamp),
              reason: r.reason,
              vouchId: Number(r.relatedVouchId),
            }))
            .reverse()
        );
      } catch (e: any) {
        setErr(e.message);
      }
    }
    load();
    const h = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [bundle, account]);

  return (
    <div className="card" style={{ gridColumn: "span 2" }}>
      <h2>Points history</h2>
      {err && <div className="banner err">{err}</div>}
      {entries.length === 0 ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          No point events yet. Stake to get started.
        </div>
      ) : (
        <div className="history">
          {entries.map((e, i) => (
            <div className="ev" key={i}>
              <span className="kv">block {e.timestamp}</span>
              <span className="reason">{e.reason || "—"}</span>
              <span className={`amt ${e.amount > 0 ? "pos" : e.amount < 0 ? "neg" : ""}`}>
                {e.amount > 0 ? "+" : ""}
                {e.amount}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
