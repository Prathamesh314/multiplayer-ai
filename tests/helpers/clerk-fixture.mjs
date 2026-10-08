/** Local Clerk backend + real RS256 session JWTs. No application auth bypass. */
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {SignJWT} from 'jose';
export async function clerkFixture({origin:authOrigin=process.env.AUTH_PUBLIC_URL || "http://localhost:3000"}={}) {
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const profiles=new Map(),sessions=new Map();
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    const path=new URL(req.url,'http://fixture').pathname;
    const user=/^\/v1\/users\/([^/]+)$/.exec(path);
    const session=/^\/v1\/sessions\/([^/]+)(\/revoke)?$/.exec(path);
    let result;
    if(user)result=profiles.get(user[1]);
    if(session){result=sessions.get(session[1]);if(result&&session[2])result.status='revoked';}
    if(path==='/v1/sign_in_tokens'&&req.method==='POST')result={object:'sign_in_token',id:'sit_fixture',user_id:'user_fixture',token:'one-use-fixture-ticket',status:'pending',created_at:Date.now(),updated_at:Date.now()};
    if(!result){res.statusCode=404;result={errors:[{code:'not_found',message:'Not found'}]};}
    res.end(JSON.stringify(result));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const env={AUTH_PUBLIC_URL:authOrigin,NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:'pk_test_'+Buffer.from('fixture.clerk.accounts.dev$').toString('base64'),CLERK_SECRET_KEY:'sk_test_fixture',
    CLERK_JWT_KEY:publicKey.export({type:'spki',format:'pem'}),CLERK_API_URL:`http://127.0.0.1:${server.address().port}`,
    CLERK_TELEMETRY_DISABLED:'1',CLERK_WEBHOOK_SIGNING_SECRET:'whsec_'+Buffer.from('test-only-webhook-secret').toString('base64')};
  function profile(id,email,overrides={}) {const value={id,object:'user',primary_email_address_id:'email_'+id,email_addresses:[{id:'email_'+id,email_address:email,verification:{status:'verified'},linked_to:[]}],
    first_name:'Fixture',last_name:'User',has_image:false,image_url:'',banned:false,locked:false,updated_at:Date.now(),created_at:Date.now(),...overrides};profiles.set(id,value);return value;}
  async function token(id,{sessionId='sess_'+randomUUID(),origin=authOrigin,expiresIn=3600,...claims}={}) {
    sessions.set(sessionId,{object:'session',id:sessionId,user_id:id,status:'active',expire_at:Date.now()+expiresIn*1000});
    return new SignJWT({sid:sessionId,v:2,sts:'active',...(origin?{azp:origin}:{}),...claims}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setSubject(id)
      .setIssuer('https://fixture.clerk.accounts.dev').setIssuedAt().setNotBefore(Math.floor(Date.now()/1000)-1).setExpirationTime(Math.floor(Date.now()/1000)+expiresIn).sign(privateKey);
  }
  async function link(db,userId,options) {
    const id='user_'+userId;
    const result=await db.query('UPDATE users SET clerk_user_id=$2,email_verified_at=now() WHERE id=$1 RETURNING email',[userId,id]);
    profile(id,result.rows[0].email);return token(id,options);
  }
  return {env,profile,token,link,profiles,sessions,close:()=>new Promise(resolve=>server.close(resolve))};
}

export const clerkCookie=token=>`__session=${token}; __client_uat=1; __clerk_db_jwt=fixture`;
