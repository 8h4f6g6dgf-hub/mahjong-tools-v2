// v5.3.8: HARから認証後セッション条件だけを抽出し、値やPayloadを保存せずWorkerと共有する。
export const SESSION_TIMELINE_VERSION = 'current-har-session-v1';
export const MAX_SESSION_DELAY_MS = 3000;

export function safeDelayMs(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_SESSION_DELAY_MS, Math.round(value)));
}

export function validateSessionTimeline(value) {
  const present = Boolean(value && typeof value === 'object');
  const versionValid = present && value.version === SESSION_TIMELINE_VERSION;
  const eventsValid = versionValid && Array.isArray(value.events) && value.events.every((item, index) => item && item.order === index + 1 && ['client-to-server', 'server-to-client'].includes(item.direction) && ['request', 'response', 'push', 'notify', 'empty', 'ack'].includes(item.eventType) && Number.isFinite(item.delayFromPreviousMs));
  const profileValid = Boolean(eventsValid && Number.isFinite(value.prepareLoginToFetchDelayMs) && Number.isInteger(value.requestIdDeltaBeforeFetch) && value.requestIdDeltaBeforeFetch > 0 && value.sameConnectionRequired === true && value.validated === true);
  return { sessionTimelineProfilePresent: present, sessionTimelineProfileValid: profileValid, sessionTimelineVersionValid: versionValid, profile: profileValid ? { ...value, prepareLoginToFetchDelayMs: safeDelayMs(value.prepareLoginToFetchDelayMs) } : null };
}

export function legacySessionTimeline() {
  return { version: 'legacy-response-trigger-v1', prepareLoginToFetchDelayMs: 0, events: [], heartbeatRequired: false, requiredIntermediateRpc: null, requiredServerEvent: null, requestIdDeltaBeforeFetch: 1, sameConnectionRequired: true, validated: false };
}

export function createSessionTimeline(events) {
  const prepareResponseIndex = events.findIndex((item) => item.rpc === '.lq.Lobby.prepareLogin' && item.eventType === 'response');
  const fetchRequestIndex = events.findIndex((item, index) => index > prepareResponseIndex && item.rpc === '.lq.Lobby.fetchGameRecord' && item.eventType === 'request');
  if (prepareResponseIndex < 0 || fetchRequestIndex < 0) return null;
  const selected = events.slice(prepareResponseIndex, fetchRequestIndex + 1).map((item, index, list) => ({ order: index + 1, direction: item.direction, eventType: item.eventType, rpc: item.rpc || null, requestId: Number.isInteger(item.requestId) ? item.requestId : null, delayFromPreviousMs: index ? safeDelayMs(item.timestampMs - list[index - 1].timestampMs) : 0, requiredBeforeFetch: index < list.length - 1, payloadPresent: Boolean(item.payloadSize), payloadSize: Number(item.payloadSize) || 0 }));
  const intermediate = selected.slice(1, -1), prepare = events[prepareResponseIndex], fetch = events[fetchRequestIndex];
  const heartbeat = intermediate.find((item) => item.rpc === '.lq.Route.heartbeat');
  const intermediateRpc = intermediate.find((item) => item.eventType === 'request' && item.rpc && item.rpc !== '.lq.Route.heartbeat');
  const serverEvent = intermediate.find((item) => item.direction === 'server-to-client' && (item.eventType === 'push' || item.eventType === 'notify'));
  return { version: SESSION_TIMELINE_VERSION, prepareLoginToFetchDelayMs: safeDelayMs(fetch.timestampMs - prepare.timestampMs), events: selected, heartbeatRequired: Boolean(heartbeat), requiredIntermediateRpc: intermediateRpc?.rpc || null, requiredServerEvent: serverEvent?.rpc || null, requestIdDeltaBeforeFetch: Number.isInteger(fetch.requestId) && Number.isInteger(prepare.requestId) ? fetch.requestId - prepare.requestId : 1, sameConnectionRequired: true, validated: true };
}

export function buildSessionRuntimePlan(validation) {
  const profile = validation?.profile || legacySessionTimeline();
  const valid = Boolean(validation?.sessionTimelineProfileValid);
  const blockedCode = valid && profile.heartbeatRequired ? 'HEARTBEAT_FAILED' : valid && profile.requiredIntermediateRpc ? 'INTERMEDIATE_RPC_FAILED' : null;
  const source = valid ? SESSION_TIMELINE_VERSION : validation?.sessionTimelineProfilePresent ? 'missing' : 'legacy';
  const legacyReason = valid ? null : validation?.sessionTimelineProfilePresent ? 'session-timeline-schema-invalid' : 'profile-has-no-session-timeline';
  return { profile, valid, source, legacyReason, strategy: valid ? 'har-timeline-plus-buffer' : 'legacy-response-trigger', delayMs: valid ? safeDelayMs(profile.prepareLoginToFetchDelayMs + 50) : 0, blockedCode };
}
