import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { transaction, query } from "../db/client";
import { isUuid } from "../ai/turns";
import { SharingError } from "../sharing/store";
import { chatAccess, requireEditor } from "./access";
import type { AccessPreview, AccessRequest } from "./types";

type GrantContext = {sessionId:string;ownerId:string;orgId:string|null;projectId:string|null;visibility:string;orgName:string|null;projectName:string|null;orgRole:string|null;projectRole:string|null;host:boolean;consent:boolean;requestScope:string|null};
async function grantContext(tx:PoolClient,runId:string,actor:string,invitationId:string):Promise<GrantContext> {
  if(!isUuid(runId)||!isUuid(invitationId))throw new SharingError("Choose a guest invitation.",400);
  const {rows:[chat]}=await tx.query<GrantContext & {roomRole:string|null}>(`SELECT s.id AS "sessionId",s.owner_id AS "ownerId",s.org_id AS "orgId",s.project_id AS "projectId",s.visibility,
    o.name AS "orgName",p.name AS "projectName",om.role AS "orgRole",pm.role AS "projectRole",chat_share_manager(r.id,$2) AS host,room_access_role(s.id,$2) AS "roomRole",
    (SELECT scope_key FROM chat_access_requests WHERE invitation_id=$3) AS "requestScope",
    EXISTS(SELECT 1 FROM chat_access_requests q JOIN chat_invitations i ON i.id=q.invitation_id
      WHERE q.invitation_id=$3 AND i.run_id=r.id AND q.status='pending' AND q.requested_by=s.owner_id
      AND chat_share_issuer_active(r.id,q.requested_by)) AS consent
    FROM agent_runs r JOIN sessions s ON s.id=r.session_id LEFT JOIN orgs o ON o.id=s.org_id LEFT JOIN projects p ON p.id=s.project_id
    LEFT JOIN org_members om ON om.org_id=s.org_id AND om.user_id=$2 AND om.status='active'
    LEFT JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=$2 AND pm.removed_at IS NULL
    WHERE r.id=$1 AND chat_guest_eligible(r.id,$2)`,[runId,actor,invitationId]);
  if(!chat || (!chat.roomRole && !(chat.consent&&['owner','admin'].includes(chat.orgRole??''))) || (!chat.host && !['owner','admin'].includes(chat.orgRole??'') && chat.projectRole!=='manager'))throw new SharingError("Only the host or an authorized administrator can manage this guest’s access.");
  return chat;
}

async function preview(tx: PoolClient, runId: string, actor: string, invitationId: string): Promise<AccessPreview> {
  const chat = await grantContext(tx,runId,actor,invitationId);
  const orgAdmin = ['owner','admin'].includes(chat.orgRole??'');
  const projectAdmin = orgAdmin || chat.projectRole==='manager';
  if(!isUuid(invitationId)) throw new SharingError("Choose a guest invitation.",400);
  const {rows:[invite]} = await tx.query(`SELECT i.*,u.email_verified_at,u.deleted_at,chat_guest_eligible(i.run_id,i.accepted_by) AS eligible,
    chat_share_issuer_active(i.run_id,i.created_by) AS issuer_active,
    room_access_role($3,i.accepted_by) AS room_role,
    (SELECT status FROM org_members WHERE org_id=$4 AND user_id=i.accepted_by) AS org_status,
    (SELECT role FROM project_members WHERE project_id=$5 AND user_id=i.accepted_by AND removed_at IS NULL) AS project_role,
    (SELECT removed_at FROM session_members WHERE session_id=$3 AND user_id=i.accepted_by) AS room_removed_at
    FROM chat_invitations i LEFT JOIN users u ON u.id=i.accepted_by AND u.email=i.email
    WHERE i.id=$1 AND i.run_id=$2`,[invitationId,runId,chat.sessionId,chat.orgId,chat.projectId]);
  if(!invite) throw new SharingError("That invitation is not available.");
  const scope = chat.projectId
    ? [`Join organization “${chat.orgName}” as a member if necessary.`,`Edit project “${chat.projectName}”: its repositories, public workspaces, and their conversations.`,"Edit this workspace, including its files and other chats."]
    : [chat.orgId ? `Join organization “${chat.orgName}” as a member if necessary.` : "No organization membership is added.","Edit this workspace, including its files and other chats."];
  scope.push("Membership continues after the chat invitation expires. An administrator can remove it in member settings.","AI execution still needs a connected computer and AI tool. Control transfers only through a separate handoff.");
  const scopeKey=createHash('sha256').update(JSON.stringify([runId,invitationId,invite.accepted_by,chat.sessionId,chat.orgId,chat.projectId,scope])).digest('hex');
  chat.consent=chat.consent && chat.requestScope===scopeKey;
  let reason: string | null = null;
  if(!invite.accepted_by) reason = "Ask this guest to open and accept their chat invitation first.";
  else if(invite.room_removed_at) reason = "This person was removed from the workspace. Resolve that removal in member settings first.";
  else if(invite.revoked_at || Date.parse(invite.expires_at)<=Date.now() || !invite.eligible || !invite.issuer_active || !invite.email_verified_at || invite.deleted_at) reason = "This guest’s invitation or account is no longer eligible. Resolve access in member settings first.";
  const eligible=!reason;
  if(!reason) {
  if(chat.orgId && !invite.org_status && !orgAdmin) reason = "An organization owner or admin must grant access because this guest is not an organization member.";
  else if(chat.projectId && !projectAdmin && !['editor','manager'].includes(invite.project_role)) reason = "A project manager or organization admin must grant project editing access.";
  else if(chat.ownerId!==actor && (chat.visibility==='private' || !chat.projectId) && !chat.consent) reason = "The workspace owner must request this access before an administrator can grant it.";
  }
  return {invitationId,email:invite.email,userId:invite.accepted_by,canGrant:!reason,reason,scope,scopeKey,
    canRequest:eligible&&!!chat.orgId&&chat.ownerId===actor,requestPending:chat.consent,
    alreadyEditor:['owner','editor'].includes(invite.room_role??''),sessionId:chat.sessionId};
}

