import { randomInt } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { hashPassword } from "../app/lib/auth/password";
import { pool } from "../app/lib/db/client";
loadEnvConfig(process.cwd());

// Creates a platform administrator, or resets one's password, with a generated
// password printed once. They must choose their own at first sign-in, and every
// session they had ends. Run where the server's DATABASE_URL is set.
async function main() {
  let database: ReturnType<typeof pool> | undefined;
  try {
    const [email, ...name] = process.argv.slice(2);
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("Usage: npm run admin:user -- EMAIL [DISPLAY NAME]");
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const group = () => Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join("");
    const password = `${group()}-${group()}-${group()}-${group()}`;
    database = pool();
    const { rows: [row] } = await database.query<{ created: boolean }>(
      `INSERT INTO platform_admins (email, display_name, password_hash, must_change_password)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change_password = true,
         failed_attempts = 0, locked_until = NULL, disabled_at = NULL
       RETURNING (xmax = 0) AS created`,
      [email.trim().toLowerCase(), name.join(" ").trim() || "Administrator", await hashPassword(password)]);
    await database.query(`UPDATE platform_admin_sessions SET revoked_at = now() WHERE revoked_at IS NULL AND admin_id = (SELECT id FROM platform_admins WHERE email = $1)`, [email.trim().toLowerCase()]);
    console.log(`${row?.created ? "Created" : "Reset"} administrator ${email}.\nOne-time password: ${password}\nSign in at /admin/login; a new password is required. Share this privately and do not keep it.`);
  } finally {
    await database?.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : "Could not create the administrator.");
  process.exitCode = 1;
});
