import type { Response } from "express";
import { z } from "zod/v4";

/** Standard JSON error envelope used by routes that do not expose a generated error schema. */
export const ErrorResponse = z.object({ error: z.string() });
export const InternalErrorResponse = ErrorResponse.extend({ requestId: z.string().optional() });

/**
 * Parses the exact wire payload before it is sent.  Keeping this at the
 * response boundary prevents dates, numeric Drizzle values, and incomplete
 * objects from silently escaping an endpoint.
 */
export function sendParsedJson<T extends { parse(body: unknown): unknown }>(
  res: Response,
  schema: T,
  body: unknown,
  status?: number,
): Response {
  if (status !== undefined) res.status(status);
  return res.json(schema.parse(body));
}