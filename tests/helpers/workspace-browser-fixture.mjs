/** Isolated sample API data shared by browser checks and documentation captures. */
export function installFixtures() {
  const room = { id: "modelroomabc", name: "Alice", joinCode: "ABCD-EFGH", ownerId: "alice", orgId: "org", projectId: "project", visibility: "public", createdAt: 1, repo: null, lastActiveAt: 1, pinned: true, archivedAt: null, myRole: "owner" };
  const repositories = [{id:"11111111-1111-4111-8111-111111111111",name:"frontend"},{id:"22222222-2222-4222-8222-222222222222",name:"backend"}].map(r=>({...r,projectId:"project",defaultBranch:"main",ready:true}));
  const computer={id:"computer-1",userId:"alice",name:"Alice’s Mac",platform:"darwin",version:"2",lastSeenAt:Date.now(),createdAt:1,revokedAt:null,online:true,supportsPermissions:true,git:"2.47.1"};
  const state = window.__model = { room, repos: [], runs: [], inputs: {}, files: {}, failSave: false, devices:[computer], deviceFailure:false, agentsFailure:false, aiReady:true, sources: [], requests: [], unknown: [] };
  state.emit = (type, data={}) => state.sources.filter(source=>source.url.includes(`/sessions/${room.id}/events`)).forEach(source=>source.dispatchEvent(new MessageEvent(type,{data:JSON.stringify({type,...data})})));
  state.emitDevices = () => state.sources.filter(source=>source.url==="/api/events").forEach(source=>source.dispatchEvent(new MessageEvent("devices.changed",{data:"{}"})));
  window.EventSource = class extends EventTarget {
    constructor(url) { super(); this.url=url;state.sources.push(this);setTimeout(()=>this.dispatchEvent(new MessageEvent("ready",{data:"{}"})),10); }
    close() { state.sources=state.sources.filter(source=>source!==this); }
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init={}) => {
    const u = new URL(typeof input === "string" ? input : input.url, location.origin), path=u.pathname;
    if (!path.startsWith("/api/")) return nativeFetch(input, init);
    state.requests.push({path,search:u.search,method:init.method ?? "GET",body:init.body});
    const json = body => new Response(JSON.stringify(body), {headers:{"content-type":"application/json"}});
    if(path.startsWith('/api/shared-chats/')&&path.endsWith('/invitations')) {
      state.invitations??=[];
      if(init.method==='POST'){
        // Shared like a document: by email, no token, no expiry.
        const input=JSON.parse(init.body),invitation={id:crypto.randomUUID(),email:input.email,role:input.role,createdAt:new Date().toISOString(),expiresAt:null,acceptedAt:null,revokedAt:null,viaLink:false};
        state.invitations=state.invitations.filter(item=>item.email!==input.email);state.invitations.unshift(invitation);return json({invitation,notified:false});
      }
      if(init.method==='DELETE'){state.invitations.find(item=>item.id===JSON.parse(init.body).id).revokedAt=new Date().toISOString();return json({ok:true});}
      return json({invitations:state.invitations,link:state.link??null,canNotify:false});
    }
    if(path.startsWith('/api/shared-chats/')&&path.endsWith('/link')&&init.method==='PUT'){
      const role=JSON.parse(init.body).role;state.link=role?{role,token:state.link?.token??'l'.repeat(43)}:null;return json({link:state.link});
    }
    state.feedback??=[{id:'guest-feedback',seq:1,body:'Please check delivery errors.',authorName:'Guest',createdAt:new Date().toISOString()}];
    if(path==='/api/handoffs')return json({received:[],sent:[]});
    if(path==='/api/collaboration/inbox'){
      const unread=state.feedback.filter(c=>c.authorName!=='Alice'&&c.seq>(state.feedbackRead??0)).length;
      return json({items:unread?[{runId:u.searchParams.get('runId'),sessionId:room.id,title:'Conversation',unread,reviews:0}]:[],hasMore:false});
    }
    if(path==='/api/collaboration/access-requests')return json({items:[],hasMore:false});
    if(path.startsWith('/api/chats/')&&path.endsWith('/access')) {
      if(init.method==='POST') {
        const body=JSON.parse(init.body);
        if(body.action==='request')state.accessPending=true;
        if(body.action==='grant')state.accessGranted=true;
        return json({granted:state.accessGranted,requested:state.accessPending});
      }
      return json({invitationId:u.searchParams.get('invitationId'),email:'guest@example.test',userId:'guest',canGrant:!!state.canGrant,canRequest:true,requestPending:!!state.accessPending,
        reason:state.canGrant?null:'An organization owner or admin must grant access because this guest is not an organization member.',
        scope:['Join organization “Team” as a member.','Edit this project and workspace.','Handoff remains a separate action.'],scopeKey:'confirmed-scope',alreadyEditor:!!state.accessGranted,sessionId:room.id});
    }
    if(path.startsWith('/api/chats/')&&path.endsWith('/briefing')) {
      state.briefing??={body:{goal:'Review the repository',decisions:'No approved decisions recorded.',progress:'AI reported an implementation.',blockers:'Verify tests.',nextAction:'Review saved changes.'},sources:[],fingerprint:'fixture',sourceSeq:2,headSha:'a'.repeat(40),revision:0,sharedWithGuests:false,stale:false,canEdit:true,updatedBy:null,updatedAt:null};
      if(init.method==='PUT'){state.briefing={...JSON.parse(init.body),revision:state.briefing.revision+1,updatedBy:'Alice'};}
      return json(state.briefing);
    }
    if(path.startsWith('/api/chats/')&&path.endsWith('/reviews'))return json({reviews:[],headSha:'a'.repeat(40),reviewers:[{id:'bob',name:'Bob'}],canRequest:true});
    if(path.startsWith('/api/chats/')&&path.endsWith('/feedback')){
      if(init.method==='PUT'){state.feedbackRead=Math.max(state.feedbackRead??0,JSON.parse(init.body).seq);return json({read:true});}
      const comments=state.feedback.filter(c=>!u.searchParams.has('before')||c.seq<Number(u.searchParams.get('before')));
      return json({comments:comments.slice(-50),hasMore:comments.length>50,lastRead:state.feedbackRead??0,canComment:true});
    }
    if(path.startsWith('/api/shared-chats/')&&path.endsWith('/comments')){
      if(state.failFeedback)return new Response(JSON.stringify({error:'Could not post feedback. Try again.'}),{status:503});
      const comment={...JSON.parse(init.body),seq:state.feedback.length+1,authorName:'Alice',createdAt:new Date().toISOString()};state.feedback.push(comment);return json(comment);
    }
    if (path === "/api/auth/me") return json({user:{id:"alice",handle:"alice",displayName:"Alice",email:"alice@example.test"}});
    if (path === "/api/orgs") return json({orgs:[{id:"org",slug:"team",name:"Alice’s workspace",myRole:"owner",createdAt:1}]});
    if (path === "/api/invitations") return json({invitations:[]});
    if (path.endsWith("/projects")) return json({projects:[{id:"project",slug:"project",name:"My project",orgId:"org",myRole:"manager",createdAt:1,archivedAt:null}]});
    if (path.endsWith("/rooms")) return json({sessions:[room]});
    if (path.endsWith("/usage")) return json({concurrency:{used:0,limit:3},monthly:{used:0,limit:null}});
    if (path === "/api/sessions/modelroomabc") return json(room);
    if (path.endsWith("/project-repositories")) return json({repositories});
    // One repository: its creator makes it private or visible, or it is deleted.
    const oneRepo=path.match(/\/repos\/([a-z0-9]+)$/);
    if (oneRepo && (init.method==="PATCH"||init.method==="DELETE")) {
      const repo=state.repos.find(item=>item.id===oneRepo[1]);
      if(!repo)return new Response(JSON.stringify({error:"Repository not found in this room."}),{status:404,headers:{"content-type":"application/json"}});
      if(init.method==="PATCH"){repo.visibility=JSON.parse(init.body).visibility;return json({repo});}
      state.repos=state.repos.filter(item=>item!==repo);state.runs=state.runs.filter(run=>run.repoId!==repo.id);return json({deleted:true,chats:0});
    }
    if (path.endsWith("/repos")) {
      if (init.method === "POST") {
        const body=JSON.parse(init.body);
        if(body.empty) {
          if(state.failCreate)return new Response(JSON.stringify({error:"Could not create the conversation space. Please try again."}),{status:503,headers:{"content-type":"application/json"}});
          if(state.repos.some(repo=>repo.rootName===body.name))return new Response(JSON.stringify({error:"A repository or conversation space with that name already exists here. Choose another name."}),{status:409,headers:{"content-type":"application/json"}});
          const repo={id:"emptyproject",sessionId:room.id,rootName:body.name,projectRepositoryId:null,headSha:"e".repeat(40),baseSha:"e".repeat(40),seededAt:1,createdAt:1,createdBy:"alice",empty:true};
          state.repos.push(repo);return json({repo});
        }
        const shared = repositories.find(r=>r.id===body.projectRepositoryId);
        const repo = {id:shared.name==="frontend"?"frontendabcd":"backendabcde",sessionId:room.id,rootName:shared.name,projectRepositoryId:shared.id,headSha:"a".repeat(40),baseSha:"a".repeat(40),seededAt:1,createdAt:1,createdBy:"alice"};
        state.repos.push(repo);return json({repo});
      }
      return json({repos:state.repos});
    }
    if(path.endsWith("/tree")) {
      const repo=state.repos.find(r=>r.id===u.searchParams.get("repoId"));
      const added=(repo.added??[]).map(path=>({name:path,path,type:"file",size:1}));
      return json({rootName:repo.rootName,root:{name:repo.rootName,path:"",type:"directory",children:[...(repo.empty?[]:[{name:repo.rootName+".txt",path:repo.rootName+".txt",type:"file",size:10}]),...added]},headSha:repo.headSha,sessionBranch:"session/"+repo.id});
    }
    if(path.endsWith("/files") && init.method==="POST") {
      // Explorer uploads: recorded, added to the repository's tree; an existing file needs overwrite.
      const repo=state.repos.find(r=>r.id===u.searchParams.get("repoId")),form=init.body,paths=JSON.parse(form.get("paths")),overwrite=form.get("overwrite")==="1";
      const existing=new Set([...(repo.empty?[]:[repo.rootName+".txt"]),...(repo.added??[])]),clashing=paths.filter(p=>existing.has(p));
      (state.uploads??=[]).push({paths,overwrite,sizes:form.getAll("file").map(f=>f.size)});
      if(clashing.length&&!overwrite)return new Response(JSON.stringify({error:"Some files already exist.",exists:clashing}),{status:409,headers:{"content-type":"application/json"}});
      repo.added=[...(repo.added??[]),...paths.filter(p=>!existing.has(p))];
      return json({headSha:"d".repeat(40),added:paths.filter(p=>!existing.has(p)),replaced:clashing});
    }
    if(path.endsWith("/changes")) return u.searchParams.has("path") ? json({diff:state.diffs?.[u.searchParams.get("path")] ?? ""}) : json(state.changes ?? {changes:[]});
    if(path.endsWith("/file")) {
      if(init.method === "PUT") {
        if(state.failSave) return new Response(JSON.stringify({error:"Save unavailable"}),{status:503,headers:{"content-type":"application/json"}});
        const file=JSON.parse(init.body);state.files[file.path]=file.text;
        return json({headSha:"c".repeat(40),conflict:false});
      }
      const text=state.files[u.searchParams.get("path")] ?? "Original file contents";
      const live=state.liveFiles?.[u.searchParams.get("path")];
      return json({text,size:text.length,truncated:false,binary:false,...(live?{live}:{})});
    }
    if(path.endsWith("/activity")) return json({ok:true});
    if(path.endsWith("/publish") || path.endsWith("/sync")) return json({ok:true,sha:"b".repeat(40)});
    if(path.endsWith("/members"))return json({members:[{userId:"alice",handle:"alice",displayName:"Alice",role:"owner",online:true},...(state.extraMembers??[])]});
    if(path.endsWith("/runs"))return json({runs:state.runs});
    const runPath=path.match(/\/runs\/([^/]+)(?:\/(handoff|history|inputs|join|branch|permissions|stop)(?:\/([^/]+))?)?$/);
    if(runPath) {
      const run=state.runs.find(item=>item.id===runPath[1]);
      if(runPath[2]==="branch") {
        // A parallel chat's branch: state.branches[runId] is the GET answer;
        // POSTs are recorded and answered from state.branchOutcomes (a queue).
        if(init.method==="POST"){const outcome=(state.branchOutcomes??=[]).shift()??{ok:true,sha:"d".repeat(40),changed:true};return new Response(JSON.stringify(outcome),{status:outcome.ok===false?409:200,headers:{"content-type":"application/json"}});}
        if(u.searchParams.has("path"))return json({diff:(state.diffs??{})[u.searchParams.get("path")]??""});
        return json(state.branches?.[run.id]);
      }
      if(runPath[2]==="handoff")return json({run,offers:[],recipients:[]});
      if(runPath[2]==="history")return json({turns:[],snapshots:[],selectedSnapshotId:null});
      if(runPath[2]==="join")return json({ok:true});
      if(runPath[2]==="permissions") {
        // Tool requests an agent is waiting on: state.permissions[runId]; answers are recorded.
        const requests=(state.permissions??={})[run.id]??=[];
        if(runPath[3]&&init.method==="POST"){const decision=JSON.parse(init.body).decision;(state.permissionDecisions??=[]).push({id:runPath[3],decision});const request=requests.find(item=>item.id===runPath[3]);if(request)request.status=decision==="deny"?"denied":"allowed";return json({status:request?.status});}
        // Approvals: Auto allows what is waiting, as the server does.
        if(!runPath[3]&&init.method==="PUT"){const mode=JSON.parse(init.body).mode;run.permissionMode=mode;(state.modeChanges??=[]).push(mode);
          let released=0;if(mode==="auto")for(const request of requests)if(request.status==="pending"){request.status="allowed";request.automatic=true;released++;}
          setTimeout(()=>state.emit?.("run.permission",{runId:run.id,at:Date.now()}),0);return json({mode,released});}
        return json({requests});
      }
      // Stop: recorded, then the agent "stops" (the run finishes) when the test says so.
      if(runPath[2]==="stop") { state.stops=(state.stops??0)+1; return json({status:"stopping"}); }
      if(runPath[2]==="inputs") {
        const inputs=state.inputs[run.id]??=[];
        if(init.method==="POST") {const input={...JSON.parse(init.body),runId:run.id,status:"queued",createdAt:new Date().toISOString()};inputs.push(input);return json({input});}
        return json({inputs});
      }
      // state.messages[runId]: this chat's stored messages, when a test sets them.
      if(state.messages?.[run.id])return json({run,messages:state.messages[run.id]});
      // state.forks[runId]: this chat imported its context from another ({runId,sessionId,name}).
      const fork=state.forks?.[run.id];
      if(fork)return json({run,forkedFrom:{runId:fork.runId,sessionId:fork.sessionId},messages:[{role:"system",body:"Imported context from #"+fork.name},{role:"user",body:"Continue from that chat."}]});
      return json({run,messages:[{role:"user",body:"Review the repository and explain how the session works."},{role:"assistant",body:"## Session workspace\n\nThe repository is ready. Use `executeAgentRun` to start an agent turn.\n\n### Next steps\n\nSelect a file to inspect its contents, or continue the conversation."}]});
    }
    if(path==="/api/tasks"&&init.method==="POST"){(state.taskPosts??=[]).push(JSON.parse(init.body));return json({ok:true,runId:state.runs[0]?.id??null});}
    if(path==="/api/tasks")return json({tasks:(state.tasks??[]).filter(task=>!u.searchParams.get("runId")||task.runId===u.searchParams.get("runId")),members:state.taskMembers??[],hasMore:false});
    if(path.endsWith("/handoffs"))return json({offers:[]});
    if(path.endsWith("/messages"))return json({messages:[]});
    if(path.endsWith("/forkable-runs"))return json({runs:[]});
    if(path.endsWith("/mention-targets"))return json({rooms:[{sessionId:room.id,name:room.name,chats:state.runs.map(run=>({runId:run.id,title:run.title}))}]});
    // Terminal keystrokes, resizes and kills: recorded, answered like the real route.
    if(path === "/api/terminal/pty")return new Response(null,{status:204});
    if(path === "/api/terminal")return json(state.terminal??{enabled:false,location:"computer",reason:"Terminal disabled in browser fixture",cwd:"",shell:"",platform:""});
    if(path === "/api/ai/agents") {
      if(state.agentsFailure)return new Response("Temporarily unavailable",{status:503});
      const ready=state.devices.some(device=>device.online&&device.version==="2")&&state.aiReady;
      return json({agents:[{id:"codex",name:"Codex",vendor:"OpenAI",installed:ready,execution:"runner",install:{command:"npm install -g @openai/codex"},models:{choices:[{id:"",label:"Automatic"},{id:"fixture/model-a",label:"Model Alpha"},{id:"fixture/model-b",label:"Model Beta"}],source:"Browser fixture",checkedAt:1,refreshedAt:1,stale:false}},...(state.extraAgents??[]).map(agent=>({...agent,installed:ready&&agent.installed}))],canRun:ready,reason:ready?null:"Connect your computer, then install and sign in to an AI tool on it.",parallelChats:!!state.parallelChats});
    }
    // Runs are not executed in the fixture: the request is recorded, then refused.
    if(path === "/api/ai/run") {
      // state.runEvents scripts a live run: NDJSON events, {wait:ms} pauses; the stream then stays open (still working).
      if(state.runEvents){const events=state.runEvents,encoder=new TextEncoder();return new Response(new ReadableStream({async start(controller){for(const event of events){if(event.wait){await new Promise(resolve=>setTimeout(resolve,event.wait));continue;}controller.enqueue(encoder.encode(JSON.stringify(event)+"\n"));}}}),{headers:{"content-type":"application/x-ndjson"}});}
      return new Response(JSON.stringify({error:"Runs are not executed in the browser fixture."}),{status:503,headers:{"content-type":"application/json"}});
    }
    if(path === "/api/presence"){if(init.body)state.presenceRun=JSON.parse(init.body).runId??null;return json({intervalMs:20000,online:["alice"],viewers:state.presenceRun?(state.viewers??["alice"]):[]});}
    if(path === "/api/orgs/team/online")return json({people:state.orgOnline??[{userId:"alice",handle:"alice",displayName:"Alice",avatarUrl:null,isSelf:true}]});
    if(path === "/api/runner/devices") {
      if(state.deviceFailure)return new Response("Temporary upstream error",{status:502});
      return json({devices:state.devices,requiresComputer:true});
    }
    if(path === "/api/runner/pairing")return json({code:"RN-ABCD-EFGH",expiresAt:Date.now()+600000});
    state.unknown.push(path);return json({});
  };
}
