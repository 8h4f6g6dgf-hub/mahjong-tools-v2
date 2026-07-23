import { validateFetchProfile } from './fetch-profile-schema.js';

const LOSS_CATALOG = Object.freeze({
  RAW_REQUEST_BINARY: { role: 'missingBinary', reason: 'Profileは認証情報保護のため生のrequest byteを保存していません', severity: 'high' },
  RAW_RESPONSE_BINARY: { role: 'missingBinary', reason: 'Profileは生のresponse byteを保存していません', severity: 'medium' },
  BYTE_OFFSETS: { role: 'missingMetadata', reason: 'fieldのbyte offsetとencoded lengthは保存されていません', severity: 'medium' },
  REQUEST_METADATA: { role: 'missingMetadata', reason: 'HAR request header等の通信メタデータはProfile対象外です', severity: 'low' },
  RESPONSE_METADATA: { role: 'missingMetadata', reason: 'HAR response header等の通信メタデータはProfile対象外です', severity: 'low' },
  UNKNOWN_FIELD_PROOF: { role: 'missingUnknownField', reason: '旧ProfileではUnknown Fieldが存在しないことを生byteから証明できません', severity: 'high' },
  RESERVED_EXTENSION_PROOF: { role: 'missingUnknownField', reason: 'Reserved/Extensionの有無を示す生byte証跡は保存されていません', severity: 'medium' },
  SESSION_TIMELINE: { role: 'missingSessionField', reason: '旧Profileには現行HARのSession Timelineがありません', severity: 'medium' },
  SAFE_BINARY_METADATA: { role: 'missingMetadata', reason: '旧Profileには長さ・field順の安全なBinaryメタデータがありません', severity: 'medium' }
});

function loss(key) { return { item: key, ...LOSS_CATALOG[key] }; }

export function auditFetchProfile(profile) {
  const validation = validateFetchProfile(profile);
  const normalized = validation.profile;
  if (!normalized) return {
    profileCompleteness: 0, profileLossDetected: true, lossCount: 1,
    lossItems: ['PROFILE_MISSING'], lossReason: ['Profileが設定されていません'], lossSeverity: 'high',
    profileCanRebuildRawBinary: false, profileCanGenerateWorkerRequest: false,
    profileCanReproduceOriginalRequest: false, profileCanReproduceOriginalBinary: false,
    rawHarCompared: false, comparisonLevel: 'unknown', secretCompleteness: 'incomplete',
    missingRole: ['fetchGameRecordProfile'], missingBinary: true, missingMetadata: true,
    missingUnknownField: true, missingSessionField: true, profileAuditStages: []
  };

  const losses = [loss('RAW_REQUEST_BINARY'), loss('RAW_RESPONSE_BINARY'), loss('BYTE_OFFSETS'), loss('REQUEST_METADATA'), loss('RESPONSE_METADATA'), loss('RESERVED_EXTENSION_PROOF')];
  if (!normalized.binaryProfile) losses.push(loss('SAFE_BINARY_METADATA'), loss('UNKNOWN_FIELD_PROOF'));
  if (!normalized.sessionTimeline) losses.push(loss('SESSION_TIMELINE'));
  const weights = { messageType: 10, envelopeFields: 10, requestFields: 15, fieldOrder: 10, wireTypes: 10, sourceRoles: 10, clientContext: 10, requestPolicy: 5, connectionRelation: 5, sessionTimeline: 5, binaryMetadata: 5, rawBinary: 5 };
  const present = {
    messageType: Boolean(normalized.messageType), envelopeFields: Array.isArray(normalized.envelopeFields),
    requestFields: Array.isArray(normalized.requestFields), fieldOrder: Array.isArray(normalized.requestFields),
    wireTypes: Array.isArray(normalized.requestFields), sourceRoles: Boolean(normalized.field1Role && normalized.field2Role),
    clientContext: Boolean(normalized.fetchClientContext), requestPolicy: Boolean(normalized.requestIdPolicy),
    connectionRelation: Boolean(normalized.sameConnectionRequired), sessionTimeline: Boolean(normalized.sessionTimeline),
    binaryMetadata: Boolean(normalized.binaryProfile), rawBinary: false
  };
  const profileCompleteness = Object.entries(weights).reduce((sum, [key, weight]) => sum + (present[key] ? weight : 0), 0);
  const severityRank = { low: 1, medium: 2, high: 3 };
  const lossSeverity = losses.reduce((highest, item) => severityRank[item.severity] > severityRank[highest] ? item.severity : highest, 'low');
  const missingRoles = [...new Set(losses.map((item) => item.role))];
  const canGenerate = validation.profileSchemaValid;
  return {
    profileCompleteness, profileLossDetected: losses.length > 0, lossCount: losses.length,
    lossItems: losses.map((item) => item.item), lossReason: losses.map((item) => item.reason), lossSeverity,
    profileCanRebuildRawBinary: false, profileCanGenerateWorkerRequest: canGenerate,
    profileCanReproduceOriginalRequest: canGenerate, profileCanReproduceOriginalBinary: false,
    rawHarCompared: false, comparisonLevel: 'worker-vs-profile',
    secretCompleteness: canGenerate && missingRoles.length === 0 ? 'complete' : canGenerate ? 'runtime-complete-proof-incomplete' : 'incomplete',
    missingRole: missingRoles, missingBinary: missingRoles.includes('missingBinary'),
    missingMetadata: missingRoles.includes('missingMetadata'), missingUnknownField: missingRoles.includes('missingUnknownField'),
    missingSessionField: missingRoles.includes('missingSessionField'),
    profileAuditStages: [
      { stage: 'HAR', retained: ['gateway frames'], lost: [] },
      { stage: 'Parse', retained: ['RPC name', 'Envelope', 'field/wire order'], lost: ['HTTP/WebSocket metadata not needed by RPC builder'] },
      { stage: 'Message', retained: ['field roles', 'client context role'], lost: ['raw byte offsets'] },
      { stage: 'Profile', retained: ['safe semantic structure'], lost: losses.map((item) => item.item) },
      { stage: 'Secret', retained: ['Profile and runtime values'], lost: ['raw HAR binary by security design'] },
      { stage: 'Worker', retained: ['request-generation inputs'], lost: ['raw-HAR comparison proof'] }
    ]
  };
}

export function classifyFetchRejection({ audit, actualFailureCode, requestSemanticMatched, sessionTimelineProfileValid }) {
  if (!actualFailureCode) return null;
  if (!audit || !audit.profileCanGenerateWorkerRequest) return 'REQUEST_INFORMATION_LOST';
  if (audit.missingBinary || audit.missingUnknownField) return 'PROFILE_INFORMATION_LOST';
  if (!sessionTimelineProfileValid && audit.missingSessionField) return 'SESSION_INFORMATION_LOST';
  if (requestSemanticMatched) return 'SERVER_VALIDATION_REJECTED';
  return 'FETCH_GAME_RECORD_FAILED';
}
