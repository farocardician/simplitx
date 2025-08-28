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
    const xmlContent = await callGateway(pdfPath, job.mapping);
    
    // Save XML result
    const resultPath = `results/${job.id}.xml`;
    await saveResult(resultPath, xmlContent);
    
    // Update job as complete
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'complete',
        resultPath,
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

async function callGateway(pdfPath, mapping) {
  const form = new FormData();
  form.append('file', createReadStream(pdfPath), {
    filename: 'document.pdf',
    contentType: 'application/pdf'
  });
  form.append('mapping', `${mapping}.json`);
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

async function saveResult(path, content) {
  const tempPath = `${path}.tmp`;
  await fs.writeFile(tempPath, content, 'utf-8');
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