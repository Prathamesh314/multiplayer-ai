-- Organisation owners and admins can look at every project without being
-- added to it, and looking used to give them a room there, so they appeared
-- to be members of every project. Rooms are now only made for added members.
--
-- Here, the rooms looking left behind are hidden (soft-deleted, recoverable
-- by clearing deleted_at): only a project room whose owner is not an added
-- member of that project, and that holds nothing at all — no chats, no
-- repository, no messages, no attachments, and nobody else on
-- its roster (memories only come from chats and messages, so none exist
-- here either). A room with any work in it stays as it is.
UPDATE sessions s SET deleted_at = now()
 WHERE s.project_id IS NOT NULL AND s.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = s.project_id AND pm.user_id = s.owner_id AND pm.removed_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.session_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM room_repos rr WHERE rr.session_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM session_repos sr WHERE sr.session_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM session_messages m WHERE m.session_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM chat_attachments a WHERE a.session_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM session_members sm WHERE sm.session_id = s.id AND sm.user_id <> s.owner_id AND sm.removed_at IS NULL);
