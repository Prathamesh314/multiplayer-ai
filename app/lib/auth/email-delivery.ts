type VerificationErrorCode = "verification_unavailable" | "verification_expired" | "resend_limited" | "invalid_code" | "incorrect_code" | "code_expired" | "attempts_exhausted" | "delivery_failed";
export class EmailVerificationError extends Error {
  constructor(message: string, public readonly status = 400, public readonly retryAfter?: number, public readonly code: VerificationErrorCode = "verification_unavailable") { super(message); }
}

/** Enable explicitly after configuring a verified sender; never infer policy from an API key. */
export function emailVerificationEnabled(): boolean {
  const setting = process.env.EMAIL_VERIFICATION_ENABLED || "false";
  if (setting !== "true" && setting !== "false") throw new EmailVerificationError("Email verification is temporarily unavailable.", 503);
  return setting === "true";
}

export function emailDeliveryConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from || /[\r\n]/.test(from)) {
    throw new EmailVerificationError("Email verification is temporarily unavailable. Please try again later.", 503);
  }
  return { apiKey, from };
}

export async function sendVerificationEmail(email: string, code: string, deliveryId: string): Promise<void> {
  const { apiKey, from } = emailDeliveryConfig();
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "Idempotency-Key": `email-verification/${deliveryId}` },
      body: JSON.stringify({
        from, to: [email], subject: "Verify your Multicode AI email",
        text: `Your Multicode AI verification code is ${code}.\n\nThis code expires in 10 minutes. Enter it in the window where you signed up or signed in. You only need to verify your email once.\n\nIf you didn't request this code, you can ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:32px auto;color:#24211f"><h1 style="font-size:24px">Verify your email</h1><p>Enter this code in Multicode AI to finish signing in:</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px;padding:20px;background:#f3f0ec;border-radius:12px">${code}</p><p>This code expires in 10 minutes. You only need to verify your email once.</p><p style="color:#716b65;font-size:14px">If you didn’t request this code, you can ignore this email.</p></div>`,
      }),
    });
    if (!response.ok) throw new Error("Email delivery rejected");
    const result = await response.json();
    if (typeof result?.id !== "string" || !result.id) throw new Error("Email delivery unconfirmed");
  } catch {
    // Provider responses and transport errors may contain recipients or secrets.
    throw new EmailVerificationError("We couldn’t send your code. Please try sending it again in a minute.", 503);
  }
}
