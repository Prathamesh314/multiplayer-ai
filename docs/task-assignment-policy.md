# Human task assignment

An owner or editor can assign a task to **another person who can access the
room**. Self-assignment is rejected by the API for both existing chats and new
task chats. UUID casing does not change identity. Both assignment pickers also
exclude the signed-in user.

| Action | Required access |
| --- | --- |
| Assign to another member | Creator is a room owner/editor; recipient has room access |
| Assign to yourself | Not allowed |
| Assign from another person's chat | Same room permissions; taking over the chat is unnecessary |
| Change a task's status as its assignee | Assignee still has room access, including viewer access |
| Change a task's status as its creator | Creator still has owner/editor access |
| Change somebody else's task as an unrelated editor | Not allowed |
| Read tasks after losing room access | Not allowed |

Creating a task does not run AI, add an AI prompt, or transfer chat control.
A fresh task chat and its first task are saved in one transaction. A rejected
assignment creates neither record. Retrying the same request creates one task;
reusing its ID with different content is rejected. These rules also apply when
the picker is stale or the request is sent directly to the API.

Room rosters are scoped to the currently displayed room. Removing the selected
person's tag clears the composer's assignment selection. The assignment tag is
removed once from the saved task; further mentions in the task's text are kept.

The creation policy does not delete historical tasks or change the existing
status-update rules. It introduces no database migration.

Regression coverage is in `tests/tasks.test.mjs` and the real PostgreSQL/Chrome
workflow in `tests/handoff-browser.mjs`. It checks API rejection, both pickers,
private-room isolation, membership revocation, viewer restrictions, status
updates, retry behavior, draft recovery, repeated mentions, selected repositories,
inbox delivery, and the absence of unintended AI turns or ownership transfers.
