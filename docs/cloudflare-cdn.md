# Cloudflare Free CDN with your own account

This reuses the public-assets CDN support in commit `60c0827`. No GoDaddy CDN
subscription, Cloudflare Worker, paid routing add-on, or domain transfer is
required. Keep registration/renewals at GoDaddy; move authoritative DNS to your
own Cloudflare account. Basic CDN is included in Cloudflare's Free website plan.

Start by proxying **assets.multicode.in only**. Keep multicode.in and www
DNS-only. This accelerates public scripts, CSS, fonts and screenshots while chat,
login, Git transfers and event streams keep using the Bangalore server directly.
Cloudflare Free permits 100 MB request bodies; this application's Git receiver
accepts up to 128 MiB. Proxying the main hostname now would reduce that limit and
also require a change to its trusted-client-IP handling. This asset-only setup
does not provide Cloudflare protection or regional execution for the main API.

## 1. Add the domain to Cloudflare

In your own [Cloudflare dashboard](https://dash.cloudflare.com/), choose
**Add/Onboard a domain**, enter `multicode.in`, and select the **Free** plan.
Do not enter a URL or only the assets subdomain. Keep paid add-ons disabled.

## 2. Copy and verify the complete DNS zone

In GoDaddy, open **multicode.in → DNS → Export Zone File**. Import the zone
file into Cloudflare or compare its automatically discovered records against
every record in GoDaddy. A scan is not guaranteed to find every record.

Preserve website, mail, Resend verification, DKIM, SPF, DMARC, service verification
and other subdomain records. Use the actual record types and values in GoDaddy,
not the recursively resolved answers of a CNAME. Keep mail/service CNAMEs
DNS-only. Cloudflare manages its own apex NS/SOA records; do not replace those
with GoDaddy's old authoritative nameservers during the import.

The relevant web records should initially be:

| Type | Name | Content | Proxy status |
| --- | --- | --- | --- |
| A | `@` | `143.110.177.77` | DNS only (gray) |
| CNAME | `www` | `multicode.in` | DNS only (gray) |
| A | `assets` | `143.110.177.77` | DNS only (gray), until step 5 |

The VM IPv4 was verified on 2026-10-08; confirm it in your VM dashboard if the
server has moved. This table is **not** a complete zone export. Public checks
also found `resend._domainkey`, `_dmarc` and a `send` CNAME; preserve them and any
additional records from your account. GoDaddy's authoritative server returned
no apex AAAA record. Do not copy a DNS64-synthesized `64:ff9b::...` address into
Cloudflare as though it were the VM's IPv6 address.

## 3. Change nameservers at GoDaddy

After all records match, copy the **two nameservers assigned to this zone in your
own Cloudflare account**. In GoDaddy, open **DNS → Nameservers → Change → Use my
own nameservers** and enter those exact two values. Do not use example nameservers
or nameservers belonging to another Cloudflare account.

Check DNSSEC before this change. No public DS record was observed on 2026-10-08.
If GoDaddy now shows DNSSEC enabled, remove the old DS record and allow its TTL
to expire before switching. Once Cloudflare is active and stable, enable DNSSEC
there and add its new DS values at GoDaddy.

Wait for the zone to show **Active**. Existing DNS responses may persist until
their TTLs expire; keep the GoDaddy zone intact during the transition. Recheck
the website, Google sign-in and email verification. Future DNS edits belong in
Cloudflare; the domain registration remains at GoDaddy.

## 4. Enable and verify the asset origin

On the VM, in `/opt/multiplayer-ai/.env.production`, set:

```dotenv
APP_ASSET_DOMAIN=assets.multicode.in
# Leave NEXT_PUBLIC_ASSET_PREFIX unset for this first deployment.
```

Deploy using the existing **Application checks** workflow on `main` (it supports
**Run workflow**). The deployed code must contain commit `60c0827` or later.
Do not stop the current containers to build manually. Caddy provisions the asset
hostname's HTTPS certificate using its existing persistent certificate storage.

Verify the direct origin while the assets record is still DNS-only:

```sh
curl --fail --head https://assets.multicode.in/docs/images/workspace.webp
curl --head https://assets.multicode.in/api/auth/me
```

The image must return 200 with `Content-Type: image/webp`,
`Access-Control-Allow-Origin: *` and `X-Multiplayer-Public-Assets: 1`.
The API must return 404. Keep port 80 available for Caddy's certificate renewal
challenges; do not cache or challenge `/.well-known/acme-challenge/`.

## 5. Enable Cloudflare for public assets

In Cloudflare:

- **SSL/TLS → Overview:** choose **Full (strict)**. The Caddy origin certificate
  is already valid. Do not choose Flexible or disable certificate verification.
- **SSL/TLS → Edge Certificates:** wait for the certificate covering
  assets.multicode.in to be Active.
- **DNS → Records:** switch **assets only** to **Proxied (orange)**. Leave `@`,
  `www`, and mail/service hostnames DNS-only.
- Keep normal caching that respects origin headers. Do not add a zone-wide
  **Cache Everything** rule or a TTL that overrides private/no-store responses.
- Keep Rocket Loader off and avoid interactive challenges on the public-assets
  hostname. Scripts and fonts must be available to anonymous browser requests.

Repeat the step 4 checks through Cloudflare. For a real cache test, fetch the
same public image twice using GET (the second response should normally be HIT):

```sh
curl --fail --silent --show-error --dump-header - --output /dev/null https://assets.multicode.in/docs/images/workspace.webp
curl --fail --silent --show-error --dump-header - --output /dev/null https://assets.multicode.in/docs/images/workspace.webp
```

Look for `CF-Ray`, `Server: cloudflare`, and `CF-Cache-Status: HIT`. A first MISS
is normal. If subsequent requests remain uncached, inspect cache settings and
origin headers; do not force caching across the entire site. Always verify TLS
normally, without `curl -k`.

## 6. Switch the application's public asset URLs

Only after step 5 passes, set both VM variables:

```dotenv
APP_ASSET_DOMAIN=assets.multicode.in
NEXT_PUBLIC_ASSET_PREFIX=https://assets.multicode.in
```

Run the normal deployment again. NEXT_PUBLIC_ASSET_PREFIX is baked into the web
image, so changing only the running container's environment is insufficient.
The private deployment candidate checks asset availability, CORS and rejection
of API paths before pausing the current app. Build/preflight failures leave the
current release serving traffic.

In browser Network tools, confirm bundles/fonts/screenshots load from the asset
hostname and APIs/event streams remain on multicode.in. Compare cold and warm
page loads from India and an overseas connection. The CDN reduces asset latency;
database writes and live chat still make the trip to Bangalore.

## Rollback

If Cloudflare's asset proxy is unavailable, switch the assets record to DNS-only;
its origin content remains the VM IP, so the existing HTTPS asset hostname still
works directly after DNS caches expire. Keep Caddy's certificate valid. To remove
the asset prefix permanently, unset NEXT_PUBLIC_ASSET_PREFIX and redeploy.

Do not switch nameservers back while a Cloudflare DNSSEC DS record is still
published at GoDaddy. A nameserver rollback requires the corresponding DNSSEC
migration steps; toggling the assets proxy does not change nameservers or DS.

References: [Free plan](https://www.cloudflare.com/plans/free/),
[Cloudflare full setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/),
[DNSSEC migration](https://developers.cloudflare.com/dns/dnssec/),
[GoDaddy zone export](https://www.godaddy.com/help/export-my-domains-zone-file-records-4166),
[GoDaddy nameserver change](https://www.godaddy.com/help/change-my-domain-nameservers-664),
[Full (strict) TLS](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/),
[default caching](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/),
[upload limits](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/).
