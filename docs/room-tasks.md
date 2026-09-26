# Tasks from chats

Open any AI chat in a room, including a teammate's chat. Below the conversation,
click **@ Assign task**, choose a room member by `@handle`, describe the request
(for example, “Please review the changes in this chat”), and click **Create task**.
The assignment stays visible under **Chat tasks**. It does not run AI or change
who controls the chat. Start a chat first if the room has no conversations yet.

The assignee's workspace dashboard shows **My tasks** across their rooms.
Each task names its author and assignee and links to the source room and chat.
Use the status menu to move between **To do**, **In progress**, **Done**, and
**Cancelled**. Completed tasks remain available. Lists refresh every five seconds
while the page is visible and on window focus, with pagination for older tasks.

Room owners and editors can create assignments in any chat they can access.
Assignees may also be viewers. The assignee or the creator (while still an editor)
can update status. Public-room project membership is included in the person picker;
private rooms require actual room access. Every read and write rechecks the existing
`room_access_role` permission function. Losing access hides tasks from that room.

Storage is PostgreSQL's `room_tasks` table (migration `031_room_tasks.sql`). Each
row references the AI run, creator and assignee, with text, status and timestamps.
The run supplies the room and its permission boundary. Human requests are kept
separate from AI prompts, so task assignment cannot accidentally invoke a model.
Client-generated request IDs make retries idempotent; failed submissions retain
their draft. No vector store, external task service or extra worker is required.

Run `npm run db:migrate` before starting the updated app. `npm run test:tasks`
checks storage, permissions, retries, status changes and pagination using all real
migrations in an isolated PGlite database.

The existing `tests/handoff-browser.mjs` integration harness also checks the
two-user assignment flow through real Next.js routes and Chrome: failed-send
draft recovery, dashboard delivery, status changes and the source chat link.

Implementation entry points:

- `app/components/tasks/TaskPanel.tsx`: chat assignment form and dashboard inbox.
- `app/lib/tasks/store.ts`: durable writes, task queries and permission checks.
- `app/api/tasks/route.ts`, `app/api/tasks/[id]/route.ts`: authenticated HTTP API.
- `app/components/workspace/Workspace.tsx`: source chat deep links (`?run=<id>`).
