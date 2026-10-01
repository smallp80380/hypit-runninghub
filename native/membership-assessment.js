import { digest } from './descriptor.js';

export const MEMBERSHIP_SOURCE = 'https://www.runninghub.ai/enterprise-api/consumerApi';
// Candidate evidence assessment, NOT an entitlement verifier or execution gate.
// No caller-controlled field can turn this result into execution authorization.
export function assessMembershipCandidate({ evidence, config, descriptor, observation, now }) {
  const reasons = [];
  if (config.family !== 'native-workflow') reasons.push('NATIVE_FAMILY_REQUIRED');
  if (config.keyType !== 'Consumer-Member') reasons.push('MEMBERSHIP_DECLARATION_REQUIRED');
  if (evidence?.source?.url !== MEMBERSHIP_SOURCE
    || evidence.source.statement !== 'Membership API KEY consumes RH coins') reasons.push('OFFICIAL_SOURCE_REQUIRED');
  if (evidence?.credentialIdentification?.kind !== 'user-identified-membership-key'
    || digest(evidence?.credentialIdentification?.reference ?? null) !== digest(config.apiKey)) reasons.push('CREDENTIAL_REFERENCE_MISMATCH');
  if (observation?.actualAccountApiType === 'SHARED') reasons.push('KNOWN_SHARED_DENIAL');
  else if (observation?.actualAccountApiType !== 'NORMAL') reasons.push('ACCOUNT_OBSERVATION_UNKNOWN');
  if (!Number.isFinite(observation?.observedAt) || !Number.isFinite(now)
    || now < observation.observedAt || now - observation.observedAt > 60_000
    || digest(observation?.credentialReference ?? null) !== digest(config.apiKey)) reasons.push('FRESH_SAME_REFERENCE_OBSERVATION_REQUIRED');
  if (evidence?.workflowReview?.graphDigest !== descriptor.graphDigest.value
    || evidence.workflowReview.workflowId !== descriptor.workflowId
    || evidence.workflowReview.scope !== 'native-only-no-external-api-charge') reasons.push('EXACT_GRAPH_REVIEW_REQUIRED');
  return { executionAuthorized: false, status: reasons.length ? 'incomplete' : 'candidate-needs-authoritative-key-class-proof', reasons,
    unresolved: ['NORMAL_HAS_NO_DOCUMENTED_MEMBERSHIP_MAPPING', 'USER_REVIEW_IS_NOT_SERVER_ENTITLEMENT_PROOF'] };
}
