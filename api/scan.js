import { orchestrateScan } from '../utils/orchestrateScan.js';

function extractClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const firstIp = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : forwardedFor.split(',')[0];
    return firstIp.trim();
  }

  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  if (req.ip) {
    return req.ip;
  }

  return 'anonymous';
}

function validateScanRequest(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    errors.push({ field: 'body', message: 'Request body is required' });
    return errors;
  }

  const { repoUrl, scanMode } = body;

  if (!repoUrl) {
    errors.push({ field: 'repoUrl', message: 'repoUrl is required' });
  } else if (typeof repoUrl !== 'string') {
    errors.push({ field: 'repoUrl', message: 'repoUrl must be a string' });
  } else if (!repoUrl.includes('github.com')) {
    errors.push({ field: 'repoUrl', message: 'repoUrl must be a GitHub URL' });
  }

  if (scanMode !== undefined) {
    if (scanMode !== 'fast' && scanMode !== 'full') {
      errors.push({
        field: 'scanMode',
        message: "scanMode must be 'fast' or 'full'",
      });
    }
  }

  return errors;
}

function getHttpStatus(result) {
  if (result.status === 'success' || result.status === 'partial') {
    return 200;
  }

  const errorCode = result.error?.code;
  switch (errorCode) {
    case 'RATE_LIMIT_EXCEEDED':
      return 429;
    case 'INVALID_GITHUB_URL':
      return 400;
    case 'REPO_NOT_FOUND':
      return 404;
    case 'CLONE_TIMEOUT':
      return 504;
    default:
      return 500;
  }
}

export async function handleScanRequest(req, res) {
  try {
    const validationErrors = validateScanRequest(req.body);
    if (validationErrors.length > 0) {
      res.status(400).json({
        status: 'error',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: validationErrors,
        },
        rateLimit: null,
      });
      return;
    }

    const { repoUrl, scanMode = 'fast' } = req.body;
    const clientIp = extractClientIp(req);

    const result = await orchestrateScan({
      repoUrl,
      scanMode,
      clientIp,
    });

    const httpStatus = getHttpStatus(result);
    res.status(httpStatus).json(result);
  } catch (error) {
    console.error('Unexpected error in handleScanRequest:', error);
    res.status(500).json({
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
      rateLimit: null,
    });
  }
}

export default handleScanRequest;
