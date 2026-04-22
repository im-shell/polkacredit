import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined ? fallback : Number(v);
}

export interface Deployment {
  chainId: number;
  indexer: string;
  contracts: Record<string, string>;
}

function loadDeployment(): Deployment {
  const raw = process.env.DEPLOYMENT_FILE ?? path.join(__dirname, "..", "..", "contracts", "deployments", "31337.json");
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(__dirname, "..", raw);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Deployment file not found at ${absolute}. Run contracts/scripts/deploy.ts first.`);
  }
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

export const config = {
  db: {
    file: optional("DATABASE_FILE", "./polkacredit.db"),
  },
  evm: {
    rpcUrl: optional("EVM_RPC_URL", "http://127.0.0.1:8545"),
    chainId: num("EVM_CHAIN_ID", 31337),
    indexerPrivateKey: process.env.INDEXER_PRIVATE_KEY ?? "",
  },
  openGov: {
    enabled: bool("ENABLE_OPENGOV", false),
    // OpenGov lives on AssetHub (Polkadot Hub / Passet Hub), not the relay.
    // Default: Passet Hub testnet. Override to Polkadot Hub for mainnet.
    wss: optional("OPENGOV_WSS", "wss://asset-hub-paseo-rpc.n.dwellir.com"),
  },
  api: {
    port: num("API_PORT", 4000),
  },
  polling: {
    blockIntervalMs: num("BLOCK_POLL_INTERVAL_MS", 12_000),
    scoreIntervalMs: num("SCORE_JOB_INTERVAL_MS", 6 * 60 * 60 * 1000),
    finalizationIntervalMs: num("FINALIZATION_JOB_INTERVAL_MS", 15 * 60 * 1000),
  },
  deployment: loadDeployment(),
};

export type Config = typeof config;
