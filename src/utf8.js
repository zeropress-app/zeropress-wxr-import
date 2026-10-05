/**
 * Decode UTF-8 while discarding malformed bytes instead of materializing U+FFFD.
 *
 * A valid, explicitly encoded U+FFFD sequence (EF BF BD) is preserved. When a
 * malformed sequence contains a later valid byte, only the invalid lead or
 * continuation byte is discarded so parsing can resume at the next byte.
 */
const UTF8_2_BYTE_SEQUENCE = Object.freeze({
  length: 2,
  secondMinimum: 0x80,
  secondMaximum: 0xbf,
});
const UTF8_3_BYTE_LOW_SEQUENCE = Object.freeze({
  length: 3,
  secondMinimum: 0xa0,
  secondMaximum: 0xbf,
});
const UTF8_3_BYTE_SEQUENCE = Object.freeze({
  length: 3,
  secondMinimum: 0x80,
  secondMaximum: 0xbf,
});
const UTF8_3_BYTE_NON_SURROGATE_SEQUENCE = Object.freeze({
  length: 3,
  secondMinimum: 0x80,
  secondMaximum: 0x9f,
});
const UTF8_4_BYTE_LOW_SEQUENCE = Object.freeze({
  length: 4,
  secondMinimum: 0x90,
  secondMaximum: 0xbf,
});
const UTF8_4_BYTE_SEQUENCE = Object.freeze({
  length: 4,
  secondMinimum: 0x80,
  secondMaximum: 0xbf,
});
const UTF8_4_BYTE_HIGH_SEQUENCE = Object.freeze({
  length: 4,
  secondMinimum: 0x80,
  secondMaximum: 0x8f,
});

export function createUtf8Sanitizer() {
  let pending = new Uint8Array(0);
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

  return {
    write(chunk) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('UTF-8 sanitizer chunks must be bytes');
      }

      const incoming = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let source = incoming;
      if (pending.length > 0) {
        source = new Uint8Array(pending.length + incoming.length);
        source.set(pending);
        source.set(incoming, pending.length);
      }
      pending = new Uint8Array(0);

      const output = new Uint8Array(source.length);
      let inputOffset = 0;
      let outputOffset = 0;

      while (inputOffset < source.length) {
        const lead = source[inputOffset];
        if (lead <= 0x7f) {
          output[outputOffset] = lead;
          inputOffset += 1;
          outputOffset += 1;
          continue;
        }

        const sequence = utf8Sequence(lead);
        if (!sequence) {
          inputOffset += 1;
          continue;
        }

        const available = source.length - inputOffset;
        const inspectedLength = Math.min(available, sequence.length);
        if (!hasValidContinuationPrefix(source, inputOffset, inspectedLength, sequence)) {
          inputOffset += 1;
          continue;
        }
        if (available < sequence.length) {
          pending = new Uint8Array(source.subarray(inputOffset));
          break;
        }

        output.set(source.subarray(inputOffset, inputOffset + sequence.length), outputOffset);
        inputOffset += sequence.length;
        outputOffset += sequence.length;
      }

      return decoder.decode(output.subarray(0, outputOffset));
    },

    end() {
      pending = new Uint8Array(0);
      return '';
    },
  };
}

function utf8Sequence(lead) {
  if (lead >= 0xc2 && lead <= 0xdf) {
    return UTF8_2_BYTE_SEQUENCE;
  }
  if (lead === 0xe0) {
    return UTF8_3_BYTE_LOW_SEQUENCE;
  }
  if ((lead >= 0xe1 && lead <= 0xec) || (lead >= 0xee && lead <= 0xef)) {
    return UTF8_3_BYTE_SEQUENCE;
  }
  if (lead === 0xed) {
    return UTF8_3_BYTE_NON_SURROGATE_SEQUENCE;
  }
  if (lead === 0xf0) {
    return UTF8_4_BYTE_LOW_SEQUENCE;
  }
  if (lead >= 0xf1 && lead <= 0xf3) {
    return UTF8_4_BYTE_SEQUENCE;
  }
  if (lead === 0xf4) {
    return UTF8_4_BYTE_HIGH_SEQUENCE;
  }
  return null;
}

function hasValidContinuationPrefix(source, offset, inspectedLength, sequence) {
  if (inspectedLength >= 2) {
    const second = source[offset + 1];
    if (second < sequence.secondMinimum || second > sequence.secondMaximum) {
      return false;
    }
  }

  for (let index = 2; index < inspectedLength; index += 1) {
    const continuation = source[offset + index];
    if (continuation < 0x80 || continuation > 0xbf) {
      return false;
    }
  }
  return true;
}
