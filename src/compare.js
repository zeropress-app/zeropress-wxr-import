const UNSIGNED_INTEGER_REGEX = /^\d+$/u;

export function compareLexically(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

export function compareWordPressIdStrings(left, right) {
  const leftText = String(left);
  const rightText = String(right);

  if (UNSIGNED_INTEGER_REGEX.test(leftText) && UNSIGNED_INTEGER_REGEX.test(rightText)) {
    const leftId = BigInt(leftText);
    const rightId = BigInt(rightText);
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
  }

  return compareLexically(leftText, rightText);
}
