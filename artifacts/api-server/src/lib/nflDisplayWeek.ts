const NEW_YORK_DATE_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

function newYorkCalendarDate(value: Date): { year: number; month: number; day: number } {
  const parts = NEW_YORK_DATE_PARTS.formatToParts(value);
  const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: numberPart("year"),
    month: numberPart("month"),
    day: numberPart("day"),
  };
}

function firstRegularSeasonSundayDay(year: number): number {
  const septemberFirstDayOfWeek = new Date(Date.UTC(year, 8, 1)).getUTCDay();
  const laborDay = 1 + ((8 - septemberFirstDayOfWeek) % 7);
  return laborDay + 6;
}

export function nflDisplayWeek(asOf: Date): number {
  const { year, month, day } = newYorkCalendarDate(asOf);
  const localDate = Date.UTC(year, month - 1, day);
  const weekOne = Date.UTC(year, 8, firstRegularSeasonSundayDay(year));
  if (localDate < weekOne) return 0;
  return Math.floor((localDate - weekOne) / (7 * 24 * 60 * 60 * 1000)) + 1;
}