-- A repository in a room can be private to the member who added it.
--
-- 'room' (the default) is how repositories behaved: everyone who can open the
-- room sees it, its files and its chats. 'private' hides the repository, its
-- files, its chats and their live output from everyone else in the room,
-- including the room owner, until its creator makes it 'room' again.
--
-- The two functions are the one rule every reader applies: a repository or a
-- chat is hidden from someone when it is private and they did not add it.
--
-- Additive with a default, so the previous release ignores it.
ALTER TABLE room_repos
  ADD COLUMN visibility text NOT NULL DEFAULT 'room' CHECK (visibility IN ('room', 'private'));

CREATE FUNCTION room_repo_hidden(repo text, actor uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM room_repos rr WHERE rr.id = repo AND rr.visibility = 'private' AND rr.created_by IS DISTINCT FROM actor)
$$;

CREATE FUNCTION agent_run_hidden(run uuid, actor uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM agent_runs r JOIN room_repos rr ON rr.id = r.repo_id
    WHERE r.id = run AND rr.visibility = 'private' AND rr.created_by IS DISTINCT FROM actor)
$$;

-- Sharing a chat is managed by its driver or the room's owner, but never by
-- someone it is hidden from (a room owner, for a chat in a member's private
-- repository). Same rule as in 047, plus that one condition.
CREATE OR REPLACE FUNCTION chat_share_manager(chat uuid, actor uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM agent_runs r JOIN sessions s ON s.id=r.session_id
    WHERE r.id=chat AND chat_share_issuer_active(chat,actor)
      AND (s.owner_id=actor OR r.driver_user_id=actor)
      AND NOT agent_run_hidden(chat, actor)
  )
$$;
