import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {guides} from '../app/docs/content.ts';
import {docsBrowser,eventually,delay} from './helpers/docs-browser.mjs';

const b=await docsBrowser();const {base,navigate,evaluate,click,type,send,viewport}=b;
try{
  for(const guide of guides){
    const response=await fetch(`${base}/docs/${guide.slug}`),html=await response.text();
    assert.equal(response.status,200,guide.slug);
    assert.ok(html.includes(guide.title.replaceAll('&','&amp;')),guide.title);
    for(const section of guide.sections)assert.ok(html.includes(`id="${section.id}"`),`${guide.slug}#${section.id}`);
  }
  assert.equal((await fetch(base+'/docs/does-not-exist')).status,404);
  await navigate('/','!!document.querySelector("#docs")');
  assert.ok(await evaluate('!!document.querySelector(\'nav[aria-label="Main navigation"] a[href="/docs"]\')'));
  await click('nav[aria-label="Main navigation"] a[href="/docs"]');
  await eventually(()=>evaluate('location.pathname==="/docs"&&!!document.querySelector("#docs-search")'),'homepage documentation link');
  await type('#docs-search','pairing code');
  await eventually(()=>evaluate('!!document.querySelector(\'nav[aria-label="Documentation search results"] a[href^="/docs/connect-computer"]\')'),'full-text section search');
  await click('nav[aria-label="Documentation search results"] a[href^="/docs/connect-computer"]');
  await eventually(()=>evaluate('location.pathname==="/docs/connect-computer"&&location.hash==="#terminal-connection"'),'search opens matching section');
  await eventually(()=>evaluate('(()=>{const y=document.querySelector("#terminal-connection").getBoundingClientRect().top;return y>=76&&y<innerHeight;})()'),'matching section scrolls into view below the header');
  await type('#docs-search','no-such-feature-987654');
  await eventually(()=>evaluate('document.querySelector("[role=status]")?.textContent.includes("0 guides")'),'empty search');
  await click('button[aria-label="Clear search"]');
  await navigate('/docs/prerequisites','document.querySelector("h1")?.textContent==="Prerequisites"');
  await evaluate('document.querySelector(\'button[aria-label="Enlarge screenshot: Connect your AI"]\').focus()');
  await click('button[aria-label="Enlarge screenshot: Connect your AI"]');
  assert.equal(await evaluate('document.querySelector("dialog")?.open'),true);
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await eventually(()=>evaluate('!document.querySelector("dialog")?.open'),'screenshot Escape dismissal');
  assert.equal(await evaluate('document.activeElement?.getAttribute("aria-label")'),'Enlarge screenshot: Connect your AI');

  for(const width of [1440,800,390]){
    await viewport(width,960);
    await navigate('/docs/prerequisites','document.querySelector("h1")?.textContent==="Prerequisites"');
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),`page overflow at ${width}`);
    assert.ok(await evaluate('document.querySelector("[data-docs-scroll]").scrollWidth<=innerWidth'),`docs overflow at ${width}`);
    assert.equal(await evaluate('document.querySelectorAll("#docs-content h1").length'),1);
    if(width===390){
      assert.equal(await evaluate('document.querySelector("details").open'),false,'mobile navigation starts collapsed');
      await click('details > summary');
      await click('nav[aria-label="Documentation"] a[href="/docs/sharing"]');
      await eventually(()=>evaluate('location.pathname==="/docs/sharing"'),'mobile guide navigation');
      assert.equal(await evaluate('document.querySelector("details").open'),false,'mobile navigation closes after selection');
    }
    await evaluate('document.querySelector("[data-docs-scroll]").scrollTop=0');await delay(100);
    await writeFile(join(tmpdir(),`multiplayer-docs-${width}.png`),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  await viewport(1440);
  await navigate('/docs','document.querySelector("h1")?.textContent.includes("From your first prompt")');
  await writeFile(join(tmpdir(),'multiplayer-docs-home.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
  assert.deepEqual(b.errors,[],'no browser exceptions');
  console.log(`PASS: ${guides.length} public guides, section links, 404, homepage entry, full-text search, screenshot dialog, and desktop/mobile navigation.`);
}finally{await b.close();}
