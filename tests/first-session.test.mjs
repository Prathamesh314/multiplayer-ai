// A team's first session: the getting-started guide reads its progress from
// the work itself, shows one next step for each state, and never shows an
// impossible time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { createProject } from "../app/lib/project/store.ts";
import { createSession } from "../app/lib/session/store.ts";
import { createRun } from "../app/lib/ai/runs.ts";
import { orgOnboarding } from "../app/lib/org/onboarding.ts";
import { guideSteps } from "../app/components/orgs/GettingStarted.tsx";
import { relativeTime } from "../app/lib/format.ts";

async function freshTeam(f, handle = "dana") {
  const user = (await f.first(`INSERT INTO users(handle,email,display_name,connect_code) VALUES ($1,$2,$3,$4) RETURNING id`,
    [handle, `${handle}@example.test`, handle, "PK-DANA-2222"])).id;
  const org = (await f.first(`INSERT INTO orgs(slug,name,created_by) VALUES ($1,$2,$3) RETURNING id`, [`${handle}-team`, `${handle} team`, user])).id;
  await f.db.query(`INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'owner')`, [org, user]);
  return { user, org };
}

test("a new team's progress comes from what exists, step by step, and only counts this team", async () => {
  const f = await memoryFixture();
  try {
    const { user: dana, org } = await freshTeam(f);
    assert.deepEqual(await orgOnboarding(org, dana), { projects: 0, codeAdded: false, members: 1, pendingInvites: 0, projectTeammate: false, myTasks: 0, taskPeople: 0 });

    const { project } = await createProject({ orgId: org, name: "Website", createdBy: dana });
    const room = await createSession(dana, "dana", { orgId: org, projectId: project.id, pinned: true });
    assert.equal((await orgOnboarding(org, dana)).projects, 1);
    assert.equal((await orgOnboarding(org, dana)).codeAdded, false, "an empty room has no code yet");

    // A half-finished import is not code yet; a seeded one is.
    await f.db.query(`INSERT INTO room_repos(id,session_id,root_name,created_by) VALUES ('onbrdrepoabc',$1,'site',$2)`, [room.id, dana]);
    assert.equal((await orgOnboarding(org, dana)).codeAdded, false);
    await f.db.query(`UPDATE room_repos SET seeded_at=now(), head_sha=$1 WHERE id='onbrdrepoabc'`, ["a".repeat(40)]);
    assert.equal((await orgOnboarding(org, dana)).codeAdded, true);

    // Only live invitations wait to be accepted.
    const erin = (await f.first(`INSERT INTO users(handle,email,display_name,connect_code) VALUES ('erin','erin@example.test','Erin','PK-ERNA-3333') RETURNING id`)).id;
    await f.db.query(`INSERT INTO org_invitations(org_id,via,invitee_user_id,role,invited_by,expires_at) VALUES ($1,'connect_code',$2,'member',$3,now()+interval '1 day')`, [org, erin, dana]);
    await f.db.query(`INSERT INTO org_invitations(org_id,via,invitee_user_id,role,invited_by,created_at,expires_at) VALUES ($1,'connect_code',$2,'member',$3,now()-interval '3 days',now()-interval '1 day')`, [org, f.bob, dana]);
    assert.equal((await orgOnboarding(org, dana)).pendingInvites, 1);

    // Joining the team is not yet working on the project: that takes project membership.
    await f.db.query(`INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'member')`, [org, erin]);
    let progress = await orgOnboarding(org, dana);
    assert.equal(progress.members, 2);
    assert.equal(progress.projectTeammate, false);
    await f.db.query(`INSERT INTO project_members(project_id,org_id,user_id,role) VALUES ($1,$2,$3,'editor')`, [project.id, org, erin]);
    assert.equal((await orgOnboarding(org, dana)).projectTeammate, true);

    // Finished tasks, and how many people finished one.
    const finish = async (sessionId, startedBy, status = "completed") => {
      const run = await createRun({ sessionId, startedBy, agentId: "codex", baseSha: "a".repeat(40) });
      await f.db.query(`UPDATE agent_runs SET status=$2 WHERE id=$1`, [run.id, status]);
    };
    await finish(room.id, dana, "failed");
    assert.equal((await orgOnboarding(org, dana)).myTasks, 0, "a failed task is not a finished one");
    await finish(room.id, dana);
    progress = await orgOnboarding(org, dana);
    assert.equal(progress.myTasks, 1);
    assert.equal(progress.taskPeople, 1);
    const erinsRoom = await createSession(erin, "erin", { orgId: org, projectId: project.id, pinned: true });
    await finish(erinsRoom.id, erin);
    assert.equal((await orgOnboarding(org, dana)).taskPeople, 2, "two people finished tasks: shared work");

    // Another team's work never counts here, and this team's never counts there.
    await finish(f.room, f.alice);
    assert.equal((await orgOnboarding(org, dana)).taskPeople, 2);
    assert.equal((await orgOnboarding(f.org, f.alice)).myTasks, 1);
    assert.equal((await orgOnboarding(f.org, f.alice)).members, 3);
  } finally {
    await f.close();
  }
});

