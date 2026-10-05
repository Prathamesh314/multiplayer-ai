// Manual integration test: deliberately excluded from npm test and CI.
// Uses the real verification template/transport without creating an account.
import { randomInt, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import nextEnv from '@next/env';
import { sendVerificationEmail } from '../app/lib/auth/email-delivery.ts';

const usage = `Send ONE real verification-template email (the code cannot log in):
  npm run test:email-sender -- --to you@example.com
  npm run test:email-sender -- --env-file .env.production --to you@example.com

Check an existing message without sending another:
  npm run test:email-sender -- --status <resend-email-id>

Options: --wait <seconds> (default 30, maximum 60), --help
Requires RESEND_API_KEY and EMAIL_FROM. Loads Next.js environment files by default.
An explicit --env-file loads that file instead; existing process variables win.
Secrets, email bodies and codes are never printed.`;

function rejectionHint(body) {
  const message = typeof body?.message === 'string' ? body.message : '';
  if (/domain.*not verified/i.test(message)) return 'The EMAIL_FROM domain is not verified in this Resend account. Verify that exact domain at https://resend.com/domains.';
  if (/only send testing emails/i.test(message)) return 'The Resend test sender can only email the account owner. Set EMAIL_FROM to an address on your verified domain.';
  if (body?.name === 'restricted_api_key') return 'This API key is inactive or restricted. Check its status and sending permissions in Resend.';
  if (body?.name === 'suspended_api_key') return 'Resend has suspended this API key. Check the account in Resend.';
  if (body?.name === 'invalid_permission') return 'This API key lacks the required sending permission.';
  if (['daily_quota_exceeded', 'monthly_quota_exceeded', 'rate_limit_exceeded'].includes(body?.name)) return 'Resend reports a sending quota or rate limit. Check the account limits before retrying.';
  return 'Check RESEND_API_KEY, the verified EMAIL_FROM domain and network access.';
}

async function checkDelivery(id, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastEvent = 'unknown';
  do {
    let response;
    try {
      response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}` },
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
      });
    } catch {
      console.warn('UNCONFIRMED: Could not retrieve delivery status. Check this message in Resend.');
      return;
    }
    if (!response.ok) {
      console.warn(`UNCONFIRMED: Delivery lookup returned HTTP ${response.status}. Sending-only keys cannot read delivery status; check the Resend dashboard.`);
      return;
    }
    const message = await response.json().catch(() => null);
    if (!message) {
      console.warn('UNCONFIRMED: Resend returned an unreadable delivery status. Check the dashboard.');
      return;
    }
    const knownEvents = ['sent', 'queued', 'scheduled', 'delivered', 'delivery_delayed', 'opened', 'clicked', 'bounced', 'complained', 'failed', 'suppressed', 'canceled'];
    lastEvent = knownEvents.includes(message.last_event) ? message.last_event : 'unknown';
    if (['bounced', 'complained', 'failed', 'suppressed', 'canceled'].includes(lastEvent)) {
      throw new Error(`Delivery failed: Resend reports ${lastEvent}. Check the message in Resend.`);
    }
    if (['delivered', 'opened', 'clicked'].includes(lastEvent)) {
      console.log(`PASS: Resend reports ${lastEvent}; the recipient mail server accepted the message. Check the inbox/spam folder.`);
      return;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(3000, deadline - Date.now()));
  } while (true);
  console.warn(`UNCONFIRMED: Last event is ${lastEvent}; final delivery has not been confirmed. Recheck with --status ${id}.`);
}

async function main() {
  const { values } = parseArgs({ options: {
    to: { type: 'string' }, status: { type: 'string' },
    'env-file': { type: 'string' }, wait: { type: 'string', default: '30' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return; }
  if ((!values.to && !values.status) || (values.to && values.status)) {
    throw new Error(`Choose either --to or --status.\n${usage}`);
  }
  if (values.to && !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(values.to)) {
    throw new Error('--to must contain one plain email address.');
  }
  if (values.status && !/^[a-zA-Z0-9-]{1,128}$/.test(values.status)) throw new Error('Invalid message ID.');
  const waitSeconds = Number(values.wait);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 60) throw new Error('--wait must be between 0 and 60 seconds.');
  if (values['env-file']) process.loadEnvFile(values['env-file']);
  else nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV === 'development');
  const missing = ['RESEND_API_KEY', ...(values.to ? ['EMAIL_FROM'] : [])].filter(key => !process.env[key]?.trim());
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}. No email sent.`);

  if (values.status) { await checkDelivery(values.status, waitSeconds); return; }

  // Observe only status and ID while exercising the application's real sender.
  // Never replace its request or print the provider's raw response/error body.
  const nativeFetch = globalThis.fetch;
  let emailId;
  let httpStatus;
  let hint = rejectionHint(null);
  globalThis.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (args[0] === 'https://api.resend.com/emails' && args[1]?.method === 'POST') {
      httpStatus = response.status;
      const body = await response.clone().json().catch(() => null);
      if (response.ok && body) {
        if (typeof body.id === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(body.id)) emailId = body.id;
      } else hint = rejectionHint(body);
    }
    return response;
  };
  try {
    await sendVerificationEmail(values.to, randomInt(100000, 1000000).toString(), randomUUID());
  } catch {
    const detail = httpStatus ? ` (HTTP ${httpStatus})` : '';
    throw new Error(`Sending failed${detail}. ${hint} No automatic retry was made.`);
  } finally {
    globalThis.fetch = nativeFetch;
  }
  console.log(`PASS: Resend accepted the test email to ${values.to}.`);
  if (!emailId) {
    console.warn('UNCONFIRMED: No usable message ID; check delivery in the Resend dashboard.');
    return;
  }
  console.log(`Resend email ID: ${emailId}`);
  await checkDelivery(emailId, waitSeconds);
}

main().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
