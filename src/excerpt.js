export function computeImportedPostExcerpt({ excerpt, metaDescription }) {
  const explicitExcerpt = normalizeSafePlainText(excerpt);
  if (explicitExcerpt) {
    return explicitExcerpt;
  }

  const explicitMetaDescription = normalizeSafePlainText(metaDescription);
  if (explicitMetaDescription) {
    return explicitMetaDescription;
  }

  return '';
}

function normalizeSafePlainText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
