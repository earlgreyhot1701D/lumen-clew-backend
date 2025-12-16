import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { validateGithubUrl } from '../lib/validateGithubUrl.js';
import { fetchGitHubRepo, cleanupDir } from './gitHubFetcher.js';
import { runESLint } from './runESLint.js';
import { runNpmAudit } from './runNpmAudit.js';
import { runSecretsScanner } from './runSecretsScanner.js';
import { runA11yAnalyzer } from './runA11yAnalyzer.js';
import { translateAllPanels } from './claudeTranslator.js';
import { CONFIG } from '../lib/config.js';

const logger = {
  debug: (...args) => {
    if (process.env.DEBUG === 'true') console.log('[DEBUG]', ...args);
  },
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

// Rate Limiting
const rateLimitMap = new Map();

function getTodayUTC() {
  return new Date().toISOString().split('T')[0];
}

function getResetTimeISO() {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(CONFIG.RATE_LIMIT_RESET_HOUR_UTC, 0, 0, 0);
  return tomorrow.toISOString();
}

function checkRateLimit(clientIp) {
  const today = getTodayUTC();
  const entry = rateLimitMap.get(clientIp);

  if (!entry || entry.resetDate !== today) {
    return {
      scansToday: 0,
      maxScansPerDay: CONFIG.MAX_SCANS_PER_DAY,
      resetTime: getResetTimeISO(),
      remaining: CONFIG.MAX_SCANS_PER_DAY,
      canScan: true,
    };
  }

  const remaining = Math.max(0, CONFIG.MAX_SCANS_PER_DAY - entry.count);
  return {
    scansToday: entry.count,
    maxScansPerDay: CONFIG.MAX_SCANS_PER_DAY,
    resetTime: getResetTimeISO(),
    remaining,
    canScan: remaining > 0,
  };
}

function incrementRateLimit(clientIp) {
  const today = getTodayUTC();
  const entry = rateLimitMap.get(clientIp);

  if (!entry || entry.resetDate !== today) {
    rateLimitMap.set(clientIp, { count: 1, resetDate: today });
  } else {
    entry.count += 1;
  }
}

async function runToolSafely(toolName, fn) {
  try {
    const result = await fn();
    logger.info(`${toolName} completed: ${result.findings.length} findings`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`${toolName} crashed: ${message}`);
    return {
      success: false,
      findings: [],
      error: `${toolName} crashed: ${message}`,
    };
  }
}

function calculateStatus(panelResults) {
  const statuses = panelResults.map((p) => p.status);

  if (statuses.every((s) => s === 'skipped')) {
    return 'error';
  }

  if (statuses.some((s) => s === 'partial' || s === 'skipped')) {
    return 'partial';
  }

  return 'success';
}

function buildPanelResult(panel, toolResult, translatedFindings) {
  if (!toolResult.success) {
    return {
      panel,
      status: 'partial',
      findingCount: 0,
      findings: [],
      statusReason: 'tool_error',
      errorMessage: toolResult.error,
    };
  }

  return {
    panel,
    status: 'success',
    findingCount: translatedFindings.length,
    findings: translatedFindings,
  };
}

export async function orchestrateScan(args) {
  const { repoUrl, scanMode = 'fast', clientIp = 'anonymous' } = args;
  const scanId = randomUUID();
  const startTime = Date.now();
  let tempDir = null;

  logger.info(`Starting scan ${scanId} for ${repoUrl} (mode: ${scanMode})`);

  try {
    // Step 1: Validate GitHub URL
    const validation = validateGithubUrl(repoUrl);
    if (!validation.isValid) {
      logger.warn(`Invalid URL: ${validation.error}`);
      return {
        status: 'error',
        error: { code: 'INVALID_GITHUB_URL', message: validation.error },
        rateLimit: checkRateLimit(clientIp),
      };
    }
    const normalizedUrl = validation.normalizedUrl;

    // Step 2: Check Rate Limit
    const rateLimit = checkRateLimit(clientIp);
    if (!rateLimit.canScan) {
      logger.warn(`Rate limit exceeded for ${clientIp}`);
      return {
        status: 'error',
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Daily scan limit (${CONFIG.MAX_SCANS_PER_DAY}) reached. Resets at midnight UTC.`,
        },
        rateLimit,
      };
    }

    // Step 3: Clone Repository
    logger.info('Cloning repository...');
    const fetchResult = await fetchGitHubRepo(normalizedUrl, scanMode);

    if (!fetchResult.success) {
      logger.error(`Clone failed: ${fetchResult.error}`);
      return {
        status: 'error',
        error: {
          code: 'REPO_NOT_FOUND',
          message: fetchResult.error || 'Failed to fetch repository',
        },
        rateLimit: checkRateLimit(clientIp),
      };
    }

    tempDir = fetchResult.tempDir;
    logger.info(`Repository cloned to ${tempDir}`);

    // Step 4: Build ScanScope
    const scanScope = {
      maxFilesAllowed:
        scanMode === 'fast'
          ? CONFIG.FAST_SCAN.maxFiles
          : CONFIG.FULL_SCAN.maxFiles,
      maxFileSizeMb: CONFIG.MAX_FILE_SIZE_MB,
      ignoredDirectories: CONFIG.FILES_TO_IGNORE,
      filesCounted: fetchResult.fileCount || 0,
      filesScanned: fetchResult.filesScanned || 0,
      filesSkipped: fetchResult.filesSkipped || 0,
    };

    // Step 5: Run All Analyzers
    const scanConfig = scanMode === 'fast' ? CONFIG.FAST_SCAN : CONFIG.FULL_SCAN;
    const hasPackageJson = fs.existsSync(path.join(tempDir, 'package.json'));

    logger.info('Running analyzers...');
    const [eslintResult, npmAuditResult, secretsResult, a11yResult] =
      await Promise.all([
        runToolSafely('ESLint', () =>
          runESLint(tempDir, scanConfig.eslintTimeoutMs)
        ),
        hasPackageJson
          ? runToolSafely('npm audit', () =>
              runNpmAudit(tempDir, scanConfig.npmAuditTimeoutMs)
            )
          : Promise.resolve({ success: true, findings: [], error: undefined }),
        runToolSafely('Secrets Scanner', () =>
          runSecretsScanner(tempDir, scanConfig.secretsScanTimeoutMs)
        ),
        runToolSafely('A11y Analyzer', () =>
          runA11yAnalyzer(tempDir, scanConfig.a11yTimeoutMs)
        ),
      ]);

    if (!hasPackageJson) {
      logger.info('Skipping npm audit - no package.json found');
    }

    // Step 6: Translate All Findings
    logger.info('Translating findings...');
    const panelsMap = new Map([
      ['code_quality', eslintResult.findings],
      ['dependencies', npmAuditResult.findings],
      ['secrets', secretsResult.findings],
      ['accessibility', a11yResult.findings],
    ]);

    const translationResults = await translateAllPanels(panelsMap);

    // Step 7: Assemble Panel Results
    const codeQualityTranslation = translationResults.get('code_quality');
    const dependenciesTranslation = translationResults.get('dependencies');
    const secretsTranslation = translationResults.get('secrets');
    const accessibilityTranslation = translationResults.get('accessibility');

    const codeQualityPanel = buildPanelResult(
      'code_quality',
      eslintResult,
      codeQualityTranslation?.findings || []
    );
    const dependenciesPanel = buildPanelResult(
      'dependencies',
      npmAuditResult,
      dependenciesTranslation?.findings || []
    );
    const secretsPanel = buildPanelResult(
      'secrets',
      secretsResult,
      secretsTranslation?.findings || []
    );
    const accessibilityPanel = buildPanelResult(
      'accessibility',
      a11yResult,
      accessibilityTranslation?.findings || []
    );

    // Handle translation failures
    if (codeQualityTranslation?.status === 'failed') {
      codeQualityPanel.status = 'partial';
      codeQualityPanel.statusReason = 'translation_error';
    }
    if (dependenciesTranslation?.status === 'failed') {
      dependenciesPanel.status = 'partial';
      dependenciesPanel.statusReason = 'translation_error';
    }
    if (secretsTranslation?.status === 'failed') {
      secretsPanel.status = 'partial';
      secretsPanel.statusReason = 'translation_error';
    }
    if (accessibilityTranslation?.status === 'failed') {
      accessibilityPanel.status = 'partial';
      accessibilityPanel.statusReason = 'translation_error';
    }

    // Step 8: Assemble Final Report
    const allPanels = [
      codeQualityPanel,
      dependenciesPanel,
      secretsPanel,
      accessibilityPanel,
    ];
    const overallStatus = calculateStatus(allPanels);

    const partialReasons = [];
    if (eslintResult.error) partialReasons.push(`ESLint: ${eslintResult.error}`);
    if (npmAuditResult.error)
      partialReasons.push(`npm audit: ${npmAuditResult.error}`);
    if (secretsResult.error)
      partialReasons.push(`Secrets: ${secretsResult.error}`);
    if (a11yResult.error) partialReasons.push(`A11y: ${a11yResult.error}`);

    const scanDuration = Date.now() - startTime;

    const report = {
      id: scanId,
      repoUrl: normalizedUrl,
      scanMode,
      status: overallStatus,
      partialReasons: partialReasons.length > 0 ? partialReasons : undefined,
      scanScope,
      panels: {
        codeQuality: codeQualityPanel,
        dependencies: dependenciesPanel,
        secrets: secretsPanel,
        accessibility: accessibilityPanel,
      },
      orientationNote:
        'This scan provides awareness of potential areas to explore. ' +
        'Static analysis has limitations—use these findings as starting points for reflection, not definitive judgments.',
      clonedAt: new Date().toISOString(),
      scanDuration,
    };

    // Step 9: Increment Rate Limit on Success
    incrementRateLimit(clientIp);

    logger.info(
      `Scan ${scanId} completed in ${scanDuration}ms with status: ${overallStatus}`
    );

    return {
      status: overallStatus,
      report,
      rateLimit: checkRateLimit(clientIp),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Scan ${scanId} crashed: ${message}`);

    return {
      status: 'error',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred during the scan.',
      },
      rateLimit: checkRateLimit(clientIp),
    };
  } finally {
    if (tempDir) {
      logger.info(`Cleaning up ${tempDir}`);
      try {
        cleanupDir(tempDir);
      } catch (cleanupError) {
        logger.error(`Failed to cleanup ${tempDir}`, cleanupError);
      }
    }
  }
}
