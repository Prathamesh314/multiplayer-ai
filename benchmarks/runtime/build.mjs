import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const output = resolve('.test-build/runtime');
await mkdir(output, { recursive: true });
for (const entry of ['server', 'worker']) {
  await build({ entryPoints: [`benchmarks/runtime/typescript/${entry}.ts`],
    outfile: `${output}/${entry}.cjs`, platform: 'node', format: 'cjs',
    target: 'node24', bundle: true, packages: 'external', sourcemap: true });
}
execFileSync('go', ['build', '-o', `${output}/go-server`, '.'], {
  cwd: 'benchmarks/runtime/go', stdio: 'inherit',
});
console.log('Built both isolated runtime prototypes.');