const connection = (status, extra = {}) => ({ status, devices: [], computer: status === "not-connected" ? undefined : { name: "Dana’s Mac" }, error: null, checking: false, refresh: async () => {}, ...extra });
const org = role => ({ id: "org", slug: "team", name: "Team", myRole: role, createdAt: 1 });
const project = { id: "p", slug: "web", name: "Web", myRole: "manager", isMember: true };
const noop = () => {};
const steps = (role, progress, status = "not-connected", aiReady = false) => guideSteps({
  org: org(role), progress: { projects: 0, codeAdded: false, members: 1, pendingInvites: 0, projectTeammate: false, myTasks: 0, taskPeople: 0, ...progress },
  connection: connection(status), aiReady, firstProject: progress.projects ? project : null,
  onNewProject: noop, onInvite: noop, onOpenRoom: async () => {}, onManageMembers: noop, onConnectComputer: noop, onSetUpAi: noop,
});
const next = list => list.find(step => !step.done);

test("the guide shows one next step for each state, with an action that fits it", () => {
  // A brand-new owner: create a project first.
  let list = steps("owner", {});
  assert.deepEqual(list.map(step => step.id), ["project", "code", "computer", "task", "invite", "together"]);
  assert.equal(next(list).id, "project");
  assert.equal(next(list).action.label, "Create a project");

  // Project made, code added, computer offline: reconnect, with the reason.
  list = steps("owner", { projects: 1, codeAdded: true }, "offline");
  assert.equal(next(list).id, "computer");
  assert.equal(next(list).action.label, "Reconnect computer");
  assert.match(next(list).state, /offline: closed, paused or asleep/);
  // Connected, but no AI tool signed in: set up AI, not "connect".
  list = steps("owner", { projects: 1, codeAdded: true }, "connected", false);
  assert.equal(next(list).action.label, "Set up AI");
  // A failed check is said as one, with a retry.
  assert.equal(next(steps("owner", { projects: 1, codeAdded: true }, "error")).action.label, "Try again");

  // Ready: run the first task in your room.
  list = steps("owner", { projects: 1, codeAdded: true }, "connected", true);
  assert.equal(next(list).id, "task");
  assert.equal(next(list).action.label, "Open my room");

  // A teammate joined the team but isn't on the project: add them, don't invite again.
  list = steps("owner", { projects: 1, codeAdded: true, myTasks: 1, taskPeople: 1, members: 2 }, "connected", true);
  assert.equal(next(list).id, "invite");
  assert.equal(next(list).action.label, "Add to project");
  // An invitation is out: say it's waiting, and still offer another invite.
  list = steps("owner", { projects: 1, codeAdded: true, myTasks: 1, taskPeople: 1, pendingInvites: 1 }, "connected", true);
  assert.match(next(list).state, /An invitation is waiting to be accepted/);
  assert.equal(next(list).action.label, "Invite a teammate");

  // Starting without files counts as having started: a finished task means code isn't blocking.
  assert.equal(steps("owner", { projects: 1, myTasks: 1 }).find(step => step.id === "code").done, true);

  // An established team is done: the guide has nothing left to show.
  assert.equal(next(steps("owner", { projects: 2, codeAdded: true, myTasks: 4, taskPeople: 3, members: 5, projectTeammate: true }, "connected", true)), undefined);
});

test("a member who joined sees how to get into a project, and no invite step they can't take", () => {
  const list = steps("member", { members: 4 });
  assert.deepEqual(list.map(step => step.id), ["project", "code", "computer", "task", "together"]);
  assert.equal(next(list).title, "Get added to a project");
  assert.equal(next(list).action, undefined);
  assert.match(next(list).state, /Ask a team admin to add you/);
});

test("times are never impossible: milliseconds, missing, invalid and future values", () => {
  const now = Date.now();
  assert.equal(relativeTime(Math.floor((now - 60_000) / 1000)), "1 minute ago");
  assert.equal(relativeTime(now - 60_000), "1 minute ago", "milliseconds are read as milliseconds, not 56,000 years");
  assert.equal(relativeTime(now - 3 * 86_400_000), "3 days ago");
  for (const value of [null, undefined, 0, -5, Number.NaN, Infinity]) assert.equal(relativeTime(value), "", String(value));
  assert.equal(relativeTime(Math.floor(now / 1000) + 30), "now", "another computer's clock slightly ahead");
});
