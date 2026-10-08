# GoDaddy CDN for the Bangalore deployment

Keep GoDaddy DNS and the existing VM. Use GoDaddy Website Security's Firewall/CDN
on **assets.cubeclashes.com only**. The application remains at cubeclashes.com.
This setup is opt-in: a normal build uses the existing same-origin asset URLs.

| Request | Route |
| --- | --- |
| JavaScript, CSS, bundled fonts | Visitor → GoDaddy CDN → public asset origin on cache miss |
| Public product/docs screenshots | Visitor → GoDaddy CDN → public asset origin on cache miss |
| Pages, sign-in, APIs, Git, AI/event streams, private files | Visitor → Bangalore application |

Cached assets load from the CDN rather than crossing the world for every visit.
Interactive requests still reach Bangalore; this does not make database writes
or live conversations equally fast everywhere. Measure actual overseas sessions
before deciding whether regional application servers are needed. A domain/DNS
subscription does not by itself activate a CDN.

## Why a separate hostname

GoDaddy documents that certain file types have special edge caching behavior,
even with non-cache URL exclusions. Its Sucuri documentation also says its WAF
does not support WebSockets. Our current live events use SSE, but the separation
also avoids depending on the CDN's streaming and upload behavior.

The asset origin allows only GET/HEAD requests for explicitly matched public file
paths and types. APIs, HTML/RSC pages, invitations, source maps, private files,
mutations and traversal paths return 404 before reaching Next. Cookie,
Authorization and application gateway credentials are removed upstream;
Set-Cookie is removed downstream. Public fonts/scripts can use anonymous CORS.
Next's content-hashed bundles keep immutable caching; unversioned public
screenshots use a one-hour origin TTL. Do not put private material in public/.

## 1. Confirm the GoDaddy service

Open **My Products → Website Security and Backups → Manage → Firewall/CDN**.
If this product is absent, there is no CDN to activate from the domain's DNS page.
Confirm the plan includes CDN and can be provisioned for **assets.cubeclashes.com
alone**, preserving the apex domain's existing record. GoDaddy's setup guide
specifically names Advanced/Premium for CDN. Do not buy or auto-activate a plan
against the main application hostname merely to complete this procedure.

No GoDaddy account is connected to the coding environment. Provisioning, assigned
firewall IPs and certificate status must come from your GoDaddy account; none
should be guessed. Keep the current apex A record and email records unchanged.

## 2. Bring up the public asset origin first

In GoDaddy DNS, create an `A` record named `assets` pointing to the VM's public
IPv4 address. The observed address on 2026-10-08 was `143.110.177.77`; verify it
against your VM before using it. Do not create an AAAA record unless the VM's
IPv6 listener and routing are working.

On the VM, add to `.env.production`:

```dotenv
APP_ASSET_DOMAIN=assets.cubeclashes.com
# Leave NEXT_PUBLIC_ASSET_PREFIX unset in this first deployment.
```

Deploy the gateway changes through the normal deployment procedure. Caddy issues
the origin certificate using its existing persistent certificate volumes. Verify:

```sh
curl --fail --head https://assets.cubeclashes.com/docs/images/workspace.webp
curl --head https://assets.cubeclashes.com/api/auth/me
```

The image must return 200, `Content-Type: image/webp`,
`Access-Control-Allow-Origin: *`, and `X-Multiplayer-Public-Assets: 1`.
The API must return 404. With no APP_ASSET_DOMAIN, the public-assets handler is
only on an unpublished container port; it does not replace the application host.

## 3. Put that hostname behind GoDaddy CDN

Provision Website Security for **assets.cubeclashes.com**, with its hosting/origin
IP set to the VM IP. Enable HTTPS to the origin and certificate validation where
the service exposes it. Keep the Host header and TLS SNI as assets.cubeclashes.com.
Complete GoDaddy's domain verification and wait for its edge certificate to be
valid before directing browser traffic through it.

Change only the `assets` A record to the **Firewall IP shown by GoDaddy**. Do not
replace the cubeclashes.com apex A record or the nameservers. Some GoDaddy setup
wizards apply DNS automatically: confirm the selected hostname before activation.
Keep the original VM IP in the CDN's origin settings to avoid a proxy loop.

Select **Site Caching / honor origin headers** where available. Do not enable
JavaScript rewriting, browser challenges or cookie-based challenges on the asset
hostname; browsers must be able to fetch scripts and fonts anonymously. Ensure
certificate renewal challenges reach Caddy without caching. If GoDaddy cannot
preserve this isolated hostname, stop here and request its support to configure
it; do not route the main application through it as a substitute.

Repeat the two curl checks through the CDN. Check the SSL certificate normally,
without `curl -k`. A repeated public asset request should show GoDaddy/Sucuri cache
headers (for example X-Sucuri-Cache: HIT on the applicable service). Record the
actual response rather than assuming that a DNS change means the CDN is active.

## 4. Enable asset URLs in the application

Only after step 3 passes, set:

```dotenv
APP_ASSET_DOMAIN=assets.cubeclashes.com
NEXT_PUBLIC_ASSET_PREFIX=https://assets.cubeclashes.com
```

Rebuild/redeploy normally. This public value is a Docker build argument baked
into Next and retained in the image; changing it requires a new image. It is not
a secret. Do not override it only at container runtime.

Next prefixes its bundled assets; the screenshot component prefixes only the
approved public screenshot paths. API, OAuth callback, invitation and runner URLs
stay on the main hostname. The private candidate preflight checks the CDN image,
asset-origin marker, CORS and API rejection before pausing the live application.
An unreachable or misconfigured asset CDN therefore aborts before deployment
downtime. This preflight is not a worldwide latency benchmark or an ongoing CDN
availability guarantee.

After deployment, use browser Network tools to verify actual JS/CSS/font requests
go to assets.cubeclashes.com and load successfully, while API/event requests go
to cubeclashes.com. Test from an overseas connection as well as India, comparing
cold/warm asset load times separately from API response time. Next builds use
content hashes; never overwrite an existing hashed asset with different bytes.
Purge changed public screenshots if they need to update before their cache TTL.

## Recovery and checks

If the CDN fails, point the `assets` A record back to the VM. Caddy's public-assets
hostname serves those same URLs directly using its existing certificate; keep
that certificate valid and the route deployed. DNS cache expiry still applies.
For a permanent rollback, unset NEXT_PUBLIC_ASSET_PREFIX and rebuild through the
normal pipeline. The current app hostname/DNS record does not need changing.

Automated tests: `npm run test:deployment` verifies the real Caddy public/private
boundary, credential removal, CORS, existing streaming and upload behavior.
`node --import tsx --test tests/cdn-config.test.mjs` checks opt-in configuration.
`node --test tests/deployment-safety.test.mjs` checks rejection of an unavailable
or incorrectly exposed CDN before activation. These do not claim to test a live
GoDaddy subscription.

References: [GoDaddy WAF/CDN setup](https://www.godaddy.com/help/set-up-my-web-application-firewall-waf-and-cdn-26813),
[GoDaddy cache exceptions](https://www.godaddy.com/en-ca/help/cache-exceptions-41618),
[Sucuri cache header behavior](https://docs.sucuri.net/website-firewall/troubleshooting/investigating-cache-headers/),
[Sucuri protocol limitations](https://docs.sucuri.net/website-firewall/troubleshooting/ftp-sftp-ssh-mail-cpanel-whm-plesk-or-websockets-not-working/),
[Next assetPrefix](https://nextjs.org/docs/app/api-reference/config/next-config-js/assetPrefix).
