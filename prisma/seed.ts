import "dotenv/config";
import { prisma } from "../src/infrastructure/prisma/client";
import { PrismaDataStore } from "../src/infrastructure/prisma/store";
import { AuthService } from "../src/services/auth-service";
import { seedDemoData } from "../src/demo/seed-data";

async function main(): Promise<void> {
  const store = new PrismaDataStore(prisma);
  const authService = new AuthService(store);
  const seeded = await seedDemoData(store, authService);

  console.log("Seed complete");
  console.log(`Organization ID: ${seeded.organizationId}`);
  console.log(`Agent ID: ${seeded.agentId}`);
  console.log(`API Key: ${seeded.rawApiKey}`);
}

main()
  .catch((error) => {
    console.error("Seed failed", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
