export const NEW_YORK_TIME_ZONE = "America/New_York";

/** Returns a YYYY-MM-DD date for the pool's canonical New York calendar. */
export function todayInNewYork(date = new Date()): string {
  const parts = Object.fromEntries(
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
  return `${parts.year}-${parts.month}-${parts.day}`;
}