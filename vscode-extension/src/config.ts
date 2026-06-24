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
export type DiffMode = 'staged' | 'workingTree';
export type PromptPreset = 'basic' | 'conventional' | 'gitmoji' | 'custom';

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
  numberOfPreviousCommits: number;
  diffMode: DiffMode;
  exclusions: string[];
  cleanupRegex: string;
  cleanupRegexIgnoreCase: boolean;
  cliPath: string;
  codexReasoningEffort: string;
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
  const provider = readEnum(config.get<string>('provider'), providers, 'openai');
  const promptPreset = readEnum(config.get<string>('promptPreset'), ['basic', 'conventional', 'gitmoji', 'custom'] as const, 'basic');
  const diffMode = readEnum(config.get<string>('diffMode'), ['staged', 'workingTree'] as const, 'staged');

  return {
    provider,
    model: config.get<string>('model', '').trim(),
    baseUrl: config.get<string>('baseUrl', '').trim(),
    timeoutSeconds: Math.max(1, config.get<number>('timeoutSeconds', 60)),
    temperature: config.get<number>('temperature', 0.2),
    topP: readOptionalNumber(config.get<number | null>('topP', null)),
    topK: readOptionalNumber(config.get<number | null>('topK', null)),
    maxTokens: Math.max(1, config.get<number>('maxTokens', 300)),
    locale: config.get<string>('locale', '').trim() || inferLocaleName(),
    promptPreset,
    customPrompt: config.get<string>('customPrompt', ''),
    numberOfPreviousCommits: Math.max(0, Math.floor(config.get<number>('numberOfPreviousCommits', 5))),
    diffMode,
    exclusions: config.get<string[]>('exclusions', []).filter((value) => value.trim().length > 0),
    cleanupRegex: config.get<string>('cleanupRegex', ''),
    cleanupRegexIgnoreCase: config.get<boolean>('cleanupRegexIgnoreCase', false),
    cliPath: config.get<string>('cliPath', '').trim(),
    codexReasoningEffort: config.get<string>('codexReasoningEffort', 'medium').trim() || 'medium'
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
