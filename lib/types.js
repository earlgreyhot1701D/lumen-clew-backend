// Lumen Clew - Type exports for JSDoc
// These are used for documentation only in JavaScript

/**
 * @typedef {'low' | 'medium' | 'high' | 'critical'} Severity
 * @typedef {'fyi' | 'note' | 'explore' | 'important'} Importance
 * @typedef {'code_quality' | 'dependencies' | 'secrets' | 'accessibility'} PanelType
 * @typedef {'eslint' | 'npm_audit' | 'secrets_regex' | 'a11y_analyzer'} ToolType
 */

/**
 * @typedef {Object} RawFinding
 * @property {string} id
 * @property {PanelType} panel
 * @property {ToolType} tool
 * @property {Severity} severity
 * @property {string} message
 * @property {string} [file]
 * @property {number} [line]
 * @property {number} [column]
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} TranslatedFinding
 * @property {string} id
 * @property {PanelType} panel
 * @property {string} plainLanguage
 * @property {string} context
 * @property {string[]} [commonApproaches]
 * @property {Importance} importance
 * @property {string} reflection
 * @property {string} [staticAnalysisNote]
 */

export {};
