import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Common alias mappings for Indonesian UOM codes
const COMMON_ALIASES: Record<string, string[]> = {
  'UM.0021': ['PCS', 'PC', 'PCE', 'PIECES'],  // Piece
  'UM.0018': ['EA', 'UN', 'UNIT', 'UNITS'],   // Unit
  'UM.0001': ['KG', 'KILOGRAM', 'KILOGRAMS'], // Kilogram
  'UM.0002': ['G', 'GRAM', 'GRAMS'],          // Gram
  'UM.0003': ['M', 'METER', 'METERS'],        // Meter
  'UM.0004': ['CM', 'CENTIMETER'],            // Centimeter
  'UM.0005': ['L', 'LITER', 'LITERS'],        // Liter
  'UM.0006': ['ML', 'MILLILITER'],            // Milliliter
  'UM.0007': ['BOX', 'BOXES', 'BX'],          // Box
  'UM.0008': ['SET', 'SETS'],                 // Set
  'UM.0009': ['PACK', 'PACKS', 'PK'],         // Pack
  'UM.0010': ['ROLL', 'ROLLS'],               // Roll
  'UM.0011': ['SHEET', 'SHEETS', 'SH'],       // Sheet
  'UM.0012': ['PAIR', 'PAIRS', 'PR'],         // Pair
  'UM.0013': ['DOZEN', 'DOZ', 'DZ'],          // Dozen
  'UM.0014': ['CARTON', 'CARTONS', 'CTN'],    // Carton
  'UM.0015': ['BOTTLE', 'BOTTLES', 'BTL'],    // Bottle
  'UM.0016': ['CAN', 'CANS'],                 // Can
  'UM.0017': ['BAG', 'BAGS'],                 // Bag
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
