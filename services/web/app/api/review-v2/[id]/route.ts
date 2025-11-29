import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';
import { updateInvoiceCompleteness } from '@/lib/invoiceCompleteness';

type RoundingRule = {
  scale: number;
  mode: 'half_up';
};

type RoundingConfig = {
  qty: RoundingRule;
  unit_price: RoundingRule;
  tax_base: RoundingRule;
  other_tax_base: RoundingRule;
  vat: RoundingRule;
};

type ItemInput = {
  id?: string;
  description: string;
  qty: number;
  unit_price: number;
  hs_code: string;
  uom: string;
  type: 'Barang' | 'Jasa';
};

type ItemValidationError = {
  index: number;
  field: string;
  message: string;
  detail?: string;
};

function loadConfig(configName: string): any {
  const configDir = process.env.CONFIG_DIR;

  if (!configDir) {
    throw new Error('CONFIG_DIR environment variable is not set');
  }

  if (!configName) {
    throw new Error('Config name is required');
  }

  try {
    const configPath = join(configDir, configName);
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to load config from ${configDir}/${configName}: ${error}`);
  }
}

function roundValue(value: number, rule: RoundingRule): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const factor = Math.pow(10, rule.scale);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

const normalizeHsCode = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return null;
  return digits.slice(0, 6).padEnd(6, '0');
};

const normalizeType = (value: string | null | undefined): 'Barang' | 'Jasa' | null => {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  if (upper === 'JASA' || upper === 'B') return 'Jasa';
  if (upper === 'BARANG' || upper === 'A') return 'Barang';
  return null;
};

const getVatRate = (config: any): number => {
  const raw = config?.tax?.vat_rate ?? config?.vat_rate;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('VAT rate missing or invalid in config');
  }
  return parsed;
};

function ensureRounding(config: any): RoundingConfig {
  const fallback: RoundingConfig = {
    qty: { scale: 3, mode: 'half_up' },
    unit_price: { scale: 2, mode: 'half_up' },
    tax_base: { scale: 2, mode: 'half_up' },
    other_tax_base: { scale: 2, mode: 'half_up' },
    vat: { scale: 2, mode: 'half_up' }
  };

  if (!config || typeof config !== 'object' || !config.rounding) {
    return fallback;
  }

  const mergeRule = (rule: any, defaults: RoundingRule): RoundingRule => ({
    scale: typeof rule?.scale === 'number' ? rule.scale : defaults.scale,
    mode: rule?.mode === 'half_up' ? 'half_up' : defaults.mode
  });

  return {
    qty: mergeRule(config.rounding.qty, fallback.qty),
    unit_price: mergeRule(config.rounding.unit_price, fallback.unit_price),
    tax_base: mergeRule(config.rounding.tax_base, fallback.tax_base),
    other_tax_base: mergeRule(config.rounding.other_tax_base, fallback.other_tax_base),
    vat: mergeRule(config.rounding.vat, fallback.vat)
  };
}

async function getHsCodeTypes(code: string): Promise<Set<'BARANG' | 'JASA'>> {
  const rows = await prisma.$queryRaw<{ type: 'BARANG' | 'JASA' }[]>`
    SELECT type FROM hs_codes WHERE code = ${code} LIMIT 5
  `;
  return new Set(rows.map(r => r.type));
}

export const GET = withSession(async (_req: NextRequest, _session: { sessionId: string }, { params }: { params: { id: string } }) => {
  const invoiceId = params.id;

  // First, get the invoice to find its job_id
  const invoiceRows = await prisma.$queryRaw<{ id: string; invoice_number: string; tax_invoice_date: Date | null; buyer_party_id: string | null; job_id: string | null }[]>`
    SELECT id, invoice_number, tax_invoice_date, buyer_party_id, job_id::text as job_id
    FROM tax_invoices
    WHERE id::text = ${invoiceId}
    LIMIT 1
  `;

  if (invoiceRows.length === 0) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Invoice not found' } },
      { status: 404 }
    );
  }

  const invoice = invoiceRows[0];

  // Get the config name from job_config
  if (!invoice.job_id) {
    return NextResponse.json(
      { error: { code: 'NO_JOB_CONFIG', message: 'Invoice is not linked to any job/config' } },
      { status: 400 }
    );
  }

  const jobConfigRows = await prisma.$queryRaw<{ config_name: string }[]>`
    SELECT config_name FROM job_config WHERE job_id = ${invoice.job_id}::uuid LIMIT 1
  `;

  if (jobConfigRows.length === 0) {
    return NextResponse.json(
      { error: { code: 'CONFIG_NOT_FOUND', message: `Configuration not found for job ${invoice.job_id}` } },
      { status: 400 }
    );
  }

  const configName = jobConfigRows[0].config_name;

  // Load the config
  const config = loadConfig(configName);
  const sellerName = config?.queue?.seller_name || 'Seller';
  const rounding = ensureRounding(config);
  let configVatRate: number;
  try {
    configVatRate = getVatRate(config);
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'CONFIG_ERROR', message: (err as Error).message || 'VAT rate missing in config' } },
      { status: 500 }
    );
  }

  const itemRows = await prisma.$queryRaw<{
    id: string;
    line_number: number;
    opt: string | null;
    code: string;
    name: string;
    unit: string;
    price: any;
    qty: any;
    tax_base: any;
    other_tax_base: any;
    vat_rate: any;
    vat: any;
  }[]>`
    SELECT id, line_number, opt, code, name, unit, price, qty, tax_base, other_tax_base, vat_rate, vat
    FROM tax_invoice_items
    WHERE tax_invoice_id::text = ${invoiceId}
    ORDER BY line_number ASC
  `;

  const items = itemRows.map((row, index) => ({
    id: row.id,
    orderKey: index,
    no: row.line_number ?? index + 1,
    description: row.name || '',
    qty: parseFloat(String(row.qty ?? 0)),
    unit_price: parseFloat(String(row.price ?? 0)),
    amount: parseFloat(String(row.tax_base ?? 0)),
    hs_code: row.code || '',
    uom: row.unit || '',
    type: normalizeType(row.opt) ?? 'Barang',
    taxRate: parseFloat(String(row.vat_rate ?? configVatRate)) || configVatRate
  }));

  return NextResponse.json({
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.tax_invoice_date ? invoice.tax_invoice_date.toISOString().slice(0, 10) : '',
    seller_name: sellerName,
    rounding,
    items
  });
});

export const POST = withSession(async (req: NextRequest, _session: { sessionId: string }, { params }: { params: { id: string } }) => {
  try {
    const invoiceId = params.id;
    const body = await req.json().catch(() => ({}));
    const items: ItemInput[] = Array.isArray(body?.items) ? body.items : [];
    const invoiceNumberRaw: string = typeof body?.invoice_number === 'string' ? body.invoice_number.trim() : '';
    const invoiceDateRaw: string = typeof body?.invoice_date === 'string' ? body.invoice_date.trim() : '';

    if (!invoiceNumberRaw) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Invoice number is required' } },
        { status: 400 }
      );
    }

    if (!invoiceDateRaw) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Invoice date is required' } },
        { status: 400 }
      );
    }

    const parsedDate = new Date(invoiceDateRaw);
    if (Number.isNaN(parsedDate.getTime())) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Invoice date is invalid' } },
        { status: 400 }
      );
    }

    const invoiceRows = await prisma.$queryRaw<{ id: string; buyer_party_id: string | null }[]>`
      SELECT id, buyer_party_id FROM tax_invoices WHERE id::text = ${invoiceId} LIMIT 1
    `;

    if (invoiceRows.length === 0) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Invoice not found' } },
        { status: 404 }
      );
    }
    const buyerPartyId = invoiceRows[0].buyer_party_id;

    const conflictRows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM tax_invoices
      WHERE invoice_number = ${invoiceNumberRaw}
        AND buyer_party_id::text IS NOT DISTINCT FROM ${buyerPartyId}
        AND id::text != ${invoiceId}
      LIMIT 1
    `;

    if (conflictRows.length > 0) {
      return NextResponse.json(
        { error: { code: 'DUPLICATE_INVOICE', message: 'Another invoice with this number already exists for the same buyer' } },
        { status: 400 }
      );
    }

    if (items.length === 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'At least one line item is required' } },
        { status: 400 }
      );
    }

    const config = loadConfig();
    const rounding = ensureRounding(config);
    let vatRate: number;
    try {
      vatRate = getVatRate(config);
    } catch (err) {
      return NextResponse.json(
        { error: { code: 'CONFIG_ERROR', message: (err as Error).message || 'VAT rate missing in config' } },
        { status: 500 }
      );
    }

    const itemErrors: ItemValidationError[] = [];
    const validated: Array<{
      description: string;
      qty: number;
      unit_price: number;
      tax_base: number;
      other_tax_base: number;
      vat_rate: number;
      vat: number;
      hs_code: string;
      uom: string;
      opt: string;
    }> = [];

    const hsTypeCache = new Map<string, Set<'BARANG' | 'JASA'>>();

    const ensureHsMatches = async (code: string, normalizedType: 'BARANG' | 'JASA'): Promise<boolean> => {
      if (hsTypeCache.has(code)) {
        return hsTypeCache.get(code)!.has(normalizedType);
      }
      const types = await getHsCodeTypes(code);
      hsTypeCache.set(code, types);
      return types.has(normalizedType);
    };

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const currentErrors: ItemValidationError[] = [];

      if (!item.description || typeof item.description !== 'string' || item.description.trim() === '') {
        currentErrors.push({
          index,
          field: 'description',
          message: 'Description is required',
          detail: 'Enter a meaningful item description so it can be classified correctly.'
        });
      }

      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty < 0) {
        currentErrors.push({
          index,
          field: 'qty',
          message: 'Quantity must be a non-negative number',
          detail: 'Provide quantity using digits only; negative values are not allowed.'
        });
      }

      const unitPrice = Number(item.unit_price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        currentErrors.push({
          index,
          field: 'unit_price',
          message: 'Unit price must be a non-negative number',
          detail: 'Provide unit price using digits only; negative values are not allowed.'
        });
      }

      const normalizedType = normalizeType(item.type);
      if (!normalizedType) {
        currentErrors.push({
          index,
          field: 'type',
          message: 'Type is required',
          detail: 'Choose Barang (A) or Jasa (B).'
        });
      }

      const hsCode = normalizeHsCode(item.hs_code);
      if (!hsCode) {
        currentErrors.push({
          index,
          field: 'hs_code',
          message: 'HS code must be 6 digits',
          detail: 'Enter a 6-digit HS code; only digits are allowed.'
        });
      }

      if (!item.uom || typeof item.uom !== 'string' || item.uom.trim() === '') {
        currentErrors.push({
          index,
          field: 'uom',
          message: 'UOM is required',
          detail: 'Select a valid unit of measure.'
        });
      }

      if (currentErrors.length === 0 && normalizedType && hsCode) {
        const matches = await ensureHsMatches(hsCode, normalizedType === 'Barang' ? 'BARANG' : 'JASA');
        if (!matches) {
          currentErrors.push({
            index,
            field: 'hs_code',
            message: 'HS code type does not match',
            detail: 'The HS code belongs to a different type. Change the type or HS code so they match.'
          });
        }
      }

      if (currentErrors.length > 0) {
        itemErrors.push(...currentErrors);
        continue;
      }

      const roundedQty = roundValue(qty, rounding.qty);
      const roundedUnitPrice = roundValue(unitPrice, rounding.unit_price);
      const taxBase = roundValue(roundedQty * roundedUnitPrice, rounding.tax_base);
      const otherTaxBase = roundValue(((vatRate - 1) / vatRate) * taxBase, rounding.other_tax_base);
      const vat = roundValue(otherTaxBase * (vatRate / 100), rounding.vat);

      validated.push({
        description: item.description.trim(),
        qty: roundedQty,
        unit_price: roundedUnitPrice,
        tax_base: taxBase,
        other_tax_base: otherTaxBase,
        vat_rate: vatRate,
        vat,
        hs_code: hsCode!,
        uom: item.uom,
        opt: normalizedType === 'Jasa' ? 'B' : 'A'
      });
    }

    if (itemErrors.length > 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_ITEMS', message: 'One or more items are invalid', details: { items: itemErrors } } },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE tax_invoices
        SET invoice_number = ${invoiceNumberRaw},
            ref_desc = ${invoiceNumberRaw},
            tax_invoice_date = ${parsedDate},
            updated_at = NOW()
        WHERE id::text = ${invoiceId}
      `;

      await tx.$executeRaw`
        DELETE FROM tax_invoice_items
        WHERE tax_invoice_id::text = ${invoiceId}
      `;

      for (let i = 0; i < validated.length; i++) {
        const v = validated[i];
        await tx.$executeRaw`
          INSERT INTO tax_invoice_items (
            tax_invoice_id,
            line_number,
            opt,
            code,
            name,
            unit,
            price,
            qty,
            total_discount,
            tax_base,
            other_tax_base,
            vat_rate,
            vat,
            stlg_rate,
            stlg
          )
          VALUES (
            CAST(${invoiceId} AS uuid),
            ${i + 1},
            ${v.opt},
            ${v.hs_code},
            ${v.description},
            ${v.uom},
            ${v.unit_price},
            ${v.qty},
            0,
            ${v.tax_base},
            ${v.other_tax_base},
            ${v.vat_rate},
            ${v.vat},
            NULL,
            NULL
          )
        `;
      }

    });

    // Recalculate and update completeness status after transaction completes
    await updateInvoiceCompleteness(invoiceId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Review V2 save error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to save review' } },
      { status: 500 }
    );
  }
});
