// Copyright (c) 2026 Alayra Systems LLC (United States)
//                    Alayra Systems Pvt. Limited (Pakistan)
//                    All rights reserved.
//
// Kinetic IDE is a proprietary product of Alayra Systems.
// Unauthorized reproduction, distribution, or modification
// is strictly prohibited under applicable law.

import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
