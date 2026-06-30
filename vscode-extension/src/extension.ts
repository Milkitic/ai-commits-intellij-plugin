import * as vscode from 'vscode';
import { getClientSecretKey, getSecretKey, getSettings, providerLabels, providers, Provider } from './config';
import {
  getBranch,
  getCommitInputValue,
  getDiff,
  getPreviousCommitMessages,
  getRepositoryContext,
  getRepositoryContextKey,
  getRepositoryContextKeyFromCommandArg,
  pickRepository,
  RepositoryContext,
  setCommitInput,
  updateCommitInput
} from './git';
import { cleanupGeneratedMessage, constructPrompt } from './prompt';
import { createProvider } from './llm/providers';
import { openSettingsPage } from './settingsWebview';

const outputChannel = vscode.window.createOutputChannel('AI Commits');
const currentGenerations = new Map<string, vscode.CancellationTokenSource>();
type HintMode = 'auto' | 'prompt';

export function activate(context: vscode.ExtensionContext): void {
  void updateGeneratingContexts();
  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand('aiCommits.generate', (commandArg?: unknown) => generateCommitMessage(context, 'auto', commandArg)),
    vscode.commands.registerCommand('aiCommits.generateWithHint', (commandArg?: unknown) => generateCommitMessage(context, 'prompt', commandArg)),
    vscode.commands.registerCommand('aiCommits.cancelGeneration', (commandArg?: unknown) => cancelGeneration(commandArg)),
    vscode.commands.registerCommand('aiCommits.previewPrompt', () => previewPrompt()),
    vscode.commands.registerCommand('aiCommits.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('aiCommits.clearApiKey', () => clearApiKey(context)),
    vscode.commands.registerCommand('aiCommits.selectProvider', () => selectProvider()),
    vscode.commands.registerCommand('aiCommits.openSettings', () => openSettingsPage(context))
  );
}

export function deactivate(): void {
  cancelAllGenerations();
}