export async function previewGuestAccess(runId: string, actor: string, invitationId: string) {
  return transaction(tx=>preview(tx,runId,actor,invitationId));
}

export async function grantGuestAccess(runId: string, actor: string, input: unknown) {
  const value = input as {invitationId?:unknown;confirm?:unknown;scopeKey?:unknown}|null;
  if(!isUuid(value?.invitationId)||value.confirm!==true) throw new SharingError("Review the access scope and explicitly confirm before granting editing access.",400);
  return transaction(async tx=>{
    const initial = await preview(tx,runId,actor,value.invitationId as string);
    if(!initial.canGrant || !initial.userId) throw new SharingError(initial.reason??"This guest is not eligible.");
    const chat = await grantContext(tx,runId,actor,initial.invitationId);
    // Membership writers (including suspension triggers) lock membership before
    // invitations. Follow that order; no invitation/run -> membership cycle.
    if(chat.orgId) await tx.query('SELECT user_id FROM org_members WHERE org_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR UPDATE',[chat.orgId,[actor,initial.userId]]);
    if(chat.projectId) await tx.query('SELECT user_id FROM project_members WHERE project_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR UPDATE',[chat.projectId,[actor,initial.userId]]);
    await tx.query('SELECT user_id FROM session_members WHERE session_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR UPDATE',[chat.sessionId,[actor,initial.userId]]);
    await tx.query('SELECT id FROM agent_runs WHERE id=$1 FOR NO KEY UPDATE',[runId]);
    await tx.query('SELECT id FROM chat_invitations WHERE id=$1 FOR UPDATE',[initial.invitationId]);
    const current = await preview(tx,runId,actor,initial.invitationId);
    if(!current.canGrant || current.userId!==initial.userId) throw new SharingError(current.reason??"Guest access changed. Refresh and try again.");
    if(value.scopeKey!==current.scopeKey)throw new SharingError("The access details changed. Reopen the preview and confirm the current scope.",409);
    if(chat.orgId) {
      await tx.query(`INSERT INTO org_members(org_id,user_id,role,invited_by) VALUES($1,$2,'member',$3) ON CONFLICT DO NOTHING`,[chat.orgId,current.userId,actor]);
      const {rows:[member]} = await tx.query("SELECT status FROM org_members WHERE org_id=$1 AND user_id=$2",[chat.orgId,current.userId]);
      if(member.status!=='active') throw new SharingError("This account is suspended. An administrator must resolve that first.");
    }
    if(chat.projectId) await tx.query(`INSERT INTO project_members(project_id,org_id,user_id,role,added_by) VALUES($1,$2,$3,'editor',$4)
      ON CONFLICT(project_id,user_id) DO UPDATE SET role=CASE WHEN project_members.role='manager' THEN 'manager' ELSE 'editor' END
      WHERE project_members.removed_at IS NULL`,[chat.projectId,chat.orgId,current.userId,actor]);
    await tx.query(`INSERT INTO session_members(session_id,user_id,role,added_via,added_by) VALUES($1,$2,'editor','owner',$3)
      ON CONFLICT(session_id,user_id) DO UPDATE SET role=CASE WHEN session_members.role='owner' THEN 'owner' ELSE 'editor' END,removed_at=NULL`,[chat.sessionId,current.userId,actor]);
    await tx.query(`INSERT INTO chat_access_grants(invitation_id,granted_by,granted_to,scope) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[current.invitationId,actor,current.userId,JSON.stringify(current.scope)]);
    requireEditor(await chatAccess(tx,runId,current.userId!));
    await tx.query("UPDATE chat_access_requests SET status='approved',resolved_by=$2,resolved_at=now() WHERE invitation_id=$1 AND status='pending'",[current.invitationId,actor]);
    return {granted:true,sessionId:chat.sessionId,userId:current.userId};
  });
}

export async function requestGuestAccess(runId:string,actor:string,input:unknown) {
  const value=input as {invitationId?:unknown;scopeKey?:unknown;confirm?:unknown}|null;
  if(!isUuid(value?.invitationId)||value.confirm!==true)throw new SharingError("Review and confirm the access scope before asking an administrator.",400);
  return transaction(async tx=>{
    await chatAccess(tx,runId,actor,true);
    const current=await preview(tx,runId,actor,value.invitationId as string);
    if(!current.canRequest)throw new SharingError("The workspace owner must request editing access for an eligible guest.");
    if(current.alreadyEditor)throw new SharingError("This guest already has editing access. Use Handoff to offer control.",409);
    if(value.scopeKey!==current.scopeKey)throw new SharingError("Access details changed. Refresh the preview.",409);
    await tx.query(`INSERT INTO chat_access_requests(invitation_id,requested_by,scope_key) VALUES($1,$2,$3)
      ON CONFLICT(invitation_id) DO UPDATE SET requested_by=$2,scope_key=$3,status='pending',resolved_by=NULL,resolved_at=NULL,created_at=now()
      WHERE chat_access_requests.status<>'approved'`,[current.invitationId,actor,current.scopeKey]);
    return {requested:true};
  });
}

export async function declineGuestAccess(runId:string,actor:string,invitationId:unknown) {
  if(!isUuid(runId)||!isUuid(invitationId))throw new SharingError("Choose an access request.",400);
  return transaction(async tx=>{
    await tx.query('SELECT id FROM agent_runs WHERE id=$1 FOR NO KEY UPDATE',[runId]);
    const context=await grantContext(tx,runId,actor,invitationId);
    if(!['owner','admin'].includes(context.orgRole??'') || !context.consent)throw new SharingError("Only an organization administrator can decline this request.");
    await tx.query("UPDATE chat_access_requests SET status='declined',resolved_by=$2,resolved_at=now() WHERE invitation_id=$1 AND status='pending'",[invitationId,actor]);
    return {declined:true};
  });
}

export async function listGuestAccessRequests(actor:string,offset=0) {
  const start=Number.isSafeInteger(offset)&&offset>=0&&offset<=10000?offset:0;
  // Admins see the guest, requester and project, not private transcripts/files.
  const rows=await query<AccessRequest>(`SELECT r.id AS "runId",i.id AS "invitationId",i.email,u.display_name AS "requesterName",COALESCE(p.name,'Workspace') AS "projectName"
    FROM org_members om JOIN sessions s ON s.org_id=om.org_id JOIN agent_runs r ON r.session_id=s.id
    JOIN chat_invitations i ON i.run_id=r.id JOIN chat_access_requests q ON q.invitation_id=i.id
    JOIN users u ON u.id=q.requested_by LEFT JOIN projects p ON p.id=s.project_id
    WHERE om.user_id=$1 AND om.status='active' AND om.role IN ('owner','admin') AND q.status='pending'
      AND q.requested_by=s.owner_id AND chat_share_issuer_active(r.id,q.requested_by)
      AND i.revoked_at IS NULL AND i.expires_at>now() AND chat_guest_eligible(r.id,i.accepted_by) AND chat_guest_eligible(r.id,$1)
    ORDER BY q.created_at,q.invitation_id LIMIT 51 OFFSET $2`,[actor,start]);
  return {items:rows.slice(0,50),hasMore:rows.length>50};
}
