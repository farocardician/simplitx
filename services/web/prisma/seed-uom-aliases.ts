import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Common alias mappings for Indonesian UOM codes
// Based on official Indonesian customs UOM codes (uom.csv)
const COMMON_ALIASES: Record<string, string[]> = {
  'UM.0001': ['MT', 'METRIC TON', 'TONNE', 'TONNES', 'TON'],           // Metrik Ton
  'UM.0002': ['WT', 'WET TON', 'WTON'],                                 // Wet Ton
  'UM.0003': ['KG', 'KILOGRAM', 'KILOGRAMS'],                          // Kilogram
  'UM.0004': ['G', 'GRAM', 'GRAMS'],                                   // Gram
  'UM.0005': ['K', 'KARAT', 'CARAT'],                                  // Karat
  'UM.0006': ['KL', 'KILOLITER', 'KILOLITRE'],                         // Kiloliter
  'UM.0007': ['L', 'LITER', 'LITERS', 'LITRE', 'LITRES'],             // Liter
  'UM.0008': ['BBL', 'BARREL', 'BARRELS'],                             // Barrel
  'UM.0013': ['M', 'METER', 'METERS', 'METRE', 'METRES'],             // Meter
  'UM.0015': ['CM', 'CENTIMETER', 'CENTIMETRE'],                       // Sentimeter
  'UM.0017': ['DOZEN', 'DOZ', 'DZ', 'LUSIN'],                          // Lusin
  'UM.0018': ['UN', 'UNIT', 'UNITS', 'EA', 'EACH'],                    // Unit
  'UM.0019': ['SET', 'SETS'],                                          // Set
  'UM.0020': ['SHEET', 'SHEETS', 'SH', 'LEMBAR'],                      // Lembar
  'UM.0021': ['PCS', 'PC', 'PCE', 'PIECE', 'PIECES'],                  // Piece
  'UM.0022': ['BOX', 'BOXES', 'BX', 'BOKS', 'CARTON', 'CARTONS', 'CTN'], // Boks
};

async function main() {
  console.log('Starting UOM alias seeding...');

  // Step 1: Get all existing UOMs
  const uoms = await prisma.unitOfMeasure.findMany();
  console.log(`Found ${uoms.length} UOMs in database`);

  let aliasCount = 0;

  // Step 2: Create canonical aliases (code + name as primary aliases)
  for (const uom of uoms) {
    const canonicalAliases = [
      { alias: uom.code.toUpperCase(), uomCode: uom.code, isPrimary: true },
      { alias: uom.name.toUpperCase(), uomCode: uom.code, isPrimary: true }
    ];

    for (const aliasData of canonicalAliases) {
      await prisma.uomAlias.upsert({
        where: { alias: aliasData.alias },
        update: { isPrimary: aliasData.isPrimary },
        create: aliasData
      });
      aliasCount++;
    }
  }

  console.log(`Created ${aliasCount} canonical aliases`);

  // Step 3: Create common variation aliases
  let variationCount = 0;
  for (const [uomCode, aliases] of Object.entries(COMMON_ALIASES)) {
    // Check if this UOM exists
    const uomExists = await prisma.unitOfMeasure.findUnique({
      where: { code: uomCode }
    });

    if (!uomExists) {
      console.log(`⚠️  Skipping aliases for ${uomCode} (UOM not found in database)`);
      continue;
    }

    // Create aliases
    for (const alias of aliases) {
      const normalizedAlias = alias.toUpperCase();

      try {
        await prisma.uomAlias.upsert({
          where: { alias: normalizedAlias },
          update: { uomCode, isPrimary: false },
          create: { alias: normalizedAlias, uomCode, isPrimary: false }
        });
        variationCount++;
      } catch (error: any) {
        if (error.code === 'P2003') {
          console.log(`⚠️  Foreign key constraint failed for ${normalizedAlias} → ${uomCode}`);
        } else {
          console.error(`Error creating alias ${normalizedAlias}:`, error.message);
        }
      }
    }
  }

  console.log(`Created ${variationCount} variation aliases`);

  // Step 4: Summary
  const totalAliases = await prisma.uomAlias.count();
  const primaryAliases = await prisma.uomAlias.count({ where: { isPrimary: true } });
  const secondaryAliases = await prisma.uomAlias.count({ where: { isPrimary: false } });

  console.log('\n✅ UOM alias seeding complete!');
  console.log(`   Total aliases: ${totalAliases}`);
  console.log(`   Primary (canonical): ${primaryAliases}`);
  console.log(`   Secondary (variations): ${secondaryAliases}`);

  // Show some examples
  console.log('\n📋 Sample alias mappings:');
  const samples = await prisma.uomAlias.findMany({
    where: { isPrimary: false },
    include: { uom: true },
    take: 5
  });

  for (const sample of samples) {
    console.log(`   "${sample.alias}" → ${sample.uom.code} (${sample.uom.name})`);
  }
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
