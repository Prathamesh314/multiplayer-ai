/** Isolated sample API data shared by browser checks and documentation captures. */
export function installFixtures() {
  const members = [
    { userId: "alex", handle: "alex", displayName: "Alex Chen", avatarUrl: null, role: "owner" },
    { userId: "priya", handle: "priya", displayName: "Priya Shah", avatarUrl: null, role: "member" },
    { userId: "sam", handle: "sam", displayName: "Sam Rivera", avatarUrl: null, role: "member" },
    { userId: "jordan", handle: "jordan", displayName: "Jordan Lee", avatarUrl: null, role: "member" },
    { userId: "maya", handle: "maya", displayName: "Maya Patel", avatarUrl: null, role: "member" },
  ];
  const org = { id: "northstar", slug: "northstar", name: "Northstar Studio", image: "", myRole: "owner", createdAt: 0 };
  const channels = ["general", "product-design", "engineering", "shipping", "ideas-and-feedback"].map((name, index) => ({ id: name, name, kind: "channel", visibility: "public", unread: index === 2 ? 3 : 0, lastMessageAt: null, lastPreview: null, otherUserId: null }));
  const dms = members.slice(1, 4).map(member => ({ id: `dm-${member.userId}`, name: member.displayName, kind: "dm", visibility: "private", unread: 0, lastMessageAt: null, lastPreview: null, otherUserId: member.userId }));
  const message = (id, userId, body, at) => {
    const user = members.find(member => member.userId === userId);
    return { id, userId, userName: user.displayName, handle: user.handle, body, createdAt: new Date(at).getTime() };
  };
  const messages = [
    message("m1", "priya", "The new checkout flow is ready for a look. I’ve kept the empty-cart state simple and added a clearer order summary.", "2026-09-28T10:30:00"),
    message("m2", "priya", "You can find the changes in my project room whenever you have a minute.", "2026-09-28T10:31:00"),
    message("m3", "sam", "Just went through it. The spacing feels much better — especially on the smaller screen.", "2026-09-28T10:38:00"),
    message("m4", "alex", "Let’s use this channel to keep the design and engineering decisions together. Small updates are welcome, too.", "2026-09-29T09:10:00"),
    message("m5", "jordan", "One thought: can we keep the quantity validation close to the input? It will make the error easier to fix.", "2026-09-29T09:16:00"),
    message("m6", "priya", "@alex the validation changes are in. I’ve also left the full context in the AI chat so you can pick up the review.", "2026-09-29T09:22:00"),
    message("m7", "maya", "Nice. I’ll check the keyboard flow and focus states this afternoon.", "2026-09-29T09:25:00"),
    message("m8", "alex", "Sounds good. Let’s review the changes together before we publish. Thanks, everyone!", "2026-09-29T09:28:00"),
  ];
  const orgMembers = members.map(member => ({...member,status:'active'}));
  const projectMembers = members.slice(0,2).map(member => ({...member,role:'manager'}));
  window.__chatFixture = { failNext: false, sent: [], unknown: [], messages, streams: [], sendDelay: 0, memberWrites: [] };
  const integration = {id:'slack-connection',provider:'slack',name:'Northstar Slack',channels:[{id:'engineering',name:'engineering',url:'https://app.slack.com/client/T1/C1',verifiedAt:new Date().toISOString(),syncedAt:new Date().toISOString(),messageCount:15,error:null}]};
  let connected=true;
  // AI tools: one a teammate added that Alex has not allowed yet.
  const tools={project:[{id:'00000000-0000-4000-8000-000000000001',scope:'project',kind:'mcp',name:'context7',spec:{transport:'stdio',command:'npx',args:['-y','@upstash/context7-mcp@latest'],env:[]},enabled:true,approved:false,secrets:[],createdBy:'Priya',updatedAt:0}],personal:[]};
  window.__chatFixture.toolWrites=[];
  class FixtureEventSource extends EventTarget {
    constructor(url) {
      super(); this.url = url;
      window.__chatFixture.streams.push(this);
      setTimeout(() => { this.onopen?.(new Event("open")); this.dispatchEvent(new MessageEvent("ready", {data: "{}"})); }, 30);
    }
    close() { window.__chatFixture.streams = window.__chatFixture.streams.filter(item => item !== this); }
  }
  window.EventSource = FixtureEventSource;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
    const path = url.pathname;
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: {"content-type":"application/json"} }));
    if (path === "/api/orgs") return json({ orgs: [org, {...org, id:"labs", slug:"labs", name:"Side Projects", myRole:"member"}] });
    if (path === "/api/auth/me") return json({user:{id:"alex",handle:"alex",displayName:"Alex Chen",email:"alex@example.test",avatarUrl:null},connectCode:null});
    if (path === "/api/runner/devices") return json({devices:[],requiresComputer:true});
    // Presence: this tab's heartbeat, and who in the org has the app open.
    if (path === "/api/presence") return json({intervalMs:20000,online:[],viewers:[]});
    if (/^\/api\/orgs\/[^/]+\/online$/.test(path)) return json({people:orgMembers.slice(0,3).map((member,index)=>({userId:member.userId,handle:member.handle,displayName:member.displayName,avatarUrl:null,isSelf:index===0}))});
    if (path === "/api/invitations/accept") return json({error:"This invitation has expired. Ask your administrator for a new invitation."},410);
    if (path === "/api/sessions/locked-room") return json({error:"This room is private. Enter your access code to join."},403);
    if (path === "/api/orgs/northstar/settings") { Object.assign(org, JSON.parse(init.body)); return json(org); }
    if (path === "/api/invitations") return json({invitations:[]});
    if ((init.method ?? "GET") === "GET" && ["/api/collaboration/inbox", "/api/collaboration/access-requests"].includes(path)) return json({items:[],hasMore:false});
    // Established teams: everything done, so the getting-started guide never shows.
    if (path.endsWith("/onboarding")) return json({projects:2,codeAdded:true,members:3,pendingInvites:0,projectTeammate:true,myTasks:4,taskPeople:3});
    if (path.endsWith("/usage")) return json({concurrency:{used:0,limit:3},monthly:{used:0,limit:null}});
    if (path.endsWith("/projects")) return json({projects:[{id:"checkout",orgId:org.id,slug:"checkout",name:"Northstar Checkout",source:"local",githubRepo:null,defaultBranch:"main",upstreamUrl:null,myRole:"manager",createdAt:0,archivedAt:null}]});
    if (path.endsWith("/rooms")) return json({sessions:[{id:"alex-room",name:"Checkout · Alex",ownerId:"alex",visibility:"public"},{id:"priya-room",name:"Checkout · Priya",ownerId:"priya",visibility:"public"}]});
    if (path === '/api/orgs/northstar/members') return json({members:orgMembers});
    if (path === '/api/orgs/northstar/projects/checkout/members') {
      if (init.method === 'POST') {
        const body=JSON.parse(init.body);window.__chatFixture.memberWrites.push({path,...body});
        projectMembers.push({...orgMembers.find(member=>member.userId===body.userId),role:body.role});
        return json({ok:true});
      }
      return json({members:projectMembers});
    }
    if (init.method === 'PATCH' && /^\/api\/orgs\/northstar\/(projects\/checkout\/)?members\/[^/]+$/.test(path)) {
      if(window.__chatFixture.failNext){window.__chatFixture.failNext=false;return json({error:'Could not change that role. Try again.'},503);}
      const body=JSON.parse(init.body);window.__chatFixture.memberWrites.push({path,...body});
      const roster=path.includes('/projects/')?projectMembers:orgMembers;
      Object.assign(roster.find(member=>member.userId===path.split('/').at(-1)),body);
      return json({ok:true});
    }
    if (path === "/api/tasks") return json({tasks:[],members:[],hasMore:false});
    const toolScope = path === '/api/orgs/northstar/projects/checkout/agent-tools' || path.startsWith('/api/orgs/northstar/projects/checkout/agent-tools/') ? 'project' : path === '/api/me/agent-tools' || path.startsWith('/api/me/agent-tools/') ? 'personal' : null;
    if (toolScope) {
      const list=tools[toolScope], method=init.method ?? 'GET', [, toolId, approval]=path.split('/agent-tools')[1].split('/');
      const body=init.body?JSON.parse(init.body):null;
      if (body||method!=='GET') window.__chatFixture.toolWrites.push({scope:toolScope,method,toolId:toolId??null,approval:!!approval,body});
      if (method==='GET' && !toolId) return json({tools:list,canManage:true,secretNames:[],computersReady:true});
      if (method==='POST' && !toolId) {
        if(list.some(tool=>tool.name===body.name))return json({error:`A tool named ${body.name} already exists here.`},400);
        const text=JSON.stringify(body.spec), secrets=[...new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map(match=>match[1]))].sort();
        list.push({id:`tool-${list.length+2}`,scope:toolScope,kind:body.kind,name:body.name,spec:body.spec,enabled:true,approved:true,secrets,createdBy:'Alex Chen',updatedAt:Date.now()});
        return json({id:list.at(-1).id},201);
      }
      const tool=list.find(item=>item.id===toolId);
      if(!tool)return json({error:'Tool not found.'},404);
      if(approval){tool.approved=method==='POST';return json({approved:tool.approved});}
      if(method==='PATCH'){Object.assign(tool,body);return json({updated:true});}
      if(method==='DELETE'){list.splice(list.indexOf(tool),1);return json({deleted:true});}
    }
    // Handoffs on the dashboard: one waiting for Alex, one Alex sent.
    if (path === '/api/handoffs') {
      window.__chatFixture.handoffs??={received:[{id:'h-received',runId:'run-polish',sessionId:'priya-room',title:'Checkout polish',roomName:'Checkout · Priya',projectName:'Northstar Checkout',orgSlug:'northstar',person:'Priya Shah',note:'Copy is done; please wire the analytics.',expiresAt:new Date(Date.now()+42*60000).toISOString(),createdAt:new Date().toISOString(),version:3,direct:true,busy:false}],
        sent:[{id:'h-sent',runId:'run-cart',sessionId:'alex-room',title:'Cart totals',roomName:'Checkout · Alex',projectName:'Northstar Checkout',orgSlug:'northstar',person:null,note:'',expiresAt:new Date(Date.now()+20*60000).toISOString(),createdAt:new Date().toISOString(),version:1,direct:false,busy:false}]};
      return json(window.__chatFixture.handoffs);
    }
    if (/^\/api\/sessions\/[^/]+\/runs\/[^/]+\/handoff$/.test(path) && init.method==='POST') {
      const body=JSON.parse(init.body);(window.__chatFixture.handoffActions??=[]).push(body);
      const inbox=window.__chatFixture.handoffs;inbox.received=inbox.received.filter(item=>item.id!==body.handoffId);inbox.sent=inbox.sent.filter(item=>item.id!==body.handoffId);
      return json({ok:true});
    }
    if (path.endsWith('/integrations')) return json({canManage:true,providers:[{id:'slack',configured:true},{id:'discord',configured:false}],connections:connected?[integration]:[]});
    if (path.endsWith('/integrations/slack')) {
      if(init.method==='DELETE'){connected=false;return json({ok:true});}
      if(init.method==='PUT'){
        if(window.__chatFixture.failNext){window.__chatFixture.failNext=false;return json({error:'Could not save channels. Try again.'},503);}
        const {channelIds,shareWithProject}=JSON.parse(init.body);
        if(!shareWithProject)return json({error:'Sharing confirmation is required.'},400);
        integration.channels=channelIds.map(id=>({id,name:id,url:'https://app.slack.com/client/T1/'+id,verifiedAt:null,syncedAt:null,messageCount:0,error:null}));return json({ok:true});
      }
      return json({channels:['engineering','product-design'].map(id=>({id,name:id,url:'https://app.slack.com/client/T1/'+id}))});
    }
    if (path === "/api/chat/conversations") return json({conversations:[...channels,...dms]});
    if (path.endsWith("/read")) return json({ok:true});
    if (path.endsWith("/messages")) {
      const conversationId = path.split("/")[4];
      if (init.method === "POST") {
        if (window.__chatFixture.failNext) {window.__chatFixture.failNext = false; return json({error:"Could not send. Try again."},503);}
        if (window.__chatFixture.sendDelay) await new Promise(resolve=>setTimeout(resolve,window.__chatFixture.sendDelay));
        const body = JSON.parse(init.body).body;
        const saved = message(`sent-${window.__chatFixture.sent.length}`,"alex",body,new Date().toISOString());
        window.__chatFixture.sent.push(saved);messages.push(saved);
        for (const stream of window.__chatFixture.streams) stream.dispatchEvent(new MessageEvent("chat.message", {data:JSON.stringify({type:"chat.message",conversationId,message:saved})}));
        return json(saved,201);
      }
      if (url.searchParams.has("before")) return json({messages:[message("earlier","sam","Earlier context: keep the first release focused on the checkout experience.","2026-09-27T09:00:00")],hasMore:false});
      return json({messages:conversationId.startsWith("dm-") ? [] : messages,hasMore:!conversationId.startsWith("dm-")});
    }
    if (path.startsWith("/api/chat/conversations/")) {
      const item=[...channels,...dms].find(item=>item.id===path.split("/")[4]);
      return json({conversation:{...item,orgId:org.id,topic:item.kind==="channel" ? "A shared space for thoughtful product decisions." : null,members:item.kind==="dm" ? members.filter(member=>member.userId==="alex" || member.userId===item.otherUserId) : members,myRole:"owner"}});
    }
    window.__chatFixture.unknown.push(path);
    return json({error:`Unmocked fixture: ${path}`},404);
  };
}
