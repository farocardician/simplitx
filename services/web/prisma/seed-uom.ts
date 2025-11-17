import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

async function main() {
  const csvPath = join(process.cwd(), 'uom.csv');
  const csvContent = readFileSync(csvPath, 'utf-8');

  const lines = csvContent.trim().split('\n');

  console.log(`Importing ${lines.length} UOM entries...`);

  for (const line of lines) {
    const [code, name] = line.split(',').map(s => s.trim());

    if (code && name) {
      await prisma.unitOfMeasure.upsert({
        where: { code },
        update: { name },
        create: { code, name }
      });
    }
  }

  console.log('UOM import complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
