import { createHash } from "node:crypto";
import { z } from "zod/v4";

export const listenerResultSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    lotId: z.number().int().positive(),
    nominationId: z.string().uuid(),
    totalCents: z.number().int().positive().max(100_000_000),
    allocations: z
      .array(
        z.object({
          consortiumId: z.number().int().positive(),
          basisPoints: z.number().int().positive().max(10000),
        }),
      )
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.allocations.map((a) => a.consortiumId)).size !==
        value.allocations.length ||
      value.allocations.reduce((n, a) => n + a.basisPoints, 0) !== 10000
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Choose distinct buyers with shares totaling exactly 100%.",
      });
    }
  });

export function resultFingerprint(value: z.infer<typeof listenerResultSchema>) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        lotId: value.lotId,
        nominationId: value.nominationId,
        totalCents: value.totalCents,
        allocations: [...value.allocations].sort(
          (a, b) => a.consortiumId - b.consortiumId,
        ),
      }),
    )
    .digest("hex");
}
