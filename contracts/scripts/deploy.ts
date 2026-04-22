import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getAddress, parseEther, type Chain } from "viem";

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
    OracleRegistry: `0x${string}`;
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

  // Bootstrap oracle bond: 100 mUSD per oracle. Testnet-comfortable; tune up
  // for production to make slashing economically meaningful.
  const ORACLE_MIN_BOND = parseEther("100");

  console.log(`Network      : ${hre.network.name} (chainId ${chainId})`);
  console.log(`Deployer     : ${deployer}`);
  console.log(`Indexer      : ${indexer}  (the bootstrap oracle)`);
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
    // `indexer` here is a placeholder — we'll immediately point it at
    // OracleRegistry via setIndexer once it's deployed. The ctor requires a
    // non-zero address so we pass the EOA as a temporary.
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

  const oracle = await hre.viem.deployContract(
    "OracleRegistry",
    [
      deployer,
      score.address,
      ledger.address,
      stable.address,
      treasury,
      ORACLE_MIN_BOND,
      1, // threshold = 1 — bootstrap with a single oracle
    ],
    { client },
  );
  console.log(`OracleRegistry   : ${oracle.address}`);

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

  // OracleRegistry now holds the writer roles that the raw indexer address
  // used to have. The bootstrap indexer becomes an oracle that registers
  // itself; its signatures flow through OracleRegistry → ScoreRegistry /
  // PointsLedger.
  await send("ledger.setAuthorized(vault)", () =>
    ledger.write.setAuthorized([vault.address, true]),
  );
  await send("ledger.setAuthorized(vouch)", () =>
    ledger.write.setAuthorized([vouch.address, true]),
  );
  await send("ledger.setAuthorized(oracleRegistry)", () =>
    ledger.write.setAuthorized([oracle.address, true]),
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
  await send("score.setIndexer(oracleRegistry)", () =>
    score.write.setIndexer([oracle.address]),
  );

  // Bootstrap: fund + approve + register the single oracle (our indexer key).
  // For testnet demos we mint mUSD to the indexer so it can post its bond;
  // production deployments would transfer from treasury or require the oracle
  // operator to source the stake externally.
  await send("stable.mint(indexer, bond)", () =>
    stable.write.mint([indexer, ORACLE_MIN_BOND]),
  );
  await send("stable.approve(oracleRegistry)", async () => {
    // If deployer != indexer we need a separate client; for the common
    // case (deployer == indexer) the same wallet is fine.
    return stable.write.approve([oracle.address, ORACLE_MIN_BOND]);
  });
  await send("oracleRegistry.register", () =>
    oracle.write.register([ORACLE_MIN_BOND]),
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
      OracleRegistry: oracle.address,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
