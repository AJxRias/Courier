import { loadConfig } from "./config.js";
import { Gateway } from "./gateway.js";

const gateway = new Gateway({ config: loadConfig() });

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1); // second signal: give up waiting
    stopping = true;
    gateway.log.info({ sig }, "shutting down");
    await gateway.drain();
    process.exit(0);
  });
}

process.on("unhandledRejection", (err) => gateway.log.error({ err }, "unhandled rejection"));

await gateway.start();
