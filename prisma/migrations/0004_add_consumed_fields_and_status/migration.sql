-- AlterEnum
ALTER TYPE "ApprovalStatus" ADD VALUE 'consumed';

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN "consumedAt" TIMESTAMP(3),
ADD COLUMN "consumedByInvocationId" TEXT;
