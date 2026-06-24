import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import { promisify } from 'util';
import * as path from 'path';
import * as vscode from 'vscode';
import { Settings } from './config';

const execFileAsync = promisify(execFile);
const gitMaxBuffer = 80 * 1024 * 1024;
const maxUntrackedFileBytes = 1024 * 1024;

type DiffScope = 'staged' | 'workingTree';

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

export interface CommitInputWriteResult {
  wroteToInput: boolean;
  verified: boolean;
  actualValue?: string;
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
  if (settings.diffMode === 'stagedThenWorkingTree') {
    const stagedDiff = await getScopedDiff(rootUri, settings, 'staged');
    if (stagedDiff.trim()) {
      return stagedDiff;
    }

    return getScopedDiff(rootUri, settings, 'workingTree');
  }

  return getScopedDiff(rootUri, settings, settings.diffMode);
}

async function getScopedDiff(rootUri: vscode.Uri, settings: Settings, scope: DiffScope): Promise<string> {
  const changedFiles = await getChangedFiles(rootUri, scope, settings.timeoutSeconds);
  const includedFiles = changedFiles.filter((file) => !matchesAnyGlob(file, settings.exclusions));
  const untrackedFiles = scope === 'workingTree'
    ? (await getUntrackedFiles(rootUri, settings.timeoutSeconds)).filter((file) => !matchesAnyGlob(file, settings.exclusions))
    : [];

  if (includedFiles.length === 0 && untrackedFiles.length === 0) {
    return '';
  }

  const args = ['diff'];
  if (scope === 'staged') {
    args.push('--staged');
  }
  args.push('--no-ext-diff', '--no-color', '--', ...includedFiles);

  const trackedDiff = includedFiles.length > 0
    ? await runGit(rootUri, args, settings.timeoutSeconds)
    : '';
  const untrackedDiff = await buildUntrackedDiff(rootUri, untrackedFiles);
  const diff = [trackedDiff.trim(), untrackedDiff.trim()].filter(Boolean).join('\n\n');

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

export async function setCommitInput(context: RepositoryContext, message: string): Promise<CommitInputWriteResult> {
  const normalizedMessage = normalizeCommitMessage(message);
  await vscode.env.clipboard.writeText(normalizedMessage);

  const inputBox = context.repository?.inputBox;
  if (inputBox) {
    await vscode.commands.executeCommand('workbench.view.scm');
    await sleep(50);

    inputBox.value = '';
    await sleep(10);
    inputBox.value = normalizedMessage;
    await sleep(80);

    if (normalizeCommitMessage(inputBox.value) !== normalizedMessage) {
      inputBox.value = normalizedMessage;
      await sleep(120);
    }

    const actualValue = inputBox.value;
    return {
      wroteToInput: true,
      verified: normalizeCommitMessage(actualValue) === normalizedMessage,
      actualValue
    };
  }

  return {
    wroteToInput: false,
    verified: false
  };
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

async function getChangedFiles(rootUri: vscode.Uri, scope: DiffScope, timeoutSeconds: number): Promise<string[]> {
  const args = ['diff'];
  if (scope === 'staged') {
    args.push('--staged');
  }
  args.push('--name-only', '--diff-filter=ACDMRTUXB');

  const output = await runGit(rootUri, args, timeoutSeconds);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function getUntrackedFiles(rootUri: vscode.Uri, timeoutSeconds: number): Promise<string[]> {
  const output = await runGit(rootUri, ['ls-files', '--others', '--exclude-standard', '-z'], timeoutSeconds);
  return output
    .split('\0')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function buildUntrackedDiff(rootUri: vscode.Uri, files: string[]): Promise<string> {
  const patches = await Promise.all(files.map((file) => buildUntrackedFilePatch(rootUri, file)));
  return patches.filter(Boolean).join('\n');
}

async function buildUntrackedFilePatch(rootUri: vscode.Uri, file: string): Promise<string> {
  const normalizedFile = normalizePath(file);
  const absolutePath = path.join(rootUri.fsPath, file);

  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return '';
    }

    if (stats.size > maxUntrackedFileBytes) {
      return buildOmittedUntrackedFilePatch(normalizedFile, `Large untracked file omitted (${stats.size} bytes).`);
    }

    const content = await fs.readFile(absolutePath);
    if (isBinary(content)) {
      return buildOmittedUntrackedFilePatch(normalizedFile, `Binary untracked file omitted (${content.length} bytes).`);
    }

    return buildNewTextFilePatch(normalizedFile, content.toString('utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildOmittedUntrackedFilePatch(normalizedFile, `Unable to read untracked file: ${message}`);
  }
}

function buildNewTextFilePatch(file: string, content: string): string {
  const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const hasTrailingNewline = normalizedContent.endsWith('\n');
  const body = hasTrailingNewline ? normalizedContent.slice(0, -1) : normalizedContent;
  const lines = body.length > 0 ? body.split('\n') : [];
  const header = [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`
  ];
  const patchLines = lines.map((line) => `+${line}`);

  if (!hasTrailingNewline && lines.length > 0) {
    patchLines.push('\\ No newline at end of file');
  }

  return [...header, ...patchLines].join('\n');
}

function buildOmittedUntrackedFilePatch(file: string, reason: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    `+${reason}`
  ].join('\n');
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, Math.min(content.length, 8000)).includes(0);
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

function normalizeCommitMessage(message: string): string {
  return message.replace(/\r\n/g, '\n').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
