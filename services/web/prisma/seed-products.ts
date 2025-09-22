import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

async function seedProducts() {
  try {
    console.log('Starting product information seed...');

    // Read the sample JSON file to extract product information
    const jsonPath = join(__dirname, '../11-final.json');
    const jsonContent = readFileSync(jsonPath, 'utf-8');
    const data = JSON.parse(jsonContent);

    // Get vendor information
    const vendorName = data.seller?.name;
    if (!vendorName) {
      throw new Error('No vendor name found in sample data');
    }

    // Find the vendor
    const vendor = await prisma.vendor.findFirst({
      where: {
        name: {
          equals: vendorName,
          mode: 'insensitive',
        },
      },
    });

    if (!vendor) {
      throw new Error(`Vendor "${vendorName}" not found. Please run vendor seed first.`);
    }

    console.log(`Using vendor: ${vendor.name} (ID: ${vendor.id})`);

    // Process each item
    const items = data.items || [];
    let createdCount = 0;
    let skippedCount = 0;

    for (const item of items) {
      try {
        const sku = item.sku || null;
        const description = item.description;
        const hsCode = item.hs_code || '';
        const uom = item.uom || 'PCS';

        if (!description) {
          console.log(`⚠️ Skipping item with missing description`);
          skippedCount++;
          continue;
        }

        // Map UOM to UOM code - try to find existing UOM, otherwise leave null for MVP
        let uomCode: string | null = null;

        // Try to find matching UOM
        const existingUom = await prisma.uom.findFirst({
          where: {
            OR: [
              { code: { equals: uom, mode: 'insensitive' } },
              { name: { equals: uom, mode: 'insensitive' } },
            ],
          },
        });

        if (existingUom) {
          uomCode = existingUom.code;
        } else {
          console.log(`⚠️ UOM "${uom}" not found, leaving null for MVP partial data`);
        }

        // Create product information record
        const productInfo = await prisma.productInformation.upsert({
          where: sku
            ? { vendorId_sku: { vendorId: vendor.id, sku } }
            : { vendorId_description: { vendorId: vendor.id, description } },
          update: {
            uomCode,
            hsCode: hsCode || null, // Allow null for MVP partial data
            optCode: '1', // Default to item (1), can be adjusted later or set to null
          },
          create: {
            vendorId: vendor.id,
            sku,
            description,
            uomCode,
            hsCode: hsCode || null, // Allow null for MVP partial data
            optCode: '1', // Default to item (1), can be adjusted later or set to null
          },
        });

        console.log(`✅ Created/Updated product: ${sku || 'No SKU'} - ${description.substring(0, 50)}...`);
        createdCount++;

      } catch (error) {
        console.error(`❌ Error processing item ${item.sku || 'No SKU'}:`, error);
        skippedCount++;
      }
    }

    console.log(`\n✅ Product information seeding completed!`);
    console.log(`📊 Created/Updated: ${createdCount} products`);
    console.log(`⚠️ Skipped: ${skippedCount} products`);

    // Verify the count
    const totalCount = await prisma.productInformation.count();
    console.log(`📊 Total product information records in database: ${totalCount}`);

  } catch (error) {
    console.error('❌ Error seeding product information:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the seed function if this file is executed directly
if (require.main === module) {
  seedProducts()
    .then(() => {
      console.log('Product information seeding completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Product information seeding failed:', error);
      process.exit(1);
    });
}

export default seedProducts;