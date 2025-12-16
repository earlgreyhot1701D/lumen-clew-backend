import { CONFIG } from '../lib/config.js';

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

function buildFallback(rawFindings, panel, reason) {
  return rawFindings.map((raw) => ({
    id: raw.id,
    panel,
    plainLanguage: raw.message,
    context: `This finding was detected by automated analysis${raw.file ? ` in ${raw.file}` : ''}.`,
    importance: mapSeverityToImportance(raw.severity),
    reflection: 'Consider reviewing this in the context of your specific project needs.',
    staticAnalysisNote: `Translation unavailable (${reason}). Showing original finding.`,
  }));
}

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

  const systemPrompt = getSystemPromptFor(panel);
  const userPrompt = `Translate these ${panel} findings into warm, educational language.

For each finding, return a JSON object with:
- plainLanguage: A clear, jargon-free explanation (1-2 sentences)
- context: Why this matters and what it might affect
- importance: One of "fyi", "note", "explore", or "important"
- reflection: A thoughtful question or consideration for the developer
- commonApproaches: (optional) Array of 2-3 common ways teams handle this
- staticAnalysisNote: (optional) Limitations of automated detection

Return a JSON array of translated findings.

Findings to translate:
${JSON.stringify(capped, null, 2)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.FAST_SCAN.claudeTranslationTimeoutMs);

  try {
    logger.info(`Translating ${capped.length} findings for ${panel}`);

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
      logger.error(`Claude API error for ${panel}: ${response.status}`, errorText);
      return {
        panel,
        findings: buildFallback(capped, panel, 'CLAUDE_API_ERROR'),
        status: 'failed',
        statusReason: 'CLAUDE_API_ERROR',
        truncated,
        originalCount,
        translatedCount: 0,
      };
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';

    if (!content) {
      logger.warn(`Empty response from Claude for ${panel}`);
      return {
        panel,
        findings: buildFallback(capped, panel, 'EMPTY_RESPONSE'),
        status: 'failed',
        statusReason: 'EMPTY_RESPONSE',
        truncated,
        originalCount,
        translatedCount: 0,
      };
    }

    const parsed = parseClaudeResponse(content);
    const translated = [];

    for (let i = 0; i < capped.length; i++) {
      const rawFinding = capped[i];
      const parsedObj = parsed[i];
      const validated = validateTranslatedFinding(parsedObj, rawFinding.id);

      if (validated) {
        validated.panel = panel;
        validated.importance = mapSeverityToImportance(rawFinding.severity);
        translated.push(validated);
      } else {
        translated.push({
          id: rawFinding.id,
          panel,
          plainLanguage: rawFinding.message,
          context: `This finding was detected by automated analysis${rawFinding.file ? ` in ${rawFinding.file}` : ''}.`,
          importance: mapSeverityToImportance(rawFinding.severity),
          reflection: 'Consider reviewing this in the context of your specific project needs.',
          staticAnalysisNote: 'Partial translation - showing original finding.',
        });
      }
    }

    const translatedCount = translated.filter(t => !t.staticAnalysisNote?.includes('Partial translation')).length;
    const status = translatedCount === capped.length ? 'success' : translatedCount > 0 ? 'partial' : 'failed';

    logger.info(`Translated ${translatedCount}/${capped.length} findings for ${panel}`);

    return {
      panel,
      findings: translated,
      status,
      statusReason: status !== 'success' ? 'partial_parse' : undefined,
      truncated,
      originalCount,
      translatedCount,
    };

  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      logger.error(`Claude API timeout for ${panel}`);
      return {
        panel,
        findings: buildFallback(capped, panel, 'CLAUDE_TIMEOUT'),
        status: 'failed',
        statusReason: 'CLAUDE_TIMEOUT',
        truncated,
        originalCount,
        translatedCount: 0,
      };
    }

    logger.error(`Unexpected error translating ${panel}`, error);
    return {
      panel,
      findings: buildFallback(capped, panel, 'UNEXPECTED_ERROR'),
      status: 'failed',
      statusReason: 'UNEXPECTED_ERROR',
      truncated,
      originalCount,
      translatedCount: 0,
    };
  }
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
