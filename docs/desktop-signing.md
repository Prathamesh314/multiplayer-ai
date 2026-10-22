# Signing the desktop installers

Unsigned installers make the operating system warn before the app opens:

- **macOS:** *"Multicode AI" Not Opened — Apple could not verify "Multicode AI" is free of malware…*
  Only an app signed with an Apple **Developer ID** certificate and **notarized** by Apple
  opens without it.
- **Windows:** *Windows protected your PC* (SmartScreen), until the installer is
  code-signed.
- **Linux:** no signing prompt; the AppImage only needs to be allowed to run.

The build already signs and notarizes when credentials are present
(`desktop/targets.cjs`, `desktop/builder.cjs`). Add them once as GitHub secrets, then
run **Actions → Desktop checks and preview installers → Run workflow**. Manual runs sign
the installers they publish; pull requests stay unsigned. A run without the secrets
still builds, and warns that macOS is unsigned.

Manual runs also build in this website's address (`vars.DESKTOP_WORKSPACE_URL`,
default `https://multicode.in`), so a new install opens straight to sign-in.

## macOS: Developer ID + notarization

Needs a paid **Apple Developer Program** membership (individual or organisation,
US$99/year). An organisation membership shows the company name as the publisher.

1. **Certificate.** In Xcode → Settings → Accounts → Manage Certificates, or at
   developer.apple.com → Certificates, create a **Developer ID Application**
   certificate. In Keychain Access, export it *with its private key* as a `.p12`
   and choose a password.
2. **Notarization key (recommended).** App Store Connect → Users and Access →
   Integrations → **App Store Connect API** → generate a key with the *Developer*
   role. Download the `.p8` (only once), and note its **Key ID** and the **Issuer ID**.
3. **GitHub secrets** (Settings → Secrets and variables → Actions):

   | Secret | Value |
   | --- | --- |
   | `MAC_CSC_LINK` | the `.p12`, base64: `base64 -i DeveloperID.p12 \| pbcopy` |
   | `MAC_CSC_KEY_PASSWORD` | the `.p12` password |
   | `APPLE_API_KEY_P8` | the full text of the `.p8` file |
   | `APPLE_API_KEY_ID` | the key's ID |
   | `APPLE_API_ISSUER` | the issuer ID |

   Instead of the API key, an Apple ID works too: `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD` (from appleid.apple.com) and `APPLE_TEAM_ID`.

Notarization adds a few minutes per macOS build. The workflow then checks the app
the way Gatekeeper will (`spctl --assess`, `stapler validate`).

## Windows: code signing

Pick one:

- **Azure Trusted Signing** (Microsoft's service, about US$10/month; identity
  validation for a business or individual takes a few days). Create a Trusted Signing
  account and a *Public Trust* certificate profile, then an app registration with the
  *Trusted Signing Certificate Profile Signer* role on it.

  | Name | Kind | Value |
  | --- | --- | --- |
  | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | secrets | the app registration |
  | `AZURE_TRUSTED_SIGNING_ENDPOINT` | variable | e.g. `https://eus.codesigning.azure.net/` |
  | `AZURE_TRUSTED_SIGNING_ACCOUNT` | variable | the account name |
  | `AZURE_TRUSTED_SIGNING_PROFILE` | variable | the certificate profile name |
  | `AZURE_TRUSTED_SIGNING_PUBLISHER` | variable | the validated publisher name |

- **A code-signing certificate** (`.pfx`) from a certificate authority: secrets
  `WIN_CSC_LINK` (base64 of the `.pfx`) and `WIN_CSC_KEY_PASSWORD`. Note that new
  certificates are usually issued on hardware tokens, which a CI runner cannot use;
  Azure Trusted Signing avoids that.

SmartScreen may still show a warning for the first downloads of a newly signed
publisher until its reputation builds; it then names the publisher instead of
"Unknown publisher".

## Publishing

Download the workflow's artifacts and publish them as before (upload to
`/var/lib/multiplayer/downloads/<version>/` and point the `DESKTOP_DOWNLOAD_*` links in
`.env.production` at them). Set `DESKTOP_DOWNLOAD_CHANNEL=release` once the installers
are signed, so the download page stops describing the first-launch prompts.