async function generateCommitMessage(context: vscode.ExtensionContext, hintMode: HintMode, commandArg?: unknown): Promise<void> {
  const settings = getSettings();
  const repositoryContext = await getRepositoryContext(commandArg);
  if (!repositoryContext) {
    return;
  }

  const repositoryKey = getRepositoryContextKey(repositoryContext);
  if (currentGenerations.has(repositoryKey)) {
    currentGenerations.get(repositoryKey)?.cancel();
    return;
  }

  const hint = await resolveHint(repositoryContext, hintMode);
  if (hintMode === 'prompt' && hint === undefined) {
    return;
  }

  const generationSource = new vscode.CancellationTokenSource();
  currentGenerations.set(repositoryKey, generationSource);
  await updateGeneratingContexts();

  try {
    const prompt = await preparePrompt(repositoryContext, hint);
    if (!prompt || generationSource.token.isCancellationRequested) {
      return;
    }

    const provider = createProvider(settings.provider);
    const apiKey = await getApiKey(context, settings.provider, settings.activeClientId);
    let streamingInputRevealed = false;
    const onText = settings.useStreamingResponse
      ? async (partialMessage: string) => {
          const cleaned = cleanupGeneratedMessage(partialMessage, settings);
          if (!cleaned.trim()) {
            return;
          }

          const wrote = await updateCommitInput(repositoryContext, cleaned, {
            reveal: !streamingInputRevealed
          });
          streamingInputRevealed = streamingInputRevealed || wrote;
        }
      : undefined;
    const { rawMessage, message } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `AI Commits: generating with ${providerLabels[settings.provider]}`,
        cancellable: false
      },
      async (_progress, cancellationToken) => {
        const cancellation = cancellationToken.onCancellationRequested(() => generationSource.cancel());

        try {
          let generated = await provider.generate(prompt, {
            settings,
            apiKey,
            cancellationToken: generationSource.token,
            onText
          });
          let cleaned = cleanupGeneratedMessage(generated, settings);

          if (isSuspiciouslyShortMessage(cleaned)) {
            outputChannel.appendLine(`[${new Date().toISOString()}] Provider returned a suspiciously short message; retrying once.`);
            const retryPrompt = `${prompt}\n\nYour previous answer was too short or incomplete. Return exactly one complete Git commit message. Do not return a prefix, fragment, explanation, or code block.`;
            generated = await provider.generate(retryPrompt, {
              settings,
              apiKey,
              cancellationToken: generationSource.token,
              onText
            });
            cleaned = cleanupGeneratedMessage(generated, settings);
          }

          return {
            rawMessage: generated,
            message: cleaned
          };
        } finally {
          cancellation.dispose();
        }
      }
    );

    logGeneration(rawMessage, message);

    if (!message.trim()) {
      void vscode.window.showWarningMessage('AI Commits generated an empty commit message.');
      return;
    }

    if (isSuspiciouslyShortMessage(message)) {
      if (settings.copyToClipboard) {
        await vscode.env.clipboard.writeText(rawMessage.trim() || message.trim());
        void vscode.window.showWarningMessage('AI Commits generated a suspiciously short message even after retrying. The raw result was copied to the clipboard; check Output > AI Commits.');
      } else {
        void vscode.window.showWarningMessage('AI Commits generated a suspiciously short message even after retrying; check Output > AI Commits.');
      }
      return;
    }

    const writeResult = await setCommitInput(repositoryContext, message);
    if (writeResult.wroteToInput && writeResult.verified) {
      if (settings.copyToClipboard) {
        await vscode.env.clipboard.writeText(message);
        logStatus('AI Commits wrote the generated message to Source Control and copied it to the clipboard.');
      } else {
        logStatus('AI Commits wrote the generated message to Source Control.');
      }
    } else if (writeResult.wroteToInput) {
      logInputMismatch(message, writeResult.actualValue ?? '');
      if (settings.copyToClipboard) {
        await vscode.env.clipboard.writeText(message);
        void vscode.window.showWarningMessage('AI Commits generated a message, but VS Code did not keep the full text in Source Control. The full message was copied to the clipboard; check Output > AI Commits.');
      } else {
        void vscode.window.showWarningMessage('AI Commits generated a message, but VS Code did not keep the full text in Source Control; check Output > AI Commits.');
      }
    } else {
      if (settings.copyToClipboard) {
        await vscode.env.clipboard.writeText(message);
        logStatus('AI Commits copied the generated message to the clipboard.');
      } else {
        void vscode.window.showInformationMessage('AI Commits generated a commit message but could not write it to Source Control. Enable "Copy to clipboard" in settings or check Output > AI Commits.');
      }
    }
  } catch (error) {
    if (isCancellation(error)) {
      return;
    }
    void vscode.window.showErrorMessage(`AI Commits failed: ${errorMessage(error)}`);
  } finally {
    generationSource.dispose();
    if (currentGenerations.get(repositoryKey) === generationSource) {
      currentGenerations.delete(repositoryKey);
    }
    await updateGeneratingContexts();
  }
}

async function resolveHint(repositoryContext: RepositoryContext, hintMode: HintMode): Promise<string | undefined> {
  if (hintMode === 'auto') {
    return getCommitInputValue(repositoryContext)?.trim() || undefined;
  }

  if (hintMode === 'prompt') {
    return await vscode.window.showInputBox({
      title: 'AI Commits',
      prompt: 'Optional hint for the generated commit message',
      placeHolder: 'e.g. mention the migration to a VS Code extension'
    });
  }
}

function cancelGeneration(commandArg?: unknown): void {
  const repositoryKey = getRepositoryContextKeyFromCommandArg(commandArg);
  if (repositoryKey) {
    currentGenerations.get(repositoryKey)?.cancel();
    return;
  }

  cancelAllGenerations();
}

function cancelAllGenerations(): void {
  for (const generation of currentGenerations.values()) {
    generation.cancel();
  }
}

async function updateGeneratingContexts(): Promise<void> {
  await Promise.all([
    vscode.commands.executeCommand('setContext', 'aiCommits.generating', currentGenerations.size > 0),
    vscode.commands.executeCommand('setContext', 'aiCommits.generatingRepositoryRoots', Array.from(currentGenerations.keys()))
  ]);
}

async function previewPrompt(): Promise<void> {
  const repositoryContext = await pickRepository();
  if (!repositoryContext) {
    return;
  }

  const prompt = await preparePrompt(repositoryContext, undefined);
  if (!prompt) {
    return;
  }

  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: prompt
  });
  await vscode.window.showTextDocument(document, {
    preview: true
  });
}

