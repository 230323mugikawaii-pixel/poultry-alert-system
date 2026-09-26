import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import type { DatabaseClient } from "../../src/db/client.js";

/** ONLY old-schema round-trip fixtures. Production includes/writers are deliberately unchanged in 05a. */
export function createLegacySchemaClient(databaseUrl: string): DatabaseClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
    omit: {
      mailAuthorization: {
        encryptedAccessToken: true,
        accessTokenExpiresAt: true,
        credentialVersion: true,
        refreshLeaseToken: true,
        refreshLeaseUntil: true,
        refreshLeaseGeneration: true
      }
    }
  });
}
