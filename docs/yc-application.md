# YC application preparation

Prepared 21 September 2026. Product verification is recorded separately in
[demo readiness](demo-readiness.md). No application has been submitted.

## Choose the application, then the batch

YC's [Fall 2026 RFS](https://www.ycombinator.com/rfs) includes Aaron Epstein's
“Multiplayer AI”: teams sharing and handing off live agent work. It is a good
fit for this product's engineering workflow. An RFS is an invitation to build
in an area, not a separate funding application or an endorsement of this app.

On the date checked, the [application page](https://www.ycombinator.com/apply)
accepts Winter 2027 applications, for January–March in San Francisco. It lists
November 2, 2026 at 8 pm Pacific as the on-time deadline, with decisions by
December 11. Confirm the batch choices in the signed-in application portal.
If you specifically want late Fall consideration, confirm that option with YC;
do not assume the Fall RFS means Fall applications are still the default.

## Proposed product description

Short description, 47 characters:

> Shared AI coding sessions for engineering teams

Draft explanation, to refine with actual customer observations:

> Multiplayer AI lets engineering teams work in the same AI coding conversation.
> A teammate can see the agent's work, take over the task, and continue with the
> conversation and code context. Git records the resulting changes, and shared
> project memory links decisions to their sources. Teams bring their existing
> coding tools and logins.

Initial customer hypothesis: small engineering teams that already use coding
agents and lose time re-explaining work during reviews and handoffs. Validate
this with actual teams; it is not evidence of demand by itself. Focus the
application on one painful, observed workflow instead of listing every feature.

YC's [application advice](https://www.ycombinator.com/howtoapply) emphasizes
concrete, concise descriptions and specific evidence about founders and their
insight. Describe an observed handoff, why the old workflow failed, and what
changed when a team tried this product. Do not claim competitors lack a feature
without checking their current products.

## Gather these facts before writing final answers

| Topic | Evidence the founder must supply |
| --- | --- |
| Founders | Names, roles, how you met, relevant achievements, full-time commitment |
| Progress | Start date, time spent, current demo, actual shipped capabilities |
| Users | Number of real teams and weekly active users; exclude test accounts |
| Usage | Shared sessions, accepted handoffs, returning teams; include date ranges |
| Revenue | Actual payments and dates; distinguish trials, pilots, and interest |
| Customer problem | Specific interviews and examples of duplicated context or failed handoffs |
| Advantage | What your team learned or can build that a generic chat workspace misses |
| Business | Pricing hypothesis, buyer, how the first customers will find you |
| Company | Incorporation, ownership, fundraising, location, and batch availability |

Missing facts should remain blank until supplied. Test pass counts, repository
commits, and AI-generated conversations are not customer traction. If there are
no users or revenue yet, say that directly and explain the next validation step.

## Record the product demo

Suggested 90–120 second sequence; this duration is our recommendation, not a
YC requirement:

1. Show a small repository and one concrete task. Ask the connected agent to
   inspect a file and make a small change.
2. Open the same room as a second authenticated teammate. Show the shared
   conversation and code result.
3. Offer and accept control. The second teammate continues without pasting the
   transcript; both execution machines must be paired for a real device handoff.
4. Show the resulting diff and persisted conversation after a reload.
5. If demonstrating shared memory, show its approval and source. Only include
   cross-room semantic recall after rehearsing it with the actual service.

Use fresh demo data, readable text, and one connected provider. Verify the
recording reflects real responses; the deterministic runner in integration
tests is a transport fixture, not evidence of a live provider on two devices.
The three-turn live smoke test separately checks a real provider's repository
answer, conversation recall, and saved edit.

## Record the founder video separately

YC asks for a one-minute video of the founders talking, including all founders.
Explain who you are, what you are building, and why. Use bullet points and speak
naturally; keep the product demo separate. See the official
[founder video instructions](https://www.ycombinator.com/video).

Useful talking points: the handoff problem you experienced, what you built,
one verified customer observation or concrete product result, and why you are
the team to keep working on it. Do not invent usage numbers to make the story
sound stronger.

## Submission sequence

1. Finish the local demo checks and rehearse the two-person workflow.
2. Supply the facts above; turn them into short, specific answers.
3. Open [YC's application portal](https://apply.ycombinator.com/) and confirm
   the batch and the actual questions/limits shown there.
4. Add the founder video, separate product demo, and a working reviewer access
   path if the form asks for one. A localhost URL cannot be opened by YC.
5. Review every claim against evidence, confirm the final answers, and submit.

Production hosting is a separate milestone from a local application demo.
Do not describe unverified cloud operations or public multi-tenant hosting as
already deployed.