async function preparePrompt(repositoryContext: RepositoryContext, hint?: string): Promise<string | undefined> {
  const settings = getSettings();
  const diff = await getDiff(repositoryContext.rootUri, settings);

  if (!diff.trim()) {
    const source = settings.diffMode === 'staged'
      ? 'staged'
      : settings.diffMode === 'workingTree'
        ? 'working tree'
        : 'staged or working tree';
    void vscode.window.showWarningMessage(`Git diff is empty. Add ${source} changes before generating a commit message.`);
    return undefined;
  }

  const [branch, previousCommitMessages] = await Promise.all([
    getBranch(repositoryContext.rootUri, repositoryContext.repository),
    getPreviousCommitMessages(repositoryContext.rootUri, settings.numberOfPreviousCommits)
  ]);

  return constructPrompt({
    settings,
    diff,
    branch,
    hint,
    previousCommitMessages
  });
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const provider = getSettings().provider;

  if (!providerUsesApiKey(provider)) {
    void vscode.window.showInformationMessage(`${providerLabels[provider]} does not need an API key in AI Commits.`);
    return;
  }

  const apiKey = await vscode.window.showInputBox({
    title: `AI Commits: ${providerLabels[provider]} API Key`,
    prompt: 'The key is stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true
  });

  if (!apiKey) {
    return;
  }

  await context.secrets.store(getSecretKey(provider), apiKey);
  const activeClientId = getSettings().activeClientId;
  if (activeClientId) {
    await context.secrets.store(getClientSecretKey(activeClientId), apiKey);
  }
  void vscode.window.showInformationMessage(`Saved ${providerLabels[provider]} API key.`);
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  const provider = getSettings().provider;
  const activeClientId = getSettings().activeClientId;
  if (activeClientId) {
    await context.secrets.delete(getClientSecretKey(activeClientId));
  }
  await context.secrets.delete(getSecretKey(provider));
  void vscode.window.showInformationMessage(`Cleared ${providerLabels[provider]} API key.`);
}

async function selectProvider(): Promise<void> {
  const currentProvider = getSettings().provider;
  const picked = await vscode.window.showQuickPick(
    providers.map((provider) => ({
      label: providerLabels[provider],
      description: provider === currentProvider ? 'current' : undefined,
      provider
    })),
    {
      title: 'AI Commits: Select Provider'
    }
  );

  if (!picked) {
    return;
  }

  await vscode.workspace
    .getConfiguration('aiCommits')
    .update('provider', picked.provider, vscode.ConfigurationTarget.Global);
}

async function getApiKey(context: vscode.ExtensionContext, provider: Provider, clientId?: string): Promise<string | undefined> {
  if (clientId) {
    const clientSecret = await context.secrets.get(getClientSecretKey(clientId));
    if (clientSecret) {
      return clientSecret;
    }
  }

  const secret = await context.secrets.get(getSecretKey(provider));
  return secret || readApiKeyFromEnvironment(provider);
}

function readApiKeyFromEnvironment(provider: Provider): string | undefined {
  switch (provider) {
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'openai-compatible':
      return process.env.OPENAI_API_KEY || process.env.AI_COMMITS_API_KEY;
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'gemini':
      return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    case 'ollama':
    case 'codex-cli':
    case 'claude-code':
      return undefined;
  }
}

function providerUsesApiKey(provider: Provider): boolean {
  return provider === 'openai' ||
    provider === 'openai-compatible' ||
    provider === 'anthropic' ||
    provider === 'gemini';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.message === 'Generation cancelled.';
}

function isSuspiciouslyShortMessage(message: string): boolean {
  return message.trim().length < 8;
}

function logGeneration(rawMessage: string, cleanedMessage: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] Generated commit message`);
  outputChannel.appendLine(`Raw length: ${rawMessage.length}; cleaned length: ${cleanedMessage.length}`);
  outputChannel.appendLine('Cleaned message:');
  outputChannel.appendLine(cleanedMessage);
  outputChannel.appendLine('');
}

function logStatus(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function logInputMismatch(expected: string, actual: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] Source Control input mismatch`);
  outputChannel.appendLine(`Expected length: ${expected.length}; actual length: ${actual.length}`);
  outputChannel.appendLine('Actual Source Control value:');
  outputChannel.appendLine(actual);
  outputChannel.appendLine('');
}
