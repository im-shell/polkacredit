import { expect } from "chai";
import { ethers } from "hardhat";

const HUNDRED_USD = ethers.parseUnits("100", 18);
const CHALLENGE_WINDOW_HEX = "0x1c20"; // 7200 blocks

/// Mirror of lib/PopId.sol: bytes32(uint256(uint160(addr))).
function popIdOf(address: string): string {
  return ethers.zeroPadValue(address.toLowerCase(), 32);
}

async function setup() {
  const [admin, alice, bob, cara, indexer, gov, treasury] = await ethers.getSigners();

  const Stable = await ethers.getContractFactory("MockStablecoin");
  const stable = await Stable.deploy();

  const Ledger = await ethers.getContractFactory("PointsLedger");
  const ledger = await Ledger.deploy(admin.address);

  const Vault = await ethers.getContractFactory("StakingVault");
  const vault = await Vault.deploy(admin.address, await stable.getAddress(), await ledger.getAddress());

  const Vouch = await ethers.getContractFactory("VouchRegistry");
  const vouch = await Vouch.deploy(admin.address, await ledger.getAddress(), await vault.getAddress());

  const Score = await ethers.getContractFactory("ScoreRegistry");
  const score = await Score.deploy(admin.address, indexer.address);

  const Dispute = await ethers.getContractFactory("DisputeResolver");
  const dispute = await Dispute.deploy(
    admin.address,
    await score.getAddress(),
    await stable.getAddress(),
    treasury.address
  );

  await ledger.setAuthorized(await vault.getAddress(), true);
  await ledger.setAuthorized(await vouch.getAddress(), true);
  await ledger.setAuthorized(indexer.address, true);
  await vault.setVouchRegistry(await vouch.getAddress());
  await vouch.setDefaultReporter(indexer.address);
  await score.setDisputeResolver(await dispute.getAddress());
  await dispute.setGovernance(gov.address);

  for (const s of [alice, bob, cara]) {
    await stable.mint(s.address, ethers.parseUnits("10000", 18));
    await stable.connect(s).approve(await vault.getAddress(), ethers.MaxUint256);
    await stable.connect(s).approve(await dispute.getAddress(), ethers.MaxUint256);
  }
  // Pre-fund the treasury for dispute rewards.
  await stable.mint(treasury.address, ethers.parseUnits("1000", 18));
  await stable.connect(treasury).transfer(await dispute.getAddress(), ethers.parseUnits("1000", 18));

  return { admin, alice, bob, cara, indexer, gov, treasury, stable, ledger, vault, vouch, score, dispute };
}

describe("StakingVault", () => {
  it("stake below minimum reverts", async () => {
    const { alice, vault } = await setup();
    await expect(vault.connect(alice).stake(ethers.parseUnits("10", 18))).to.be.revertedWith(
      "StakingVault: below minimum"
    );
  });

  it("stake succeeds and mints stake_deposit points", async () => {
    const { alice, vault, ledger } = await setup();
    await expect(vault.connect(alice).stake(HUNDRED_USD))
      .to.emit(vault, "Staked")
      .and.to.emit(ledger, "PointsMinted");
    const bal = await ledger.getBalance(popIdOf(alice.address));
    expect(bal.earned).to.equal(10n);
  });

  it("unstake after lock expires", async () => {
    const { alice, stable, vault } = await setup();
    await vault.connect(alice).stake(HUNDRED_USD);
    await ethers.provider.send("hardhat_mine", ["0x1fa40"]);
    const before = await stable.balanceOf(alice.address);
    await vault.connect(alice).unstake();
    expect((await stable.balanceOf(alice.address)) - before).to.equal(HUNDRED_USD);
  });
});

describe("PointsLedger", () => {
  it("mint/burn only via authorized", async () => {
    const { alice, indexer, ledger } = await setup();
    const id = popIdOf(alice.address);
    await ledger.connect(indexer).mintPoints(id, 25, "opengov_vote");
    expect((await ledger.getBalance(id)).total).to.equal(25n);
    await ledger.connect(indexer).burnPoints(id, 5, "inactivity");
    expect((await ledger.getBalance(id)).total).to.equal(20n);
  });

  it("unauthorized callers revert", async () => {
    const { alice, ledger } = await setup();
    await expect(
      ledger.connect(alice).mintPoints(popIdOf(alice.address), 5, "x")
    ).to.be.revertedWith("PointsLedger: not authorized");
  });
});

