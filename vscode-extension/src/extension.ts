import * as vscode from 'vscode';
import { getSecretKey, getSettings, providerLabels, providers, Provider } from './config';
import { getBranch, getDiff, getPreviousCommitMessages, pickRepository, RepositoryContext, setCommitInput } from './git';
import { cleanupGeneratedMessage, constructPrompt } from './prompt';
import { createProvider } from './llm/providers';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('aiCommits.generate', () => generateCommitMessage(context, false)),
    vscode.commands.registerCommand('aiCommits.generateWithHint', () => generateCommitMessage(context, true)),
    vscode.commands.registerCommand('aiCommits.previewPrompt', () => previewPrompt()),
    vscode.commands.registerCommand('aiCommits.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('aiCommits.clearApiKey', () => clearApiKey(context)),
    vscode.commands.registerCommand('aiCommits.selectProvider', () => selectProvider())
  );
}

export function deactivate(): void {
  // Nothing to dispose beyond registered subscriptions.
}

async function generateCommitMessage(context: vscode.ExtensionContext, askForHint: boolean): Promise<void> {
  const settings = getSettings();
  const repositoryContext = await pickRepository();
  if (!repositoryContext) {
    return;
  }

  const hint = askForHint ? await vscode.window.showInputBox({
    title: 'AI Commits',
    prompt: 'Optional hint for the generated commit message',
    placeHolder: 'e.g. mention the migration to a VS Code extension'
  }) : undefined;

  if (askForHint && hint === undefined) {
    return;
  }

  const prompt = await preparePrompt(repositoryContext, hint);
  if (!prompt) {
    return;
  }

  try {
    const provider = createProvider(settings.provider);
    const apiKey = await getApiKey(context, settings.provider);
    const message = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AI Commits: generating with ${providerLabels[settings.provider]}`,
        cancellable: true
      },
      async (_progress, cancellationToken) => {
        const generated = await provider.generate(prompt, {
          settings,
          apiKey,
          cancellationToken
        });
        return cleanupGeneratedMessage(generated, settings);
      }
    );

    if (!message.trim()) {
      void vscode.window.showWarningMessage('AI Commits generated an empty commit message.');
      return;
    }

    const wroteToInput = await setCommitInput(repositoryContext, message);
    if (wroteToInput) {
      void vscode.window.showInformationMessage('AI Commits wrote the generated message to Source Control.');
    } else {
      void vscode.window.showInformationMessage('AI Commits copied the generated message to the clipboard.');
    }
  } catch (error) {
    if (isCancellation(error)) {
      return;
    }
    void vscode.window.showErrorMessage(`AI Commits failed: ${errorMessage(error)}`);
  }
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
    const source = settings.diffMode === 'staged' ? 'staged' : 'working tree';
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
  void vscode.window.showInformationMessage(`Saved ${providerLabels[provider]} API key.`);
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  const provider = getSettings().provider;
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

async function getApiKey(context: vscode.ExtensionContext, provider: Provider): Promise<string | undefined> {
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
