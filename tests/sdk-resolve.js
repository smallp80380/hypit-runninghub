import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
let root;
export function initialize(data) { root = data.root; }
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@hypit/')) {
    const parts = specifier.split('/'), name = parts[1];
    const directory = name === 'hypit' ? root : join(root, 'packages', name);
    const metadata = JSON.parse(readFileSync(join(directory, 'package.json')));
    const key = parts.length > 2 ? './' + parts.slice(2).join('/') : '.';
    const exported = metadata.exports?.[key];
    const target = typeof exported === 'string' ? exported : exported?.import;
    if (!target) throw new Error(`SDK export unavailable: ${specifier}`);
    return nextResolve(pathToFileURL(join(directory, target)).href, context);
  }
  return nextResolve(specifier, context);
}
