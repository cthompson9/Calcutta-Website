export const NEW_YORK_TIME_ZONE = "America/New_York";

function partsFor(date: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: NEW_YORK_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

/** Returns the calendar date in the pool's canonical America/New_York timezone. */
export function todayInNewYork(date = new Date()): string {
  const parts = partsFor(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function currentYearInNewYork(date = new Date()): number {
  return Number(partsFor(date).year);
}