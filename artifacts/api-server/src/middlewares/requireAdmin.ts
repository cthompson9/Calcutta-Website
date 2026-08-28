import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

/**
 * Protect commissioner-only HTTP routes without comparing an entire header or
 * leaking token-prefix timing information.
 */
export const requireAdmin: RequestHandler = (req, res, next) => {
  const expected = process.env["ADMIN_API_KEY"];
  const token = bearerToken(req.header("authorization"));
  if (!expected || !token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);
  if (
    expectedBuffer.length !== tokenBuffer.length ||
    !timingSafeEqual(expectedBuffer, tokenBuffer)
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};