describe("VouchRegistry", () => {
  async function primed() {
    const s = await setup();
    await s.vault.connect(s.alice).stake(HUNDRED_USD);
    await s.vault.connect(s.bob).stake(HUNDRED_USD);
    await s.ledger.connect(s.indexer).mintPoints(popIdOf(s.alice.address), 50, "opengov_vote");
    return s;
  }

  it("vouch → resolveVouch success", async () => {
    const s = await primed();
    await s.vouch.connect(s.alice).vouch(popIdOf(s.bob.address));
    await s.ledger.connect(s.indexer).mintPoints(popIdOf(s.bob.address), 40, "opengov_vote");
    await ethers.provider.send("hardhat_mine", ["0x1fa40"]);
    await expect(s.vouch.resolveVouch(1)).to.emit(s.vouch, "VouchSucceeded");
    expect((await s.ledger.getBalance(popIdOf(s.alice.address))).total).to.equal(65n);
  });

  it("resolveVouch fail halves vouchee earned points", async () => {
    const s = await primed();
    await s.vouch.connect(s.alice).vouch(popIdOf(s.bob.address));
    await s.ledger.connect(s.indexer).mintPoints(popIdOf(s.bob.address), 10, "opengov_vote");
    await ethers.provider.send("hardhat_mine", ["0x1fa40"]);
    await expect(s.vouch.resolveVouch(1)).to.emit(s.vouch, "VouchFailed");
    expect((await s.ledger.getBalance(popIdOf(s.alice.address))).total).to.equal(40n);
    expect((await s.ledger.getBalance(popIdOf(s.bob.address))).total).to.equal(15n);
  });

  it("reportDefault zeros vouchee", async () => {
    const s = await primed();
    await s.vouch.connect(s.alice).vouch(popIdOf(s.bob.address));
    await s.ledger.connect(s.indexer).mintPoints(popIdOf(s.bob.address), 25, "opengov_vote");
    await expect(s.vouch.connect(s.indexer).reportDefault(1)).to.emit(s.vouch, "VouchDefaulted");
    expect((await s.ledger.getBalance(popIdOf(s.bob.address))).total).to.equal(0n);
  });
});

