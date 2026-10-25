import { loadConfig } from "../config.ts";
import { createDb } from "../db/index.ts";
import { migrate } from "../db/migrate.ts";

const config = loadConfig();
const db = await createDb(config);
try {
  const res = await migrate(db);
  console.log(`Database: ${db.driver}. Applied: ${res.applied.join(", ") || "none"}. Already applied: ${res.alreadyApplied.length}.`);
} finally {
  await db.close();
}
