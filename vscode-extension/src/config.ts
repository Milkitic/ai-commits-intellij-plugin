import * as vscode from 'vscode';

export const providers = [
  'openai',
  'openai-compatible',
  'anthropic',
  'gemini',
  'ollama',
  'codex-cli',
  'claude-code'
] as const;

export type Provider = typeof providers[number];
export type DiffMode = 'staged' | 'workingTree' | 'stagedThenWorkingTree';
export type PromptPreset = 'basic' | 'conventional' | 'gitmoji' | 'custom';
export const defaultMaxOutputTokens = 4096;
export const minimumCommitMessageTokens = 1024;

export interface LlmClientConfiguration {
  id: string;
  name: string;
  provider: Provider;
  model: string;
  baseUrl: string;
  timeoutSeconds: number;
  temperature: number;
  topP?: number;
  topK?: number;
  maxTokens: number;
  cleanupRegex: string;
  cleanupRegexIgnoreCase: boolean;
  cliPath: string;
  codexReasoningEffort: string;
}

export interface PromptConfiguration {
  id: string;
  name: string;
  description: string;
  content: string;
  numberOfPreviousCommits: number;
  canBeChanged: boolean;
}

export interface Settings {
  provider: Provider;
  model: string;
  baseUrl: string;
  timeoutSeconds: number;
  temperature: number;
  topP?: number;
  topK?: number;
  maxTokens: number;
  locale: string;
  promptPreset: PromptPreset;
  customPrompt: string;
  promptContent?: string;
  numberOfPreviousCommits: number;
  diffMode: DiffMode;
  exclusions: string[];
  cleanupRegex: string;
  cleanupRegexIgnoreCase: boolean;
  cliPath: string;
  codexReasoningEffort: string;
  activeClientId: string;
  clients: LlmClientConfiguration[];
  activePromptId: string;
  prompts: PromptConfiguration[];
  useStreamingResponse: boolean;
}

export const providerLabels: Record<Provider, string> = {
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
  'codex-cli': 'Codex CLI',
  'claude-code': 'Claude Code'
};

export function getSettings(): Settings {
  const config = vscode.workspace.getConfiguration('aiCommits');
  const clients = getClientConfigurations(config);
  const activeClientId = config.get<string>('activeClientId', '') || clients[0]?.id || '';
  const activeClient = clients.find((client) => client.id === activeClientId) ?? clients[0];
  const prompts = getPromptConfigurations(config);
  const activePromptId = config.get<string>('activePromptId', '') || prompts[0]?.id || '';
  const activePrompt = prompts.find((prompt) => prompt.id === activePromptId) ?? prompts[0];
  const provider = readEnum(config.get<string>('provider'), providers, 'openai');
  const promptPreset = readEnum(config.get<string>('promptPreset'), ['basic', 'conventional', 'gitmoji', 'custom'] as const, 'basic');
  const diffMode = readEnum(
    config.get<string>('diffMode'),
    ['stagedThenWorkingTree', 'staged', 'workingTree'] as const,
    'stagedThenWorkingTree'
  );

  return {
    provider: activeClient?.provider ?? provider,
    model: activeClient?.model ?? config.get<string>('model', '').trim(),
    baseUrl: activeClient?.baseUrl ?? config.get<string>('baseUrl', '').trim(),
    timeoutSeconds: activeClient?.timeoutSeconds ?? Math.max(1, config.get<number>('timeoutSeconds', 60)),
    temperature: activeClient?.temperature ?? config.get<number>('temperature', 0.2),
    topP: activeClient?.topP ?? readOptionalNumber(config.get<number | null>('topP', null)),
    topK: activeClient?.topK ?? readOptionalNumber(config.get<number | null>('topK', null)),
    maxTokens: activeClient?.maxTokens ?? Math.max(minimumCommitMessageTokens, config.get<number>('maxTokens', defaultMaxOutputTokens)),
    locale: config.get<string>('locale', '').trim() || inferLocaleName(),
    promptPreset,
    customPrompt: config.get<string>('customPrompt', ''),
    promptContent: activePrompt?.content,
    numberOfPreviousCommits: activePrompt?.numberOfPreviousCommits ?? Math.max(0, Math.floor(config.get<number>('numberOfPreviousCommits', 5))),
    diffMode,
    exclusions: config.get<string[]>('exclusions', []).filter((value) => value.trim().length > 0),
    cleanupRegex: activeClient?.cleanupRegex ?? config.get<string>('cleanupRegex', ''),
    cleanupRegexIgnoreCase: activeClient?.cleanupRegexIgnoreCase ?? config.get<boolean>('cleanupRegexIgnoreCase', false),
    cliPath: activeClient?.cliPath ?? config.get<string>('cliPath', '').trim(),
    codexReasoningEffort: (activeClient?.codexReasoningEffort ?? config.get<string>('codexReasoningEffort', 'medium').trim()) || 'medium',
    activeClientId,
    clients,
    activePromptId,
    prompts,
    useStreamingResponse: config.get<boolean>('useStreamingResponse', false)
  };
}

