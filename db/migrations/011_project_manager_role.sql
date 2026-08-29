/*
 * "Project admin" is really the project's manager — the person who runs it and
 * decides who is on it, without needing to be an org admin. Naming the role
 * 'manager' makes that intent legible and matches the app's RBAC vocabulary
 * (Org Owner, Org Admin, Project Manager, Editor, Viewer).
 *
 * Pure rename: same capabilities, clearer name. Existing rows are migrated in
 * place, and the CHECK is swapped so only the new spelling is accepted.
 */

ALTER TABLE project_members DROP CONSTRAINT project_members_role_check;

UPDATE project_members SET role = 'manager' WHERE role = 'admin';

ALTER TABLE project_members
  ADD CONSTRAINT project_members_role_check CHECK (role IN ('manager', 'editor', 'viewer'));