describe("ScoreRegistry: propose / finalize", () => {
  it("only indexer can propose", async () => {
    const { alice, score } = await setup();
    await expect(
      score.connect(alice).proposeScore(popIdOf(alice.address), 100, 50n, ethers.ZeroHash, 0, 0, 1)
    ).to.be.revertedWith("ScoreRegistry: not indexer");
  });

  it("proposeScore rejects score > MAX_SCORE", async () => {
    const { alice, indexer, score } = await setup();
    await expect(
      score.connect(indexer).proposeScore(popIdOf(alice.address), 900, 500n, ethers.ZeroHash, 0, 0, 1)
    ).to.be.revertedWith("ScoreRegistry: score > max");
  });

  it("proposeScore puts proposal into Pending", async () => {
    const { alice, indexer, score } = await setup();
    const id = popIdOf(alice.address);
    await expect(
      score.connect(indexer).proposeScore(id, 247, 145n, ethers.ZeroHash, 0, 0, 1)
    ).to.emit(score, "ScoreProposed");
    const p = await score.getPendingProposal(id);
    expect(p.score).to.equal(247n);
    expect(p.status).to.equal(1n); // Pending
  });

  it("getScore returns 0 while proposal is pending", async () => {
    const { alice, indexer, score } = await setup();
    const id = popIdOf(alice.address);
    await score.connect(indexer).proposeScore(id, 247, 145n, ethers.ZeroHash, 0, 0, 1);
    const [s] = await score.getScore(id);
    expect(s).to.equal(0n);
  });

  it("finalize reverts before challenge window closes", async () => {
    const { alice, indexer, score } = await setup();
    const id = popIdOf(alice.address);
    await score.connect(indexer).proposeScore(id, 247, 145n, ethers.ZeroHash, 0, 0, 1);
    await expect(score.finalizeScore(id)).to.be.revertedWith("ScoreRegistry: window open");
  });

  it("finalize succeeds after window, getScore returns it", async () => {
    const { alice, indexer, score } = await setup();
    const id = popIdOf(alice.address);
    await score.connect(indexer).proposeScore(id, 247, 145n, ethers.ZeroHash, 0, 0, 1);
    await ethers.provider.send("hardhat_mine", [CHALLENGE_WINDOW_HEX]);
    await expect(score.finalizeScore(id)).to.emit(score, "ScoreFinalized");
    const [s] = await score.getScore(id);
    expect(s).to.equal(247n);
  });

  it("resubmit before MIN_PROPOSAL_INTERVAL reverts", async () => {
    const { alice, indexer, score } = await setup();
    const id = popIdOf(alice.address);
    await score.connect(indexer).proposeScore(id, 100, 50n, ethers.ZeroHash, 0, 0, 1);
    await expect(
      score.connect(indexer).proposeScore(id, 110, 55n, ethers.ZeroHash, 0, 0, 1)
    ).to.be.revertedWith("ScoreRegistry: too soon");
  });

  it("supersedes an old pending proposal after MIN_PROPOSAL_INTERVAL", async () => {
    const { alice, indexer, score } = await setup();
    const id = popIdOf(alice.address);
    await score.connect(indexer).proposeScore(id, 100, 50n, ethers.ZeroHash, 0, 0, 1);
    await ethers.provider.send("hardhat_mine", ["0x708"]); // 1800
    await expect(
      score.connect(indexer).proposeScore(id, 150, 75n, ethers.ZeroHash, 0, 0, 1)
    ).to.emit(score, "ProposalSuperseded");
    const p = await score.getPendingProposal(id);
    expect(p.score).to.equal(150n);
  });

  it("computeScore view matches JS mapping", async () => {
    const { score } = await setup();
    expect(await score.computeScore(0)).to.equal(0n);
    expect(await score.computeScore(50)).to.equal(100n);
    expect(await score.computeScore(100)).to.equal(200n);
    expect(await score.computeScore(250)).to.equal(500n);
    expect(await score.computeScore(500)).to.equal(850n);
    expect(await score.computeScore(-5)).to.equal(0n);
    expect(await score.computeScore(1000)).to.equal(850n);
  });
});

