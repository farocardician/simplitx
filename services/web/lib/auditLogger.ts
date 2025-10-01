/**
 * PII-Safe Audit Logger for Buyer Resolution
 * Logs resolution decisions without exposing sensitive information
 */

export interface BuyerResolutionAuditLog {
  timestamp: string;
  jobId: string;
  partyId: string | null;
  confidence: number | null;
  thresholdBand: 'exact' | 'auto' | 'confirm' | 'unresolved' | 'data_error';
  decisionPath: 'auto' | 'confirmed' | 'override' | 'unresolved' | 'error';
  candidateCount?: number;
  hasTies?: boolean;
}

/**
 * Log buyer resolution decision
 * @param data - Audit log data (PII-safe, no TIN/email/address)
 */
export function auditBuyerResolution(data: BuyerResolutionAuditLog): void {
  const logEntry = {
    ...data,
    timestamp: new Date().toISOString(),
    _type: 'buyer_resolution'
  };

  // In production, this should go to a proper logging service (e.g., Winston, Pino, CloudWatch)
  console.log('[AUDIT] Buyer Resolution:', JSON.stringify(logEntry));

  // Future: Send to audit database table or logging service
  // await prisma.auditLog.create({ data: logEntry });
}

/**
 * Log buyer resolution attempt (GET endpoint)
 */
export function auditResolutionAttempt(
  jobId: string,
  status: 'resolved' | 'candidates' | 'unresolved' | 'conflict' | 'data_error' | 'locked',
  confidence: number | null,
  candidateCount: number = 0,
  hasTies: boolean = false
): void {
  let thresholdBand: BuyerResolutionAuditLog['thresholdBand'];
  let decisionPath: BuyerResolutionAuditLog['decisionPath'];

  if (status === 'resolved') {
    if (confidence === 1.0) {
      thresholdBand = 'exact';
      decisionPath = 'auto';
    } else if (confidence && confidence >= 0.92) {
      thresholdBand = 'auto';
      decisionPath = 'auto';
    } else {
      thresholdBand = 'confirm';
      decisionPath = 'auto'; // Will be confirmed later
    }
  } else if (status === 'candidates') {
    thresholdBand = confidence && confidence >= 0.92 ? 'auto' : 'confirm';
    decisionPath = 'unresolved';
  } else if (status === 'unresolved') {
    thresholdBand = 'unresolved';
    decisionPath = 'unresolved';
  } else {
    thresholdBand = 'data_error';
    decisionPath = 'error';
  }

  auditBuyerResolution({
    timestamp: new Date().toISOString(),
    jobId,
    partyId: null,
    confidence,
    thresholdBand,
    decisionPath,
    candidateCount,
    hasTies
  });
}

/**
 * Log buyer resolution confirmation (POST endpoint)
 */
export function auditResolutionConfirmation(
  jobId: string,
  partyId: string,
  confidence: number,
  isOverride: boolean = false
): void {
  const thresholdBand: BuyerResolutionAuditLog['thresholdBand'] =
    confidence === 1.0 ? 'exact' :
    confidence >= 0.92 ? 'auto' : 'confirm';

  auditBuyerResolution({
    timestamp: new Date().toISOString(),
    jobId,
    partyId,
    confidence,
    thresholdBand,
    decisionPath: isOverride ? 'override' : 'confirmed'
  });
}
