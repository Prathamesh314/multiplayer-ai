const TOKEN = /^[a-zA-Z0-9_-]{43}$/;

/** Extract credentials from a pasted invitation without navigating to its URL. */
export function invitationDetails(value: string): { token: string; email?: string } | null {
  const input = value.trim();
  if (TOKEN.test(input)) return { token: input };
  try {
    const url = new URL(input);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const token = url.pathname === '/login'
      ? url.searchParams.get('invite') ?? /^\/invite\/([a-zA-Z0-9_-]{43})$/.exec(url.searchParams.get('next') ?? '')?.[1]
      : /^\/invite\/([a-zA-Z0-9_-]{43})$/.exec(url.pathname)?.[1];
    if (!token || !TOKEN.test(token)) return null;
    const email = url.searchParams.get('email')?.trim();
    return { token, ...(email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { email } : {}) };
  } catch {
    return null;
  }
}
