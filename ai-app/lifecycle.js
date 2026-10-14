import { fail } from '../core/errors.js';
import { serviceBase } from '../core/config.js';
import { mapRequest } from '../generic/request.js';
import { createNativeOperationLifecycle } from '../generic/operation-lifecycle.js';
import { fetchAiApp, validateAiAppDocument } from './document.js';
import { validateAiAppRequest, validateAiAppTargets } from './request.js';

export function createAiAppLifecycle({ config, dataRoot, instance, fetch, clock, authority }) {
  const protocol = {
    validateRequest: validateAiAppRequest,
    fetchSource(request, key) {
      return fetchAiApp({ format: 'hypit-runninghub.ai-app-fetch@1', baseUrl: config.baseUrl, webappId: request.webappId,
        apiKey: config.apiKey, requestTimeoutMs: config.http.requestTimeoutMs, maxResponseBytes: config.http.maxResponseBytes },
      { resolveCredential: () => key, fetch, clock });
    },
    validateSource(source, options) {
      const document = validateAiAppDocument(source, options);
      if (document.baseUrl !== serviceBase(config.baseUrl, 'native-workflow')) fail('MEMBER_BINDING_ORIGIN_MISMATCH');
      return document;
    },
    validateTargets: validateAiAppTargets,
    digestSource: source => source.appDigest,
    sourceField: 'app',
    sourceDigestField: 'appDigest',
    preparationFormat: 'ai-app-preparation@1',
    handleContract: 'hypit.runninghub.ai-app@1',
    submitPath: '/task/openapi/ai-app/run',
    wire(request, source, filenames) {
      const body = { webappId: request.webappId, nodeInfoList: mapRequest(request, filenames) };
      if (request.instanceType !== undefined) body.instanceType = request.instanceType;
      return body;
    },
    reviewArgs(request, source, files, key, password) {
      return { config, request, appDigest: source.appDigest, fileDigests: files.map(file => ({ key: file.key, sha256: file.sha256 })), secret: key, password, fetch, clock };
    },
    revisionMismatchCode: 'AI_APP_REVISION_MISMATCH',
  };
  return createNativeOperationLifecycle({ config, dataRoot, instance, fetch, clock, authority, protocol });
}
