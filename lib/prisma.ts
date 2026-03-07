import { PrismaClient } from "@/lib/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// BigInt is not JSON serializable by default. NextAuth serializes the full
// user object (including diskQuotaBytes / diskUsedBytes) when building the
// session token, so we need this polyfill to prevent a runtime crash.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });

export default prisma;
