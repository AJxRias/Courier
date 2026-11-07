import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";

const db = createPool(loadConfig().databaseUrl, 1);
const applied = await migrate(db);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
await db.end();
