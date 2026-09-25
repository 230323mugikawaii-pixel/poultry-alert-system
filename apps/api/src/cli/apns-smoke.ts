import { runApnsSmoke } from "../modules/device-push/apns-smoke.js";

// Independent opt-in entrypoint. Never import/start the API or load .env.
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  process.exitCode = await runApnsSmoke(process.argv.slice(2), process.env, {
    stdin: process.stdin,
    write: (line) => {
      process.stdout.write(line);
    },
    signal: controller.signal
  });
} catch {
  // In particular, never print the raw exception/cause or argv.
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
