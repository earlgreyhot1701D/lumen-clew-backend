import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../lib/config.js';

const logger = {
  debug: (msg, data) => process.env.DEBUG && console.debug(`[GitHubFetcher] ${msg}`, data ?? ''),
  info: (msg, data) => console.info(`[GitHubFetcher] ${msg}`, data ?? ''),
  warn: (msg, data) => console.warn(`[GitHubFetcher] ${msg}`, data ?? ''),
  error: (msg, data) => console.error(`[GitHubFetcher] ${msg}`, data ?? ''),
  time: (label) => {
    const start = Date.now();
    return () => console.debug(`[GitHubFetcher] ${label}: ${Date.now() - start}ms`);
  },
};

const GITHUB_URL_REGEX = /github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/?$/;

// Build headers with optional GitHub token
function getGitHubHeaders() {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'LumenClew/1.0',
  };

  // Add token if available (increases rate limit from 60/hr to 5000/hr)
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    logger.debug('Using GitHub token for authentication');
  } else {
    logger.warn('No GITHUB_TOKEN found - using unauthenticated requests (60/hr limit)');
  }

  return headers;
}

function isAllowedFile(filePath) {
  for (const ignored of CONFIG.FILES_TO_IGNORE) {
    if (filePath.startsWith(ignored) || filePath.includes(`/${ignored}`)) {
      return false;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  return CONFIG.ALLOWED_FILE_TYPES.includes(ext);
}

async function downloadFile(owner, repo, filePath, targetDir) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filePath}`;
  const targetPath = path.join(targetDir, filePath);

  try {
    const parentDir = path.dirname(targetPath);
    fs.mkdirSync(parentDir, { recursive: true });

    // Use token for raw content too if available
    const headers = getGitHubHeaders();
    
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      logger.warn(`Failed to download ${filePath}: ${response.status}`);
      return false;
    }

    const content = await response.text();
    fs.writeFileSync(targetPath, content, 'utf-8');
    return true;
  } catch (error) {
    logger.warn(`Error downloading ${filePath}:`, error);
    return false;
  }
}

export function cleanupDir(tempDir) {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      logger.debug(`Cleaned up temp directory: ${tempDir}`);
    }
  } catch (error) {
    logger.warn(`Failed to cleanup temp directory ${tempDir}:`, error);
  }
}

export async function fetchGitHubRepo(repoUrl, scanMode = 'fast') {
  const endTimer = logger.time('fetchGitHubRepo');

  const match = repoUrl.match(GITHUB_URL_REGEX);
  if (!match) {
    return {
      success: false,
      error: 'Invalid GitHub URL format',
    };
  }

  const [, owner, repo] = match;
  logger.info(`Fetching repository: ${owner}/${repo} (mode: ${scanMode})`);

  const tempDir = `/tmp/lumen-${Date.now()}`;
  try {
    fs.mkdirSync(tempDir, { recursive: true });
  } catch (error) {
    return {
      success: false,
      error: `Failed to create temp directory: ${error}`,
    };
  }

  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
  let treeData;

  try {
    const headers = getGitHubHeaders();
    
    const response = await fetch(treeUrl, {
      headers,
      signal: AbortSignal.timeout(30000),
    });

    if (response.status === 404) {
      cleanupDir(tempDir);
      return {
        success: false,
        error: 'Repository not found (404)',
      };
    }

    if (response.status === 403) {
      cleanupDir(tempDir);
      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
      const rateLimitReset = response.headers.get('x-ratelimit-reset');
      
      if (rateLimitRemaining === '0') {
        const resetTime = rateLimitReset 
          ? new Date(parseInt(rateLimitReset) * 1000).toISOString()
          : 'unknown';
        
        return {
          success: false,
          error: process.env.GITHUB_TOKEN 
            ? `GitHub API rate limit exceeded. Resets at ${resetTime}`
            : `GitHub API rate limit exceeded (60/hr for unauthenticated requests). Add GITHUB_TOKEN to increase limit to 5000/hr. Resets at ${resetTime}`,
        };
      }
      
      return {
        success: false,
        error: 'GitHub API access forbidden (403)',
      };
    }

    if (!response.ok) {
      cleanupDir(tempDir);
      return {
        success: false,
        error: `GitHub API error: ${response.status} ${response.statusText}`,
      };
    }

    treeData = await response.json();
  } catch (error) {
    cleanupDir(tempDir);
    if (error instanceof Error && error.name === 'TimeoutError') {
      return {
        success: false,
        error: 'GitHub API request timed out',
      };
    }
    return {
      success: false,
      error: `Failed to fetch repository tree: ${error}`,
    };
  }

  const maxFiles = scanMode === 'fast' 
    ? CONFIG.FAST_SCAN.maxFiles 
    : CONFIG.FULL_SCAN.maxFiles;
  const maxFileSizeBytes = CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024;

  const allFiles = treeData.tree.filter((item) => item.type === 'blob');
  const allowedFiles = allFiles.filter((item) => isAllowedFile(item.path));
  const sizedFiles = allowedFiles.filter(
    (item) => !item.size || item.size <= maxFileSizeBytes
  );

  const filesToDownload = sizedFiles.slice(0, maxFiles);

  logger.info(`Files: ${allFiles.length} total, ${allowedFiles.length} allowed, ${filesToDownload.length} to download`);

  let filesScanned = 0;
  let filesSkipped = 0;

  for (const file of filesToDownload) {
    const success = await downloadFile(owner, repo, file.path, tempDir);
    if (success) {
      filesScanned++;
    } else {
      filesSkipped++;
    }
  }

  const totalSkipped = allFiles.length - filesScanned;

  endTimer();

  logger.info(`Fetch complete: ${filesScanned} scanned, ${totalSkipped} skipped`);

  return {
    success: true,
    tempDir,
    fileCount: allFiles.length,
    filesScanned,
    filesSkipped: totalSkipped,
  };
}
