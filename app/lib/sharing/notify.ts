/*
 * "Someone shared a chat with you", sent like a document share notice.
 * Best-effort: only when an email sender is configured, never inside a
 * database transaction, and a failure never undoes the share itself.
 */

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const oneLine = (value: string, max: number) => value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

export function shareEmailConfigured(env = process.env) {
  return !!env.RESEND_API_KEY?.trim() && !!env.EMAIL_FROM?.trim() && !/[\r\n]/.test(env.EMAIL_FROM);
}

export async function sendShareEmail(input: { to: string; hostName: string; title: string; url: string; role: "viewer" | "commenter" | "editor"; message?: string }) {
  if (!shareEmailConfigured()) return false;
  const host = oneLine(input.hostName, 80), title = oneLine(input.title, 120), note = input.message ? input.message.trim().slice(0, 1000) : "";
  const can = input.role === "editor" ? "view, comment on and continue" : input.role === "commenter" ? "view and comment on" : "view";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM!.trim(), to: [input.to], subject: `${host} shared a chat with you: ${title}`,
        text: `${host} shared “${title}” with you on Multicode AI. You can ${can} it.\n\n${note ? `${note}\n\n` : ""}Open it: ${input.url}\n\nSign in with this email address to open it.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:32px auto;color:#24211f"><p><strong>${escape(host)}</strong> shared a chat with you. You can ${can} it.</p>${note ? `<p style="white-space:pre-wrap;padding:12px;background:#f3f0ec;border-radius:8px">${escape(note)}</p>` : ""}<p style="margin:24px 0"><a href="${escape(input.url)}" style="background:#24211f;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open “${escape(title)}”</a></p><p style="color:#716b65;font-size:14px">Sign in with this email address to open it.</p></div>`,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
