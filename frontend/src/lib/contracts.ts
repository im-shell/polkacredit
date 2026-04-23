import { ethers } from "ethers";

export interface Deployment {
  chainId: number;
  deployer: string;
  indexer: string;
  contracts: {
    MockStablecoin: string;
    PointsLedger: string;
    StakingVault: string;
    VouchRegistry: string;
    ScoreRegistry: string;
    DisputeResolver?: string;
  };
  deployedAt: string;
}

/// Chain ID the UI targets. Default: 420420417 = Passet Hub (Paseo AssetHub).
/// Override at build time: `VITE_CHAIN_ID=420420419 npm run dev` for Polkadot
/// Hub mainnet, or `VITE_CHAIN_ID=420420421 npm run dev` for local zombienet.
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 420420417);

export const NETWORKS: Record<number, { name: string; rpc: string; explorer: string; currency: string }> = {
  420420419: {
    name: "Polkadot Hub",
    rpc: "https://eth-rpc.polkadot.io/",
    explorer: "https://blockscout.polkadot.io",
    currency: "DOT",
  },
  420420417: {
    name: "Passet Hub",
    rpc: "https://eth-rpc-testnet.polkadot.io/",
    explorer: "https://blockscout-testnet.polkadot.io",
    currency: "PAS",
  },
  420420418: {
    name: "Kusama Hub",
    rpc: "https://eth-rpc-kusama.polkadot.io/",
    explorer: "https://blockscout-kusama.polkadot.io",
    currency: "KSM",
  },
  420420421: {
    name: "Local (polkadot-stack-template)",
    rpc: "http://127.0.0.1:8545",
    explorer: "",
    currency: "DOT",
  },
  31337: {
    name: "Anvil (local)",
    rpc: "http://127.0.0.1:8546",
    explorer: "",
    currency: "ETH",
  },
};

let cachedDeployment: Deployment | null = null;
let cachedAbis: Record<string, any[]> | null = null;

export async function loadDeployment(): Promise<Deployment> {
  if (cachedDeployment) return cachedDeployment;
  const res = await fetch(`/deployments/${CHAIN_ID}.json`);
  if (!res.ok) throw new Error(`No deployment for chainId ${CHAIN_ID}`);
  cachedDeployment = (await res.json()) as Deployment;
  return cachedDeployment;
}

export async function loadAbis(): Promise<Record<string, any[]>> {
  if (cachedAbis) return cachedAbis;
  const names = [
    "PointsLedger",
    "StakingVault",
    "VouchRegistry",
    "ScoreRegistry",
    "MockStablecoin",
    "DisputeResolver",
  ];
  const entries = await Promise.all(
    names.map(async (n) => {
      const r = await fetch(`/abi/${n}.json`);
      if (!r.ok) throw new Error(`Missing ABI for ${n}`);
      const j = await r.json();
      return [n, j.abi] as [string, any[]];
    })
  );
  cachedAbis = Object.fromEntries(entries);
  return cachedAbis;
}

export interface ContractBundle {
  deployment: Deployment;
  abis: Record<string, any[]>;
  provider: ethers.BrowserProvider;
  signer: ethers.Signer | null;
  stable: ethers.Contract;
  ledger: ethers.Contract;
  vault: ethers.Contract;
  vouch: ethers.Contract;
  score: ethers.Contract;
  dispute: ethers.Contract | null;
}

export async function buildContracts(
  provider: ethers.BrowserProvider,
  signer: ethers.Signer | null
): Promise<ContractBundle> {
  const [deployment, abis] = await Promise.all([loadDeployment(), loadAbis()]);
  const run = signer ?? provider;
  return {
    deployment,
    abis,
    provider,
    signer,
    stable: new ethers.Contract(deployment.contracts.MockStablecoin, abis.MockStablecoin, run),
    ledger: new ethers.Contract(deployment.contracts.PointsLedger, abis.PointsLedger, run),
    vault: new ethers.Contract(deployment.contracts.StakingVault, abis.StakingVault, run),
    vouch: new ethers.Contract(deployment.contracts.VouchRegistry, abis.VouchRegistry, run),
    score: new ethers.Contract(deployment.contracts.ScoreRegistry, abis.ScoreRegistry, run),
    dispute: deployment.contracts.DisputeResolver
      ? new ethers.Contract(deployment.contracts.DisputeResolver, abis.DisputeResolver, run)
      : null,
  };
}
