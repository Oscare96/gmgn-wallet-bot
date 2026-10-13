import app from "./app";
import { logger } from "./lib/logger";
import { startGmgnWorker } from "./lib/gmgnWorker";
import { reconcileInterruptedBacktestAssessments } from "./lib/backtestAssessment";
import { startQuoteRecovery } from "./lib/quoteRecovery";
const bootAt = new Date();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void reconcileInterruptedBacktestAssessments(bootAt).catch(() => logger.warn("Could not reconcile interrupted backtest assessments; no simulation started."));
  startGmgnWorker();
  startQuoteRecovery();
});
