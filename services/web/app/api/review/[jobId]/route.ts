import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withSession } from '@/lib/session';
import { buildInvoiceXml } from '@/lib/xmlBuilder';
import { parseInvoiceXml } from '@/lib/xmlParser';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { createUomResolverSnapshot } from '@/lib/uomResolver';
import { resolveBuyerParty, validateBuyerPartyId, type ResolvedParty, type CandidateParty } from '@/lib/partyResolver';
import { auditResolutionAttempt } from '@/lib/auditLogger';

const trxCodeDefaultCache = new Map<string, string | null>();

async function loadDefaultTrxCode(mappingName: string | null | undefined): Promise<string | null> {
  if (!mappingName) {
    return '04';
  }

  if (trxCodeDefaultCache.has(mappingName)) {
    return trxCodeDefaultCache.get(mappingName) ?? null;
  }

  try {
    const mappingPath = join(process.cwd(), '..', 'json2xml', 'mappings', `${mappingName}.json`);
    const mappingContent = await readFile(mappingPath, 'utf-8');
    const mappingJson = JSON.parse(mappingContent);
    const rawValue = mappingJson?.structure?.ListOfTaxInvoice?.TaxInvoice?.TrxCode;

    if (rawValue === null || rawValue === undefined) {
      trxCodeDefaultCache.set(mappingName, null);
      return null;
    }

    if (typeof rawValue === 'string') {
      const normalized = rawValue.trim();
      trxCodeDefaultCache.set(mappingName, normalized || null);
      return normalized || null;
    }

    trxCodeDefaultCache.set(mappingName, null);
    return null;
  } catch (error) {
    console.warn(`Failed to load mapping for TrxCode: ${mappingName}`, error);
    // Fallback to legacy default behaviour
    trxCodeDefaultCache.set(mappingName, '04');
    return '04';
  }
}

function normalizeTrxCode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeType(raw: unknown): 'Barang' | 'Jasa' {
  if (raw === null || raw === undefined) {
    return 'Barang';
  }

  const value = String(raw).trim().toUpperCase();

  if (value === 'JASA' || value === 'J' || value === 'B') {
    return 'Jasa';
  }

  return 'Barang';
}

