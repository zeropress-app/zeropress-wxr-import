const MAX_SERIALIZED_DEPTH = 128;
const MAX_SERIALIZED_ITEMS = 1_000_000;

export function parseWordPressAttachmentMetadata(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const source = value.trim();
  const json = parseJsonMetadata(source);
  if (json) {
    return json;
  }

  try {
    return parsePhpSerializedMetadata(source);
  } catch {
    return null;
  }
}

function parseJsonMetadata(source) {
  if (!source.startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return compactMetadata(parsed.width, parsed.height, parsed.file);
  } catch {
    return null;
  }
}

function parsePhpSerializedMetadata(source) {
  const bytes = Buffer.from(source, 'utf8');
  const root = readArrayHeader(bytes, 0);
  if (root.count > MAX_SERIALIZED_ITEMS) {
    throw new Error('Serialized attachment metadata has too many items');
  }

  let cursor = root.next;
  let width;
  let height;
  let file;

  for (let index = 0; index < root.count; index += 1) {
    const key = readScalar(bytes, cursor);
    cursor = key.next;

    if (key.type === 'string' && key.value === 'width') {
      const value = readScalarOrSkip(bytes, cursor);
      cursor = value.next;
      if (value.type === 'integer') width = value.value;
      continue;
    }
    if (key.type === 'string' && key.value === 'height') {
      const value = readScalarOrSkip(bytes, cursor);
      cursor = value.next;
      if (value.type === 'integer') height = value.value;
      continue;
    }
    if (key.type === 'string' && key.value === 'file') {
      const value = readScalarOrSkip(bytes, cursor);
      cursor = value.next;
      if (value.type === 'string') file = value.value;
      continue;
    }

    cursor = skipSerializedValue(bytes, cursor);
  }

  expectByte(bytes, cursor, 0x7d);
  cursor += 1;
  if (cursor !== bytes.length) {
    throw new Error('Unexpected trailing serialized attachment metadata');
  }

  return compactMetadata(width, height, file);
}

