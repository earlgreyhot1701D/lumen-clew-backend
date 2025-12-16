// render-backend/utils/claudeTranslator.js
// Updated: December 16, 2025
// Changes: Added batching to ensure full translation of all findings

import { CONFIG } from '../lib/config.js';

// ============================================
// BATCHING CONFIGURATION
// ============================================
// Max 8 findings per Claude API call ensures:
// - Reliable JSON output (no truncation)
// - ~1,200 tokens per batch (well under 4000 limit)
// - Fast response times from Haiku
const BATCH_SIZE = 8;

const logger = {
  debug(message, data) {
    if (process.env.DEBUG === 'true') {
      console.debug(`[LumenClew] DEBUG ${message}`, data ?? '');
    }
  },
  info(message, data) {
    console.info(`[LumenClew] INFO ${message}`, data ?? '');
  },
  warn(message, data) {
    console.warn(`[LumenClew] WARN ${message}`, data ?? '');
  },
  error(message, data) {
    console.error(`[LumenClew] ERROR ${message}`, data ?? '');
  },
};

export function mapSeverityToImportance(severity) {
  const mapping = {
    critical: 'important',
    high: 'explore',
    medium: 'note',
    low: 'fyi',
  };
  return mapping[severity] || 'note';
}

function capFindingsBySeverity(findings, maxCount = CONFIG.MAX_FINDINGS_PER_PANEL) {
  const originalCount = findings.length;
  if (findings.length <= maxCount) {
    return { capped: findings, truncated: false, originalCount };
  }

  const severityOrder = ['critical', 'high', 'medium', 'low'];
  const sorted = [...findings].sort((a, b) => {
    return severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity);
  });

  return {
    capped: sorted.slice(0, maxCount),
    truncated: true,
    originalCount,
  };
}

function getSystemPromptFor(panel) {
  const basePrompt = `You are a supportive code mentor helping developers understand their codebase. 
Your tone is warm, educational, and encouraging - like a senior developer guiding a colleague.
Never use shame, fear, or urgency. Focus on awareness and reflection, not directives.
Always acknowledge that static analysis has limitations and context matters.`;

  const panelPrompts = {
    code_quality: `${basePrompt}

You're translating ESLint findings about code quality and maintainability.
Focus on:
- Why consistent patterns help teams collaborate
- How certain patterns might affect future maintenance
- The trade-offs between different approaches
Acknowledge that style choices are often team decisions, not universal truths.`,

    dependencies: `${basePrompt}

You're translating npm audit findings about dependency vulnerabilities.
Focus on:
- What the vulnerability means in plain language
- Whether it's likely to affect this specific project (many vulnerabilities require specific conditions)
- How dependency updates work and their trade-offs
Normalize that all projects have some vulnerabilities - it's about informed prioritization.`,

    secrets: `${basePrompt}

You're translating findings about potential secrets or credentials in code.
Focus on:
- What was detected and why it might be sensitive
- That false positives are common (test data, example values, etc.)
- General best practices for credential management
Remove any shame - accidental commits happen to everyone. Focus on awareness.`,

    accessibility: `${basePrompt}

You're translating accessibility findings from static analysis.
Focus on:
- Who might be affected and how
- The underlying accessibility principle
- That automated tools catch ~30% of issues - manual testing matters too
Add context that accessibility is a journey, not a checklist.`,
  };

  return panelPrompts[panel];
}

function validateTranslatedFinding(obj, originalId) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }

  const finding = obj;

  if (typeof finding.plainLanguage !== 'string' || !finding.plainLanguage.trim()) {
    return null;
  }
  if (typeof finding.context !== 'string' || !finding.context.trim()) {
    return null;
  }
  if (typeof finding.reflection !== 'string' || !finding.reflection.trim()) {
    return null;
  }

  const validImportance = ['fyi', 'note', 'explore', 'important'];
  const importance = validImportance.includes(finding.importance)
    ? finding.importance
    : 'note';

  const validPanels = ['code_quality', 'dependencies', 'secrets', 'accessibility'];
  const panel = validPanels.includes(finding.panel)
    ? finding.panel
    : 'code_quality';

  const maxLen = 500;
  const trimString = (s) => s.length > maxLen ? s.slice(0, maxLen) + '...' : s;

  const validated = {
    id: originalId,
    panel,
    plainLanguage: trimString(finding.plainLanguage.trim()),
    context: trimString(finding.context.trim()),
    importance,
    reflection: trimString(finding.reflection.trim()),
  };

  if (Array.isArray(finding.commonApproaches)) {
    validated.commonApproaches = finding.commonApproaches
      .filter((a) => typeof a === 'string')
      .slice(0, 5)
      .map(a => trimString(a.trim()));
  }

  if (typeof finding.staticAnalysisNote === 'string') {
    validated.staticAnalysisNote = trimString(finding.staticAnalysisNote.trim());
  }

  return validated;
}

