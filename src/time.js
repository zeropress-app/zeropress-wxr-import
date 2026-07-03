function formatDateToUtcSecondIso(value) {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseWxrGmtDateTimeToUtcSecondIso(value) {
  const parsed = parseWxrDateTime(value);
  return parsed ? formatDateToUtcSecondIso(new Date(parsed.epochMilliseconds)) : null;
}

export function parseRssPubDateToUtcSecondIso(value) {
  const trimmed = String(value ?? '').trim();
  const match = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun), )?(\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (UT|GMT|[+-]\d{4})$/u.exec(trimmed);
  if (!match) return null;

  const [, weekday, dayText, monthText, yearText, hourText, minuteText, secondText, zoneText] = match;
  const year = Number.parseInt(yearText, 10);
  const month = RSS_MONTHS.get(monthText);
  const day = Number.parseInt(dayText, 10);
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const second = Number.parseInt(secondText, 10);
  if (
    month === undefined
    || year === 0
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return null;
  }

  const localDate = new Date(0);
  localDate.setUTCFullYear(year, month, day);
  localDate.setUTCHours(hour, minute, second, 0);
  if (
    localDate.getUTCFullYear() !== year
    || localDate.getUTCMonth() !== month
    || localDate.getUTCDate() !== day
    || localDate.getUTCHours() !== hour
    || localDate.getUTCMinutes() !== minute
    || localDate.getUTCSeconds() !== second
    || (weekday && RSS_WEEKDAYS[localDate.getUTCDay()] !== weekday)
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (zoneText !== 'UT' && zoneText !== 'GMT') {
    const offsetHours = Number.parseInt(zoneText.slice(1, 3), 10);
    const offsetMinutePart = Number.parseInt(zoneText.slice(3, 5), 10);
    if (
      offsetHours > 14
      || offsetMinutePart > 59
      || (offsetHours === 14 && offsetMinutePart !== 0)
    ) {
      return null;
    }
    const sign = zoneText[0] === '-' ? -1 : 1;
    offsetMinutes = sign * ((offsetHours * 60) + offsetMinutePart);
  }

  const instant = new Date(localDate.getTime() - (offsetMinutes * 60_000));
  return Number.isFinite(instant.getTime())
    ? formatDateToUtcSecondIso(instant)
    : null;
}

export function parseWxrLocalDateParts(value) {
  const parsed = parseWxrDateTime(value);
  if (!parsed) return null;
  return {
    year: String(parsed.year).padStart(4, '0'),
    month: String(parsed.month).padStart(2, '0'),
    day: String(parsed.day).padStart(2, '0'),
  };
}

export function inferWxrUtcOffsetMinutes(localValue, gmtValue) {
  const local = parseWxrDateTime(localValue);
  const gmt = parseWxrDateTime(gmtValue);
  if (!local || !gmt) return null;

  const differenceMilliseconds = local.epochMilliseconds - gmt.epochMilliseconds;
  if (differenceMilliseconds % 60_000 !== 0) return null;

  const offsetMinutes = differenceMilliseconds / 60_000;
  return Math.abs(offsetMinutes) <= 14 * 60 ? offsetMinutes : null;
}

export function canonicalizeTimeZone(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;

  const offset = /^([+-])(\d{2}):(\d{2})$/u.exec(trimmed);
  if (offset) {
    const hours = Number(offset[2]);
    const minutes = Number(offset[3]);
    if (minutes > 59 || hours > 14 || (hours === 14 && minutes !== 0)) {
      return null;
    }
    if (hours === 0 && minutes === 0) {
      return 'UTC';
    }
    return `${offset[1]}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: trimmed })
      .resolvedOptions()
      .timeZone;
    return canonical === '+00:00' || canonical === '-00:00' ? 'UTC' : canonical;
  } catch {
    return null;
  }
}

export function formatUtcOffsetTimeZone(offsetMinutes) {
  if (offsetMinutes === 0 || Object.is(offsetMinutes, -0)) return 'UTC';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const datePartFormatters = new Map();
const RSS_MONTHS = new Map([
  ['Jan', 0],
  ['Feb', 1],
  ['Mar', 2],
  ['Apr', 3],
  ['May', 4],
  ['Jun', 5],
  ['Jul', 6],
  ['Aug', 7],
  ['Sep', 8],
  ['Oct', 9],
  ['Nov', 10],
  ['Dec', 11],
]);
const RSS_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function datePartsInTimeZone(iso, timeZone) {
  let formatter = datePartFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    datePartFormatters.set(timeZone, formatter);
  }

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(iso)).map(({ type, value }) => [type, value]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  };
}

function parseWxrDateTime(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed === '0000-00-00 00:00:00') return null;

  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const second = Number.parseInt(secondText, 10);
  if (year === 0) return null;

  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(hour, minute, second, 0);

  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
    || parsed.getUTCSeconds() !== second
  ) {
    return null;
  }

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    epochMilliseconds: parsed.getTime(),
  };
}
