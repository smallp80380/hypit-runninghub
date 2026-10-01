import { validateDescriptor } from '../native/descriptor.js';
import { validateRevision } from './revision.js';

export function rebuildDescriptor(descriptor, revision, graphFile, verifyTable) {
  const checked = validateRevision(revision);
  const candidate = { ...structuredClone(descriptor), graphFile, graphDigest: structuredClone(checked.graphDigest) };
  // A standalone editor can check structural mappings. Public SDK activation
  // still owns full Model port semantics; this candidate grants no authority.
  validateDescriptor(candidate, checked.graph, verifyTable ?? (() => {}));
  return { descriptor: candidate, reviewRequired: true, semanticValidation: 'UNVERIFIED' };
}
