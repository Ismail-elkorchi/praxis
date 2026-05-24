import path from "node:path";
import { createPraxisApp } from "../composition/createPraxisApp";
import { SqliteEventStore } from "../events/SqliteEventStore";
import { defaultAppSettings } from "../settings/SettingsService";
import { createLocalServer } from "./createLocalServer";

const port = Number(process.env.PORT ?? 4187);
const databasePath = process.env.PRAXIS_DATABASE_PATH ?? defaultAppSettings.databasePath;
const app = await createPraxisApp({ eventStore: new SqliteEventStore(databasePath) });
const { server } = createLocalServer({ app, staticRoot: path.resolve("dist") });

server.listen(port, "127.0.0.1", () => {
  console.log(`Praxis local server listening on http://127.0.0.1:${port}`);
});
