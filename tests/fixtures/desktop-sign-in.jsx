import {createRoot} from 'react-dom/client';
import {DesktopSignIn} from '../../app/components/auth/DesktopSignIn';

// Exercise the real component in Electron with a deterministic Clerk transport.
const calls=window.signInCalls={tickets:0,activations:0};
const session={id:'sess_desktop_fixture',status:'active',user:{id:'user_desktop_fixture'}};
window.clerkFixture={loaded:true,client:{sessions:[],async reload(){return this;},signIn:{async create({strategy,ticket}){
  if(strategy!=='ticket'||ticket!=='desktop-fixture-ticket')throw Error('Wrong ticket request');
  calls.tickets++;
  window.clerkFixture.client.sessions=[session];
  return {status:'complete',createdSessionId:session.id};
}}},async setActive({session:id,navigate}){
  if(id!==session.id)throw Error('Wrong session');
  calls.activations++;
  if(calls.activations===1)throw Error('Temporary activation failure');
  sessionStorage.setItem('desktop-sign-in-calls',JSON.stringify(calls));
  await navigate({session,decorateUrl:url=>url});
}};
window.open=url=>{window.approvalUrl=url;return null;};
createRoot(document.getElementById('root')).render(<DesktopSignIn complete="/auth/complete?next=%2Fworkspace" flow="next=%2Fworkspace"/>);
