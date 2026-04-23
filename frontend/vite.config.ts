import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

// Vite plugin that serves deployment JSON + ABIs from the sibling contracts/
// folder at build time. This avoids copying files around during dev; for a
// static deploy (Bulletin Chain / IPFS), `vite build` inlines the JSON.
function contractsAssets() {
  const CONTRACTS = path.resolve(__dirname, "..", "contracts");
  return {
    name: "sampo-contracts-assets",
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const url: string = req.url ?? "";
        if (url.startsWith("/deployments/")) {
          const file = path.join(CONTRACTS, url);
          if (fs.existsSync(file)) {
            res.setHeader("Content-Type", "application/json");
            res.end(fs.readFileSync(file));
            return;
          }
        }
        if (url.startsWith("/abi/")) {
          const name = url.replace("/abi/", "").replace(".json", "");
          const file = path.join(CONTRACTS, "out", `${name}.sol`, `${name}.json`);
          if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, "utf8"));
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ abi: raw.abi }));
            return;
          }
        }
        next();
      });
    },
    generateBundle() {
      // Copy deployment JSON + ABI JSON into the build output so the static
      // bundle can fetch them at runtime from its own origin.
      const out = path.resolve(__dirname, "dist");
      fs.mkdirSync(path.join(out, "deployments"), { recursive: true });
      fs.mkdirSync(path.join(out, "abi"), { recursive: true });
      const deployDir = path.join(CONTRACTS, "deployments");
      if (fs.existsSync(deployDir)) {
        for (const f of fs.readdirSync(deployDir)) {
          if (f.endsWith(".json")) {
            fs.copyFileSync(path.join(deployDir, f), path.join(out, "deployments", f));
          }
        }
      }
      const names = [
        "PointsLedger",
        "StakingVault",
        "VouchRegistry",
        "ScoreRegistry",
        "MockStablecoin",
        "DisputeResolver",
      ];
      for (const name of names) {
        const file = path.join(
          CONTRACTS,
          "artifacts",
          "contracts",
          `${name}.sol`,
          `${name}.json`
        );
        if (fs.existsSync(file)) {
          const raw = JSON.parse(fs.readFileSync(file, "utf8"));
          fs.writeFileSync(
            path.join(out, "abi", `${name}.json`),
            JSON.stringify({ abi: raw.abi })
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), contractsAssets()],
  server: { port: 5173 },
  build: {
    outDir: "dist",
  },
});
