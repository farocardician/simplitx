import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

async function seedVendors() {
  try {
    console.log('Starting vendor seed...');

    // Read the sample JSON file to extract vendor information
    const jsonPath = join(__dirname, '../11-final.json');
    const jsonContent = readFileSync(jsonPath, 'utf-8');
    const data = JSON.parse(jsonContent);

    // Extract vendor name from seller.name
    const vendorName = data.seller?.name;

    if (!vendorName) {
      throw new Error('No vendor name found in sample data');
    }

    console.log(`Found vendor: ${vendorName}`);

    // Create vendor with case-insensitive duplicate check
    const existingVendor = await prisma.vendor.findFirst({
      where: {
        name: {
          equals: vendorName,
          mode: 'insensitive',
        },
      },
    });

    let vendor;
    if (existingVendor) {
      console.log(`Vendor "${vendorName}" already exists with ID: ${existingVendor.id}`);
      vendor = existingVendor;
    } else {
      vendor = await prisma.vendor.create({
        data: {
          name: vendorName,
        },
      });
      console.log(`✅ Created new vendor: ${vendorName} with ID: ${vendor.id}`);
    }

    // Verify the count
    const totalCount = await prisma.vendor.count();
    console.log(`📊 Total vendors in database: ${totalCount}`);

    return vendor;

  } catch (error) {
    console.error('❌ Error seeding vendors:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the seed function if this file is executed directly
if (require.main === module) {
  seedVendors()
    .then(() => {
      console.log('Vendor seeding completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Vendor seeding failed:', error);
      process.exit(1);
    });
}

export default seedVendors;