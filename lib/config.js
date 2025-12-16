// Lumen Clew - Configuration Constants (Node.js version)

export const API_BASE_URL = process.env.API_URL || 'https://lumen-clew-backend.onrender.com';

export const ENDPOINTS = {
  scan: `${API_BASE_URL}/api/scan`,
};

export const CONFIG = {
  API_BASE_URL,
  API_SCAN_ENDPOINT: ENDPOINTS.scan,

  // Claude
  CLAUDE_MODEL: 'claude-sonnet-4-5-20250929',
  CLAUDE_MAX_TOKENS: 1000,
  CLAUDE_TEMPERATURE: 0.7,

  // GitHub
  GITHUB_URL_PATTERN: /^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\/?$/,

  // Repo limits
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

  // Scan modes
  FAST_SCAN: {
    maxFiles: 300,
    cloneDepth: 1,
    totalTimeoutMs: 90000,
    eslintTimeoutMs: 20000,
    npmAuditTimeoutMs: 15000,
    secretsScanTimeoutMs: 10000,
    a11yTimeoutMs: 20000,
    claudeTranslationTimeoutMs: 20000,
  },

  FULL_SCAN: {
    maxFiles: 999999,
    cloneDepth: 1,
    totalTimeoutMs: 180000,
    eslintTimeoutMs: 45000,
    npmAuditTimeoutMs: 30000,
    secretsScanTimeoutMs: 30000,
    a11yTimeoutMs: 45000,
    claudeTranslationTimeoutMs: 20000,
  },

  // Rate limiting
  MAX_SCANS_PER_DAY: 10,
  RATE_LIMIT_RESET_HOUR_UTC: 0,

  // Findings limits
  MAX_FINDINGS_PER_PANEL: 25,
};
