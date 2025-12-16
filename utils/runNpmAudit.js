import { execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../lib/config.js';

const logger = {
  debug: (msg, data) => process.env.DEBUG && console.debug(`[NpmAudit] ${msg}`, data ?? ''),
  info: (msg, data) => console.info(`[NpmAudit] ${msg}`, data ?? ''),
  warn: (msg, data) => console.warn(`[NpmAudit] ${msg}`, data ?? ''),
  error: (msg, data) => console.error(`[NpmAudit] ${msg}`, data ?? ''),
};

function generateFindingId(packageName, severity, via) {
  const input = `dependencies:npm_audit:${packageName}:${severity}:${via}`;
  return createHash('sha256').update(input).digest('hex').substring(0, 16);
}

function mapSeverity(npmSeverity) {
  switch (npmSeverity.toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'moderate':
      return 'medium';
    case 'low':
    case 'info':
    default:
      return 'low';
  }
}

export function runNpmAudit(tempDir, timeoutMs) {
  const timeout = timeoutMs ?? CONFIG.FAST_SCAN.npmAuditTimeoutMs;
  const startTime = Date.now();

  const packageJsonPath = path.join(tempDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    logger.info('runNpmAudit: No package.json found, skipping');
    return {
      success: true,
      findings: [],
      vulnerabilityCount: 0,
    };
  }

  try {
    let stdout;

    try {
      stdout = execSync(`cd "${tempDir}" && npm audit --json`, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (execError) {
      if (execError.stdout) {
        stdout = execError.stdout;
      } else if (execError.killed || execError.signal === 'SIGTERM') {
        logger.error('runNpmAudit: Timeout exceeded');
        return {
          success: true,
          findings: [],
          error: 'npm audit timeout exceeded',
        };
      } else {
        logger.error('runNpmAudit: Execution error', execError.message);
        return {
          success: true,
          findings: [],
          error: `npm audit failed: ${execError.message}`,
        };
      }
    }

    let auditData;
    try {
      auditData = JSON.parse(stdout);
    } catch (parseError) {
      logger.error('runNpmAudit: Failed to parse npm audit JSON');
      return {
        success: true,
        findings: [],
        error: 'Failed to parse npm audit output',
      };
    }

    const vulnerabilities = auditData.vulnerabilities || {};
    const findings = [];
    let totalCount = 0;

    for (const [packageName, vuln] of Object.entries(vulnerabilities)) {
      const vulnData = vuln;
      totalCount++;

      if (findings.length >= CONFIG.MAX_FINDINGS_PER_PANEL) {
        continue;
      }

      const viaInfo = Array.isArray(vulnData.via)
        ? vulnData.via.map((v) => (typeof v === 'string' ? v : v.title || v.name || 'unknown')).join(', ')
        : String(vulnData.via || 'unknown');

      const severity = mapSeverity(vulnData.severity || 'low');

      const finding = {
        id: generateFindingId(packageName, vulnData.severity || 'low', viaInfo),
        panel: 'dependencies',
        tool: 'npm_audit',
        severity,
        message: `${packageName}: ${viaInfo}`,
        file: 'package.json',
        line: 1,
        column: 0,
        metadata: {
          packageName,
          vulnerability: viaInfo,
          npmSeverity: vulnData.severity || 'unknown',
          range: vulnData.range || '*',
          fixAvailable: vulnData.fixAvailable || false,
        },
      };

      findings.push(finding);
    }

    const duration = Date.now() - startTime;
    logger.info(`runNpmAudit: Completed in ${duration}ms, found ${totalCount} vulnerabilities (returning ${findings.length})`);

    return {
      success: true,
      findings,
      vulnerabilityCount: totalCount,
    };
  } catch (error) {
    logger.error('runNpmAudit: Unexpected error', error.message);
    return {
      success: true,
      findings: [],
      error: `Unexpected error: ${error.message}`,
    };
  }
}
