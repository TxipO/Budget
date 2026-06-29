import { PrismaClient } from '@prisma/client';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'prisma', 'budget.db');
const dbUrl  = `file:${dbPath}`;

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ datasources: { db: { url: dbUrl } } });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
