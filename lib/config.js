// Lumen Clew - Configuration Constants (Node.js version)
// Updated: December 16, 2025
// Changes: Switched to Claude 3.5 Haiku for faster translations + increased timeout safety net

export const API_BASE_URL = process.env.API_URL || 'https://lumen-clew-backend.onrender.com';
export const ENDPOINTS = {
  scan: `${API_BASE_URL}/api/scan`,
};

export const CONFIG = {
  API_BASE_URL,
  API_SCAN_ENDPOINT: ENDPOINTS.scan,

  // ============================================
  // CLAUDE CONFIGURATION
  // ============================================
  // Changed to Haiku: 3-5x faster than Sonnet for translation tasks
  // Haiku is ideal for transformation/translation work (our use case)
  // while Sonnet 4.5 is overkill and slow for this specific task
  CLAUDE_MODEL: 'claude-3-5-haiku-20241022',
  CLAUDE_MAX_TOKENS: 4000,
  CLAUDE_TEMPERATURE: 0.7,

  // ============================================
  // GITHUB CONFIGURATION
  // ============================================
  GITHUB_URL_PATTERN: /^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\/?$/,

  // ============================================
  // REPOSITORY LIMITS
  // ============================================
  MAX_REPO_SIZE_MB_FOR_FULL_SCAN: 100,
  MAX_FILE_SIZE_MB: 1,
  ALLOWED_FILE_TYPES: ['.js', '.jsx', '.ts', '.tsx'],
  FILES_TO_IGNORE: [
    'node_modules/',
    'dist/',
    'build/',
    '.next/',
    'coverage/',
    '.git/',
    '.venv/',
    '__pycache__/',
    'vendor/',
    'target/'
  ],

  // ============================================
  // SCAN MODES
  // ============================================
  // FAST_SCAN: Optimized for speed (MVP default)
  // Total time target: 60-90 seconds
  FAST_SCAN: {
    maxFiles: 300,
    cloneDepth: 1,
    totalTimeoutMs: 90000,
    eslintTimeoutMs: 20000,
    npmAuditTimeoutMs: 15000,
    secretsScanTimeoutMs: 10000,
    a11yTimeoutMs: 20000,
    // CHANGED: 20000 → 45000ms
    // Why: Haiku is 3-5x faster (typically 2-5 sec), so 45 sec = 9x safety margin
    // This prevents any edge-case timeouts while maintaining speed
    // Haiku will finish in 2-5 seconds, so the extra timeout just sits unused
    claudeTranslationTimeoutMs: 45000,
  },

  // FULL_SCAN: Comprehensive analysis (post-MVP)
  // Total time target: 120-180 seconds
  FULL_SCAN: {
    maxFiles: 999999,
    cloneDepth: 1,
    totalTimeoutMs: 180000,
    eslintTimeoutMs: 45000,
    npmAuditTimeoutMs: 30000,
    secretsScanTimeoutMs: 30000,
    a11yTimeoutMs: 45000,
    // CHANGED: 20000 → 45000ms (same reasoning as FAST_SCAN)
    claudeTranslationTimeoutMs: 45000,
  },

  // ============================================
  // RATE LIMITING
  // ============================================
  // Users get 10 free scans per day (resets at midnight UTC)
  MAX_SCANS_PER_DAY: 10,
  RATE_LIMIT_RESET_HOUR_UTC: 0,

  // ============================================
  // FINDINGS LIMITS
  // ============================================
  // Max 25 findings per panel (capped by severity before translation)
  // Prevents overwhelming users and reduces API costs
  MAX_FINDINGS_PER_PANEL: 25,
};

// ============================================
// RATIONALE FOR CHANGES
// ============================================
// 
// MODEL CHANGE: Sonnet 4.5 → Haiku 3.5
// ─────────────────────────────────────────
// Previous issue: Sonnet 4.5 taking 12-20+ seconds per panel translation
// With 20-second timeout: Race condition → timeouts on 2+ panels
// 
// Solution: Switch to Claude 3.5 Haiku
// - 3-5x faster (typically 2-5 seconds per panel)
// - Excellent at transformation/translation tasks (our use case)
// - Maintains quality of "warm, educational" language
// - JSON output is reliable and well-structured
// - Reduces API latency and cost
//
// TIMEOUT CHANGE: 20000ms → 45000ms
// ─────────────────────────────────────────
// Previous: 20 seconds (caused race conditions with Sonnet)
// New: 45 seconds (9x safety margin with Haiku)
// 
// Why 45 and not 30?
// - Haiku is fast (2-5 sec), so extra buffer doesn't hurt
// - Provides insurance against any edge cases or API latency spikes
// - Better reliability during peak usage or Render slowness
// - Cost of 15 extra seconds of timeout = massive reliability gain
// - Users won't notice: Haiku finishes in 5 sec anyway
//
// Expected Results:
// - All 4 panels translate successfully (no more fallback responses)
// - Total scan time: 60-90 seconds (vs 2+ minutes before)
// - Zero timeout errors in logs
// - Better UX: users see actual translations, not raw findings
// ============================================
