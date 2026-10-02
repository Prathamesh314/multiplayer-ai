import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { IntegrationError, type TeamProvider } from "./types";

function key() {
  const value = process.env.INTEGRATIONS_ENCRYPTION_KEY ?? "";
  if (!/^[a-f\d]{64}$/i.test(value))
    throw new IntegrationError(
      "The server administrator must configure the integration encryption key.",
      503,
    );
  return Buffer.from(value, "hex");
}
export function seal(secret: string, scope: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(scope));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((value) => value.toString("base64url"))
    .join(".");
}
export function unseal(value: string, scope: string) {
  const [iv, tag, data] = value
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(Buffer.from(scope));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}
export function integrationOrigin() {
  let url: URL;
  try {
    url = new URL(process.env.INTEGRATIONS_PUBLIC_URL ?? "");
  } catch {
    throw new IntegrationError(
      "The server administrator must configure the public integration URL.",
      503,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new IntegrationError(
      "Integrations require an HTTPS origin without a path.",
      503,
    );
  }
  return url.origin;
}
export const callbackUrl = (provider: TeamProvider) =>
  `${integrationOrigin()}/api/integrations/${provider}/callback`;
export function configured(provider: TeamProvider) {
  try {
    key();
    integrationOrigin();
    const prefix = provider.toUpperCase();
    return !!(
      process.env[`${prefix}_CLIENT_ID`] &&
      process.env[`${prefix}_CLIENT_SECRET`] &&
      (provider === "slack"
        ? process.env.SLACK_SIGNING_SECRET
        : process.env.DISCORD_BOT_TOKEN)
    );
  } catch {
    return false;
  }
}
