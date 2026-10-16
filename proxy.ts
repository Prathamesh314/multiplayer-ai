import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
import { clerkConfigured } from "./app/lib/auth/clerk-config";

const withClerk = clerkMiddleware(() => {}, () => ({
  signInUrl: "/login", signUpUrl: "/login?mode=signup",
  jwtKey: process.env.CLERK_JWT_KEY,
  authorizedParties: process.env.AUTH_PUBLIC_URL ? [process.env.AUTH_PUBLIC_URL] : undefined,
}));

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  // Marketing and the setup error page still load before keys are configured.
  // Resource handlers require Clerk and never fall back to the old auth cookie.
  if (!clerkConfigured()) return NextResponse.next();
  const response = await withClerk(request, event);
  // Clerk attaches verified auth headers via a same-URL rewrite. Next 16.3
  // can network-proxy loopback rewrites back into this server (vercel/next.js
  // #94745). Continue internally, retaining Clerk's request-header overrides.
  // Real redirects and rewrites to different destinations are left intact.
  if (response && response.headers.get("x-middleware-rewrite") === request.url) {
    response.headers.delete("x-middleware-rewrite");
    response.headers.set("x-middleware-next", "1");
  }
  return response;
}

export const config = {
  // Device- and token-authenticated streaming uploads must not be buffered by
  // Next Proxy, which truncates bodies over 10 MB (attachment-uploads).
  matcher: ["/login", "/auth/:path*", "/account", "/workspace", "/s/:path*", "/shared/:path*", "/invite/:path*",
    "/api/((?!git/|runner/(?:claim|heartbeat|me|events|workspaces|terminal)(?:/|$)|runner/runs/|webhooks/|attachment-uploads(?:/|$)).*)"],
};