describe("DisputeResolver: WrongArithmetic auto-resolve", () => {
  async function primed() {
    const s = await setup();
    return s;
  }

  function emptyEvidence() {
    return {
      eventSourceChain: 0,
      eventBlockNumber: 0,
      eventIndex: 0,
      eventData: "0x",
      expectedPoints: 0,
      expectedReasonCode: "",
      merkleProof: [],
      leafIndex: 0,
      leafData: "0x",
      leafHash: ethers.ZeroHash,
      disqualifyingReason: "",
      claimedCorrectPoints: 0,
      claimedCorrectScore: 0,
    };
  }

  it("disputer wins when the indexer's score != canonical computeScore()", async () => {
    const { alice, bob, indexer, score, dispute, stable, treasury } = await primed();
    const id = popIdOf(alice.address);
    // Indexer proposes 300 for 145 points — but the real canonical is floor(200 + 45*300/150) = 290.
    await score.connect(indexer).proposeScore(id, 300, 145n, ethers.ZeroHash, 0, 0, 1);
    const treasuryBefore = await stable.balanceOf(treasury.address);
    const bobBefore = await stable.balanceOf(bob.address);

    await dispute.connect(bob).dispute(id, 2, emptyEvidence()); // ClaimType.WrongArithmetic = 2

    // Proposal should now be resolved; disputer received the reward.
    const p = await score.getPendingProposal(id);
    expect(p.status).to.equal(0n); // None (cleared)
    const [onChain] = await score.getScore(id);
    expect(onChain).to.equal(290n); // corrected

    expect(await stable.balanceOf(bob.address)).to.be.gt(bobBefore);
    // Treasury balance should be unchanged (bond didn't go to treasury)
    expect(await stable.balanceOf(treasury.address)).to.equal(treasuryBefore);
  });

  it("disputer loses when the indexer's score matches canonical", async () => {
    const { alice, bob, indexer, score, dispute, stable, treasury } = await primed();
    const id = popIdOf(alice.address);
    // canonical for 145 points is 290. Indexer submits 290. Bob disputes wrongly.
    await score.connect(indexer).proposeScore(id, 290, 145n, ethers.ZeroHash, 0, 0, 1);
    const treasuryBefore = await stable.balanceOf(treasury.address);
    const bobBefore = await stable.balanceOf(bob.address);

    await dispute.connect(bob).dispute(id, 2, emptyEvidence());

    const [onChain] = await score.getScore(id);
    expect(onChain).to.equal(290n); // original stands

    // Bob paid the bond, treasury received it.
    expect(await stable.balanceOf(bob.address)).to.equal(bobBefore - ethers.parseUnits("10", 18));
    expect(await stable.balanceOf(treasury.address)).to.equal(
      treasuryBefore + ethers.parseUnits("10", 18)
    );
  });

  it("a second dispute against a Disputed proposal is rejected", async () => {
    const { alice, bob, cara, indexer, score, dispute } = await primed();
    const id = popIdOf(alice.address);
    // Use MissingEvent so the first dispute doesn't auto-resolve.
    await score.connect(indexer).proposeScore(id, 100, 50n, ethers.ZeroHash, 0, 0, 1);
    await dispute.connect(bob).dispute(id, 0, emptyEvidence()); // MissingEvent → markDisputed
    // The proposal is now Disputed, not Pending — the first guard catches it.
    await expect(dispute.connect(cara).dispute(id, 0, emptyEvidence())).to.be.revertedWith(
      "Dispute: no pending proposal"
    );
  });
});

describe("DisputeResolver: governance path", () => {
  function ev() {
    return {
      eventSourceChain: 0,
      eventBlockNumber: 0,
      eventIndex: 0,
      eventData: "0x",
      expectedPoints: 0,
      expectedReasonCode: "",
      merkleProof: [],
      leafIndex: 0,
      leafData: "0x",
      leafHash: ethers.ZeroHash,
      disqualifyingReason: "",
      claimedCorrectPoints: 0,
      claimedCorrectScore: 0,
    };
  }

  it("governance resolves MissingEvent in disputer's favor", async () => {
    const { alice, bob, indexer, gov, score, dispute } = await setup();
    const id = popIdOf(alice.address);
    await score.connect(indexer).proposeScore(id, 100, 50n, ethers.ZeroHash, 0, 0, 1);
    await dispute.connect(bob).dispute(id, 0, ev());
    await expect(dispute.connect(gov).resolveDispute(1, true, 120, 60)).to.emit(
      dispute,
      "DisputeResolved"
    );
    const [s] = await score.getScore(id);
    expect(s).to.equal(120n);
  });

  it("governance resolves MissingEvent in proposer's favor (finalizes original)", async () => {
    const { alice, bob, indexer, gov, score, dispute } = await setup();
    const id = popIdOf(alice.address);
    await score.connect(indexer).proposeScore(id, 100, 50n, ethers.ZeroHash, 0, 0, 1);
    await dispute.connect(bob).dispute(id, 0, ev());
    await dispute.connect(gov).resolveDispute(1, false, 0, 0);
    const [s] = await score.getScore(id);
    expect(s).to.equal(100n);
  });

  it("governance cannot override WrongArithmetic (auto-resolved)", async () => {
    const { alice, bob, indexer, gov, score, dispute } = await setup();
    const id = popIdOf(alice.address);
    await score.connect(indexer).proposeScore(id, 300, 145n, ethers.ZeroHash, 0, 0, 1);
    await dispute.connect(bob).dispute(id, 2, ev()); // auto-resolves
    await expect(dispute.connect(gov).resolveDispute(1, true, 0, 0)).to.be.revertedWith(
      "Dispute: not open"
    );
  });
});

