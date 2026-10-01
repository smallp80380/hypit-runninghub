// Source-driven release staging keeps tests/private state/upstream README out.
// Supply an explicit output directory; never overwrite an existing archive.
import { readFile, cp, mkdtemp, mkdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const source = fileURLToPath(new URL('..', import.meta.url)), output = resolve(process.argv[2] ?? 'artifacts');
const metadata = JSON.parse(await readFile(join(source, 'package.json')));
const target = join(output, `local-provider-runninghub-${metadata.version}.tgz`);
try { await lstat(target); throw Error('Archive already exists; sealed artifacts are never overwritten.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const stage = await mkdtemp(join(tmpdir(), 'rh-release-stage-'));
for (const path of ['package.json', ...metadata.files.filter(path => !path.startsWith('!'))]) {
  const destination = join(stage, path); await mkdir(dirname(destination), { recursive: true });
  await cp(join(source, path), destination, { recursive: true });
}
await mkdir(output, { recursive: true });
execFileSync('npm', ['pack', '--cache', join(stage, 'npm-cache'), '--ignore-scripts', '--json', '--pack-destination', output], { cwd: stage, stdio: 'inherit' });
