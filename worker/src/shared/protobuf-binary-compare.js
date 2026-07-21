// v5.3.9: 認証値やPayloadを返さず、Protobufの構造・長さ・byte差分だけを比較する。
function readVarint(bytes, start) {
  let value = 0, shift = 0, offset = start, byte;
  do {
    if (offset >= bytes.length || shift > 35) throw new Error('Invalid protobuf varint');
    byte = bytes[offset++]; value += (byte & 0x7f) * 2 ** shift; shift += 7;
  } while (byte & 0x80);
  return { value, offset };
}

export function inspectBinaryFields(bytes) {
  const result = []; let offset = 0;
  while (offset < bytes.length) {
    const fieldOffset = offset, tag = readVarint(bytes, offset); offset = tag.offset;
    const field = tag.value >>> 3, wire = tag.value & 7; let valueOffset = offset, valueLength = 0;
    if (wire === 0) { const parsed = readVarint(bytes, offset); offset = parsed.offset; valueLength = offset - valueOffset; }
    else if (wire === 1) { valueLength = 8; offset += 8; }
    else if (wire === 2) { const length = readVarint(bytes, offset); offset = length.offset; valueOffset = offset; valueLength = length.value; offset += valueLength; }
    else if (wire === 5) { valueLength = 4; offset += 4; }
    else throw new Error('Unsupported protobuf wire type');
    if (!field || offset > bytes.length) throw new Error('Invalid protobuf field');
    result.push({ field, wire, offset: fieldOffset, encodedLength: offset - fieldOffset, valueOffset, valueLength });
  }
  return result;
}

function equalBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function firstDifference(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) if (left[index] !== right[index]) return index;
  return left.length === right.length ? null : limit;
}

function fieldSummary(actual, expected, knownFields) {
  const actualKeys = actual.map((item) => `${item.field}:${item.wire}`), expectedKeys = expected.map((item) => `${item.field}:${item.wire}`);
  const all = [...new Set([...actualKeys, ...expectedKeys])];
  const differences = all.filter((key) => actualKeys.filter((item) => item === key).length !== expectedKeys.filter((item) => item === key).length);
  const unknown = actual.filter((item) => !knownFields.includes(item.field));
  return {
    unknown,
    summary: differences.length ? differences.map((key) => `${key}=${actualKeys.includes(key) ? expectedKeys.includes(key) ? 'count-mismatch' : 'worker-only' : 'reference-only'}`).join(', ') : 'field-order-and-wire-match'
  };
}

export function compareProtobufBinary(actual, expected, options = {}) {
  const knownFields = Array.isArray(options.knownFields) ? options.knownFields : [];
  try {
    const actualFields = inspectBinaryFields(actual), expectedFields = inspectBinaryFields(expected);
    const fields = fieldSummary(actualFields, expectedFields, knownFields), differenceOffset = firstDifference(actual, expected);
    const binaryMatch = equalBytes(actual, expected);
    return {
      payloadByteMatch: binaryMatch,
      payloadLengthMatch: actual.length === expected.length,
      protobufBinaryMatch: binaryMatch,
      protobufObjectMatch: actualFields.map(({ field, wire }) => `${field}:${wire}`).join(',') === expectedFields.map(({ field, wire }) => `${field}:${wire}`).join(','),
      encodeMatch: binaryMatch,
      unknownFieldCount: fields.unknown.length,
      unknownFieldSummary: fields.unknown.length ? fields.unknown.map((item) => `field ${item.field}/wire ${item.wire}`).join(', ') : 'none',
      binaryDiffSummary: binaryMatch ? 'binary-identical' : `${fields.summary}; firstDifferenceOffset=${differenceOffset}; workerLength=${actual.length}; referenceLength=${expected.length}`,
      firstDifferenceOffset: differenceOffset,
      workerPayloadLength: actual.length,
      referencePayloadLength: expected.length
    };
  } catch (_) {
    return { payloadByteMatch: false, payloadLengthMatch: false, protobufBinaryMatch: false, protobufObjectMatch: false, encodeMatch: false, unknownFieldCount: 0, unknownFieldSummary: 'inspection-failed', binaryDiffSummary: 'protobuf-inspection-failed', firstDifferenceOffset: null, workerPayloadLength: actual?.length || 0, referencePayloadLength: expected?.length || 0 };
  }
}
