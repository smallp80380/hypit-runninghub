// Offline development loader: resolves released SDK package exports without
// installing dependencies or modifying the host's node_modules.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.HYPIT_SDK_ROOT ?? '/home/ubuntu/.local/lib/node_modules/@hypit/hypit';
const sdk = JSON.parse(readFileSync(join(root, 'package.json')));
if (sdk.name !== '@hypit/hypit' || sdk.version !== '0.2.16') throw new Error('Offline checks require pinned Hypit 0.2.16');
const { register: registerTsx } = await import(pathToFileURL(join(root, 'node_modules/tsx/dist/esm/api/index.mjs')).href);
registerTsx();
register(new URL('./sdk-resolve.js', import.meta.url), { data: { root } });
