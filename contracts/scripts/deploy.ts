import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getAddress, type Chain } from "viem";

const DEPLOYMENTS_DIR = path.resolve(__dirname, "../deployments");

type Deployed = {
  chainId: number;
  network: string;
  deployer: `0x${string}`;
  indexer: `0x${string}`;
  treasury: `0x${string}`;
  rpcUrl: string;
  contracts: {
    MockStablecoin: `0x${string}`;
    PointsLedger: `0x${string}`;
    StakingVault: `0x${string}`;
    VouchRegistry: `0x${string}`;
    ScoreRegistry: `0x${string}`;
    DisputeResolver: `0x${string}`;
  };
};

function writeDeployment(d: Deployed) {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  }
  const file = path.join(DEPLOYMENTS_DIR, `${d.chainId}.json`);
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
  console.log(`Wrote ${file}`);
}

async function main() {
  // hardhat-viem looks up the chain by id in viem's built-in `viem/chains`.
  // Paseo/Polkadot Hub aren't there, so we synthesize a Chain from network config
  // and pass it (and the resulting clients) into every getter + deployContract call.
  const netCfg = hre.network.config as { url?: string; chainId?: number };
  const rawChainId =
    netCfg.chainId ?? Number(await hre.network.provider.send("eth_chainId"));
  const chain: Chain = {
    id: rawChainId,
    name: hre.network.name,
    nativeCurrency: { name: "PAS", symbol: "PAS", decimals: 18 },
    rpcUrls: { default: { http: [netCfg.url ?? ""] } },
  };

  const [wallet] = await hre.viem.getWalletClients({ chain });
  const publicClient = await hre.viem.getPublicClient({ chain });
  const client = { public: publicClient, wallet } as const;

  const deployer = getAddress(wallet.account.address);
  const indexer = getAddress(process.env.INDEXER_ADDRESS ?? deployer);
  const treasury = getAddress(process.env.TREASURY_ADDRESS ?? deployer);
  const chainId = await publicClient.getChainId();

  console.log(`Network      : ${hre.network.name} (chainId ${chainId})`);
  console.log(`Deployer     : ${deployer}`);
  console.log(`Indexer      : ${indexer}`);
  console.log(`Treasury     : ${treasury}`);

  const stable = await hre.viem.deployContract("MockStablecoin", [], { client });
  console.log(`MockStablecoin   : ${stable.address}`);

  const ledger = await hre.viem.deployContract("PointsLedger", [deployer], { client });
  console.log(`PointsLedger     : ${ledger.address}`);

  const vault = await hre.viem.deployContract(
    "StakingVault",
    [deployer, stable.address, ledger.address, treasury, 18],
    { client },
  );
  console.log(`StakingVault     : ${vault.address}`);

  const vouch = await hre.viem.deployContract(
    "VouchRegistry",
    [deployer, ledger.address, vault.address],
    { client },
  );
  console.log(`VouchRegistry    : ${vouch.address}`);

  const score = await hre.viem.deployContract(
    "ScoreRegistry",
    [deployer, indexer],
    { client },
  );
  console.log(`ScoreRegistry    : ${score.address}`);

  const dispute = await hre.viem.deployContract(
    "DisputeResolver",
    [deployer, score.address, ledger.address, stable.address, treasury, 18],
    { client },
  );
  console.log(`DisputeResolver  : ${dispute.address}`);

  console.log("Wiring permissions...");
  // pallet-revive's tx pool rejects rapid same-sender submissions with
  // "Priority is too low". Send each tx and wait for its receipt before the next.
  const send = async (
    label: string,
    submit: () => Promise<`0x${string}`>,
  ) => {
    const hash = await submit();
    await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    console.log(`  ${label} ✓`);
  };

  await send("ledger.setAuthorized(vault)", () =>
    ledger.write.setAuthorized([vault.address, true]),
  );
  await send("ledger.setAuthorized(vouch)", () =>
    ledger.write.setAuthorized([vouch.address, true]),
  );
  await send("ledger.setAuthorized(indexer)", () =>
    ledger.write.setAuthorized([indexer, true]),
  );
  await send("vault.setVouchRegistry", () =>
    vault.write.setVouchRegistry([vouch.address]),
  );
  await send("vouch.setDefaultReporter", () =>
    vouch.write.setDefaultReporter([indexer]),
  );
  await send("score.setDisputeResolver", () =>
    score.write.setDisputeResolver([dispute.address]),
  );

  writeDeployment({
    chainId,
    network: hre.network.name,
    deployer,
    indexer,
    treasury,
    rpcUrl: (hre.network.config as { url?: string }).url ?? "",
    contracts: {
      MockStablecoin: stable.address,
      PointsLedger: ledger.address,
      StakingVault: vault.address,
      VouchRegistry: vouch.address,
      ScoreRegistry: score.address,
      DisputeResolver: dispute.address,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