describe("DisputeResolver: Merkle-backed InvalidEvent", () => {
  function leafFor(marker: number) {
    return ethers.solidityPackedKeccak256(["uint256"], [marker]);
  }

  it("rejects a bogus inclusion proof upfront", async () => {
    const { alice, bob, indexer, score, dispute } = await setup();
    const id = popIdOf(alice.address);
    // Use a real 2-leaf tree; disputer lies about leaf 1.
    const leafA = leafFor(111);
    const leafB = leafFor(222);
    const root = ethers.keccak256(ethers.concat([leafA, leafB]));

    await score.connect(indexer).proposeScore(id, 100, 50n, root, 2, 0, 1);

    const badLeafData = ethers.toUtf8Bytes("not a real leaf");
    const badLeafHash = ethers.keccak256(badLeafData);
    const evidence = {
      eventSourceChain: 0,
      eventBlockNumber: 0,
      eventIndex: 0,
      eventData: "0x",
      expectedPoints: 0,
      expectedReasonCode: "",
      merkleProof: [leafB],
      leafIndex: 0,
      leafData: ethers.hexlify(badLeafData),
      leafHash: badLeafHash,
      disqualifyingReason: "fabricated",
      claimedCorrectPoints: 0,
      claimedCorrectScore: 0,
    };
    await expect(dispute.connect(bob).dispute(id, 1, evidence)).to.be.revertedWith(
      "Dispute: bad inclusion proof"
    );
  });

  it("accepts a valid inclusion proof and hands off to governance", async () => {
    const { alice, bob, indexer, gov, score, dispute } = await setup();
    const id = popIdOf(alice.address);
    // Build a 2-leaf tree where leaf 0 is a real serialized event.
    const leafData = ethers.toUtf8Bytes("fake:event:payload");
    const leafHash = ethers.keccak256(leafData);
    const leafB = leafFor(999);
    const root = ethers.keccak256(ethers.concat([leafHash, leafB]));

    await score.connect(indexer).proposeScore(id, 100, 50n, root, 2, 0, 1);

    const evidence = {
      eventSourceChain: 0,
      eventBlockNumber: 0,
      eventIndex: 0,
      eventData: "0x",
      expectedPoints: 0,
      expectedReasonCode: "",
      merkleProof: [leafB],
      leafIndex: 0,
      leafData: ethers.hexlify(leafData),
      leafHash,
      disqualifyingReason: "amount_below_minimum",
      claimedCorrectPoints: 0,
      claimedCorrectScore: 0,
    };
    await expect(dispute.connect(bob).dispute(id, 1, evidence)).to.emit(dispute, "DisputeCreated");

    // Governance now resolves in disputer's favor.
    await dispute.connect(gov).resolveDispute(1, true, 0, 0);
    const p = await score.getPendingProposal(id);
    expect(p.status).to.equal(0n); // cleared
  });
});

describe("End-to-end flow (optimistic)", () => {
  it("stake → earn → propose → finalize", async () => {
    const { alice, bob, indexer, vault, vouch, ledger, score } = await setup();
    const aliceId = popIdOf(alice.address);
    const bobId = popIdOf(bob.address);

    await vault.connect(alice).stake(HUNDRED_USD);
    await vault.connect(bob).stake(HUNDRED_USD);
    await ledger.connect(indexer).mintPoints(aliceId, 50, "opengov_vote");
    await vouch.connect(alice).vouch(bobId);
    await ledger.connect(indexer).mintPoints(bobId, 40, "opengov_vote");
    await ethers.provider.send("hardhat_mine", ["0x1fa40"]);
    await vouch.resolveVouch(1);

    const aliceBal = await ledger.getBalance(aliceId);
    const aliceScore = await score.computeScore(aliceBal.total);

    await score
      .connect(indexer)
      .proposeScore(aliceId, aliceScore, aliceBal.total, ethers.ZeroHash, 0, 0, 1);
    await ethers.provider.send("hardhat_mine", [CHALLENGE_WINDOW_HEX]);
    await score.finalizeScore(aliceId);

    const [published] = await score.getScore(aliceId);
    expect(published).to.equal(aliceScore);
  });
});
