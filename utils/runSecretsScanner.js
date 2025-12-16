import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { CONFIG } from '../lib/config.js';

const logger = {
  debug: (msg, data) => process.env.DEBUG && console.debug(`[Secrets] ${msg}`, data ?? ''),
  info: (msg, data) => console.info(`[Secrets] ${msg}`, data ?? ''),
  warn: (msg, data) => console.warn(`[Secrets] ${msg}`, data ?? ''),
  error: (msg, data) => console.error(`[Secrets] ${msg}`, data ?? ''),
};

const SECRET_PATTERNS = [
  {
    id: 'private_key',
    name: 'Private Key',
    regex: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    baseSeverity: 'critical',
  },
  {
    id: 'aws_key',
    name: 'AWS Access Key',
    regex: /AKIA[0-9A-Z]{16}/,
    baseSeverity: 'critical',
  },
  {
    id: 'db_connection_mongo',
    name: 'MongoDB Connection String',
    regex: /mongodb(\+srv)?:\/\/[^:]+:[^@]+@/,
    baseSeverity: 'high',
  },
  {
    id: 'db_connection_postgres',
    name: 'PostgreSQL Connection String',
    regex: /postgres(ql)?:\/\/[^:]+:[^@]+@/,
    baseSeverity: 'high',
  },
  {
    id: 'db_connection_mysql',
    name: 'MySQL Connection String',
    regex: /mysql:\/\/[^:]+:[^@]+@/,
    baseSeverity: 'high',
  },
  {
    id: 'api_key_generic',
    name: 'Generic API Key',
    regex: /['"]?api[_-]?key['"]?\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/i,
    baseSeverity: 'high',
  },
  {
    id: 'bearer_token',
    name: 'Bearer Token',
    regex: /['"]?Bearer\s+[a-zA-Z0-9_\-\.]{20,}['"]?/,
    baseSeverity: 'high',
  },
  {
    id: 'token_generic',
    name: 'Generic Token',
    regex: /['"]?token['"]?\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/i,
    baseSeverity: 'medium',
  },
];

function generateFindingId(patternId, file, line) {
  const input = `secrets:secrets_regex:${patternId}:${file}:${line}`;
  return createHash('sha256').update(input).digest('hex').substring(0, 16);
}

function determineSeverity(pattern, filePath) {
  const fileName = path.basename(filePath).toLowerCase();
  
  if (fileName.includes('.example') || fileName.includes('.sample') || fileName.includes('.template')) {
    return 'low';
  }
  
  if (fileName === '.env' || fileName.startsWith('.env.')) {
    return 'critical';
  }
  
  if (filePath.includes('test') || filePath.includes('spec') || filePath.includes('__tests__')) {
    return 'medium';
  }
  
  return pattern.baseSeverity;
}

function shouldScanFile(filePath) {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  
  for (const ignore of CONFIG.FILES_TO_IGNORE) {
    if (filePath.includes(ignore)) {
      return false;
    }
  }
  
  if (fileName.startsWith('.env')) {
    return true;
  }
  
  if (ext && !CONFIG.ALLOWED_FILE_TYPES.includes(ext)) {
    return false;
  }
  
  return true;
}

function scanFileForSecrets(tempDir, filePath, findings) {
  const relativePath = filePath.replace(tempDir, '').replace(/^\//, '');
  let secretsFound = 0;
  
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024) {
      logger.debug(`Skipping large file: ${relativePath}`);
      return 0;
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(line)) {
          secretsFound++;
          
          if (findings.length >= CONFIG.MAX_FINDINGS_PER_PANEL) {
            continue;
          }
          
          const severity = determineSeverity(pattern, filePath);
          
          const finding = {
            id: generateFindingId(pattern.id, relativePath, lineNum + 1),
            panel: 'secrets',
            tool: 'secrets_regex',
            severity,
            message: `Possible ${pattern.name} detected`,
            file: relativePath,
            line: lineNum + 1,
            column: 0,
            metadata: {
              patternId: pattern.id,
              patternName: pattern.name,
              baseSeverity: pattern.baseSeverity,
              contextSeverity: severity,
            },
          };
          
          findings.push(finding);
        }
      }
    }
  } catch (readError) {
    logger.debug(`Error reading file ${relativePath}: ${readError.message}`);
  }
  
  return secretsFound;
}

function walkDirectory(dir, tempDir, findings, startTime, timeoutMs) {
  let filesScanned = 0;
  let secretsFound = 0;
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (Date.now() - startTime > timeoutMs) {
        return { filesScanned, secretsFound, timedOut: true };
      }
      
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        if (CONFIG.FILES_TO_IGNORE.includes(entry.name)) {
          continue;
        }
        
        const subResult = walkDirectory(fullPath, tempDir, findings, startTime, timeoutMs);
        filesScanned += subResult.filesScanned;
        secretsFound += subResult.secretsFound;
        
        if (subResult.timedOut) {
          return { filesScanned, secretsFound, timedOut: true };
        }
      } else if (entry.isFile()) {
        if (shouldScanFile(fullPath)) {
          filesScanned++;
          secretsFound += scanFileForSecrets(tempDir, fullPath, findings);
        }
      }
    }
  } catch (readDirError) {
    logger.debug(`Error reading directory ${dir}: ${readDirError.message}`);
  }
  
  return { filesScanned, secretsFound, timedOut: false };
}

export function runSecretsScanner(tempDir, timeoutMs = CONFIG.FAST_SCAN.secretsScanTimeoutMs) {
  const startTime = Date.now();
  
  logger.info(`runSecretsScanner: Starting scan of ${tempDir}`);
  
  if (!tempDir || !fs.existsSync(tempDir)) {
    logger.error('runSecretsScanner: tempDir does not exist');
    return {
      success: true,
      findings: [],
      error: 'Scan directory does not exist',
    };
  }
  
  try {
    const findings = [];
    
    const result = walkDirectory(tempDir, tempDir, findings, startTime, timeoutMs);
    
    if (result.timedOut) {
      logger.warn(`runSecretsScanner: Timeout after scanning ${result.filesScanned} files`);
      return {
        success: true,
        findings,
        filesScanned: result.filesScanned,
        secretsFound: result.secretsFound,
        error: `Secrets scan timeout after ${timeoutMs}ms`,
      };
    }
    
    const duration = Date.now() - startTime;
    logger.info(`runSecretsScanner: Completed in ${duration}ms, scanned ${result.filesScanned} files, found ${result.secretsFound} secrets (returning ${findings.length})`);
    
    return {
      success: true,
      findings,
      filesScanned: result.filesScanned,
      secretsFound: result.secretsFound,
    };
  } catch (error) {
    logger.error('runSecretsScanner: Unexpected error', error.message);
    return {
      success: true,
      findings: [],
      error: `Unexpected error: ${error.message}`,
    };
  }
}
