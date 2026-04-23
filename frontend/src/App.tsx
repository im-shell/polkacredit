import { useEffect, useState } from "react";
import { CHAIN_ID, NETWORKS, buildContracts, type ContractBundle } from "./lib/contracts";
import {
  bindEvents,
  connectInjected,
  connectWalletConnect,
  disconnect,
  hasAnyProvider,
  hasInjectedProvider,
  hasWalletConnect,
  silentConnectInjected,
  silentConnectWalletConnect,
  switchChain,
  type Connection,
  type Eip1193,
  type WalletKind,
} from "./lib/wallet";
import { short } from "./lib/address";
import { registerAccount } from "./lib/indexerApi";
import { Connect } from "./components/Connect";
import { Overview } from "./components/ScoreCard";
import { StakeSection } from "./components/StakeCard";
import { VouchSection } from "./components/VouchCard";
import { VouchListCard } from "./components/VouchListCard";
import { LedgerSection } from "./components/PointsHistoryCard";
import { FaucetSection } from "./components/FaucetCard";

/**
 * Persisted WalletKind for silent reconnect on page refresh. Cleared on
 * explicit disconnect. Survives browser restarts (localStorage).
 */
const LAST_WALLET_KEY = "sampo:lastWalletKind";
function readLastWallet(): WalletKind | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(LAST_WALLET_KEY);
  return v === "injected" || v === "walletconnect" ? v : null;
}
function writeLastWallet(kind: WalletKind | null) {
  if (typeof window === "undefined") return;
  if (kind) window.localStorage.setItem(LAST_WALLET_KEY, kind);
  else window.localStorage.removeItem(LAST_WALLET_KEY);
}

