import { CONFIG } from './config.js';

export function validateGithubUrl(url) {
  const trimmed = url.trim();

  if (!trimmed) {
    return { isValid: false, error: 'Please enter a GitHub repository URL' };
  }

  if (!trimmed.startsWith('https://github.com/')) {
    return { isValid: false, error: 'URL must start with https://github.com/' };
  }

  if (!CONFIG.GITHUB_URL_PATTERN.test(trimmed)) {
    return {
      isValid: false,
      error: 'Invalid GitHub repository URL format. Expected: https://github.com/owner/repo',
    };
  }

  const normalizedUrl = trimmed.replace(/\/$/, '');
  return { isValid: true, normalizedUrl };
}
