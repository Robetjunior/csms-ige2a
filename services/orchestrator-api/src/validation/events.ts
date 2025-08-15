// src/validation/events.ts
import { z } from "zod";

export const OcppEventSchema = z.object({
    type: z.string().min(1, "type is required"),
    transactionId: z.coerce.number().int().optional(),
    chargeBoxId: z.string().optional(),
    idTag: z.string().optional(),
    reason: z.string().optional(),
    timestamp: z.string().datetime().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    eventId: z.union([z.string(), z.number()]).optional()
});

export type OcppEvent = z.infer<typeof OcppEventSchema>;
