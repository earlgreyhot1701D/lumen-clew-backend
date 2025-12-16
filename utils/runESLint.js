import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { CONFIG } from '../lib/config.js';

const logger = {
  debug: (msg, data) => process.env.DEBUG && console.debug(`[ESLint] ${msg}`, data ?? ''),
  info: (msg, data) => console.info(`[ESLint] ${msg}`, data ?? ''),
  warn: (msg, data) => console.warn(`[ESLint] ${msg}`, data ?? ''),
  error: (msg, data) => console.error(`[ESLint] ${msg}`, data ?? ''),
};

function generateFindingId(panel, tool, ruleId, file, line) {
  const input = `${panel}:${tool}:${ruleId}:${file}:${line}`;
  return createHash('sha256').update(input).digest('hex').substring(0, 16);
}

function mapSeverity(eslintSeverity) {
  return eslintSeverity === 2 ? 'high' : 'low';
}

export function runESLint(tempDir, timeoutMs = CONFIG.FAST_SCAN.eslintTimeoutMs) {
  const startTime = Date.now();

  try {
    logger.info(`Running ESLint on ${tempDir}`);

    const command = `npx eslint "${tempDir}" --format=json --ignore-path /dev/null`;
    
    let output;
    try {
      output = execSync(command, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (execError) {
      if (execError.stdout) {
        output = execError.stdout;
      } else if (execError.killed) {
        logger.error('ESLint timeout exceeded', { timeoutMs });
        return {
          success: true,
          findings: [],
          error: `ESLint timeout after ${timeoutMs}ms`,
        };
      } else {
        logger.error('ESLint execution failed', { error: execError.message });
        return {
          success: true,
          findings: [],
          error: execError.message,
        };
      }
    }

    let eslintResults;
    try {
      eslintResults = JSON.parse(output);
    } catch (parseError) {
      logger.error('Failed to parse ESLint output', { output: output.substring(0, 200) });
      return {
        success: true,
        findings: [],
        error: 'Failed to parse ESLint JSON output',
      };
    }

    const findings = [];
    let totalIssueCount = 0;

    for (const fileResult of eslintResults) {
      const relativePath = fileResult.filePath.replace(tempDir, '').replace(/^\//, '');

      for (const msg of fileResult.messages) {
        totalIssueCount++;

        if (findings.length >= CONFIG.MAX_FINDINGS_PER_PANEL) {
          continue;
        }

        const ruleId = msg.ruleId || 'unknown';
        
        const finding = {
          id: generateFindingId('code_quality', 'eslint', ruleId, relativePath, msg.line),
          panel: 'code_quality',
          tool: 'eslint',
          severity: mapSeverity(msg.severity),
          message: msg.message,
          file: relativePath,
          line: msg.line,
          column: msg.column,
          metadata: { ruleId },
        };

        findings.push(finding);
      }
    }

    const duration = Date.now() - startTime;
    logger.info(`ESLint completed in ${duration}ms: ${findings.length} findings (${totalIssueCount} total issues, capped at ${CONFIG.MAX_FINDINGS_PER_PANEL})`);

    return {
      success: true,
      findings,
      issueCount: totalIssueCount,
    };
  } catch (error) {
    logger.error('Unexpected error in runESLint', { error: error.message });
    return {
      success: true,
      findings: [],
      error: error.message,
    };
  }
}
