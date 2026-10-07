# Join, understand, contribute

This change connects six existing product capabilities into a clearer workflow.

1. Reserve **Project** for the dashboard's team/project boundary. Inside a room,
   use **Repositories & chats**, **Add repository**, and **Start without files**.
   Keep the existing data model and URLs; do not migrate user content just to rename UI.
2. Present an editable briefing with goal, approved decisions, recorded progress,
   blockers, and next action. Build the initial draft from bounded, attributed
   database evidence without running an agent or inventing completed work. Store
   its source version, protect edits against concurrent saves, and flag stale
   briefings. Internal evidence is only exposed to guests after explicit sharing.
3. Label the existing prompt shortcut **Ask AI to review**. Add teammate review
   requests bound to repository and saved commit, with approve/request-changes
   outcomes. Reject approval against a changed commit; keep old reviews as history.
4. Add feedback directly to the conversation and a workspace inbox. Persist a
   per-user comment cursor; only mark comments actually displayed as read.
   Poll only visible pages, bound requests, and retain drafts on failed sends.
5. Offer a preview and explicit confirmation before granting editing access to
   an accepted guest. Require authority at every newly granted scope. Never
   reactivate suspended/removed users, downgrade existing privileges, transfer
   control, or execute AI as a side effect. Record the grant; offer handoff afterward.
   A workspace owner without organization authority can request an admin's
   approval in the collaboration inbox. Bind that consent to the previewed scope;
   expose only request metadata to admins without private workspace access.
6. Explain browser participation versus local execution before signup and when
   starting without files. Keep setup deferred for readers/commenters.

All mutations recheck permissions in short database transactions. Lock shared
rows consistently; no model, filesystem, email, or network calls while locked.
Keep current database connection, statement, lock, and transaction deadlines.

Validation: migration + store tests for evidence isolation, stale/concurrent edits,
versioned reviews, unread feedback, guest promotion and revocation; real PostgreSQL
race checks; HTTP/browser coverage for the integrated journey; TypeScript, lint,
existing suites, and production build. Migration 048 is required before serving
the new routes. Deployment applies it through the existing migration step.
