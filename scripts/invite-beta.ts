import nextEnv from "@next/env";
import { issueSignupInvitation } from "../app/lib/auth/admission";
import { pool } from "../app/lib/db/client";
nextEnv.loadEnvConfig(process.cwd());
try {
  const [email, origin, hours] = process.argv.slice(2);
  const url = new URL(origin);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Use your workspace HTTPS origin (localhost HTTP is allowed for testing).");
  const token = await issueSignupInvitation(email, hours ? Number(hours) : 72);
  url.pathname = "/login"; url.searchParams.set("invite", token);
  console.log(`Private, single-use invitation for ${email}:\n${url.href}\nSend this privately. Do not commit the link or put it in public logs.`);
} catch (error) { console.error(error instanceof Error ? error.message : "Could not issue invitation."); process.exitCode = 1; }
finally { await pool().end(); }
