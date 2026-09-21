import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {S3Client} from '@aws-sdk/client-s3';
import {s3ObjectStore} from '../app/lib/git-storage/objects.ts';

// Exercise the real SDK's serialization, signing and multipart uploader with a
// deterministic HTTP transport. No AWS account or network request is involved.
const stored=new Map(),uploads=new Map();
let multipart=0,aborted=0,failPart=false;
const bodyBytes=async body=>{
  if(typeof body==='string'||body instanceof Uint8Array) return Buffer.from(body);
  const chunks=[];for await(const chunk of body??[]) chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);
};
const response=(status,body='',headers={})=>({response:{statusCode:status,headers,body:Readable.from([body])}});
const client=new S3Client({region:'us-east-1',endpoint:'https://storage.example.test',forcePathStyle:true,
  credentials:{accessKeyId:'test-key',secretAccessKey:'test-secret'},maxAttempts:1,
  requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
  requestHandler:{async handle(request){
    assert.ok(request.headers.authorization?.startsWith('AWS4-HMAC-SHA256'));
    assert.ok(request.path.startsWith('/test-bucket/git/'));
    const q=request.query??{},key=request.path;
    if(request.method==='POST'&&'uploads' in q){const id=String(++multipart);uploads.set(id,new Map());return response(200,`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);}
    if(request.method==='PUT'&&q.uploadId){
      if(failPart) return response(500,'<Error><Code>InternalError</Code></Error>');
      uploads.get(q.uploadId).set(Number(q.partNumber),await bodyBytes(request.body));return response(200,'',{etag:'"part"'});
    }
    if(request.method==='POST'&&q.uploadId){stored.set(key,Buffer.concat([...uploads.get(q.uploadId)].sort((a,b)=>a[0]-b[0]).map(([,part])=>part)));uploads.delete(q.uploadId);return response(200,'<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>');}
    if(request.method==='DELETE'&&q.uploadId){uploads.delete(q.uploadId);aborted++;return response(204);}
    if(request.method==='PUT'){stored.set(key,await bodyBytes(request.body));return response(200,'',{etag:'"stored"'});}
    if(request.method==='GET'){const body=stored.get(key);return body?response(200,body,{'content-length':String(body.length)}):response(404,'<Error><Code>NoSuchKey</Code></Error>');}
    throw new Error(`Unexpected S3 operation ${request.method}`);
  }},
});
const root=await mkdtemp(join(tmpdir(),'s3-storage-test-'));
const store=await s3ObjectStore({bucket:'test-bucket',prefix:'git',region:'us-east-1'},client);
try {
  const small=join(root,'small');await writeFile(small,'git bundle bytes');
  await store.putFile('bundles/small.bundle',small);await store.getFile('bundles/small.bundle',join(root,'small-out'));
  assert.equal(await readFile(join(root,'small-out'),'utf8'),'git bundle bytes');
  console.log('  ok signed S3 PUT/GET round-trip preserves bundle bytes');
  const large=join(root,'large');const bytes=Buffer.alloc(10*1024*1024,42);await writeFile(large,bytes);
  await store.putFile('bundles/large.bundle',large);await store.getFile('bundles/large.bundle',join(root,'large-out'));
  assert.deepEqual(await readFile(join(root,'large-out')),bytes);assert.equal(multipart,1);
  console.log('  ok large bundles use multipart upload and restore without buffering the full upload');
  failPart=true;await assert.rejects(store.putFile('bundles/failed.bundle',large));
  assert.equal(aborted,1);assert.equal(stored.has('/test-bucket/git/bundles/failed.bundle'),false);
  console.log('  ok failed multipart upload is aborted and cannot acknowledge a stored bundle');
  await assert.rejects(store.getFile('bundles/missing.bundle',join(root,'missing')));
  console.log('  ok missing cloud objects propagate an error');
} finally {client.destroy();await rm(root,{recursive:true,force:true});}
console.log('4 S3 transport tests passed');