function parseClaudeResponse(text) {
  // Tier 1: Direct JSON parse
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.findings)) return parsed.findings;
      if (Array.isArray(parsed.translations)) return parsed.translations;
      if (Array.isArray(parsed.results)) return parsed.results;
      return [parsed];
    }
  } catch {
    // Continue to tier 2
  }

  // Tier 2: Extract array from text
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Continue to tier 3
    }
  }

  // Tier 3: Extract individual objects
  const objects = [];
  const objectRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let match;
  while ((match = objectRegex.exec(text)) !== null) {
    try {
      objects.push(JSON.parse(match[0]));
    } catch {
      // Skip invalid objects
    }
  }

  return objects;
}

/**
 * buildFallback: Creates fallback findings when translation fails
 * ✅ PRESERVES: file, line, column from raw findings
 */
function buildFallback(rawFindings, panel, reason) {
  return rawFindings.map((raw) => ({
    id: raw.id,
    panel,
    plainLanguage: raw.message,
    context: `This finding was detected by automated analysis${raw.file ? ` in ${raw.file}` : ''}.`,
    importance: mapSeverityToImportance(raw.severity),
    reflection: 'Consider reviewing this in the context of your specific project needs.',
    staticAnalysisNote: `Translation unavailable (${reason}). Showing original finding.`,
    file: raw.file,
    line: raw.line,
    column: raw.column,
  }));
}

/**
 * translateBatch: Translates a single batch of findings (≤ BATCH_SIZE)
 * Returns: { findings: TranslatedFinding[], matchedCount: number, fallbackCount: number }
 */
