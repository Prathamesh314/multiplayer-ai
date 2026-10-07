import {withStorageAdmission} from '../../app/lib/storage/admission.ts';
import {objectGit} from '../../app/lib/git/objects.ts';
import {barePath} from '../../app/lib/session/paths.ts';
const [ref,mode]=process.argv.slice(2);
await withStorageAdmission(ref,async()=>{
  if(mode==='git')await objectGit(barePath(ref),['-c', 'alias.hold=!python3 -c "import pathlib,time; pathlib.Path(\'git-started\').touch(); time.sleep(3); pathlib.Path(\'git-finished\').write_text(\'durable\')"','hold']);
  else {process.send?.('locked');await new Promise(resolve=>process.once('message',resolve));}
},1024*1024);
process.disconnect?.();
