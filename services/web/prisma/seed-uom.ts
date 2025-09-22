import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

async function seedUom() {
  try {
    // Read the UOM CSV file from the app directory
    const csvPath = join(__dirname, '../uom.csv');
    const csvContent = readFileSync(csvPath, 'utf-8');

    console.log('Starting UOM seed...');

    // Parse CSV content
    const lines = csvContent.trim().split('\n');
    let upsertCount = 0;

    for (const line of lines) {
      if (line.trim()) {
        const [code, name] = line.split(',');

        if (code && name) {
          await prisma.uom.upsert({
            where: { code: code.trim() },
            update: { name: name.trim() },
            create: {
              code: code.trim(),
              name: name.trim(),
            },
          });
          upsertCount++;
          console.log(`Upserted UOM: ${code.trim()} - ${name.trim()}`);
        }
      }
    }

    console.log(`✅ Successfully upserted ${upsertCount} UOM codes`);

    // Verify the count
    const totalCount = await prisma.uom.count();
    console.log(`📊 Total UOM codes in database: ${totalCount}`);

  } catch (error) {
    console.error('❌ Error seeding UOM codes:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the seed function if this file is executed directly
if (require.main === module) {
  seedUom()
    .then(() => {
      console.log('UOM seeding completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('UOM seeding failed:', error);
      process.exit(1);
    });
}

export default seedUom;