export default function App() {
  const [conn, setConn] = useState<Connection | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [bundle, setBundle] = useState<ContractBundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [head, setHead] = useState<number>(0);
  const [autoSwitchTried, setAutoSwitchTried] = useState(false);
  const [tab, setTab] = useState<"overview" | "stake" | "vouch" | "activity" | "dev">("overview");

  // Silent reconnect on mount.
  useEffect(() => {
    const last = readLastWallet();
    if (!last) return;
    let cancelled = false;
    (async () => {
      try {
        const c = last === "walletconnect"
          ? await silentConnectWalletConnect()
          : await silentConnectInjected();
        if (cancelled || !c) return;
        setConn(c); setAddress(c.address); setChainId(c.chainId);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  const netName = chainId ? NETWORKS[chainId]?.name ?? `chain ${chainId}` : null;
  const onRightChain = chainId === CHAIN_ID;
  const wcEnabled = hasWalletConnect();

  useEffect(() => {
    if (!conn) return;
    return bindEvents(conn.eip1193 as Eip1193, {
      onAccounts: (accs) => {
        if (!accs.length) handleDisconnect();
        else setAddress(accs[0]);
      },
      onChain: (cid) => setChainId(cid),
      onDisconnect: () => handleDisconnect(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn]);

  useEffect(() => {
    if (!conn || !address || !onRightChain) {
      setBundle(null);
      return;
    }
    (async () => {
      try {
        const b = await buildContracts(conn.provider, conn.signer);
        setBundle(b);
      } catch (e: any) {
        setErr(e.message ?? String(e));
      }
    })();
  }, [conn, address, onRightChain, reloadKey]);

  useEffect(() => {
    if (!address) return;
    registerAccount(address);
  }, [address]);

  useEffect(() => {
    if (!conn || !address || onRightChain || autoSwitchTried) return;
    setAutoSwitchTried(true);
    (async () => {
      try {
        await switchChain(conn.eip1193, CHAIN_ID);
        setChainId(CHAIN_ID);
      } catch {}
    })();
  }, [conn, address, onRightChain, autoSwitchTried]);

  // Poll chain head every 4s for the live tag in the page header (DESIGN §7).
  useEffect(() => {
    if (!bundle) return;
    let stop = false;
    async function tick() {
      try {
        const b = await bundle!.provider.getBlockNumber();
        if (!stop) setHead(b);
      } catch {}
    }
    tick();
    const h = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(h); };
  }, [bundle]);

  async function doConnect(kind: WalletKind) {
    try {
      setErr(null);
      const c = kind === "walletconnect" ? await connectWalletConnect() : await connectInjected();
      setConn(c); setAddress(c.address); setChainId(c.chainId);
      setAutoSwitchTried(false);
      writeLastWallet(kind);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    }
  }

  async function handleDisconnect() {
    const kind = conn?.kind;
    setConn(null); setAddress(null); setChainId(null); setBundle(null);
    setAutoSwitchTried(false);
    writeLastWallet(null);
    if (kind) {
      try { await disconnect(kind); } catch {}
    }
  }

  async function handleSwitch() {
    if (!conn) return;
    try {
      await switchChain(conn.eip1193, CHAIN_ID);
      setChainId(CHAIN_ID);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    }
  }

  const refresh = () => setReloadKey((k) => k + 1);

  // ─── Connect screen ────────────────────────────────────────────────
  if (!address) {
    if (!hasAnyProvider()) {
      return (
        <Connect
          wcEnabled={false}
          injectedAvailable={false}
          onConnectInjected={() => {}}
          onConnectWalletConnect={() => {}}
          err="No EVM wallet detected. Install Talisman, SubWallet, or MetaMask — or set VITE_WALLETCONNECT_PROJECT_ID to enable QR login."
        />
      );
    }
    return (
      <Connect
        wcEnabled={wcEnabled}
        injectedAvailable={hasInjectedProvider()}
        onConnectInjected={() => doConnect("injected")}
        onConnectWalletConnect={() => doConnect("walletconnect")}
        err={err}
      />
    );
  }

  // ─── Connected shell ───────────────────────────────────────────────
  return (
    <>
      <nav className="nav">
        <div className="brand">
          <span className="mark" />
          Sampo
        </div>
        <div className="tabs">
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button>
          <button className={tab === "stake"    ? "active" : ""} onClick={() => setTab("stake")}>Stake</button>
          <button className={tab === "vouch"    ? "active" : ""} onClick={() => setTab("vouch")}>Vouch</button>
          <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Activity</button>
          <button className={tab === "dev"      ? "active" : ""} onClick={() => setTab("dev")}>Dev</button>
        </div>
        <div className="spacer" />
        <div className="chips">
          <span className="chip">
            {onRightChain && <span className="pip" />}
            {!onRightChain && <span className="pip warn" />}
            {netName ?? "—"}
          </span>
          <button className="chip button" onClick={handleDisconnect} title={address}>
            {short(address)}
            {conn?.kind === "walletconnect" && <span style={{ marginLeft: 4 }}>· WC</span>}
          </button>
        </div>
      </nav>

      <main className="main">
        <div className="pageHead">
          <h1>Your credit</h1>
          <span className="tag">Soulbound · on {netName}</span>
          <span className="dot">·</span>
          <span className="tag">
            {head > 0 && <span className="pip" style={{
              display: "inline-block", width: 6, height: 6, borderRadius: 999,
              background: "var(--accent)",
              boxShadow: "0 0 0 3px color-mix(in oklch, var(--accent) 22%, transparent)",
              marginRight: 8, verticalAlign: "middle",
            }} />}
            live · block {head.toLocaleString()}
          </span>
        </div>

        {!onRightChain && (
          <div className="banner">
            <div className="msg">
              <span className="pip" />
              Connected to {netName}. Sampo lives on{" "}
              <strong style={{ color: "var(--text)" }}>
                {NETWORKS[CHAIN_ID]?.name ?? `chain ${CHAIN_ID}`}
              </strong>.
            </div>
            <button className="btn sm ghost" onClick={handleSwitch}>Switch network</button>
          </div>
        )}

        {err && <div className="flash bad" style={{ marginBottom: 24 }}>{err}</div>}

        {bundle && onRightChain && tab === "overview" && (
          <>
            <Overview       bundle={bundle} account={address} key={`ov-${reloadKey}`} />
            <StakeSection   bundle={bundle} account={address} onChange={refresh} key={`stake-${reloadKey}`} />
            <VouchSection   bundle={bundle} account={address} onChange={refresh} key={`vouch-${reloadKey}`} />
            <VouchListCard  bundle={bundle} account={address} key={`vlist-${reloadKey}`} />
            <LedgerSection  bundle={bundle} account={address} key={`hist-${reloadKey}`} />
          </>
        )}

        {bundle && onRightChain && tab === "stake" && (
          <StakeSection bundle={bundle} account={address} onChange={refresh} key={`stake-${reloadKey}`} />
        )}

        {bundle && onRightChain && tab === "vouch" && (
          <>
            <VouchSection  bundle={bundle} account={address} onChange={refresh} key={`vouch-${reloadKey}`} />
            <VouchListCard bundle={bundle} account={address} key={`vlist-${reloadKey}`} />
          </>
        )}

        {bundle && onRightChain && tab === "activity" && (
          <LedgerSection bundle={bundle} account={address} key={`hist-${reloadKey}`} />
        )}

        {bundle && onRightChain && tab === "dev" && (
          <FaucetSection bundle={bundle} address={address} onChange={refresh} key={`faucet-${reloadKey}`} />
        )}

        <div className="footer">
          <span>Sampo · {NETWORKS[CHAIN_ID]?.name ?? `chain ${CHAIN_ID}`}</span>
          {bundle && <span>vault {short(bundle.deployment.contracts.StakingVault)}</span>}
        </div>
      </main>
    </>
  );
}
