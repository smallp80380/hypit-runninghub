import { validateAiAppRequest } from './request.js';
import { renderOperationAuthor } from '../generic/author-render.js';

export function renderAiAppAuthor(request, { id = 'app', files = [], outputs = [] } = {}) {
  return renderOperationAuthor(request, { id, files, outputs }, { validator: validateAiAppRequest, tag: 'AiApp' });
}
