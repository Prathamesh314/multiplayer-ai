# Projects and repositories

A project is a collaboration space, not a Git repository. It owns membership,
rooms, tasks, and a collection of zero or more shared repositories. Creating a
project or a member room creates no Git repository and selects none implicitly.

## Workflow

1. Create a project using its name.
2. Open your room and import one or more folders. Each import has its own Git
   history and remains in that room, subject to its visibility and membership.
3. Select an imported repository and click **Share repository** to publish its
   current committed code to the project. This exposes the shared repository to
   project members, including when the originating room is private.
4. Other members use **Project repositories → Add to room** to create their own
   checkout of that repository. They can select several repositories in a room.
5. **Publish** and **Get latest** operate only on the selected repository.
   Conflicts are reported without forcing a merge. These actions use the app's
   managed Git repositories; they do not push to GitHub.

Each AI chat currently targets one selected room repository. Cross-repository
agent execution within one chat is not part of this model change.

## Data model

- `projects`: collaboration identity, organisation, membership and limits.
- `project_repositories`: independent UUID, project ID, name, optional remote
  metadata, and readiness. A project can contain many rows or none.
- `room_repos.project_repository_id`: optional link to a shared repository.
  An unshared import has no such link. Each shared repository can be selected
  once per room; different rooms have independent branches and heads.
- `session_repos.project_repository_id`: explicit link for existing primary
  repositories. Existing chats with a null `repo_id` keep their original target.

Project membership is required to list or select shared repositories. Publishing
requires both room write access and project edit access. A room invitation alone
never grants access to the project's other repositories. Database checks prevent
room repositories from being attached to another project's repository.

Knowledge retrieval, publication approval, and new local runner caches resolve
an explicit repository identity. They do not treat the project ID as a repository.
Existing runner cache bindings remain intact to preserve local edits and files.

## Migration and storage

Migration `032_project_repositories.sql` moves existing project remote metadata
into a repository row and explicitly links existing room forks. Legacy repository
IDs retain their previous storage key so files, Git history and chat references
are not moved or deleted. New repository IDs are independent of project IDs.

The existing storage strategy remains: managed bare repositories under
`projects/<repository-id>.git`, room bare repositories under `repos/<room-repo-id>.git`,
and server working directories under `work/<room-repo-id>`. Storage optimization,
local-only repositories, and transferable snapshots are separate future work.

Run `npm run db:migrate` before starting the updated app. The migration should
be deployed together with the application change; older application versions
expect repository fields on `projects` that this migration removes.

## Verification

`npm run test:project-repositories` checks migration preservation, empty project
creation, independent repositories, selection, publish/sync isolation, and
cross-project binding rejection using real Git and embedded PostgreSQL.

With a built app running on port 3105, run
`node tests/project-repositories.browser.mjs` for fixture-based desktop/mobile
checks. Set `PROJECT_UI_BASE_URL` to use another address. The browser script uses
the installed macOS Chrome, matching the existing chat UI checks.
