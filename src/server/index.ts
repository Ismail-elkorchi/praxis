import path from "node:path";
import { defaultAppSettings } from "../settings/SettingsService";
import { startPraxisRuntime } from "../runtime/PraxisRuntimeHost";

const port = Number(process.env.PORT ?? 4187);
const databasePath = process.env.PRAXIS_DATABASE_PATH ?? defaultAppSettings.databasePath;
const runtime = await startPraxisRuntime({
  databasePath,
  port,
  host: "127.0.0.1",
  staticRoot: path.resolve("dist"),
  listen: true,
  deploymentMode: "local_browser"
});

console.log(`Praxis local server listening on ${runtime.url}`);

process.once("SIGINT", () => {
  void runtime.shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void runtime.shutdown().finally(() => process.exit(0));
});
