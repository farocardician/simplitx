import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

async function seedTransactionCodes() {
  try {
    const csvPath = join(process.cwd(), '../../context/transactionCode.csv');
    console.log(`Reading CSV from: ${csvPath}`);

    const csvContent = readFileSync(csvPath, 'utf-8');
    const lines = csvContent.split('\n').slice(1); // Skip header row

    let count = 0;

    for (const line of lines) {
      if (!line.trim()) continue;

      // Parse CSV line (handle quotes and commas in description)
      const match = line.match(/^(\d+),([^,]+),"(.+)"$/);
      if (!match) {
        console.warn(`Skipping malformed line: ${line}`);
        continue;
      }

      const [, code, name, description] = match;

      if (!code || !name) {
        console.warn(`Skipping incomplete line: ${line}`);
        continue;
      }

      await prisma.transactionCode.upsert({
        where: { code: code.trim() },
        update: {
          name: name.trim(),
          description: description.trim()
        },
        create: {
          code: code.trim(),
          name: name.trim(),
          description: description.trim()
        }
      });

      console.log(`✓ Seeded: ${code} - ${name.trim()}`);
      count++;
    }

    console.log(`\n✅ Successfully seeded ${count} transaction codes`);
  } catch (error) {
    console.error('❌ Error seeding transaction codes:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

seedTransactionCodes();
