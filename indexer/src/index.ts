import { config } from "./config.js";
import { log } from "./util/log.js";
import { runPolkaCreditListener } from "./listeners/polkaCreditListener.js";
import { runOpenGovListener } from "./listeners/openGovListener.js";
import { processUnscoredEvents } from "./jobs/pointsJob.js";
import { runScoreJob } from "./jobs/scoreJob.js";
import { runFinalizationJob } from "./jobs/finalizationJob.js";
import { runVouchResolutionJob } from "./jobs/vouchResolutionJob.js";
import { buildApi } from "./api/server.js";

async function main() {
  log.info(`polkacredit indexer starting`);
  log.info(`  evm rpc      : ${config.evm.rpcUrl}`);
  log.info(`  evm chain    : ${config.evm.chainId}`);
  log.info(`  opengov      : ${config.openGov.enabled ? config.openGov.wss : "disabled"}`);
  log.info(`  api port     : ${config.api.port}`);
  log.info(`  sqlite       : ${config.db.file}`);

  const controller = new AbortController();
  process.on("SIGINT", () => {
    log.info("shutdown requested");
    controller.abort();
  });

  // Boot REST API
  const app = buildApi();
  app.listen(config.api.port, () => {
    log.info(`api: listening on http://127.0.0.1:${config.api.port}`);
  });

  // Kick off listeners (long-running)
  const listeners = Promise.all([
    runPolkaCreditListener(controller.signal).catch((e) =>
      log.error(`polkacredit listener died: ${e.message}`)
    ),
    runOpenGovListener(controller.signal).catch((e) =>
      log.error(`opengov listener died: ${e.message}`)
    ),
  ]);

  // Periodic jobs
  const pointsTimer = setInterval(() => {
    processUnscoredEvents().catch((e) => log.error(`points job: ${e.message}`));
  }, 60_000);

  const scoreTimer = setInterval(() => {
    runScoreJob().catch((e) => log.error(`score job: ${e.message}`));
  }, config.polling.scoreIntervalMs);

  // Finalization runs more often than proposal since the 24-h window closing
  // is what makes scores visible to external consumers.
  const finalizeTimer = setInterval(() => {
    runFinalizationJob().catch((e) => log.error(`finalize job: ${e.message}`));
  }, config.polling.finalizationIntervalMs);

  // Vouch auto-resolution. The frontend doesn't expose a "Resolve" button
  // anymore — the indexer handles every vouch whose window has closed so
  // the committed stake returns to honest vouchers automatically and
  // slash flows land without user intervention.
  const vouchResolveTimer = setInterval(() => {
    runVouchResolutionJob().catch((e) =>
      log.error(`vouch resolve job: ${e.message}`)
    );
  }, config.polling.finalizationIntervalMs);

  controller.signal.addEventListener("abort", () => {
    clearInterval(pointsTimer);
    clearInterval(scoreTimer);
    clearInterval(finalizeTimer);
    clearInterval(vouchResolveTimer);
  });

  await listeners;
  log.info("indexer shut down");
}

main().catch((e) => {
  log.error(`fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
