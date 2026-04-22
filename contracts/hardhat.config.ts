import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-viem";
import "@parity/hardhat-polkadot";
import { vars } from "hardhat/config";

const RAW_PRIVATE_KEY = vars.get("PRIVATE_KEY", "").trim();
// Guard against malformed values (mnemonics, Substrate seeds, stray whitespace) —
// a bad entry would otherwise fail the entire config load, even for `local`.
const PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/.test(RAW_PRIVATE_KEY)
  ? (RAW_PRIVATE_KEY.startsWith("0x") ? RAW_PRIVATE_KEY : `0x${RAW_PRIVATE_KEY}`)
  : "";
if (RAW_PRIVATE_KEY && !PRIVATE_KEY) {
  console.warn(
    "[hardhat.config] PRIVATE_KEY is set but not a 32-byte hex secp256k1 key — ignoring. " +
      "Export the Ethereum private key from Talisman and run `npx hardhat vars set PRIVATE_KEY`.",
  );
}

const config: HardhatUserConfig = {
  solidity: {
    // Must match the `pragma solidity 0.8.30;` in contracts/*.sol. An older
    // solc version here would reject the new syntax the Forge build accepts.
    version: "0.8.30",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
    },
  },
  resolc: {
    version: "1.0.0",
  },
  paths: {
    sources: "contracts",
    tests: "test",
    artifacts: "artifacts",
    cache: "cache_hardhat",
  },
  networks: {
    local: {
      url: process.env.ETH_RPC_HTTP || "http://127.0.0.1:8545",
      // Template Alice EVM dev key — matches polkadot-stack-template local node.
      // (Hardhat accounts must be 0x-prefixed secp256k1 keys; not SS58.)
      accounts: ["0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133"],
    },
    passetHub: {
      // Paseo AssetHub testnet — pallet-revive via eth-rpc adapter.
      // Probed 2026-04-20: eth_chainId = 0x190f1b41 = 420420417.
      url: process.env.PASSET_HUB_RPC_URL || "https://eth-rpc-testnet.polkadot.io/",
      chainId: 420420417,
      // `polkadot: { target: "evm" }` keeps plain solc EVM bytecode (skips resolc/PVM).
      // pallet-revive accepts EVM bytecode via the eth-rpc adapter.
      polkadot: { target: "evm" },
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    polkadotHub: {
      // Polkadot AssetHub mainnet.
      url: process.env.POLKADOT_HUB_RPC_URL || "https://eth-rpc.polkadot.io/",
      // Same as passetHub — plain solc EVM bytecode, no resolc.
      polkadot: { target: "evm" },
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};

export default config;
