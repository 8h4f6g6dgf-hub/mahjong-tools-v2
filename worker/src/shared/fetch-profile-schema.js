// v5.3.7: HAR登録ツールとWorkerが同じProfile Schema・意味検証規則を共有する。
export const FETCH_PROFILE_VERSION = 'current-har-v3';
export const COMPATIBLE_FETCH_PROFILE_VERSIONS = Object.freeze(['current-har-v2', FETCH_PROFILE_VERSION]);
export const FETCH_RPC = '.lq.Lobby.fetchGameRecord';
export const CONNECTION_CONTEXT_PENDING = 'pending-runtime-validation';

const expectedEnvelope = Object.freeze([{ field: 1, wire: 2 }, { field: 2, wire: 2 }]);
const expectedRequest = Object.freeze([
  { field: 1, wire: 2, source: 'completePaipuId' },
  { field: 2, wire: 2, source: 'fetchClientContext' }
]);

function sameShape(actual, expected) {
  return Array.isArray(actual) && actual.map((item) => `${item.field}:${item.wire}`).join(',') === expected.map((item) => `${item.field}:${item.wire}`).join(',');
}

export function normalizeFetchProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const sourceMetadata = Array.isArray(profile.sourceMetadata) ? profile.sourceMetadata : [];
  const sourceConnectionIndex = sourceMetadata.find((item) => item.sourceRpc === FETCH_RPC)?.sourceConnectionIndex ?? profile.sourceConnectionIndex ?? null;
  return {
    ...profile,
    profileVersion: profile.profileVersion || profile.version,
    sourceConnectionIndex,
    sourceGatewayRole: profile.sourceGatewayRole || 'record-gateway',
    sourceRpc: profile.sourceRpc || FETCH_RPC,
    sourceDirection: profile.sourceDirection || 'request',
    field1Role: profile.field1Role || 'completePaipuId',
    field1Source: profile.field1Source || 'sharedUrlPageState',
    field2Role: profile.field2Role || 'fetchGameRecordClientContext',
    field2Source: profile.field2Source || FETCH_RPC,
    routeContextRole: profile.routeContextRole || 'requestConnectionRouteContext',
    fetchClientContextRole: profile.fetchClientContextRole || 'fetchGameRecordClientContext',
    requestIdPolicy: profile.requestIdPolicy || 'sequential-per-websocket',
    sameConnectionRequired: profile.sameConnectionRequired !== false,
    prepareLoginRequired: profile.prepareLoginRequired !== false,
    connectionContextValidated: profile.connectionContextValidated !== false,
    sourceMetadata
  };
}

