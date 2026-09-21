import nextEnv from "@next/env";

// Deliberate local testing mode. Never silently change the deployed backend.
process.env.APP_ENV="testing";
nextEnv.loadEnvConfig(process.cwd(),true);
process.env.HANDOFF_TEST_POSTGRES="1";
process.env.HANDOFF_TEST_BROWSER="1";
if(process.argv.includes("--live")) process.env.HANDOFF_TEST_LIVE_AGENT=process.env.DEMO_AGENT || "codex";
await import("../tests/handoff.test.mjs");