export const GET = withSession(async (
  req: NextRequest,
  { sessionId }: { sessionId: string },
  { params }: { params: { jobId: string } }
) => {
  const jobId = params.jobId;

  try {
    // Fetch job
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        ownerSessionId: true,
        status: true,
        resultPath: true,
        buyerPartyId: true,
        buyerResolutionStatus: true,
        buyerResolutionConfidence: true,
        buyerResolutionDecidedAt: true,
        mapping: true
      }
    });

    if (!job) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Job not found' } },
        { status: 404 }
      );
    }

    // Check ownership
    if (job.ownerSessionId !== sessionId) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'Access denied' } },
        { status: 403 }
      );
    }

    // Check if job is complete
    if (job.status !== 'complete') {
      return NextResponse.json(
        { error: { code: 'NOT_READY', message: 'Job is not complete yet' } },
        { status: 400 }
      );
    }

    const defaultTrxCode = await loadDefaultTrxCode(job.mapping);

    // PHASE F: Try reading XML from resultPath first (reflects saved edits)
    let xmlData = null;
    if (job.resultPath) {
      const xmlPath = join(process.cwd(), job.resultPath);
      if (existsSync(xmlPath)) {
        try {
          const xmlContent = await readFile(xmlPath, 'utf-8');
          xmlData = parseInvoiceXml(xmlContent);
          console.log(`Loaded saved XML for job ${jobId} from ${job.resultPath}`);
        } catch (xmlError) {
          console.warn(`Failed to parse XML for job ${jobId}, falling back to parser_results:`, xmlError);
        }
      }
    }

    // Load from parser_results.final (source of truth for metadata)
    // Try by jobId first, then fallback to original filename
    let parserResult = await prisma.parserResult.findUnique({
      where: { docId: jobId },
      select: { final: true }
    });

    // Fallback: try finding by original filename (for legacy/test data)
    if (!parserResult && job.resultPath) {
      console.log(`No parser_result found for jobId ${jobId}, trying by filename...`);

      const job2 = await prisma.job.findUnique({
        where: { id: jobId },
        select: { originalFilename: true }
      });

      if (job2?.originalFilename) {
        parserResult = await prisma.parserResult.findUnique({
          where: { docId: job2.originalFilename },
          select: { final: true }
        });
      }

      // Try jobId with .pdf extension
      if (!parserResult) {
        parserResult = await prisma.parserResult.findUnique({
          where: { docId: `${jobId}.pdf` },
          select: { final: true }
        });
      }
    }

    // PHASE F: If XML was parsed, use it as primary source
    if (xmlData) {
      // Merge seller_name and SKU from parser_results if available
      const final = parserResult?.final as any;
      const sellerName = final?.seller?.name || 'Seller';

      // Create request-scoped UOM resolver snapshot
      const resolver = await createUomResolverSnapshot();

      // Merge SKU and resolve UOMs from parser_results (SKU/UOM not always in XML)
      const mergedItems = await Promise.all(
        xmlData.items.map(async (xmlItem: any, index: number) => {
          const originalItem = final?.items?.[index];

          // Resolve UOM from XML (should already be canonical, but verify)
          const rawUom = xmlItem.uom || originalItem?.uom;
          let canonical = '';
          let resolved = false;
          let warning = null;

          if (rawUom) {
            const resolution = resolver.resolve(rawUom);
            if (resolution) {
              canonical = resolution.code;
              resolved = true;
            } else {
              warning = `Unrecognized UOM: "${rawUom}". Please select from dropdown.`;
              canonical = '';
            }
          }

          return {
            ...xmlItem,
            type: normalizeType(xmlItem.type),
            sku: originalItem?.sku || xmlItem.sku || '',
            uom: canonical,
            uom_raw: rawUom || null,
            uom_resolved: resolved,
            uom_warning: warning
          };
        })
      );

      // BUYER RESOLUTION: Check if buyer already resolved (locked)
      let buyerResolved: ResolvedParty | null = null;
      let buyerCandidates: CandidateParty[] = [];
      let buyerResolutionStatus: string = 'unresolved';
      let buyerUnresolved = true;
      let buyerResolutionConfidence: number | null = null;

      if (job.buyerPartyId) {
        // Buyer already resolved - validate it still exists
        buyerResolved = await validateBuyerPartyId(job.buyerPartyId);

        if (!buyerResolved) {
          return NextResponse.json(
            { error: { code: 'PARTY_DELETED', message: 'Resolved buyer party was deleted, requires re-resolution' } },
            { status: 410 }
          );
        }

        buyerResolutionStatus = 'locked';
        buyerUnresolved = false;
        buyerResolutionConfidence = job.buyerResolutionConfidence || 1.0;

        auditResolutionAttempt(jobId, 'locked', buyerResolutionConfidence, 0, false);
      } else {
        // Run buyer resolution
        const buyerName = xmlData.buyer_name || 'Buyer';
        const resolutionResult = await resolveBuyerParty(buyerName);

        if (resolutionResult.status === 'resolved') {
          buyerResolved = resolutionResult.party;
          buyerResolutionStatus = 'auto';
          buyerUnresolved = false;
          buyerResolutionConfidence = resolutionResult.confidence;

          auditResolutionAttempt(jobId, 'resolved', resolutionResult.confidence, 0, false);
        } else if (resolutionResult.status === 'candidates') {
          buyerCandidates = resolutionResult.candidates;
          buyerResolutionStatus = 'pending_confirmation';
          buyerUnresolved = true;
          buyerResolutionConfidence = resolutionResult.topConfidence;

          auditResolutionAttempt(jobId, 'candidates', resolutionResult.topConfidence, resolutionResult.candidates.length, false);
        } else if (resolutionResult.status === 'unresolved') {
          buyerCandidates = resolutionResult.candidates;
          buyerResolutionStatus = 'pending_selection';
          buyerUnresolved = true;

          auditResolutionAttempt(jobId, 'unresolved', null, resolutionResult.candidates.length, false);
        } else if (resolutionResult.status === 'conflict') {
          return NextResponse.json(
            { error: { code: 'NAME_COLLISION', message: 'Name collision detected, requires manual resolution' } },
            { status: 409 }
          );
        } else if (resolutionResult.status === 'data_error') {
          return NextResponse.json(
            { error: { code: 'DATA_ERROR', message: resolutionResult.message } },
            { status: 500 }
          );
        }
      }

      const xmlTrxCode = normalizeTrxCode((xmlData as any).trx_code);
      const resolvedTrxCode = xmlTrxCode ?? defaultTrxCode ?? null;
      const trxCodeRequired = defaultTrxCode === null;

      return NextResponse.json({
        invoice_number: xmlData.invoice_number,
        seller_name: sellerName,
        buyer_name: xmlData.buyer_name,
        invoice_date: xmlData.invoice_date,
        items: mergedItems,
        buyer_resolved: buyerResolved,
        buyer_candidates: buyerCandidates,
        buyer_resolution_status: buyerResolutionStatus,
        buyer_unresolved: buyerUnresolved,
        buyer_resolution_confidence: buyerResolutionConfidence,
        trx_code: resolvedTrxCode,
        trx_code_required: trxCodeRequired
      });
    }

    // Fallback: Use parser_results.final if XML not available
    if (!parserResult) {
      console.error(`No parser_result found for job ${jobId}. Check stage 10 pipeline.`);
      return NextResponse.json(
        {
          error: {
            code: 'NO_DATA',
            message: 'Invoice data not found in database. The job may need to be reprocessed through stage 10.'
          }
        },
        { status: 404 }
      );
    }

    const final = parserResult.final as any;

    // Create request-scoped UOM resolver snapshot
    const resolver = await createUomResolverSnapshot();

    // Resolve UOMs for all items (batch operation)
    const items = await Promise.all(
      (final.items || []).map(async (item: any, index: number) => {
        const rawUom = item.uom;
        let canonical = '';
        let resolved = false;
        let warning = null;

        if (rawUom) {
          const resolution = resolver.resolve(rawUom);
          if (resolution) {
            canonical = resolution.code;
            resolved = true;
          } else {
            warning = `Unrecognized UOM: "${rawUom}". Please select from dropdown.`;
            // Do NOT pass through raw value
            canonical = '';
          }
        }

        return {
          no: item.no || index + 1,
          description: item.description || '',
          qty: item.qty || 0,
          unit_price: item.unit_price || 0,
          amount: item.amount || 0,
          sku: item.sku || '',
          hs_code: item.hs_code || '',
          uom: canonical,           // Canonical code or empty
          uom_raw: rawUom || null,  // Original parsed value
          uom_resolved: resolved,   // Explicit state
          uom_warning: warning,     // Explicit error
          type: normalizeType(item.type)
        };
      })
    );

    // BUYER RESOLUTION: Check if buyer already resolved (locked)
    let buyerResolved: ResolvedParty | null = null;
    let buyerCandidates: CandidateParty[] = [];
    let buyerResolutionStatus: string = 'unresolved';
    let buyerUnresolved = true;
    let buyerResolutionConfidence: number | null = null;

    if (job.buyerPartyId) {
      // Buyer already resolved - validate it still exists
      buyerResolved = await validateBuyerPartyId(job.buyerPartyId);

      if (!buyerResolved) {
        return NextResponse.json(
          { error: { code: 'PARTY_DELETED', message: 'Resolved buyer party was deleted, requires re-resolution' } },
          { status: 410 }
        );
      }

      buyerResolutionStatus = 'locked';
      buyerUnresolved = false;
      buyerResolutionConfidence = job.buyerResolutionConfidence || 1.0;

      auditResolutionAttempt(jobId, 'locked', buyerResolutionConfidence, 0, false);
    } else {
      // Run buyer resolution
      const buyerName = final.buyer?.name || 'Buyer';
      const resolutionResult = await resolveBuyerParty(buyerName);

      if (resolutionResult.status === 'resolved') {
        buyerResolved = resolutionResult.party;
        buyerResolutionStatus = 'auto';
        buyerUnresolved = false;
        buyerResolutionConfidence = resolutionResult.confidence;

        auditResolutionAttempt(jobId, 'resolved', resolutionResult.confidence, 0, false);
      } else if (resolutionResult.status === 'candidates') {
        buyerCandidates = resolutionResult.candidates;
        buyerResolutionStatus = 'pending_confirmation';
        buyerUnresolved = true;
        buyerResolutionConfidence = resolutionResult.topConfidence;

        auditResolutionAttempt(jobId, 'candidates', resolutionResult.topConfidence, resolutionResult.candidates.length, false);
      } else if (resolutionResult.status === 'unresolved') {
        buyerCandidates = resolutionResult.candidates;
        buyerResolutionStatus = 'pending_selection';
        buyerUnresolved = true;

        auditResolutionAttempt(jobId, 'unresolved', null, resolutionResult.candidates.length, false);
      } else if (resolutionResult.status === 'conflict') {
        return NextResponse.json(
          { error: { code: 'NAME_COLLISION', message: 'Name collision detected, requires manual resolution' } },
          { status: 409 }
        );
      } else if (resolutionResult.status === 'data_error') {
        return NextResponse.json(
          { error: { code: 'DATA_ERROR', message: resolutionResult.message } },
          { status: 500 }
        );
      }
    }

    const trxCodeRequired = defaultTrxCode === null;
    const resolvedTrxCode = defaultTrxCode ?? null;

    return NextResponse.json({
      invoice_number: final.invoice?.number || final.invoice_number || '',
      seller_name: final.seller?.name || 'Seller',
      buyer_name: final.buyer?.name || 'Buyer',
      invoice_date: final.invoice?.date || final.invoice_date || '',
      items,
      buyer_resolved: buyerResolved,
      buyer_candidates: buyerCandidates,
      buyer_resolution_status: buyerResolutionStatus,
      buyer_unresolved: buyerUnresolved,
      buyer_resolution_confidence: buyerResolutionConfidence,
      trx_code: resolvedTrxCode,
      trx_code_required: trxCodeRequired
    });

  } catch (error) {
    console.error('Error loading invoice data:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to load invoice data' } },
      { status: 500 }
    );
  }
});

