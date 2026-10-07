import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stat,readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {categories,guides} from '../app/docs/content.ts';
import {screenshots} from '../app/docs/screenshots.ts';

test('public guides have unique routes, working section references and registered screenshots',()=>{
  const bySlug=new Map(guides.map(guide=>[guide.slug,guide]));
  assert.equal(bySlug.size,guides.length);
  const imageKeys=new Set();
  for(const guide of guides){
    assert.ok(categories.includes(guide.category),guide.slug);
    assert.match(guide.slug,/^[a-z0-9-]+$/);
    assert.equal(new Set(guide.sections.map(section=>section.id)).size,guide.sections.length);
    for(const section of guide.sections){
      assert.ok(section.body.trim(),`${guide.slug}/${section.id}`);
      for(const match of section.body.matchAll(/\]\((\/docs\/[^)]+)\)/g)){
        const [path,anchor]=match[1].split('#');const target=bySlug.get(path.split('/').at(-1));
        assert.ok(target,`broken documentation link: ${match[1]}`);
        if(anchor)assert.ok(target.sections.some(item=>item.id===anchor),`broken section link: ${match[1]}`);
      }
      if(section.screenshot){assert.ok(screenshots[section.screenshot],section.screenshot);imageKeys.add(section.screenshot);}
    }
  }
  assert.deepEqual([...imageKeys].sort(),Object.keys(screenshots).sort(),'every published capture is used');
});

test('documentation images exist with correct dimensions and a bounded transfer size',async()=>{
  for(const image of Object.values(screenshots)){
    const path='public'+image.src,info=await sharp(path).metadata();
    assert.equal(info.width,image.width,path);assert.equal(info.height,image.height,path);
    assert.ok((await stat(path)).size<750_000,`oversized documentation screenshot: ${path}`);
    assert.ok(image.alt.length>20);
  }
  const total=await Promise.all(Object.values(screenshots).map(image=>stat('public'+image.src)));
  assert.ok(total.reduce((bytes,item)=>bytes+item.size,0)<8_000_000,'documentation image budget');
});

test('source instructions never contain an actual invitation or user credentials',async()=>{
  const content=await readFile('app/docs/content.ts','utf8');
  assert.doesNotMatch(content,/\/invite\/[A-Za-z0-9_-]{40,}|#invite=[A-Za-z0-9_-]{40,}/);
});