export function getDefaultModel(provider: Provider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-3-5-sonnet-latest';
    case 'gemini':
      return 'gemini-1.5-flash';
    case 'ollama':
      return 'llama3.1';
    case 'codex-cli':
      return 'gpt-5.2-codex';
    case 'claude-code':
      return '';
    case 'openai-compatible':
      return 'gpt-4o-mini';
  }
}

export function getDefaultBaseUrl(provider: Provider): string {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta';
    case 'ollama':
      return 'http://localhost:11434';
    case 'openai-compatible':
      return 'http://localhost:1234/v1';
    case 'codex-cli':
    case 'claude-code':
      return '';
  }
}

export function getEffectiveModel(settings: Settings): string {
  return settings.model || getDefaultModel(settings.provider);
}

export function getEffectiveBaseUrl(settings: Settings): string {
  return stripTrailingSlash(settings.baseUrl || getDefaultBaseUrl(settings.provider));
}

export function getSecretKey(provider: Provider): string {
  return `aiCommits.${provider}.apiKey`;
}

export function getClientSecretKey(clientId: string): string {
  return `aiCommits.client.${clientId}.apiKey`;
}

export function createDefaultClient(provider: Provider, index = 1): LlmClientConfiguration {
  return {
    id: createId(),
    name: `${providerLabels[provider]}${index > 1 ? ` ${index}` : ''}`,
    provider,
    model: getDefaultModel(provider),
    baseUrl: getDefaultBaseUrl(provider),
    timeoutSeconds: 60,
    temperature: 0.2,
    topP: undefined,
    topK: undefined,
    maxTokens: defaultMaxOutputTokens,
    cleanupRegex: '',
    cleanupRegexIgnoreCase: false,
    cliPath: '',
    codexReasoningEffort: 'medium'
  };
}

export function createDefaultPrompts(): PromptConfiguration[] {
  return [
    {
      id: 'basic',
      name: 'Basic',
      description: 'Basic prompt that generates a decent commit message.',
      content:
        'Write an insightful but concise Git commit message in a complete sentence in present tense for the ' +
        'following diff without prefacing it with anything, the response must be in the language {locale} and must ' +
        'NOT be longer than 74 characters. The sent text will be the differences between files, where deleted lines ' +
        'are prefixed with a single minus sign and added lines are prefixed with a single plus sign.\n' +
        '{Use this hint to improve the commit message: $hint}\n' +
        'Previous commit messages:\n' +
        '{previousCommitMessages}\n' +
        '{diff}',
      numberOfPreviousCommits: 5,
      canBeChanged: false
    },
    {
      id: 'conventional',
      name: 'Conventional',
      description: 'Prompt for commit messages following the conventional commit convention.',
      content:
        "Write a commit message in the conventional commit convention. I'll send you an output " +
        "of 'git diff --staged' command, and you convert it into a commit message. " +
        'Lines must not be longer than 74 characters. Use {locale} language to answer. ' +
        'End commit title with issue number if you can get it from the branch name: ' +
        '{branch} in parenthesis.\n' +
        '{Use this hint to improve the commit message: $hint}\n' +
        'Previous commit messages:\n' +
        '{previousCommitMessages}\n' +
        '{diff}',
      numberOfPreviousCommits: 5,
      canBeChanged: false
    },
    {
      id: 'gitmoji',
      name: 'GitMoji',
      description: 'Prompt for generating commit messages with GitMoji.',
      content:
        "Write a concise commit message from 'git diff --staged' output in the format " +
        '`[EMOJI] [TYPE](file/topic): [description in {locale}]`. Use GitMoji emojis (e.g., ✨ -> feat), ' +
        'present tense, active voice, max 120 characters per line, no code blocks.\n' +
        'Previous commit messages:\n' +
        '{previousCommitMessages}\n' +
        '---\n' +
        '{diff}',
      numberOfPreviousCommits: 5,
      canBeChanged: false
    }
  ];
}

export function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function updateConfigurationValue<T>(key: string, value: T, target = vscode.ConfigurationTarget.Global): Promise<void> {
  await vscode.workspace.getConfiguration('aiCommits').update(key, value, target);
}

