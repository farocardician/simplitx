import { NextRequest, NextResponse } from 'next/server';
import { enrichProductDescription, enrichBatch } from '@/lib/productEnrichment';
import type { HsCodeType } from '@prisma/client';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const SETTINGS_FILE = join(process.cwd(), '.settings', 'enrichment.json');
const DEFAULT_THRESHOLD = 0.80;

async function loadThreshold(): Promise<number> {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const content = await readFile(SETTINGS_FILE, 'utf-8');
      const settings = JSON.parse(content);
      return settings.threshold ?? DEFAULT_THRESHOLD;
    }
  } catch (error) {
    console.error('Error loading threshold:', error);
  }
  return DEFAULT_THRESHOLD;
}

/**
 * POST /api/products/enrich
 *
 * Enriches a product description or batch of descriptions
 * Returns matched product and auto-fill decision based on score threshold
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Check if batch request
    if (Array.isArray(body)) {
      return await handleBatchEnrichment(body);
    }

    // Single enrichment request
    const { description, invoiceId, lineItemIndex, threshold, createdBy } = body;

    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'description is required and must be a non-empty string' } },
        { status: 400 }
      );
    }

    if (threshold !== undefined && (typeof threshold !== 'number' || threshold < 0 || threshold > 1)) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'threshold must be a number between 0 and 1' } },
        { status: 400 }
      );
    }

    // Use provided threshold or load from settings
    const effectiveThreshold = threshold !== undefined ? threshold : await loadThreshold();

    const result = await enrichProductDescription({
      description: description.trim(),
      invoiceId,
      lineItemIndex,
      threshold: effectiveThreshold,
      createdBy,
    });

    return NextResponse.json(result);

  } catch (error) {
    console.error('Error enriching product description:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to enrich product description' } },
      { status: 500 }
    );
  }
}

/**
 * Handles batch enrichment requests
 */
async function handleBatchEnrichment(requests: any[]) {
  if (requests.length === 0) {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'batch requests cannot be empty' } },
      { status: 400 }
    );
  }

  if (requests.length > 100) {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'batch size cannot exceed 100 items' } },
      { status: 400 }
    );
  }

  // Validate all requests
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    if (!req.description || typeof req.description !== 'string' || req.description.trim().length === 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: `request at index ${i}: description is required` } },
        { status: 400 }
      );
    }
  }

  try {
    const results = await enrichBatch(requests);

    return NextResponse.json({
      total: results.length,
      autoFilled: results.filter(r => r.autoFilled).length,
      results,
    });

  } catch (error) {
    console.error('Error in batch enrichment:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to process batch enrichment' } },
      { status: 500 }
    );
  }
}
