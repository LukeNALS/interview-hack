import type { z } from "zod";
import type {
  createSessionSchema,
  sonioxKeyRequestSchema,
  ingestUtteranceSchema,
  backfillUtterancesQuerySchema,
} from "@/schemas/rest";

/** z.input (không phải z.infer): `kind` có default nên caller cũ không cần truyền. */
export type CreateSessionInput = z.input<typeof createSessionSchema>;
export type SonioxKeyRequestInput = z.infer<typeof sonioxKeyRequestSchema>;
export type IngestUtteranceInput = z.infer<typeof ingestUtteranceSchema>;
export type BackfillUtterancesQuery = z.infer<typeof backfillUtterancesQuerySchema>;

export interface ApiErrorBody {
  error: {
    code: string;
    message?: string;
  };
}
