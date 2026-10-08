import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {publicAsset} from '../app/lib/public-asset.ts';

test('CDN is optional and production prefix must be an HTTPS origin',()=>{
  const config=(prefix='',mode='production')=>execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',
    "import config from './next.config.ts'; console.log((config.default ?? config).assetPrefix || 'disabled');"],
  {encoding:'utf8',env:{...process.env,NODE_ENV:mode,NEXT_PUBLIC_ASSET_PREFIX:prefix},stdio:['ignore','pipe','pipe']}).trim();
  assert.equal(config(),'disabled');
  assert.equal(config('https://assets.example.com/'),'https://assets.example.com');
  assert.equal(config('https://assets.example.com','development'),'disabled');
  for(const prefix of ['http://assets.example.com','https://user:secret@example.com','https://example.com/private','https://example.com?secret=1','//example.com','https://example.com:8080'])assert.throws(()=>config(prefix));
});
test('only approved public screenshots receive a CDN prefix',()=>{
  const before={mode:process.env.NODE_ENV,prefix:process.env.NEXT_PUBLIC_ASSET_PREFIX};
  try {
    process.env.NODE_ENV='production';process.env.NEXT_PUBLIC_ASSET_PREFIX='https://assets.example.com/';
    assert.equal(publicAsset('/product/code-review.png'),'https://assets.example.com/product/code-review.png');
    assert.equal(publicAsset('/docs/images/workspace.webp'),'https://assets.example.com/docs/images/workspace.webp');
    for(const path of ['/api/files/private.png','/product/../api/file.png','https://other.example.com/a.png','/product/a.png?token=secret'])assert.equal(publicAsset(path),path);
    delete process.env.NEXT_PUBLIC_ASSET_PREFIX;
    assert.equal(publicAsset('/product/code-review.png'),'/product/code-review.png');
  } finally {
    for(const [name,value] of [['NODE_ENV',before.mode],['NEXT_PUBLIC_ASSET_PREFIX',before.prefix]])if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
});
