# Team chat interface

Organisation channels and direct messages at `/workspace` use a Discord-inspired
layout: workspace rail, collapsible channel/DM groups, message timeline, and a
member roster. The scoped palette stays dark regardless of the OS theme. Coding
rooms retain their editor and AI-chat behavior.

- The member list opens by default on wide screens and can be toggled everywhere.
  It displays conversation members and channel ownership, not guessed presence.
- Messages group by author within five minutes on the same local calendar day.
  Day separators make older history easier to follow. `@handle` text is highlighted;
  this is visual formatting and does not add a notification mechanism.
- Search filters loaded messages and authors. Load earlier messages to include
  more history; this is not a server-wide search.
- The composer supports Enter to send and Shift+Enter for a newline, respects IME
  composition, and limits input to the API's existing 4,000 characters. Failed
  sends preserve the draft and keep the conversation visible. Pending sends cannot
  be submitted twice, and streamed messages reconcile with POST responses by ID.
- The API, access rules, and message storage are unchanged.

`node tests/chat-ui.browser.mjs` checks the real rendered components with isolated
browser API fixtures, including error recovery, deduplication, history, direct
messages, search, and desktop/mobile layouts. See `website.md` for screenshot
regeneration. These checks exercise UI behavior, not a real backend connection.
