"use client";
import { ClerkProvider } from "@clerk/nextjs";

export function AuthProvider({ children, publishableKey }: { children: React.ReactNode; publishableKey?: string }) {
  if (!publishableKey) return children;
  return <ClerkProvider publishableKey={publishableKey} signInUrl="/login" signUpUrl="/login?mode=signup"
    signInFallbackRedirectUrl="/auth/complete" signUpFallbackRedirectUrl="/auth/complete"
    appearance={{ variables: { colorPrimary: "#e9e5df", colorPrimaryForeground: "#211f1b", colorBackground: "#211f1b",
      colorForeground: "#e7e5e2", colorMutedForeground: "#a6a29a", colorInput: "#161511", colorInputForeground: "#e7e5e2",
      colorDanger: "#f08080", colorBorder: "#39362f", borderRadius: "0.75rem", fontFamily: "var(--font-geist-sans), sans-serif", fontSize: "0.9375rem" },
      elements: { cardBox: "shadow-none border border-vs-border", card: "shadow-none", rootBox: "max-w-full" } }}>
    {children}
  </ClerkProvider>;
}
