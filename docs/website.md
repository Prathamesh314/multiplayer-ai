# Product website

The public product website is at `/`. The existing application is at
`/workspace`; sign-in, accepted invitations, room exit actions, and the Electron
entry point send users there.

The website always uses its own dark palette, independent of workspace or OS
color preferences. Its scroll container preserves the full-height workspace
layout. The product preview has four selectable screenshots captured from the actual
application, with a full-size viewer; it does not connect to a live room. Native disclosure controls provide the mobile navigation
and FAQs, including without JavaScript.

## Downloads

At the product owner's request, downloads initially use **fake placeholder URLs**:

- `https://example.com/downloads/Multiplayer-AI.dmg`
- `https://example.com/downloads/Multiplayer-AI-Setup.exe`
- `https://example.com/downloads/Multiplayer-AI.AppImage`

These do not serve installers. The site labels each as a demo link and explains
that installers have not been published. Replace them with approved public
releases using these server-side build environment variables:

- `DESKTOP_DOWNLOAD_MAC_URL`
- `DESKTOP_DOWNLOAD_WINDOWS_URL`
- `DESKTOP_DOWNLOAD_LINUX_URL`

Only HTTPS URLs without embedded credentials are accepted. An empty or invalid
value uses the labeled placeholder. Rebuild/redeploy after updating the variables;
the landing page is statically rendered. A configured platform drops its demo
label independently of the other platforms. Use a download selection page if a
platform has multiple CPU architectures. Release requirements remain in
[desktop-release.md](desktop-release.md).

## Actual product screenshots

The four original images in `public/product/` are frames from the recorded app demo:
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