export const POST = withSession(async (
  req: NextRequest,
  { sessionId }: { sessionId: string },
  { params }: { params: { jobId: string } }
) => {
  const jobId = params.jobId;

  try {
    // Parse request body
    const body = await req.json();
    const { invoice_number, invoice_date, items, buyer_party_id, trx_code } = body;

    if (!invoice_date || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Missing required fields: invoice_date, items' } },
        { status: 400 }
      );
    }

    // Fetch job
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        ownerSessionId: true,
        status: true,
        resultPath: true,
        buyerPartyId: true,
        buyerResolutionStatus: true,
        buyerResolutionConfidence: true,
        updatedAt: true,
        mapping: true
      }
    });

    if (!job) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Job not found' } },
        { status: 404 }
      );
    }

    // Check ownership
    if (job.ownerSessionId !== sessionId) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'Access denied' } },
        { status: 403 }
      );
    }

    // Check if job is complete
    if (job.status !== 'complete') {
      return NextResponse.json(
        { error: { code: 'NOT_READY', message: 'Job is not complete yet' } },
        { status: 400 }
      );
    }

    if (!job.resultPath) {
      return NextResponse.json(
        { error: { code: 'NO_RESULT_PATH', message: 'Job has no result path' } },
        { status: 400 }
      );
    }

    const defaultTrxCode = await loadDefaultTrxCode(job.mapping);
    const requestedTrxCode = normalizeTrxCode(trx_code);

    if (requestedTrxCode) {
      const trxCodeRecord = await prisma.transactionCode.findUnique({ where: { code: requestedTrxCode } });
      if (!trxCodeRecord) {
        return NextResponse.json(
          { error: { code: 'INVALID_TRX_CODE', message: 'Selected transaction code is invalid' } },
          { status: 400 }
        );
      }
    }

    // Load original parser_results.final to get metadata
    let parserResult = await prisma.parserResult.findUnique({
      where: { docId: jobId },
      select: { final: true }
    });

    // Fallback to legacy data
    if (!parserResult) {
      const job2 = await prisma.job.findUnique({
        where: { id: jobId },
        select: { originalFilename: true }
      });

      if (job2?.originalFilename) {
        parserResult = await prisma.parserResult.findUnique({
          where: { docId: job2.originalFilename },
          select: { final: true }
        });
      }

      // Try jobId with .pdf extension
      if (!parserResult) {
        parserResult = await prisma.parserResult.findUnique({
          where: { docId: `${jobId}.pdf` },
          select: { final: true }
        });
      }
    }

    if (!parserResult) {
      return NextResponse.json(
        { error: { code: 'NO_DATA', message: 'Invoice data not found in database' } },
        { status: 404 }
      );
    }

    const original = parserResult.final as any;

    const effectiveTrxCode = requestedTrxCode ?? defaultTrxCode ?? null;

    if (!effectiveTrxCode) {
      return NextResponse.json(
        { error: { code: 'TRX_CODE_REQUIRED', message: 'Transaction code must be selected before saving XML.' } },
        { status: 400 }
      );
    }

    // BUYER RESOLUTION VALIDATION: Ensure buyer is resolved before generating XML
    let buyerResolved: ResolvedParty | null = null;
    let buyerPartyIdToSave = buyer_party_id || job.buyerPartyId;
    let buyerConfidence: number | null = null;
    let buyerStatus: string | null = null;

    if (buyerPartyIdToSave) {
      // Validate buyer party exists
      buyerResolved = await validateBuyerPartyId(buyerPartyIdToSave);

      if (!buyerResolved) {
        return NextResponse.json(
          { error: { code: 'INVALID_BUYER_PARTY', message: 'Selected buyer party not found or has been deleted' } },
          { status: 400 }
        );
      }

      // Determine status and confidence
      if (buyer_party_id && buyer_party_id !== job.buyerPartyId) {
        // User manually selected/changed buyer
        buyerStatus = 'confirmed';
        buyerConfidence = 0.85; // Manual selection
      } else if (job.buyerPartyId) {
        // Reusing existing resolution
        buyerStatus = job.buyerResolutionStatus || 'confirmed';
        buyerConfidence = job.buyerResolutionConfidence || 1.0;
      } else {
        // First-time save with auto-resolved buyer
        buyerStatus = 'auto';
        buyerConfidence = 1.0;
      }
    } else {
      // No buyer party selected - check if resolution is required
      const buyerName = original.buyer?.name || 'Buyer';
      const resolutionResult = await resolveBuyerParty(buyerName);

      if (resolutionResult.status === 'resolved') {
        // Auto-resolved - use it
        buyerResolved = resolutionResult.party;
        buyerPartyIdToSave = buyerResolved.id;
        buyerConfidence = resolutionResult.confidence;
        buyerStatus = 'auto';
      } else {
        // Buyer must be manually resolved before saving
        return NextResponse.json(
          { error: { code: 'BUYER_UNRESOLVED', message: 'Buyer must be resolved before saving XML. Please select a buyer from the dropdown.' } },
          { status: 400 }
        );
      }
    }

    // Update job with buyer resolution
    await prisma.job.update({
      where: { id: jobId },
      data: {
        buyerPartyId: buyerPartyIdToSave,
        buyerResolutionStatus: buyerStatus,
        buyerResolutionConfidence: buyerConfidence,
        buyerResolutionDecidedAt: new Date()
      }
    });

    // Audit log the confirmation
    const { auditResolutionConfirmation } = await import('@/lib/auditLogger');
    auditResolutionConfirmation(
      jobId,
      buyerPartyIdToSave!,
      buyerConfidence!,
      buyer_party_id !== job.buyerPartyId
    );

    // Merge edited data with original metadata
    const mergedData = {
      ...original,
      trxCode: effectiveTrxCode,
      invoice: {
        ...original.invoice,
        number: invoice_number || original.invoice?.number || original.invoice?.no,
        date: invoice_date
      },
      items: items.map((item: any) => ({
        description: item.description,
        qty: item.qty,
        unit_price: item.unit_price,
        amount: item.amount,
        sku: item.sku || '',
        hs_code: item.hs_code,
        uom: item.uom,
        type: normalizeType(item.type)
      }))
    };

    // Transform to XML (with UOM and buyer validation)
    let xmlContent: string;
    try {
      xmlContent = await buildInvoiceXml(mergedData, buyerResolved!);
    } catch (xmlError: any) {
      console.error('Error building XML:', xmlError);
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: xmlError.message || 'Failed to build XML' } },
        { status: 400 }
      );
    }

    // Write to resultPath
    const filePath = join(process.cwd(), job.resultPath);

    try {
      await writeFile(filePath, xmlContent, 'utf-8');
      console.log(`Saved edited XML for job ${jobId} to ${job.resultPath}`);
    } catch (writeError: any) {
      console.error('Error writing XML file:', writeError);

      // Provide specific error messages based on error code
      let errorMessage = 'Failed to write XML file';
      if (writeError.code === 'EACCES') {
        errorMessage = 'Permission denied: Cannot write to file';
      } else if (writeError.code === 'ENOENT') {
        errorMessage = 'File path does not exist';
      } else if (writeError.code === 'ENOSPC') {
        errorMessage = 'Insufficient disk space';
      }

      return NextResponse.json(
        { error: { code: 'WRITE_ERROR', message: errorMessage } },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'XML saved successfully'
    });

  } catch (error) {
    console.error('Error saving invoice data:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to save invoice data' } },
      { status: 500 }
    );
  }
});
