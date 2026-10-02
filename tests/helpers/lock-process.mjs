import { createFileLock } from '../../app/lib/session/lock.ts';
import { objectGit } from '../../app/lib/git/objects.ts';
const [directory, mode] = process.argv.slice(2);
const lock = createFileLock({directory, acquireTimeoutMs: 3000});
await lock.withLock('repository', async () => {
  if (mode === 'git') {
    await objectGit(directory, ['-c', 'alias.hold=!python3 -c "import pathlib,time; pathlib.Path(\'git-started\').touch(); time.sleep(2); pathlib.Path(\'git-finished\').touch()"', 'hold']);
  } else {
    process.send?.('locked');
    await new Promise(resolve => process.once('message', resolve));
  }
});
process.disconnect?.();
