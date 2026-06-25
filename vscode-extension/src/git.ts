import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
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

interface RunGitOptions {
  env?: NodeJS.ProcessEnv;
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

export interface CommitInputUpdateOptions {
  reveal?: boolean;
}

export function getCommitInputValue(context: RepositoryContext): string | undefined {
  return context.repository?.inputBox?.value;
}

export async function pickRepository(): Promise<RepositoryContext | undefined> {
  const repositories = await getGitRepositories();

  if (repositories.length === 1) {
    return createRepositoryContext(repositories[0].rootUri, repositories[0]);
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

    return picked ? createRepositoryContext(picked.repository.rootUri, picked.repository) : undefined;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (workspaceFolders.length === 1) {
    return createRepositoryContext(workspaceFolders[0].uri);
  }

  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select the workspace folder to use for AI Commits'
  });

  return picked ? createRepositoryContext(picked.uri) : undefined;
}

export async function getDiff(rootUri: vscode.Uri, settings: Settings): Promise<string> {
  const repositoryRootUri = await resolveRepositoryRoot(rootUri);

  if (settings.diffMode === 'stagedThenWorkingTree') {
    const stagedDiff = await getScopedDiff(repositoryRootUri, settings, 'staged');
    if (stagedDiff.trim()) {
      return stagedDiff;
    }

    return getScopedDiff(repositoryRootUri, settings, 'workingTree');
  }

  return getScopedDiff(repositoryRootUri, settings, settings.diffMode);
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
  args.push('--textconv', '--no-ext-diff', '--no-color', '--', ...includedFiles);

  const trackedDiff = includedFiles.length > 0
    ? await runGit(rootUri, args, settings.timeoutSeconds)
    : '';
  const untrackedDiff = await buildUntrackedDiff(rootUri, untrackedFiles, settings.timeoutSeconds);
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

export async function updateCommitInput(
  context: RepositoryContext,
  message: string,
  options: CommitInputUpdateOptions = {}
): Promise<boolean> {
  const inputBox = context.repository?.inputBox;
  if (!inputBox) {
    return false;
  }

  if (options.reveal) {
    await vscode.commands.executeCommand('workbench.view.scm');
  }

  inputBox.value = normalizeCommitMessage(message);
  return true;
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

async function createRepositoryContext(rootUri: vscode.Uri, repository?: GitRepositoryLike): Promise<RepositoryContext> {
  return {
    rootUri: await resolveRepositoryRoot(rootUri),
    repository
  };
}

async function resolveRepositoryRoot(rootUri: vscode.Uri): Promise<vscode.Uri> {
  try {
    const rootPath = (await runGit(rootUri, ['rev-parse', '--show-toplevel'], 15)).trim();
    return rootPath ? vscode.Uri.file(rootPath) : rootUri;
  } catch {
    return rootUri;
  }
}

async function getChangedFiles(rootUri: vscode.Uri, scope: DiffScope, timeoutSeconds: number): Promise<string[]> {
  const args = ['diff'];
  if (scope === 'staged') {
    args.push('--staged');
  }
  args.push('--name-only', '-z', '--diff-filter=ACDMRTUXB');

  const output = await runGit(rootUri, args, timeoutSeconds);
  return parseNulSeparated(output);
}

async function getUntrackedFiles(rootUri: vscode.Uri, timeoutSeconds: number): Promise<string[]> {
  const output = await runGit(rootUri, ['ls-files', '--others', '--exclude-standard', '-z'], timeoutSeconds);
  return parseNulSeparated(output);
}

async function buildUntrackedDiff(rootUri: vscode.Uri, files: string[], timeoutSeconds: number): Promise<string> {
  if (files.length === 0) {
    return '';
  }

  let textconvDiff = '';
  let textconvFileSet = new Set<string>();

  try {
    const textconvFiles = await getTextconvEnabledFiles(rootUri, files, timeoutSeconds);
    if (textconvFiles.length > 0) {
      const diff = await buildUntrackedDiffWithTextconv(rootUri, textconvFiles, timeoutSeconds);
      if (diff.trim()) {
        textconvDiff = diff;
        textconvFileSet = new Set(textconvFiles);
      }
    }
  } catch {
    // Fall back to the built-in patch construction if the temporary index or
    // a configured textconv command fails.
  }

  const fallbackFiles = files.filter((file) => !textconvFileSet.has(file));
  const patches = await Promise.all(fallbackFiles.map((file) => buildUntrackedFilePatch(rootUri, file)));
  const fallbackDiff = patches.filter(Boolean).join('\n');
  return [textconvDiff.trim(), fallbackDiff.trim()].filter(Boolean).join('\n\n');
}

async function getTextconvEnabledFiles(rootUri: vscode.Uri, files: string[], timeoutSeconds: number): Promise<string[]> {
  const output = await runGit(rootUri, ['check-attr', '-z', 'diff', '--', ...files], timeoutSeconds);
  const fields = output.split('\0');
  const diffDriversByFile = new Map<string, string>();

  for (let index = 0; index + 2 < fields.length; index += 3) {
    const file = fields[index];
    const attribute = fields[index + 1];
    const diffDriver = fields[index + 2];

    if (attribute === 'diff' && isNamedDiffDriver(diffDriver)) {
      diffDriversByFile.set(file, diffDriver);
    }
  }

  const uniqueDrivers = Array.from(new Set(diffDriversByFile.values()));
  const driverChecks = await Promise.all(uniqueDrivers.map(async (driver) => ({
    driver,
    hasTextconv: await hasTextconvDriver(rootUri, driver, timeoutSeconds)
  })));
  const textconvDrivers = new Set(driverChecks.filter((check) => check.hasTextconv).map((check) => check.driver));

  return files.filter((file) => {
    const driver = diffDriversByFile.get(file);
    return driver ? textconvDrivers.has(driver) : false;
  });
}

async function hasTextconvDriver(rootUri: vscode.Uri, driver: string, timeoutSeconds: number): Promise<boolean> {
  try {
    const textconv = await runGit(rootUri, ['config', '--get', `diff.${driver}.textconv`], timeoutSeconds);
    return textconv.trim().length > 0;
  } catch {
    return false;
  }
}

async function buildUntrackedDiffWithTextconv(rootUri: vscode.Uri, files: string[], timeoutSeconds: number): Promise<string> {
  const tempIndexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-commits-index-'));
  const tempIndexPath = path.join(tempIndexDir, 'index');
  const env = {
    GIT_INDEX_FILE: tempIndexPath
  };

  try {
    await copyRepositoryIndex(rootUri, tempIndexPath, timeoutSeconds);
    await runGit(rootUri, ['add', '--intent-to-add', '--', ...files], timeoutSeconds, { env });
    return await runGit(rootUri, ['diff', '--textconv', '--no-ext-diff', '--no-color', '--', ...files], timeoutSeconds, { env });
  } finally {
    await fs.rm(tempIndexDir, {
      recursive: true,
      force: true
    });
  }
}

async function copyRepositoryIndex(rootUri: vscode.Uri, tempIndexPath: string, timeoutSeconds: number): Promise<void> {
  try {
    const indexPath = (await runGit(rootUri, ['rev-parse', '--git-path', 'index'], timeoutSeconds)).trim();
    if (!indexPath) {
      return;
    }

    await fs.copyFile(resolveGitPath(rootUri, indexPath), tempIndexPath);
  } catch {
    // Repositories without an index can still use the temporary index.
  }
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

async function runGit(rootUri: vscode.Uri, args: string[], timeoutSeconds: number, options: RunGitOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: rootUri.fsPath,
    encoding: 'utf8',
    env: options.env ? { ...process.env, ...options.env } : undefined,
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

function parseNulSeparated(output: string): string[] {
  return output
    .split('\0')
    .filter((value) => value.length > 0);
}

function isNamedDiffDriver(value: string): boolean {
  return value !== '' && value !== 'set' && value !== 'unset' && value !== 'unspecified';
}

function resolveGitPath(rootUri: vscode.Uri, value: string): string {
  return path.isAbsolute(value) ? value : path.join(rootUri.fsPath, value);
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
