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

    const response = await fetch(url, {
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
    const response = await fetch(treeUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'LumenClew/1.0',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (response.status === 404) {
      cleanupDir(tempDir);
      return {
        success: false,
        error: 'Repository not found (404)',
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
