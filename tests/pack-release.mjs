// Source-driven release staging keeps tests/private state/upstream README out.
// Supply an explicit output directory; never overwrite an existing archive.
import { readFile, cp, mkdtemp, mkdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const source = fileURLToPath(new URL('..', import.meta.url)), output = resolve(process.argv[2] ?? 'artifacts');
const metadata = JSON.parse(await readFile(join(source, 'package.json')));
const lock = JSON.parse(await readFile(join(source, 'package-lock.json')));
const tag = `v${metadata.version}`, archiveName = `local-provider-runninghub-${metadata.version}.tgz`;
const releaseBase = 'https://github.com/smallp80380/hypit-runninghub';
const releaseUrl = `${releaseBase}/releases/tag/${tag}`, downloadUrl = `${releaseBase}/releases/download/${tag}/${archiveName}`;
const readme = await readFile(join(source, 'README.md'), 'utf8');
const publishing = await readFile(join(source, 'PUBLISHING.md'), 'utf8');
const reuse = await readFile(join(source, 'docs/REUSE_RU.md'), 'utf8');
const section = (text, heading) => {
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) return '';
  const bodyStart = start + heading.length + 1;
  const nextHeading = text.indexOf('\n## ', bodyStart);
  return text.slice(bodyStart, nextHeading < 0 ? text.length : nextHeading);
};
const currentInstall = text => {
  const archiveRefs = [...text.matchAll(/(?:^|[\s"'`/])(local-provider-runninghub-\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?\.tgz(?:\.sha256)?)(?=$|[\s"'`/])/gm)].map(match => match[1]);
  const downloadRefs = text.match(/https:\/\/github\.com\/smallp80380\/hypit-runninghub\/releases\/download\/v[^/\s)`]+\/local-provider-runninghub-[^/\s)`]+/g) ?? [];
  const installTargets = [...text.matchAll(/\bnpm\s+install\b[^\n]*/g)].flatMap(([line]) =>
    [...line.matchAll(/(?:^|\s)(?:\.\/)?(local-provider-runninghub-[^\s"'`]+\.tgz)(?=$|\s)/g)].map(match => match[1]));
  return archiveRefs.includes(archiveName)
    && archiveRefs.includes(`${archiveName}.sha256`)
    && archiveRefs.every(name => name === archiveName || name === `${archiveName}.sha256`)
    && downloadRefs.includes(downloadUrl)
    && downloadRefs.includes(`${downloadUrl}.sha256`)
    && downloadRefs.every(url => url === downloadUrl || url === `${downloadUrl}.sha256`)
    && installTargets.length > 0
    && installTargets.every(name => name === archiveName);
};
const readmeInstall = section(readme, '## Установка');
const reuseInstall = section(reuse, '## 1. Установить и импортировать');
const readmeReleaseLine = readme.split('\n').find(line => line.startsWith('GitHub release:'));
const publishingCurrentLine = publishing.split('\n').find(line => line.startsWith('The current source release is '));
if (lock.version !== metadata.version || lock.packages?.['']?.version !== metadata.version
  || !readme.startsWith(`# Hypit RunningHub Provider ${tag}\n`)
  || !readmeReleaseLine?.includes(`[${tag}](${releaseUrl})`) || !currentInstall(readmeInstall)
  || !publishingCurrentLine?.includes(`is ${tag}.`) || !publishingCurrentLine.includes(`GitHub Release ${tag}`)
  || !publishingCurrentLine.includes(releaseUrl)
  || !reuse.includes(`Provider ${tag}`) || !currentInstall(reuseInstall)) {
  throw new Error(`Release version ${tag} is inconsistent across package/lock metadata and current release/install documentation.`);
}
const target = join(output, archiveName);
try { await lstat(target); throw Error('Archive already exists; sealed artifacts are never overwritten.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const stage = await mkdtemp(join(tmpdir(), 'rh-release-stage-'));
for (const path of ['package.json', ...metadata.files.filter(path => !path.startsWith('!'))]) {
  const destination = join(stage, path); await mkdir(dirname(destination), { recursive: true });
  await cp(join(source, path), destination, { recursive: true });
}
await mkdir(output, { recursive: true });
execFileSync('npm', ['pack', '--cache', join(stage, 'npm-cache'), '--ignore-scripts', '--json', '--pack-destination', output], { cwd: stage, stdio: 'inherit' });
