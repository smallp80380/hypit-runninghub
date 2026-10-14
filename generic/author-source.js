import { validateRequest } from './request.js';
import { renderOperationAuthor } from './author-render.js';

export function renderWorkflowAuthor(request, { id = 'workflow', files = [], outputs = [] } = {}) {
  return renderOperationAuthor(request, { id, files, outputs }, { validator: validateRequest, tag: 'Workflow' });
}
