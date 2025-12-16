import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CONFIG } from '../lib/config.js';

const logger = {
  debug: (msg, data) => process.env.DEBUG && console.debug(`[A11y] ${msg}`, data ?? ''),
  info: (msg, data) => console.info(`[A11y] ${msg}`, data ?? ''),
  warn: (msg, data) => console.warn(`[A11y] ${msg}`, data ?? ''),
  error: (msg, data) => console.error(`[A11y] ${msg}`, data ?? ''),
};

const A11Y_PATTERNS = [
  {
    id: 'missing_alt',
    name: 'Missing Alt Text',
    regex: /<img(?![^>]*\balt\s*=)[^>]*>/gi,
    severity: 'high',
    message: 'Image missing alt attribute for screen readers',
  },
  {
    id: 'non_semantic_button_div',
    name: 'Non-semantic Button (div)',
    regex: /<div[^>]*\bonClick\s*=/gi,
    severity: 'high',
    message: 'Div with onClick should be a button element for keyboard accessibility',
  },
  {
    id: 'non_semantic_button_role',
    name: 'Non-semantic Button (role)',
    regex: /<(?!button)[a-z]+[^>]*role\s*=\s*["']button["'][^>]*>/gi,
    severity: 'high',
    message: 'Element with role="button" should be a native button element',
  },
  {
    id: 'missing_aria_label',
    name: 'Missing ARIA Label',
    regex: /<(button|a|input)[^>]*>(\s*<[^>]+>\s*)*<\/(button|a)>/gi,
    severity: 'medium',
    message: 'Interactive element may need aria-label for screen reader context',
  },
  {
    id: 'link_without_href',
    name: 'Link Without Href',
    regex: /<a(?![^>]*\bhref\s*=)[^>]*>/gi,
    severity: 'medium',
    message: 'Anchor tag missing href attribute - not keyboard navigable',
  },
  {
    id: 'input_without_label',
    name: 'Input Without Label',
    regex: /<input(?![^>]*\b(id|aria-label|aria-labelledby)\s*=)[^>]*>/gi,
    severity: 'medium',
    message: 'Input element missing associated label or aria-label',
  },
  {
    id: 'empty_heading',
    name: 'Empty Heading',
    regex: /<h[1-6][^>]*>\s*<\/h[1-6]>/gi,
    severity: 'low',
    message: 'Empty heading element - provides no content for screen readers',
  },
];

const ALLOWED_EXTENSIONS = ['.jsx', '.tsx', '.html', '.htm'];

function generateFindingId(patternId, filePath, line) {
  const hash = crypto
    .createHash('sha256')
    .update(`${patternId}:${filePath}:${line}`)
    .digest('hex');
  return `a11y_${hash.substring(0, 12)}`;
}

function shouldAnalyzeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

function getLineNumber(content, matchIndex) {
  const lines = content.substring(0, matchIndex).split('\n');
  return lines.length;
}

function stripTempPrefix(filePath, tempDir) {
  const normalized = filePath.replace(/\\/g, '/');
  const normalizedTemp = tempDir.replace(/\\/g, '/');
  if (normalized.startsWith(normalizedTemp)) {
    return normalized.substring(normalizedTemp.length).replace(/^\//, '');
  }
  return normalized;
}

function detectHeadingHierarchyIssues(content, filePath, tempDir) {
  const findings = [];
  const headingRegex = /<h([1-6])[^>]*>/gi;
  const headings = [];

  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    headings.push({
      level: parseInt(match[1], 10),
      index: match.index,
      line: getLineNumber(content, match.index),
    });
  }

  for (let i = 1; i < headings.length; i++) {
    const current = headings[i];
    const previous = headings[i - 1];

    if (current.level > previous.level + 1) {
      const relativePath = stripTempPrefix(filePath, tempDir);
      findings.push({
        id: generateFindingId('heading_hierarchy', relativePath, current.line),
        panel: 'accessibility',
        tool: 'a11y_analyzer',
        severity: 'medium',
        message: `Heading hierarchy skip: h${previous.level} followed by h${current.level} (missing h${previous.level + 1})`,
        file: relativePath,
        line: current.line,
        metadata: {
          patternId: 'heading_hierarchy',
          previousLevel: previous.level,
          currentLevel: current.level,
          skippedLevel: previous.level + 1,
        },
      });
    }
  }

  return findings;
}

function scanFileForA11y(filePath, content, tempDir) {
  const findings = [];
  const relativePath = stripTempPrefix(filePath, tempDir);

  for (const pattern of A11Y_PATTERNS) {
    pattern.regex.lastIndex = 0;

    let match;
    while ((match = pattern.regex.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      findings.push({
        id: generateFindingId(pattern.id, relativePath, line),
        panel: 'accessibility',
        tool: 'a11y_analyzer',
        severity: pattern.severity,
        message: pattern.message,
        file: relativePath,
        line,
        metadata: {
          patternId: pattern.id,
          patternName: pattern.name,
          matchedText: match[0].substring(0, 100),
        },
      });
    }
  }

  const hierarchyFindings = detectHeadingHierarchyIssues(content, filePath, tempDir);
  findings.push(...hierarchyFindings);

  return findings;
}

function walkDirectory(dir, startTime, timeoutMs, files = []) {
  if (Date.now() - startTime > timeoutMs) {
    return files;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (Date.now() - startTime > timeoutMs) {
        break;
      }

      const fullPath = path.join(dir, entry.name);

      const shouldIgnore = CONFIG.FILES_TO_IGNORE.some((ignored) => {
        const normalizedIgnored = ignored.replace(/\/$/, '');
        return entry.name === normalizedIgnored || fullPath.includes(`/${normalizedIgnored}/`);
      });

      if (shouldIgnore) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDirectory(fullPath, startTime, timeoutMs, files);
      } else if (entry.isFile() && shouldAnalyzeFile(fullPath)) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    logger.warn(`Error reading directory ${dir}:`, error);
  }

  return files;
}

export function runA11yAnalyzer(tempDir, timeoutMs = CONFIG.FAST_SCAN.a11yTimeoutMs) {
  const startTime = Date.now();

  if (!tempDir || !fs.existsSync(tempDir)) {
    logger.warn('A11y analyzer: tempDir does not exist', { tempDir });
    return {
      success: true,
      findings: [],
      totalA11yIssues: 0,
      filesAnalyzed: 0,
      error: 'Directory not found',
    };
  }

  try {
    const files = walkDirectory(tempDir, startTime, timeoutMs);
    const allFindings = [];
    let filesAnalyzed = 0;
    let totalA11yIssues = 0;

    for (const filePath of files) {
      if (Date.now() - startTime > timeoutMs) {
        logger.info('A11y analyzer: timeout reached', {
          elapsed: Date.now() - startTime,
          filesAnalyzed,
        });
        break;
      }

      try {
        const stats = fs.statSync(filePath);
        const fileSizeMb = stats.size / (1024 * 1024);

        if (fileSizeMb > CONFIG.MAX_FILE_SIZE_MB) {
          logger.debug(`Skipping large file: ${filePath} (${fileSizeMb.toFixed(2)}MB)`);
          continue;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const fileFindings = scanFileForA11y(filePath, content, tempDir);

        totalA11yIssues += fileFindings.length;
        filesAnalyzed++;

        for (const finding of fileFindings) {
          if (allFindings.length < CONFIG.MAX_FINDINGS_PER_PANEL) {
            allFindings.push(finding);
          }
        }
      } catch (fileError) {
        logger.debug(`Error reading file ${filePath}:`, fileError);
        continue;
      }
    }

    return {
      success: true,
      findings: allFindings,
      totalA11yIssues,
      filesAnalyzed,
    };
  } catch (error) {
    logger.error('A11y analyzer unexpected error:', error);
    return {
      success: true,
      findings: [],
      totalA11yIssues: 0,
      filesAnalyzed: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