export function validateFetchProfile(profile) {
  const normalized = normalizeFetchProfile(profile);
  const profileVersionValid = Boolean(normalized && COMPATIBLE_FETCH_PROFILE_VERSIONS.includes(normalized.profileVersion));
  const clientVersionIsRouteId = Boolean(normalized && /^jp-\d+$/i.test(normalized.fetchClientContext || ''));
  const field1SourceValidated = Boolean(normalized && normalized.field1SourceValidated === true && normalized.requestFields?.[0]?.source === 'completePaipuId');
  const field2SourceValidated = Boolean(normalized && normalized.field2SourceValidated === true && normalized.requestFields?.[1]?.source === 'fetchClientContext');
  const clientVersionValidated = Boolean(normalized && normalized.clientVersionValidated === true && typeof normalized.fetchClientContext === 'string' && normalized.fetchClientContext && !clientVersionIsRouteId);
  const messageTypeValid = normalized?.messageType === FETCH_RPC && normalized?.sourceRpc === FETCH_RPC && normalized?.sourceDirection === 'request';
  const envelopeStructureValid = Boolean(normalized && sameShape(normalized.envelopeFields, expectedEnvelope));
  const fieldStructureValid = Boolean(normalized && sameShape(normalized.requestFields, expectedRequest));
  const requestIdPolicyValid = normalized?.requestIdPolicy === 'sequential-per-websocket';
  const connectionRelationValid = Boolean(normalized?.sameConnectionRequired && normalized?.connectionContextValidated && normalized?.sourceGatewayRole === 'record-gateway');
  const prepareLoginPrerequisiteValid = normalized?.prepareLoginRequired === true;
  const profileSchemaValid = Boolean(normalized && profileVersionValid && messageTypeValid && envelopeStructureValid && fieldStructureValid && field1SourceValidated && field2SourceValidated && clientVersionValidated && normalized.clientVersionSemanticMatch === true && normalized.semanticValidated === true && normalized.validated === true && requestIdPolicyValid && connectionRelationValid && prepareLoginPrerequisiteValid);
  const conditions = { profileSchemaValid, profileVersionValid, field1SourceValidated, field2SourceValidated, clientVersionValidated, clientVersionIsRouteId, clientVersionSemanticMatch: Boolean(normalized?.clientVersionSemanticMatch), messageTypeValid, envelopeStructureValid, fieldStructureValid, requestIdPolicyValid, connectionRelationValid, prepareLoginPrerequisiteValid };
  const requestSemanticMatched = profileSchemaValid && profileVersionValid && field1SourceValidated && field2SourceValidated && clientVersionValidated && !clientVersionIsRouteId && conditions.clientVersionSemanticMatch && messageTypeValid && envelopeStructureValid && fieldStructureValid && requestIdPolicyValid && connectionRelationValid && prepareLoginPrerequisiteValid;
  let remainingMismatchCategory = null;
  if (!profileVersionValid) remainingMismatchCategory = 'PROFILE_VERSION_MISMATCH';
  else if (!field1SourceValidated) remainingMismatchCategory = 'FIELD1_SOURCE_MISMATCH';
  else if (!field2SourceValidated) remainingMismatchCategory = 'FIELD2_SOURCE_MISMATCH';
  else if (clientVersionIsRouteId) remainingMismatchCategory = 'ROUTE_CONTEXT_MIXED';
  else if (!clientVersionValidated || !conditions.clientVersionSemanticMatch) remainingMismatchCategory = 'CLIENT_CONTEXT_INVALID';
  else if (!messageTypeValid) remainingMismatchCategory = 'MESSAGE_TYPE_MISMATCH';
  else if (!envelopeStructureValid) remainingMismatchCategory = 'ENVELOPE_STRUCTURE_MISMATCH';
  else if (!fieldStructureValid) remainingMismatchCategory = 'FIELD_STRUCTURE_MISMATCH';
  else if (!requestIdPolicyValid) remainingMismatchCategory = 'REQUEST_ID_POLICY_MISMATCH';
  else if (!connectionRelationValid) remainingMismatchCategory = 'CONNECTION_RELATION_MISMATCH';
  else if (!prepareLoginPrerequisiteValid) remainingMismatchCategory = 'PREPARE_LOGIN_PREREQUISITE_MISSING';
  else if (!profileSchemaValid) remainingMismatchCategory = 'PROFILE_SCHEMA_MISMATCH';
  else if (!requestSemanticMatched) remainingMismatchCategory = 'RUNTIME_VALIDATION_BUG';
  return { profile: normalized, ...conditions, requestSemanticMatched, fetchGameRecordProfileValid: profileSchemaValid, connectionContextStatus: CONNECTION_CONTEXT_PENDING, connectionContextMatched: null, remainingMismatchCategory };
}

export function createFetchProfile({ messageType, envelopeFields, requestFields, fetchClientContext, sourceConnectionIndex, sourceMetadata }) {
  const clientVersionIsRouteId = /^jp-\d+$/i.test(fetchClientContext || '');
  const clientVersionValidated = Boolean(fetchClientContext) && !fetchClientContext.includes('\uFFFD') && !clientVersionIsRouteId;
  return normalizeFetchProfile({
    version: FETCH_PROFILE_VERSION, profileVersion: FETCH_PROFILE_VERSION, messageType, envelopeFields, requestFields, fetchClientContext,
    sourceConnectionIndex, sourceGatewayRole: 'record-gateway', sourceRpc: FETCH_RPC, sourceDirection: 'request',
    field1Role: 'completePaipuId', field1Source: 'sharedUrlPageState', field2Role: 'fetchGameRecordClientContext', field2Source: FETCH_RPC,
    routeContextRole: 'requestConnectionRouteContext', fetchClientContextRole: 'fetchGameRecordClientContext', requestIdPolicy: 'sequential-per-websocket',
    sameConnectionRequired: true, prepareLoginRequired: true, connectionContextValidated: true,
    clientVersionSourceRole: 'fetchGameRecordClientContext', clientVersionSourceRpc: FETCH_RPC, clientVersionValidated, clientVersionIsRouteId,
    clientVersionSemanticMatch: clientVersionValidated, field1SourceValidated: true, field2SourceValidated: true,
    semanticValidated: clientVersionValidated, sourceMetadata, validated: clientVersionValidated
  });
}
