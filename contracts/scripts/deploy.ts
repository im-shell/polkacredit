import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying PolkaCredit from ${deployer.address}`);
  console.log(
    `Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} native`
  );

  // Indexer signer — for testnets, read from env; falls back to deployer.
  const indexerAddr = process.env.INDEXER_ADDRESS ?? deployer.address;

  // 1. Stablecoin (mock; on testnet prefer a real USDC-like)
  const Stable = await ethers.getContractFactory("MockStablecoin");
  const stable = await Stable.deploy();
  await stable.waitForDeployment();
  console.log(`MockStablecoin       → ${await stable.getAddress()}`);

  // 2. Points ledger
  const Ledger = await ethers.getContractFactory("PointsLedger");
  const ledger = await Ledger.deploy(deployer.address);
  await ledger.waitForDeployment();
  console.log(`PointsLedger         → ${await ledger.getAddress()}`);

  // 3. Staking vault
  const Vault = await ethers.getContractFactory("StakingVault");
  const vault = await Vault.deploy(
    deployer.address,
    await stable.getAddress(),
    await ledger.getAddress()
  );
  await vault.waitForDeployment();
  console.log(`StakingVault         → ${await vault.getAddress()}`);

  // 4. Vouch registry
  const Vouch = await ethers.getContractFactory("VouchRegistry");
  const vouch = await Vouch.deploy(
    deployer.address,
    await ledger.getAddress(),
    await vault.getAddress()
  );
  await vouch.waitForDeployment();
  console.log(`VouchRegistry        → ${await vouch.getAddress()}`);

  // 5. Score registry
  const Score = await ethers.getContractFactory("ScoreRegistry");
  const score = await Score.deploy(deployer.address, indexerAddr);
  await score.waitForDeployment();
  console.log(`ScoreRegistry        → ${await score.getAddress()}`);

  // 6. Wallet registry
  const Wallet = await ethers.getContractFactory("WalletRegistry");
  const wallet = await Wallet.deploy(deployer.address);
  await wallet.waitForDeployment();
  console.log(`WalletRegistry       → ${await wallet.getAddress()}`);

  // 7. Dispute resolver (treasury defaults to deployer for MVP)
  const Dispute = await ethers.getContractFactory("DisputeResolver");
  const dispute = await Dispute.deploy(
    deployer.address,
    await score.getAddress(),
    await stable.getAddress(),
    deployer.address
  );
  await dispute.waitForDeployment();
  console.log(`DisputeResolver      → ${await dispute.getAddress()}`);

  // ─── Wire up authorizations ───
  console.log("\nWiring permissions...");
  await (await ledger.setAuthorized(await vault.getAddress(), true)).wait();
  await (await ledger.setAuthorized(await vouch.getAddress(), true)).wait();
  await (await ledger.setAuthorized(indexerAddr, true)).wait();
  await (await vault.setVouchRegistry(await vouch.getAddress())).wait();
  await (await vouch.setDefaultReporter(indexerAddr)).wait();
  await (await score.setDisputeResolver(await dispute.getAddress())).wait();
  console.log("  ✔ PointsLedger: StakingVault, VouchRegistry, Indexer authorized");
  console.log("  ✔ StakingVault: VouchRegistry set");
  console.log("  ✔ VouchRegistry: defaultReporter set to indexer");
  console.log("  ✔ ScoreRegistry: DisputeResolver wired");

  // ─── Persist deployed addresses ───
  const deployment = {
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    indexer: indexerAddr,
    contracts: {
      MockStablecoin: await stable.getAddress(),
      PointsLedger: await ledger.getAddress(),
      StakingVault: await vault.getAddress(),
      VouchRegistry: await vouch.getAddress(),
      ScoreRegistry: await score.getAddress(),
      WalletRegistry: await wallet.getAddress(),
      DisputeResolver: await dispute.getAddress(),
    },
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${deployment.chainId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));
  console.log(`\nAddresses written to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