async function translateBatch(panel, batchFindings, batchIndex, apiKey) {
  const systemPrompt = getSystemPromptFor(panel);
  
  const userPrompt = `Translate these ${panel} findings into warm, educational language.

IMPORTANT: You MUST return exactly ${batchFindings.length} translations, one for each input finding.
Each translation MUST include the original finding's "id" field so we can match them.

For each finding, return a JSON object with:
- id: The EXACT id from the input finding (REQUIRED - copy it exactly)
- plainLanguage: A clear, jargon-free explanation (1-2 sentences)
- context: Why this matters and what it might affect
- importance: One of "fyi", "note", "explore", or "important"
- reflection: A thoughtful question or consideration for the developer
- commonApproaches: (optional) Array of 2-3 common ways teams handle this
- staticAnalysisNote: (optional) Limitations of automated detection

Return a JSON array of ${batchFindings.length} translated findings. Do not skip any findings.

Findings to translate:
${JSON.stringify(batchFindings, null, 2)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.FAST_SCAN.claudeTranslationTimeoutMs);

  try {
    logger.debug(`[${panel}] Batch ${batchIndex + 1}: Translating ${batchFindings.length} findings`);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CONFIG.CLAUDE_MODEL,
        max_tokens: CONFIG.CLAUDE_MAX_TOKENS,
        messages: [
          { role: 'user', content: userPrompt },
        ],
        system: systemPrompt,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      logger.error(`[${panel}] Batch ${batchIndex + 1}: Claude API error ${response.status}`, errorText);
      return {
        findings: buildFallback(batchFindings, panel, 'CLAUDE_API_ERROR'),
        matchedCount: 0,
        fallbackCount: batchFindings.length,
      };
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';

    if (!content) {
      logger.warn(`[${panel}] Batch ${batchIndex + 1}: Empty response from Claude`);
      return {
        findings: buildFallback(batchFindings, panel, 'EMPTY_RESPONSE'),
        matchedCount: 0,
        fallbackCount: batchFindings.length,
      };
    }

    const parsed = parseClaudeResponse(content);
    
    // Build a map of Claude's translations keyed by ID
    const translationMap = new Map();
    for (const item of parsed) {
      if (item && typeof item === 'object' && item.id) {
        // Case-insensitive ID matching for robustness
        translationMap.set(String(item.id).toLowerCase(), item);
      }
    }
    
    logger.debug(`[${panel}] Batch ${batchIndex + 1}: Parsed ${parsed.length} items, mapped ${translationMap.size} by ID`);
    
    const translated = [];
    let matchedCount = 0;
    let fallbackCount = 0;

    // Match by ID (case-insensitive)
    for (const rawFinding of batchFindings) {
      const lookupId = String(rawFinding.id).toLowerCase();
      const parsedObj = translationMap.get(lookupId);
      const validated = validateTranslatedFinding(parsedObj, rawFinding.id);

      if (validated) {
        // SUCCESS: Claude translation matched by ID
        validated.panel = panel;
        validated.importance = mapSeverityToImportance(rawFinding.severity);
        validated.file = rawFinding.file;
        validated.line = rawFinding.line;
        validated.column = rawFinding.column;
        translated.push(validated);
        matchedCount++;
      } else {
        // FALLBACK: No matching translation found for this ID
        translated.push({
          id: rawFinding.id,
          panel,
          plainLanguage: rawFinding.message,
          context: `This finding was detected by automated analysis${rawFinding.file ? ` in ${rawFinding.file}` : ''}.`,
          importance: mapSeverityToImportance(rawFinding.severity),
          reflection: 'Consider reviewing this in the context of your specific project needs.',
          staticAnalysisNote: 'Partial translation - showing original finding.',
          file: rawFinding.file,
          line: rawFinding.line,
          column: rawFinding.column,
        });
        fallbackCount++;
        logger.debug(`[${panel}] Batch ${batchIndex + 1}: No match for ID: ${rawFinding.id}`);
      }
    }

    logger.debug(`[${panel}] Batch ${batchIndex + 1}: ${matchedCount} matched, ${fallbackCount} fallback`);

    return { findings: translated, matchedCount, fallbackCount };

  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      logger.error(`[${panel}] Batch ${batchIndex + 1}: Claude API timeout`);
      return {
        findings: buildFallback(batchFindings, panel, 'CLAUDE_TIMEOUT'),
        matchedCount: 0,
        fallbackCount: batchFindings.length,
      };
    }

    logger.error(`[${panel}] Batch ${batchIndex + 1}: Unexpected error`, error);
    return {
      findings: buildFallback(batchFindings, panel, 'UNEXPECTED_ERROR'),
      matchedCount: 0,
      fallbackCount: batchFindings.length,
    };
  }
}

/**
 * translatePanel: Orchestrates batched translation for a panel
 * Splits findings into batches of BATCH_SIZE and translates in parallel
 */
export async function translatePanel(panel, rawFindings) {
  if (!rawFindings || rawFindings.length === 0) {
    logger.debug(`No findings to translate for ${panel}`);
    return {
      panel,
      findings: [],
      status: 'success',
      originalCount: 0,
      translatedCount: 0,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error(`Missing ANTHROPIC_API_KEY for ${panel} translation`);
    return {
      panel,
      findings: buildFallback(rawFindings, panel, 'MISSING_API_KEY'),
      status: 'failed',
      statusReason: 'MISSING_API_KEY',
      originalCount: rawFindings.length,
      translatedCount: 0,
    };
  }

  const { capped, truncated, originalCount } = capFindingsBySeverity(rawFindings);

  // Split findings into batches
  const batches = [];
  for (let i = 0; i < capped.length; i += BATCH_SIZE) {
    batches.push(capped.slice(i, i + BATCH_SIZE));
  }

  logger.info(`Translating ${capped.length} findings for ${panel} in ${batches.length} batch(es)`);

  // Translate all batches in parallel
  const batchResults = await Promise.all(
    batches.map((batch, index) => translateBatch(panel, batch, index, apiKey))
  );

  // Combine results from all batches
  const allFindings = batchResults.flatMap(r => r.findings);
  const totalMatched = batchResults.reduce((sum, r) => sum + r.matchedCount, 0);
  const totalFallback = batchResults.reduce((sum, r) => sum + r.fallbackCount, 0);

  const status = totalMatched === capped.length ? 'success' 
               : totalMatched > 0 ? 'partial' 
               : 'failed';

  logger.info(`[${panel}] Translation complete: ${totalMatched}/${capped.length} matched, ${totalFallback} fallback`);

  return {
    panel,
    findings: allFindings,
    status,
    statusReason: status !== 'success' ? 'partial_parse' : undefined,
    truncated,
    originalCount,
    translatedCount: totalMatched,
  };
}

export async function translateAllPanels(panelsMap) {
  const panels = ['code_quality', 'dependencies', 'secrets', 'accessibility'];

  logger.info('Starting parallel translation for all panels');

  const results = await Promise.all(
    panels.map(async (panel) => {
      const findings = panelsMap.get(panel) || [];
      const result = await translatePanel(panel, findings);
      return { panel, result };
    })
  );

  const resultsMap = new Map();
  for (const { panel, result } of results) {
    resultsMap.set(panel, result);
  }

  logger.info('Completed parallel translation for all panels');

  return resultsMap;
}
