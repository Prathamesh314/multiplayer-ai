# UX review and improvements

## Assessment

The existing dark, tabbed workspace is a reasonable fit for developers. The stronger adoption proposition is continuing a teammate's AI work, not merely having an editor and a model picker. Visual consistency helps, but it cannot establish that people will adopt or pay for the product. That requires observing actual teams using it.

The main onboarding problems were ambiguity and discoverability: an unsolicited provider dialog appeared before users understood the workspace; project, room, and run terminology competed; setup was hidden in a profile menu; starter prompts immediately submitted tasks; and some screens implied GitHub cloning, automatic cloud execution, or completely offline processing that the implementation did not guarantee.

## Implemented

- **An understandable home:** explain projects versus rooms, show the three-step workflow, and expose computer/AI setup actions directly. Remove the automatic first-visit provider modal. Keep project search, opening rooms, and existing navigation intact.
- **Honest project creation:** default to a local project. Label the GitHub option as a reference and explain that it does not authenticate, clone files, or create PRs. Project cards no longer claim a local folder has already been imported.
- **A clearer first room:** one primary folder action, short next-step cards, accurate upload/sharing disclosure, and an optional browser-upload fallback. Viewers see an explanatory read-only state rather than an import CTA.
- **An actionable Room guide:** available on desktop and mobile, with routes to files, the existing AI chat, team chats, invitations, AI setup, and device setup. Explain shared tabs, handoff versus copying a chat, review, and internal project publishing. Opening chat through the guide preserves the draft and current conversation.
- **Predictable prompts:** starters fill and focus the composer, preserving existing text. They do not create a turn or invoke AI; users edit and send deliberately. Examples ask for explanations/review/planning rather than immediately proposing unrestricted changes.
- **Clearer labels and feedback:** “AI chats,” “Copy chat,” “Reasoning effort,” and “Get latest”; an execution-location label; expanded-state accessibility on sidebar sections; and corrected contrast on the handoff confirmation button.
- **Setup that explains itself:** instructions for connecting a computer/provider, an explicit refresh action, model-aware availability, and a direct route from AI setup to device pairing. Remove claims that no paired computer means automatic cloud execution, or that an installed provider necessarily runs entirely offline.
- **Recoverable setup failures:** catch provider/device loading and clipboard errors, show actionable error messages, and allow retries instead of unhandled rejections or an unexplained loading state. Show the runner start command after pairing instructions.

These changes do not implement GitHub OAuth, automatic CLI installation, hosted sandbox execution, or the production-security plan. User authentication/provider setup is still required. The app's execution and authorization checks remain authoritative; explanatory UI is not a replacement for them.

## Verification

The browser suite now covers starter prompts without submission, draft preservation, Room guide actions and viewport sizing, non-interrupting home onboarding, honest project defaults, AI-to-device navigation, and loading-error recovery. It also retains the real import/file/tab, handoff, Git transport, and runner-completion regression checks.

Results: 173 default-plus-knowledge checks pass; the full browser suite passes against a production Next.js build, real PostgreSQL, and Redis. Desktop/mobile screenshots were inspected. Production webpack build and TypeScript pass; targeted lint has no errors, with existing image and chat-hook warnings. Development-mode runs hit reload interruptions during the new home/setup checks; use the production-mode command below for the full UX regression suite rather than interpreting those interruptions as a passing development run.

Validation commands:

```sh
npm test
npm run test:knowledge
npx tsc --noEmit
npm run build -- --webpack
HANDOFF_TEST_POSTGRES=1 HANDOFF_TEST_BROWSER=1 HANDOFF_TEST_PRODUCTION=1 node --env-file=.env --import tsx tests/handoff.test.mjs
```

Run build and browser validation sequentially: Next's generated type/build files can trigger development-server reloads during an active browser test. Browser tests use isolated database/Git fixtures and simulated runner results, not paid inference. Screenshots are captured under `/tmp/ux-*` and `/tmp/handoff-room-*` for visual inspection. Existing unrelated lint warnings are not a UX regression introduced by this change.

## How to find out whether people like it

Recruit five engineers who did not help build the product, including at least one pair who regularly work together. Give them a disposable project and observe, without coaching, whether they can:

1. Explain what the product does and how a project differs from a room.
2. Create a project, add code, find a file, and return to their chat draft.
3. Identify where execution happens, connect their setup, and send a small task.
4. Invite a teammate, offer/accept a handoff, and continue the same conversation.
5. Review changes and correctly distinguish publishing internally from opening a GitHub PR.

Record completion, time, wrong turns, requests for help, and confidence about uploads/costs. A provisional usability gate is four of five completing the core navigation tasks without intervention, with no misunderstanding that causes unexpected execution or sharing. This is a proposed target, not an achieved research result.

Then run a small multi-week team pilot: measure repeat successful handoffs, time saved when resuming work, reviewed changes delivered, and reasons teams stop using it. Do not substitute compliments about the visual design for evidence of repeat use. Prioritize the friction observed in these sessions before adding another large feature set.
