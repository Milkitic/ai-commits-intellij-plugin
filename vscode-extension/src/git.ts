import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as vscode from 'vscode';
import { Settings } from './config';

const execFileAsync = promisify(execFile);
const gitMaxBuffer = 80 * 1024 * 1024;

interface GitRepositoryLike {
  rootUri: vscode.Uri;
  inputBox?: {
    value: string;
  };
  state?: {
    HEAD?: {
      name?: string;
    };
  };
}

export interface RepositoryContext {
  rootUri: vscode.Uri;
  repository?: GitRepositoryLike;
}

export async function pickRepository(): Promise<RepositoryContext | undefined> {
  const repositories = await getGitRepositories();

  if (repositories.length === 1) {
    return {
      rootUri: repositories[0].rootUri,
      repository: repositories[0]
    };
  }

  if (repositories.length > 1) {
    const picked = await vscode.window.showQuickPick(
      repositories.map((repository) => ({
        label: path.basename(repository.rootUri.fsPath),
        description: repository.rootUri.fsPath,
        repository
      })),
      {
        placeHolder: 'Select the Git repository to use for AI Commits'
      }
    );

    return picked ? {
      rootUri: picked.repository.rootUri,
      repository: picked.repository
    } : undefined;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (workspaceFolders.length === 1) {
    return {
      rootUri: workspaceFolders[0].uri
    };
  }

  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select the workspace folder to use for AI Commits'
  });

  return picked ? {
    rootUri: picked.uri
  } : undefined;
}

export async function getDiff(rootUri: vscode.Uri, settings: Settings): Promise<string> {
  const changedFiles = await getChangedFiles(rootUri, settings);
  const includedFiles = changedFiles.filter((file) => !matchesAnyGlob(file, settings.exclusions));

  if (includedFiles.length === 0) {
    return '';
  }

  const args = ['diff'];
  if (settings.diffMode === 'staged') {
    args.push('--staged');
  }
  args.push('--no-ext-diff', '--no-color', '--', ...includedFiles);

  const diff = await runGit(rootUri, args, settings.timeoutSeconds);
  return diff.trim() ? `Repository: ${rootUri.fsPath}\n${diff}` : '';
}

export async function getBranch(rootUri: vscode.Uri, repository?: GitRepositoryLike): Promise<string | undefined> {
  const currentBranch = repository?.state?.HEAD?.name;
  if (currentBranch) {
    return currentBranch;
  }

  try {
    const branch = await runGit(rootUri, ['branch', '--show-current'], 15);
    if (branch.trim()) {
      return branch.trim();
    }
  } catch {
    // Fall through to detached-head fallback.
  }

  try {
    const sha = await runGit(rootUri, ['rev-parse', '--short', 'HEAD'], 15);
    return sha.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function getPreviousCommitMessages(rootUri: vscode.Uri, count: number): Promise<string[]> {
  if (count <= 0) {
    return [];
  }

  try {
    const output = await runGit(rootUri, ['log', `--max-count=${count}`, '--pretty=format:%B%x1e'], 20);
    return output
      .split('\x1e')
      .map((message) => message.trim())
      .filter(Boolean)
      .slice(0, count);
  } catch {
    return [];
  }
}

export async function setCommitInput(context: RepositoryContext, message: string): Promise<boolean> {
  const inputBox = context.repository?.inputBox;
  if (inputBox) {
    inputBox.value = message;
    await vscode.commands.executeCommand('workbench.view.scm');
    return true;
  }

  await vscode.env.clipboard.writeText(message);
  return false;
}

async function getGitRepositories(): Promise<GitRepositoryLike[]> {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) {
    return [];
  }

  const gitExtension = extension.isActive ? extension.exports : await extension.activate();
  const api = gitExtension?.getAPI?.(1);
  return Array.isArray(api?.repositories) ? api.repositories : [];
}

async function getChangedFiles(rootUri: vscode.Uri, settings: Settings): Promise<string[]> {
  const args = ['diff'];
  if (settings.diffMode === 'staged') {
    args.push('--staged');
  }
  args.push('--name-only', '--diff-filter=ACMRTUXB');

  const output = await runGit(rootUri, args, settings.timeoutSeconds);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function runGit(rootUri: vscode.Uri, args: string[], timeoutSeconds: number): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: rootUri.fsPath,
    encoding: 'utf8',
    maxBuffer: gitMaxBuffer,
    timeout: timeoutSeconds * 1000,
    windowsHide: true
  });

  return stdout;
}

function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(filePath, pattern));
}

function matchesGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern).replace(/^\/+/, '');

  if (!normalizedPattern) {
    return false;
  }

  const regex = globToRegExp(normalizedPattern);
  if (regex.test(normalizedPath)) {
    return true;
  }

  if (!normalizedPattern.includes('/')) {
    return regex.test(path.posix.basename(normalizedPath));
  }

  return false;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function globToRegExp(glob: string): RegExp {
  let source = '^';

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];

    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }

  source += '$';
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}
