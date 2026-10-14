// Offline development loader: resolves pinned SDK package exports from the
// project dependencies without modifying the host's node_modules.
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const root = process.env.HYPIT_SDK_ROOT ?? '/home/ubuntu/.local/lib/node_modules/@hypit/hypit';
const sdk = JSON.parse(readFileSync(join(root, 'package.json')));
if (sdk.name !== '@hypit/hypit' || sdk.version !== '0.2.16') throw new Error('Offline checks require pinned Hypit 0.2.16');
const tsxPackage = createRequire(join(root, 'package.json')).resolve('tsx/package.json');
const { register: registerTsx } = await import(pathToFileURL(join(dirname(tsxPackage), 'dist/esm/api/index.mjs')).href);
registerTsx();
register(new URL('./sdk-resolve.js', import.meta.url), { data: { root } });