function compactMetadata(width, height, file) {
  const normalizedWidth = positiveSafeInteger(width);
  const normalizedHeight = positiveSafeInteger(height);
  const normalizedFile = typeof file === 'string' && file.trim() !== '' ? file.trim() : undefined;

  if (normalizedWidth === undefined && normalizedHeight === undefined && normalizedFile === undefined) {
    return null;
  }

  return {
    ...(normalizedWidth !== undefined ? { width: normalizedWidth } : {}),
    ...(normalizedHeight !== undefined ? { height: normalizedHeight } : {}),
    ...(normalizedFile !== undefined ? { file: normalizedFile } : {}),
  };
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readScalarOrSkip(bytes, offset) {
  const type = bytes[offset];
  if (type === 0x73 || type === 0x69 || type === 0x62 || type === 0x64 || type === 0x4e) {
    return readScalar(bytes, offset);
  }
  return { type: 'skipped', value: undefined, next: skipSerializedValue(bytes, offset) };
}

function readScalar(bytes, offset) {
  const type = bytes[offset];
  if (type === 0x73) return readString(bytes, offset);
  if (type === 0x69) return readInteger(bytes, offset);
  if (type === 0x62) return readBoolean(bytes, offset);
  if (type === 0x64) return readDouble(bytes, offset);
  if (type === 0x4e) {
    expectByte(bytes, offset + 1, 0x3b);
    return { type: 'null', value: null, next: offset + 2 };
  }
  throw new Error('Expected a serialized scalar');
}

function readString(bytes, offset) {
  expectByte(bytes, offset, 0x73);
  expectByte(bytes, offset + 1, 0x3a);
  const length = readUnsignedInteger(bytes, offset + 2, 0x3a);
  expectByte(bytes, length.next, 0x22);
  const start = length.next + 1;
  const end = start + length.value;
  if (end > bytes.length) {
    throw new Error('Serialized string exceeds input');
  }
  expectByte(bytes, end, 0x22);
  expectByte(bytes, end + 1, 0x3b);
  return {
    type: 'string',
    value: bytes.subarray(start, end).toString('utf8'),
    next: end + 2,
  };
}

function readInteger(bytes, offset) {
  expectByte(bytes, offset, 0x69);
  expectByte(bytes, offset + 1, 0x3a);
  const token = readAsciiUntil(bytes, offset + 2, 0x3b);
  if (!/^-?(?:0|[1-9]\d*)$/u.test(token.value)) {
    throw new Error('Invalid serialized integer');
  }
  const value = Number(token.value);
  if (!Number.isSafeInteger(value)) {
    throw new Error('Serialized integer is outside the safe range');
  }
  return { type: 'integer', value, next: token.next + 1 };
}

function readBoolean(bytes, offset) {
  expectByte(bytes, offset, 0x62);
  expectByte(bytes, offset + 1, 0x3a);
  const value = bytes[offset + 2];
  if (value !== 0x30 && value !== 0x31) {
    throw new Error('Invalid serialized boolean');
  }
  expectByte(bytes, offset + 3, 0x3b);
  return { type: 'boolean', value: value === 0x31, next: offset + 4 };
}

function readDouble(bytes, offset) {
  expectByte(bytes, offset, 0x64);
  expectByte(bytes, offset + 1, 0x3a);
  const token = readAsciiUntil(bytes, offset + 2, 0x3b);
  if (!/^-?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/u.test(token.value)) {
    throw new Error('Invalid serialized double');
  }
  const value = Number(token.value);
  if (!Number.isFinite(value)) {
    throw new Error('Invalid serialized double');
  }
  return { type: 'double', value, next: token.next + 1 };
}

function readArrayHeader(bytes, offset) {
  expectByte(bytes, offset, 0x61);
  expectByte(bytes, offset + 1, 0x3a);
  const count = readUnsignedInteger(bytes, offset + 2, 0x3a);
  expectByte(bytes, count.next, 0x7b);
  return { count: count.value, next: count.next + 1 };
}

function skipSerializedValue(bytes, offset) {
  const frames = [{ remaining: 1, closesArray: false }];
  let cursor = offset;
  let totalItems = 0;

  while (frames.length > 0) {
    if (frames.length > MAX_SERIALIZED_DEPTH) {
      throw new Error('Serialized attachment metadata is too deeply nested');
    }

    const frame = frames.at(-1);
    if (frame.remaining === 0) {
      if (frame.closesArray) {
        expectByte(bytes, cursor, 0x7d);
        cursor += 1;
      }
      frames.pop();
      continue;
    }

    frame.remaining -= 1;
    totalItems += 1;
    if (totalItems > MAX_SERIALIZED_ITEMS) {
      throw new Error('Serialized attachment metadata has too many items');
    }

    if (bytes[cursor] === 0x61) {
      const array = readArrayHeader(bytes, cursor);
      cursor = array.next;
      if (array.count > MAX_SERIALIZED_ITEMS || array.count * 2 > MAX_SERIALIZED_ITEMS - totalItems) {
        throw new Error('Serialized attachment metadata has too many items');
      }
      frames.push({ remaining: array.count * 2, closesArray: true });
      continue;
    }

    if (bytes[cursor] === 0x4f || bytes[cursor] === 0x43 || bytes[cursor] === 0x52 || bytes[cursor] === 0x72) {
      throw new Error('Serialized objects and references are not supported');
    }

    cursor = readScalar(bytes, cursor).next;
  }

  return cursor;
}

function readUnsignedInteger(bytes, offset, delimiter) {
  const token = readAsciiUntil(bytes, offset, delimiter);
  if (!/^(?:0|[1-9]\d*)$/u.test(token.value)) {
    throw new Error('Invalid serialized length');
  }
  const value = Number(token.value);
  if (!Number.isSafeInteger(value)) {
    throw new Error('Serialized length is outside the safe range');
  }
  return { value, next: token.next + 1 };
}

function readAsciiUntil(bytes, offset, delimiter) {
  let cursor = offset;
  while (cursor < bytes.length && bytes[cursor] !== delimiter) {
    const byte = bytes[cursor];
    if (byte < 0x20 || byte > 0x7e) {
      throw new Error('Invalid non-ASCII serialized token');
    }
    cursor += 1;
  }
  if (cursor >= bytes.length) {
    throw new Error('Unterminated serialized token');
  }
  return { value: bytes.subarray(offset, cursor).toString('ascii'), next: cursor };
}

function expectByte(bytes, offset, expected) {
  if (offset < 0 || offset >= bytes.length || bytes[offset] !== expected) {
    throw new Error('Malformed serialized attachment metadata');
  }
}