function getClientConfigurations(config: vscode.WorkspaceConfiguration): LlmClientConfiguration[] {
  const configuredClients = config.get<unknown[]>('clients', []);
  const clients = configuredClients
    .map(normalizeClientConfiguration)
    .filter((client): client is LlmClientConfiguration => client !== undefined);

  if (clients.length > 0) {
    return clients;
  }

  const provider = readEnum(config.get<string>('provider'), providers, 'openai');
  const fallback = createDefaultClient(provider);
  fallback.id = 'default-client';
  fallback.name = providerLabels[provider];
  fallback.model = config.get<string>('model', '').trim() || fallback.model;
  fallback.baseUrl = config.get<string>('baseUrl', '').trim() || fallback.baseUrl;
  fallback.timeoutSeconds = Math.max(1, config.get<number>('timeoutSeconds', fallback.timeoutSeconds));
  fallback.temperature = config.get<number>('temperature', fallback.temperature);
  fallback.topP = readOptionalNumber(config.get<number | null>('topP', null));
  fallback.topK = readOptionalNumber(config.get<number | null>('topK', null));
  fallback.maxTokens = Math.max(minimumCommitMessageTokens, config.get<number>('maxTokens', fallback.maxTokens));
  fallback.cleanupRegex = config.get<string>('cleanupRegex', '');
  fallback.cleanupRegexIgnoreCase = config.get<boolean>('cleanupRegexIgnoreCase', false);
  fallback.cliPath = config.get<string>('cliPath', '').trim();
  fallback.codexReasoningEffort = config.get<string>('codexReasoningEffort', fallback.codexReasoningEffort).trim() || fallback.codexReasoningEffort;
  return [fallback];
}

function getPromptConfigurations(config: vscode.WorkspaceConfiguration): PromptConfiguration[] {
  const configuredPrompts = config.get<unknown[]>('prompts', []);
  const prompts = configuredPrompts
    .map(normalizePromptConfiguration)
    .filter((prompt): prompt is PromptConfiguration => prompt !== undefined);

  if (prompts.length > 0) {
    return prompts;
  }

  return createDefaultPrompts();
}

function normalizeClientConfiguration(value: unknown): LlmClientConfiguration | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const provider = readEnum(typeof record.provider === 'string' ? record.provider : undefined, providers, 'openai');

  return {
    id: typeof record.id === 'string' && record.id ? record.id : createId(),
    name: typeof record.name === 'string' && record.name ? record.name : providerLabels[provider],
    provider,
    model: typeof record.model === 'string' && record.model ? record.model : getDefaultModel(provider),
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : getDefaultBaseUrl(provider),
    timeoutSeconds: Math.max(1, readNumber(record.timeoutSeconds, 60)),
    temperature: readNumber(record.temperature, 0.2),
    topP: readOptionalNumber(readUnknownNumber(record.topP)),
    topK: readOptionalNumber(readUnknownNumber(record.topK)),
    maxTokens: Math.max(minimumCommitMessageTokens, readNumber(record.maxTokens, defaultMaxOutputTokens)),
    cleanupRegex: typeof record.cleanupRegex === 'string' ? record.cleanupRegex : '',
    cleanupRegexIgnoreCase: Boolean(record.cleanupRegexIgnoreCase),
    cliPath: typeof record.cliPath === 'string' ? record.cliPath : '',
    codexReasoningEffort: typeof record.codexReasoningEffort === 'string' && record.codexReasoningEffort ? record.codexReasoningEffort : 'medium'
  };
}

function normalizePromptConfiguration(value: unknown): PromptConfiguration | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || typeof record.content !== 'string') {
    return undefined;
  }

  return {
    id: typeof record.id === 'string' && record.id ? record.id : createId(),
    name: record.name,
    description: typeof record.description === 'string' ? record.description : '',
    content: record.content,
    numberOfPreviousCommits: Math.max(0, Math.floor(readNumber(record.numberOfPreviousCommits, 5))),
    canBeChanged: typeof record.canBeChanged === 'boolean' ? record.canBeChanged : true
  };
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readUnknownNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readOptionalNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readEnum<T extends readonly string[]>(value: string | undefined, allowed: T, fallback: T[number]): T[number] {
  return allowed.includes(value ?? '') ? value as T[number] : fallback;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function inferLocaleName(): string {
  const language = vscode.env.language || 'en';
  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    const name = displayNames.of(language.split('-')[0]);
    return name || 'English';
  } catch {
    return 'English';
  }
}
