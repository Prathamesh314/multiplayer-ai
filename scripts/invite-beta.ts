import { loadEnvConfig } from "@next/env";
import { issueSignupInvitation } from "../app/lib/auth/admission";
import { pool } from "../app/lib/db/client";
loadEnvConfig(process.cwd());

// tsx treats this repository's .ts entry points as CommonJS. Keep await inside
// an async function so the documented command runs in the worker image too.
async function main() {
  let database: ReturnType<typeof pool> | undefined;
  try {
    const [email, origin, hours] = process.argv.slice(2);
    if (!email || !origin) throw new Error("Usage: npm run beta:invite -- EMAIL HTTPS_ORIGIN [HOURS]");
    const url = new URL(origin);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Use your workspace HTTPS origin (localhost HTTP is allowed for testing).");
    database = pool();
    const token = await issueSignupInvitation(email, hours ? Number(hours) : 72);
    url.pathname = "/login"; url.searchParams.set("invite", token);
    url.searchParams.set("email", email.trim());
    console.log(`Private, single-use invitation for ${email}:\n${url.href}\nSend this privately. Do not commit the link or put it in public logs.`);
  } finally {
    await database?.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : "Could not issue invitation.");
  process.exitCode = 1;
});
