import { validateRequest, jsonValue, exact, identifier } from './request.js';
import { fail } from '../core/errors.js';
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function renderWorkflowAuthor(request, { id = 'workflow', files = [], outputs = [] } = {}) {
  validateRequest(request, { draft: true }); jsonValue({ id, files, outputs });
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id)) fail('INVALID_AUTHOR_ID');
  const keys = new Set(request.files.map(file => file.key));
  const names = new Set(['result']);
  for (const file of files) {
    exact(file, ['key', 'src', 'mediaType']); identifier(file.key); identifier(file.src); identifier(file.mediaType);
    if (keys.has(file.key)) fail('DUPLICATE_FILE_KEY'); keys.add(file.key);
  }
  for (const binding of request.bindings) if (!keys.has(binding.fileKey)) fail('FILE_BINDING_MISSING');
  for (const output of outputs) {
    exact(output, ['name', 'index']);
    if (typeof output.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(output.name) || names.has(output.name)
      || !Number.isSafeInteger(output.index) || output.index < 0) fail('INVALID_OUTPUT_INDEX');
    names.add(output.name);
  }
  return '<?svml using="@hypit/markup@1"?>\n<svml>\n  <import as="workflow" from="@local/provider-runninghub@1"/>\n'
    + `  <workflow:Workflow id="${xml(id)}">\n    <Request>${xml(JSON.stringify(request))}</Request>\n`
    + files.map(file => `    <File key="${xml(file.key)}" src="${xml(file.src)}" media-type="${xml(file.mediaType)}"/>\n`).join('')
    + outputs.map(output => `    <Output name="${xml(output.name)}" index="${output.index}"/>\n`).join('')
    + '  </workflow:Workflow>\n</svml>\n';
}
