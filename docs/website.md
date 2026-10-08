# Product website

The public product website is at `/`. The existing application is at
`/workspace`; sign-in, accepted invitations, room exit actions, and the Electron
entry point send users there.

The website and documentation use the workspace's shared warm dark palette in
`app/globals.css`, including its surfaces, text, borders, and action accent.
Headings use the same display font as the workspace. The website scroll container
preserves the full-height workspace layout. The product preview has four
selectable screenshots captured from the actual application, with a full-size
viewer; it does not connect to a live room. Native disclosure controls provide
the mobile navigation and FAQs, including without JavaScript.

## Downloads

The homepage reads configured HTTPS installer URLs from the server-side build
variables `DESKTOP_DOWNLOAD_MAC_URL` (Apple Silicon),
`DESKTOP_DOWNLOAD_MAC_INTEL_URL`, `DESKTOP_DOWNLOAD_WINDOWS_URL`, and
`DESKTOP_DOWNLOAD_LINUX_URL`. Missing or invalid values show **Coming soon**;
there are no placeholder download links. `DESKTOP_DOWNLOAD_CHECKSUMS_URL` links
to the published checksum file when available. Rebuild after changing them.

`DESKTOP_DOWNLOAD_CHANNEL=release` identifies release installers; otherwise the
page displays the preview signing notice. The desktop client connects to an
existing HTTPS workspace and includes its runner. Git and an installed,
configured AI CLI remain prerequisites. See [desktop-release.md](desktop-release.md)
for packaging and release operations.

## Public documentation

The homepage header, mobile menu, footer, and Docs section link to `/docs`.
The public handbook includes prerequisites, platform installation, AI setup,
workspace features, collaboration, and troubleshooting. See
[user-documentation.md](user-documentation.md) for its content map, image
provenance, and maintenance commands.

## Actual product screenshots

The homepage now reuses the current `connections`, `changes`, `conversation`, and
`handoff` captures from `app/docs/screenshots.ts`. Both the feature cards and
interactive preview use that registry's dimensions and alt text. Refresh these
captures using the process in [user-documentation.md](user-documentation.md).
This keeps the advertised interface and its theme consistent with the docs.

The older images in `public/product/` are retained as historical captures, and
are no longer shown on the homepage. The original demo frames came from:
`artifacts/demo-2026-09-22-extended/multiplayer-ai-extended-walkthrough.mp4`.
The sample Northstar project and Alex/Priya identities are demo fixtures. See the
recording’s README for provenance. The UI and agent responses are real footage;
no interface controls, colors, or conversation content have been fabricated.

| Asset | Recording timestamp |
| --- | --- |
| project-workspace.png | 00:13 |
| ai-conversation.png | 00:34 |
| chat-handoff.png | 00:48 |
| code-review.png | 03:04 |

Frames retain the app portion of the recording (1256 × 786 at x=588, y=134),
excluding the video’s narration captions and surrounding presentation. Next Image
serves responsive, optimized versions. The preview can be enlarged, including on
phones, without cropping the interface into an invented mobile layout.

Example extraction command, using the source recording above:

```sh
ffmpeg -ss 184 -i path/to/recording.mp4 -frames:v 1 \
  -vf 'crop=1256:786:588:134' public/product/code-review.png
```

### Team context preview

`team-connections.png` is a browser capture of the real Connections view in `/workspace`,
rendered at 1440 × 900 using the isolated Northstar demo data in
`tests/chat-ui.browser.mjs`. The component layout and controls are the production
application; account names, connection status, and channels are sample content. The original Discord
reference image and its private conversation are not included in the website.

To validate the interface and regenerate its screenshot:

```sh
npm run build -- --webpack
npm run test:ui
```

The check starts its own server and saves `multiplayer-ui-connections.png` in
Node's `os.tmpdir()`. Copy that capture to `public/product/team-connections.png`
when updating the website preview. It intercepts API calls inside an isolated
browser profile and never seeds
or sends messages to the application's database. `CHROME_BIN` can override the
Chrome executable. To test an existing server instead, set `CHAT_UI_BASE_URL`
and run `node tests/chat-ui.browser.mjs` without `--start-server`.
