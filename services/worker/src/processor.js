const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises;
const { createReadStream } = require('fs');
const { PrismaClient } = require('@prisma/client');
const { logger } = require('./logger');
const { GatewayError } = require('./errors');

const prisma = new PrismaClient();

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:8000';
const GATEWAY_TIMEOUT = parseInt(process.env.GATEWAY_TIMEOUT || '180000');

async function processJob(job) {
  logger.info(`Processing job ${job.id}`);
  
  try {
    // Read PDF file
    const pdfPath = job.upload_path;
    if (!pdfPath) {
      throw new Error('No upload path specified');
    }
    
    // Call gateway
    // job.mapping stores the selected PDF template (frontend passes it as 'template')
    const xmlContent = await callGateway(pdfPath, job.mapping, job.id);
    
    // Save XML result
    const resultPath = `results/${job.id}.xml`;
    await saveResult(resultPath, xmlContent);
    
    // Fetch and save artifacts
    let artifactPath = null;
    try {
      const artifactZip = await fetchArtifacts(pdfPath, job.mapping, job.id);
      artifactPath = `results/${job.id}-artifacts.zip`;
      await saveResult(artifactPath, artifactZip);
      logger.info(`Job ${job.id} artifacts saved to ${artifactPath}`);
    } catch (artifactError) {
      logger.warn(`Failed to fetch artifacts for job ${job.id}:`, artifactError);
    }
    
    // Update job as complete
    // NOTE: artifactPath is intentionally not persisted from worker.
// Persist via web API or update worker Prisma schema when ready.
await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'complete',
        resultPath,
        artifactPath,
        completedAt: new Date(),
        leasedBy: null,
        leaseExpiresAt: null
      }
    });
    
    logger.info(`Job ${job.id} completed successfully`);
    
  } catch (error) {
    await handleJobError(job, error);
  }
}

async function callGateway(pdfPath, template, jobId) {
  const form = new FormData();
  form.append('file', createReadStream(pdfPath), {
    filename: 'document.pdf',
    contentType: 'application/pdf'
  });

  // Pass job_id to gateway
  if (jobId) {
    form.append('job_id', jobId);
  }

  // PDF → JSON should use the selected template (forwarded as 'template')
  if (template) {
    form.append('template', template);
  }
  // JSON → XML uses fixed mapping (do not change XML flow)
  form.append('mapping', `pt_simon_invoice_v1.json`);
  form.append('pretty', '1');
  
  const response = await axios.post(`${GATEWAY_URL}/process`, form, {
    headers: {
      ...form.getHeaders(),
      'Accept': 'application/xml'
    },
    timeout: GATEWAY_TIMEOUT,
    maxContentLength: 100 * 1024 * 1024, // 100MB
    validateStatus: null // Handle all status codes
  });
  
  if (response.status === 200) {
    return response.data;
  }
  
  // Map gateway errors to our error codes
  const errorMap = {
    400: { code: 'GW_4XX', message: 'Invalid request to gateway' },
    406: { code: 'GW_4XX', message: 'Unsupported file type or mapping' },
    413: { code: 'TOO_LARGE', message: 'File exceeds gateway limit' },
    415: { code: 'GW_4XX', message: 'Unsupported media type' },
    502: { code: 'GW_5XX', message: 'Gateway processing error' }
  };
  
  const error = errorMap[response.status] || {
    code: 'GW_5XX',
    message: `Gateway returned status ${response.status}`
  };
  
  throw new GatewayError(error.code, error.message, response.status);
}

async function fetchArtifacts(pdfPath, template, jobId) {
  const form = new FormData();
  form.append('file', createReadStream(pdfPath), {
    filename: 'document.pdf',
    contentType: 'application/pdf'
  });

  // Pass job_id to gateway
  if (jobId) {
    form.append('job_id', jobId);
  }

  if (template) {
    form.append('template', template);
  }
  
  const response = await axios.post(`${GATEWAY_URL}/process-artifacts`, form, {
    headers: {
      ...form.getHeaders()
    },
    timeout: GATEWAY_TIMEOUT,
    maxContentLength: 100 * 1024 * 1024, // 100MB
    responseType: 'arraybuffer', // Get binary data
    validateStatus: null // Handle all status codes
  });
  
  if (response.status === 200) {
    return Buffer.from(response.data);
  }
  
  // Map gateway errors to our error codes
  const errorMap = {
    400: { code: 'GW_4XX', message: 'Invalid request to gateway artifacts' },
    413: { code: 'TOO_LARGE', message: 'File exceeds gateway limit' },
    415: { code: 'GW_4XX', message: 'Unsupported media type for artifacts' },
    502: { code: 'GW_5XX', message: 'Gateway artifacts processing error' }
  };
  
  const error = errorMap[response.status] || {
    code: 'GW_5XX',
    message: `Gateway artifacts returned status ${response.status}`
  };
  
  throw new GatewayError(error.code, error.message, response.status);
}

async function saveResult(path, content) {
  const tempPath = `${path}.tmp`;
  
  if (Buffer.isBuffer(content)) {
    // Binary content (ZIP files)
    await fs.writeFile(tempPath, content);
  } else {
    // Text content (XML files)
    await fs.writeFile(tempPath, content, 'utf-8');
  }
  
  await fs.rename(tempPath, path); // Atomic write
}

async function handleJobError(job, error) {
  logger.error(`Job ${job.id} failed:`, error);
  
  let errorCode = 'UNKNOWN';
  let errorMessage = 'An unexpected error occurred';
  
  if (error instanceof GatewayError) {
    errorCode = error.code;
    errorMessage = error.message;
  } else if (error.code === 'ECONNREFUSED') {
    errorCode = 'GW_5XX';
    errorMessage = 'Gateway service unavailable';
  } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    errorCode = 'GW_TIMEOUT';
    errorMessage = 'Gateway request timed out';
  } else if (error.code === 'ENOSPC') {
    errorCode = 'IO_ERROR';
    errorMessage = 'Insufficient storage space';
  }
  
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: 'failed',
      errorCode,
      errorMessage,
      failedAt: new Date(),
      leasedBy: null,
      leaseExpiresAt: null
    }
  });
}

module.exports = {
  processJob
};
