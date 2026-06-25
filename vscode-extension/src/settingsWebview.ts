import * as vscode from 'vscode';
import {
  createDefaultClient,
  createDefaultPrompts,
  defaultMaxOutputTokens,
  getClientSecretKey,
  getDefaultBaseUrl,
  getDefaultModel,
  getSecretKey,
  getSettings,
  LlmClientConfiguration,
  minimumCommitMessageTokens,
  PromptConfiguration,
  providerLabels,
  providers,
  Provider,
  Settings,
  updateConfigurationValue
} from './config';
import { createProvider } from './llm/providers';

interface SettingsPageState {
  activeClientId: string;
  clients: LlmClientConfiguration[];
  activePromptId: string;
  prompts: PromptConfiguration[];
  locale: string;
  diffMode: 'staged' | 'workingTree' | 'stagedThenWorkingTree';
  exclusions: string[];
  useStreamingResponse: boolean;
  copyToClipboard: boolean;
}

let settingsPanel: vscode.WebviewPanel | undefined;

export function openSettingsPage(context: vscode.ExtensionContext): void {
  if (settingsPanel) {
    settingsPanel.reveal(vscode.ViewColumn.Active);
    void sendState(context, settingsPanel.webview);
    return;
  }

  settingsPanel = vscode.window.createWebviewPanel(
    'aiCommitsSettings',
    'AI Commits Settings',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  settingsPanel.webview.html = getHtml(settingsPanel.webview);
  settingsPanel.onDidDispose(() => {
    settingsPanel = undefined;
  });

  settingsPanel.webview.onDidReceiveMessage((message: unknown) => {
    void handleMessage(context, settingsPanel?.webview, message);
  });
}

async function handleMessage(
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
  message: unknown
): Promise<void> {
  if (!webview || !message || typeof message !== 'object') {
    return;
  }

  const record = message as Record<string, unknown>;
  const type = record.type;

  if (type === 'ready') {
    await sendState(context, webview);
    return;
  }

  if (type === 'save') {
    const state = sanitizeState(record.state);
    await saveState(state);
    await webview.postMessage({
      type: 'saved'
    });
    await sendState(context, webview);
    return;
  }

  if (type === 'setSecret') {
    const client = sanitizeClient(record.client);
    if (!client) {
      return;
    }
    await setClientSecret(context, client);
    await sendState(context, webview);
    return;
  }

  if (type === 'clearSecret') {
    const client = sanitizeClient(record.client);
    if (!client) {
      return;
    }
    await context.secrets.delete(getClientSecretKey(client.id));
    await context.secrets.delete(getSecretKey(client.provider));
    await webview.postMessage({
      type: 'verifyResult',
      ok: true,
      message: `Cleared ${client.name} token.`
    });
    await sendState(context, webview);
    return;
  }

  if (type === 'verify') {
    const client = sanitizeClient(record.client);
    const state = sanitizeState(record.state);
    if (!client) {
      return;
    }
    await verifyClient(context, webview, state, client);
  }
}

async function sendState(context: vscode.ExtensionContext, webview: vscode.Webview): Promise<void> {
  const settings = getSettings();
  const secretStatus: Record<string, boolean> = {};

  for (const client of settings.clients) {
    secretStatus[client.id] = Boolean(await context.secrets.get(getClientSecretKey(client.id)));
  }

  await webview.postMessage({
    type: 'state',
    state: toPageState(settings),
    providers,
    providerLabels,
    defaults: Object.fromEntries(providers.map((provider, index) => [
      provider,
      createDefaultClient(provider, index + 1)
    ])),
    secretStatus
  });
}

async function saveState(state: SettingsPageState): Promise<void> {
  const activeClient = state.clients.find((client) => client.id === state.activeClientId) ?? state.clients[0];
  const activePrompt = state.prompts.find((prompt) => prompt.id === state.activePromptId) ?? state.prompts[0];

  await updateConfigurationValue('activeClientId', activeClient?.id ?? '');
  await updateConfigurationValue('clients', state.clients);
  await updateConfigurationValue('activePromptId', activePrompt?.id ?? '');
  await updateConfigurationValue('prompts', state.prompts);
  await updateConfigurationValue('locale', state.locale);
  await updateConfigurationValue('diffMode', state.diffMode);
  await updateConfigurationValue('exclusions', state.exclusions);
  await updateConfigurationValue('useStreamingResponse', state.useStreamingResponse);
  await updateConfigurationValue('copyToClipboard', state.copyToClipboard);

  if (activeClient) {
    await updateConfigurationValue('provider', activeClient.provider);
    await updateConfigurationValue('model', activeClient.model);
    await updateConfigurationValue('baseUrl', activeClient.baseUrl);
    await updateConfigurationValue('timeoutSeconds', activeClient.timeoutSeconds);
    await updateConfigurationValue('temperature', activeClient.temperature);
    await updateConfigurationValue('topP', activeClient.topP ?? null);
    await updateConfigurationValue('topK', activeClient.topK ?? null);
    await updateConfigurationValue('maxTokens', activeClient.maxTokens);
    await updateConfigurationValue('cleanupRegex', activeClient.cleanupRegex);
    await updateConfigurationValue('cleanupRegexIgnoreCase', activeClient.cleanupRegexIgnoreCase);
    await updateConfigurationValue('cliPath', activeClient.cliPath);
    await updateConfigurationValue('codexReasoningEffort', activeClient.codexReasoningEffort);
  }

  if (activePrompt) {
    await updateConfigurationValue('promptPreset', activePrompt.id === 'basic' || activePrompt.id === 'conventional' || activePrompt.id === 'gitmoji' ? activePrompt.id : 'custom');
    await updateConfigurationValue('customPrompt', activePrompt.content);
    await updateConfigurationValue('numberOfPreviousCommits', activePrompt.numberOfPreviousCommits);
  }
}

async function setClientSecret(context: vscode.ExtensionContext, client: LlmClientConfiguration): Promise<void> {
  if (!providerUsesApiKey(client.provider)) {
    void vscode.window.showInformationMessage(`${providerLabels[client.provider]} does not need an API key.`);
    return;
  }

  const apiKey = await vscode.window.showInputBox({
    title: `AI Commits: ${client.name} Token`,
    prompt: 'The key is stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true
  });

  if (!apiKey) {
    return;
  }

  await context.secrets.store(getClientSecretKey(client.id), apiKey);
  await context.secrets.store(getSecretKey(client.provider), apiKey);
}

async function verifyClient(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  state: SettingsPageState,
  client: LlmClientConfiguration
): Promise<void> {
  const tokenSource = new vscode.CancellationTokenSource();

  try {
    const settings = settingsFromState(state, client);
    const provider = createProvider(client.provider);
    const apiKey = await getClientSecret(context, client);
    const result = await provider.generate("Say 'OK' in exactly one word.", {
      settings,
      apiKey,
      cancellationToken: tokenSource.token
    });

    await webview.postMessage({
      type: 'verifyResult',
      ok: result.trim().length > 0,
      message: 'Configuration is valid.'
    });
  } catch (error) {
    await webview.postMessage({
      type: 'verifyResult',
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    tokenSource.dispose();
  }
}

async function getClientSecret(context: vscode.ExtensionContext, client: LlmClientConfiguration): Promise<string | undefined> {
  return await context.secrets.get(getClientSecretKey(client.id)) ??
    await context.secrets.get(getSecretKey(client.provider)) ??
    readApiKeyFromEnvironment(client.provider);
}

function settingsFromState(state: SettingsPageState, client: LlmClientConfiguration): Settings {
  const base = getSettings();
  const activePrompt = state.prompts.find((prompt) => prompt.id === state.activePromptId) ?? state.prompts[0];

  return {
    ...base,
    provider: client.provider,
    model: client.model,
    baseUrl: client.baseUrl,
    timeoutSeconds: client.timeoutSeconds,
    temperature: client.temperature,
    topP: client.topP,
    topK: client.topK,
    maxTokens: client.maxTokens,
    cleanupRegex: client.cleanupRegex,
    cleanupRegexIgnoreCase: client.cleanupRegexIgnoreCase,
    cliPath: client.cliPath,
    codexReasoningEffort: client.codexReasoningEffort,
    clients: state.clients,
    activeClientId: client.id,
    prompts: state.prompts,
    activePromptId: activePrompt?.id ?? '',
    promptContent: activePrompt?.content,
    numberOfPreviousCommits: activePrompt?.numberOfPreviousCommits ?? base.numberOfPreviousCommits,
    locale: state.locale,
    diffMode: state.diffMode,
    exclusions: state.exclusions,
    useStreamingResponse: state.useStreamingResponse,
    copyToClipboard: state.copyToClipboard
  };
}

function toPageState(settings: Settings): SettingsPageState {
  return {
    activeClientId: settings.activeClientId,
    clients: settings.clients,
    activePromptId: settings.activePromptId,
    prompts: settings.prompts,
    locale: settings.locale,
    diffMode: settings.diffMode,
    exclusions: settings.exclusions,
    useStreamingResponse: settings.useStreamingResponse,
    copyToClipboard: settings.copyToClipboard
  };
}

function sanitizeState(value: unknown): SettingsPageState {
  if (!value || typeof value !== 'object') {
    const settings = getSettings();
    return toPageState(settings);
  }

  const record = value as Record<string, unknown>;
  const clients = Array.isArray(record.clients)
    ? record.clients.map(sanitizeClient).filter((client): client is LlmClientConfiguration => client !== undefined)
    : [createDefaultClient('openai')];
  const prompts = Array.isArray(record.prompts)
    ? record.prompts.map(sanitizePrompt).filter((prompt): prompt is PromptConfiguration => prompt !== undefined)
    : createDefaultPrompts();

  return {
    activeClientId: asString(record.activeClientId) || clients[0]?.id || '',
    clients: clients.length > 0 ? clients : [createDefaultClient('openai')],
    activePromptId: asString(record.activePromptId) || prompts[0]?.id || '',
    prompts: prompts.length > 0 ? prompts : createDefaultPrompts(),
    locale: asString(record.locale) || 'English',
    diffMode: sanitizeDiffMode(record.diffMode),
    exclusions: Array.isArray(record.exclusions) ? record.exclusions.map(asString).filter(Boolean) : [],
    useStreamingResponse: Boolean(record.useStreamingResponse),
    copyToClipboard: Boolean(record.copyToClipboard)
  };
}

function sanitizeClient(value: unknown): LlmClientConfiguration | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const provider = providers.includes(asString(record.provider) as Provider)
    ? asString(record.provider) as Provider
    : 'openai';

  return {
    id: asString(record.id) || createDefaultClient(provider).id,
    name: asString(record.name) || providerLabels[provider],
    provider,
    model: asString(record.model) || getDefaultModel(provider),
    baseUrl: asString(record.baseUrl) || getDefaultBaseUrl(provider),
    timeoutSeconds: Math.max(1, asNumber(record.timeoutSeconds, 60)),
    temperature: asNumber(record.temperature, 0.2),
    topP: asOptionalNumber(record.topP),
    topK: asOptionalNumber(record.topK),
    maxTokens: Math.max(minimumCommitMessageTokens, asNumber(record.maxTokens, defaultMaxOutputTokens)),
    cleanupRegex: asString(record.cleanupRegex),
    cleanupRegexIgnoreCase: Boolean(record.cleanupRegexIgnoreCase),
    cliPath: asString(record.cliPath),
    codexReasoningEffort: asString(record.codexReasoningEffort) || 'medium'
  };
}

function sanitizePrompt(value: unknown): PromptConfiguration | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const name = asString(record.name);
  const content = asString(record.content);
  if (!name || !content) {
    return undefined;
  }

  return {
    id: asString(record.id) || name.toLowerCase(),
    name,
    description: asString(record.description),
    content,
    numberOfPreviousCommits: Math.max(0, Math.floor(asNumber(record.numberOfPreviousCommits, 5))),
    canBeChanged: typeof record.canBeChanged === 'boolean' ? record.canBeChanged : true
  };
}

function providerUsesApiKey(provider: Provider): boolean {
  return provider === 'openai' ||
    provider === 'openai-compatible' ||
    provider === 'anthropic' ||
    provider === 'gemini';
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

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeDiffMode(value: unknown): SettingsPageState['diffMode'] {
  if (value === 'staged' || value === 'workingTree' || value === 'stagedThenWorkingTree') {
    return value;
  }

  return 'stagedThenWorkingTree';
}

function getHtml(webview: vscode.Webview): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Commits Settings</title>
  <style>
    :root {
      --panel-border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --input-bg: var(--vscode-input-background);
      --input-border: var(--vscode-input-border);
      --row-hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 70%, transparent);
      --button-bg: var(--vscode-button-secondaryBackground);
      --button-fg: var(--vscode-button-secondaryForeground);
      --accent: var(--vscode-focusBorder);
      --card-bg: color-mix(in srgb, var(--vscode-sideBar-background) 55%, var(--vscode-editor-background));
      --card-header-bg: var(--vscode-sideBar-background);
      --section-gap: 18px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 22px 28px 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .page {
      max-width: 980px;
      margin: 0 auto 22px;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: 0.2px;
    }
    .subtitle {
      color: var(--muted);
      font-size: 12px;
      margin: 0 0 var(--section-gap);
    }
    .card {
      border: 1px solid var(--panel-border);
      border-radius: 4px;
      margin-bottom: var(--section-gap);
      background: var(--vscode-editor-background);
      overflow: hidden;
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      background: var(--card-header-bg);
      border-bottom: 1px solid var(--panel-border);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: var(--muted);
    }
    .card-header .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent);
      flex: none;
    }
    .card-body {
      padding: 14px 14px 12px;
    }
    .row {
      display: grid;
      grid-template-columns: 160px minmax(240px, 1fr) auto;
      gap: 10px;
      align-items: center;
      margin-bottom: 10px;
    }
    .row:last-child { margin-bottom: 0; }
    .label {
      color: var(--vscode-foreground);
      text-align: right;
      padding-right: 6px;
      font-size: 13px;
    }
    .help {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    select, input, textarea {
      width: 100%;
      min-height: 28px;
      color: var(--vscode-input-foreground);
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 3px;
      padding: 4px 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      outline: none;
      transition: border-color 0.12s ease, box-shadow 0.12s ease;
    }
    select:focus, input:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    textarea {
      resize: vertical;
      min-height: 130px;
      line-height: 1.45;
      font-family: var(--vscode-editor-font-family);
    }
    input[type="checkbox"] {
      width: auto;
      min-height: auto;
      margin: 0 6px 0 0;
      accent-color: var(--accent);
    }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 0;
    }
    .checkbox-row label {
      cursor: pointer;
      font-size: 13px;
    }
    button {
      min-height: 28px;
      color: var(--button-fg);
      background: var(--button-bg);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      padding: 3px 12px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      transition: background 0.12s ease, opacity 0.12s ease;
    }
    button:hover { background: color-mix(in srgb, var(--button-bg) 82%, var(--vscode-foreground) 4%); }
    button.primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button.primary:hover { background: color-mix(in srgb, var(--vscode-button-background) 88%, var(--vscode-foreground) 8%); }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    button.icon {
      width: 28px;
      padding: 0;
      font-weight: 600;
    }
    .toolbar {
      display: flex;
      gap: 6px;
      padding: 6px 8px;
      background: var(--card-header-bg);
      border-bottom: 1px solid var(--panel-border);
    }
    .table-wrap {
      border: 0;
      border-radius: 0;
      margin: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-top: 1px solid var(--panel-border);
      padding: 7px 10px;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 420px;
      font-size: 13px;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      font-size: 12px;
      letter-spacing: 0.3px;
    }
    tr.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    tbody tr:not(.selected):hover {
      background: var(--row-hover);
    }
    .checkboxes {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 22px;
      padding: 2px 0 0;
    }
    .section-spacer { height: 2px; }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 18px;
      margin: 4px 0 0;
      padding: 10px 0 14px;
    }
    a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-size: 12px;
    }
    a:hover { text-decoration: underline; }
    .actions {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
      position: sticky;
      bottom: 0;
      margin-top: 4px;
      padding: 12px 0;
      background: var(--vscode-editor-background);
      border-top: 1px solid var(--panel-border);
    }
    .status {
      flex: 1;
      color: var(--muted);
      font-size: 12px;
      align-self: center;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      display: none;
      place-items: center;
      background: rgba(0, 0, 0, 0.42);
      backdrop-filter: blur(1px);
      z-index: 10;
    }
    .modal-backdrop.open {
      display: grid;
    }
    .modal {
      width: min(900px, calc(100vw - 60px));
      max-height: calc(100vh - 80px);
      display: grid;
      grid-template-rows: auto 1fr auto;
      background: var(--vscode-editor-background);
      border: 1px solid var(--panel-border);
      border-radius: 5px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
    }
    .modal h2 {
      margin: 0;
      padding: 12px 16px;
      font-size: 15px;
      font-weight: 600;
      border-bottom: 1px solid var(--panel-border);
      background: var(--vscode-sideBar-background);
    }
    .modal-body {
      overflow: auto;
      padding: 16px;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 16px;
      border-top: 1px solid var(--panel-border);
      background: var(--vscode-sideBar-background);
    }
    .split {
      display: grid;
      grid-template-columns: 190px 1fr;
      gap: 16px;
    }
    .provider-list {
      border: 1px solid var(--panel-border);
      border-radius: 3px;
      min-height: 300px;
      padding: 6px;
      background: var(--card-bg);
    }
    .provider-item {
      padding: 7px 9px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.1s ease;
    }
    .provider-item:hover {
      background: var(--row-hover);
    }
    .provider-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .form-row {
      display: grid;
      grid-template-columns: 130px minmax(240px, 1fr) auto;
      gap: 10px;
      align-items: center;
      margin-bottom: 10px;
    }
    .form-row .label {
      text-align: right;
    }
    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="page">
    <h1>AI Commits</h1>
    <p class="subtitle">Configure providers, prompts, and commit generation behavior.</p>

    <section class="card">
      <div class="card-header"><span class="dot"></span>LLM Client</div>
      <div class="card-body">
        <div class="row">
          <div class="label">Active client</div>
          <select id="activeClient"></select>
          <label class="help"><input id="projectClient" type="checkbox">Project specific</label>
        </div>
        <div class="checkboxes">
          <span class="checkbox-row"><input id="streaming" type="checkbox"><label for="streaming">Streaming response</label></span>
          <span class="checkbox-row"><input id="copyToClipboard" type="checkbox"><label for="copyToClipboard">Copy generated message to clipboard</label></span>
        </div>
        <div class="help" style="padding:4px 0 0 170px;">Some providers fall back to non-streaming. Clipboard copy is disabled by default.</div>

        <div class="table-wrap" style="margin-top:12px;">
          <div class="toolbar">
            <button class="icon" id="addClient" title="Add">+</button>
            <button class="icon" id="editClient" title="Edit">Edit</button>
            <button class="icon" id="removeClient" title="Remove">-</button>
            <button id="setToken">Set Token</button>
            <button id="clearToken">Clear Token</button>
            <button id="verifyClient">Verify</button>
          </div>
          <table>
            <thead><tr><th>Name</th><th>Provider</th><th>Model</th><th>Token</th></tr></thead>
            <tbody id="clientRows"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header"><span class="dot"></span>General</div>
      <div class="card-body">
        <div class="row">
          <div class="label">Locale</div>
          <input id="locale" list="localeList">
          <span class="help">Prompts use English locale names.</span>
        </div>
        <datalist id="localeList">
          <option value="English"></option>
          <option value="Chinese"></option>
          <option value="French"></option>
          <option value="German"></option>
          <option value="Japanese"></option>
          <option value="Korean"></option>
          <option value="Spanish"></option>
        </datalist>
        <div class="row">
          <div class="label">Diff mode</div>
          <select id="diffMode">
            <option value="stagedThenWorkingTree">Staged, fallback to working tree</option>
            <option value="staged">Staged changes</option>
            <option value="workingTree">Working tree changes</option>
          </select>
          <span></span>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header"><span class="dot"></span>Prompts</div>
      <div class="card-body">
        <div class="row">
          <div class="label">Active prompt</div>
          <select id="activePrompt"></select>
          <label class="help"><input id="projectPrompt" type="checkbox">Project specific</label>
        </div>

        <div class="table-wrap" style="margin-top:12px;">
          <div class="toolbar">
            <button class="icon" id="addPrompt" title="Add">+</button>
            <button class="icon" id="editPrompt" title="Edit">Edit</button>
            <button class="icon" id="removePrompt" title="Remove">-</button>
          </div>
          <table>
            <thead><tr><th>Name</th><th>Description</th><th>Previous commits</th></tr></thead>
            <tbody id="promptRows"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header"><span class="dot"></span>Exclusions</div>
      <div class="card-body">
        <div class="row">
          <div class="label">New exclusion</div>
          <input id="newExclusion" placeholder="Glob, for example dist/** or *.lock">
          <button id="addExclusion">Add</button>
        </div>
        <div class="table-wrap" style="margin-top:8px;">
          <div class="toolbar">
            <button class="icon" id="removeExclusion" title="Remove">-</button>
          </div>
          <table>
            <thead><tr><th>Exclusion glob</th></tr></thead>
            <tbody id="exclusionRows"></tbody>
          </table>
        </div>
      </div>
    </section>

    <div class="links">
      <a href="https://github.com/Blarc/ai-commits-intellij-plugin/issues">Report bug</a>
      <a href="https://github.com/Blarc/ai-commits-intellij-plugin">Star on GitHub</a>
      <a href="https://ko-fi.com/blarc">Buy me a coffee</a>
      <a href="https://github.com/sponsors/Blarc">Sponsor me</a>
    </div>

    <div class="actions">
      <div class="status" id="status">Loading settings...</div>
      <button id="resetDefaults">Reset Defaults</button>
      <button id="discard">Discard</button>
      <button class="primary" id="apply" disabled>Apply</button>
    </div>
  </div>

  <div class="modal-backdrop" id="clientModal">
    <div class="modal">
      <h2 id="clientModalTitle">Add LLM Client</h2>
      <div class="modal-body">
        <div class="split">
          <div class="provider-list" id="providerList"></div>
          <div>
            <div class="form-row"><div class="label">Name</div><input id="clientName"><span></span></div>
            <div class="form-row"><div class="label">Host</div><input id="clientBaseUrl"><span></span></div>
            <div class="form-row"><div class="label">Model</div><input id="clientModel"><span class="help">Editable model ID</span></div>
            <div class="form-row"><div class="label">Timeout</div><input id="clientTimeout" type="number" min="1"><span class="help">seconds</span></div>
            <div class="form-row"><div class="label">Temperature</div><input id="clientTemperature" type="number" min="0" max="2" step="0.1"><span></span></div>
            <div class="form-row"><div class="label">Top P</div><input id="clientTopP" type="number" min="0" max="1" step="0.01"><span></span></div>
            <div class="form-row"><div class="label">Top K</div><input id="clientTopK" type="number" min="1"><span></span></div>
            <div class="form-row"><div class="label">Max tokens</div><input id="clientMaxTokens" type="number" min="${minimumCommitMessageTokens}"><span class="help">default ${defaultMaxOutputTokens}, minimum ${minimumCommitMessageTokens}</span></div>
            <div class="form-row cli-only"><div class="label">CLI Path</div><input id="clientCliPath"><span class="help">Leave blank to use PATH</span></div>
            <div class="form-row codex-only"><div class="label">Reasoning level</div><select id="clientReasoning"><option>minimal</option><option>low</option><option>medium</option><option>high</option></select><span></span></div>
            <div class="form-row"><div class="label">Clean up regex</div><input id="clientCleanupRegex"><span></span></div>
            <div class="form-row"><div></div><label><input id="clientCleanupIgnoreCase" type="checkbox">Ignore case</label><span></span></div>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button id="cancelClient">Cancel</button>
        <button class="primary" id="saveClient">Save</button>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="promptModal">
    <div class="modal">
      <h2 id="promptModalTitle">Add Prompt</h2>
      <div class="modal-body">
        <div class="form-row"><div class="label">Name</div><input id="promptName"><span></span></div>
        <div class="form-row"><div class="label">Description</div><input id="promptDescription"><span></span></div>
        <div class="form-row"><div class="label">Number of previous commits</div><input id="promptPrevious" type="number" min="0"><span></span></div>
        <div class="form-row"><div class="label">Hint</div><input id="promptHint" value="This is a hint."><span class="help">Preview only</span></div>
        <div class="two-col">
          <div>
            <div class="help">Content</div>
            <textarea id="promptContent"></textarea>
          </div>
          <div>
            <div class="help">Preview</div>
            <textarea id="promptPreview" readonly></textarea>
          </div>
        </div>
        <p class="help">Customize with {locale}, {diff}, {branch}, {hint}, {previousCommitMessages}, {taskId}, {taskSummary}, {taskDescription}, and {taskTimeSpent}. Use {Here is a hint: $hint} for conditional hint text.</p>
      </div>
      <div class="modal-actions">
        <button id="cancelPrompt">Cancel</button>
        <button class="primary" id="savePrompt">Save</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = null;
    let providers = [];
    let providerLabels = {};
    let defaults = {};
    let secretStatus = {};
    let selectedClientId = '';
    let selectedPromptId = '';
    let selectedExclusion = '';
    let dirty = false;
    let editingClientId = null;
    let editingPromptId = null;
    let clientDraftProvider = 'openai';

    const $ = (id) => document.getElementById(id);

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        state = clone(message.state);
        providers = message.providers;
        providerLabels = message.providerLabels;
        defaults = message.defaults;
        secretStatus = message.secretStatus || {};
        selectedClientId = state.activeClientId || (state.clients[0] && state.clients[0].id) || '';
        selectedPromptId = state.activePromptId || (state.prompts[0] && state.prompts[0].id) || '';
        selectedExclusion = '';
        render();
        setDirty(false);
        setStatus('Settings loaded.');
      }
      if (message.type === 'saved') {
        setDirty(false);
        setStatus('Settings saved.');
      }
      if (message.type === 'verifyResult') {
        setStatus(message.message, message.ok ? 'ok' : 'error');
      }
    });

    window.addEventListener('load', () => {
      wireEvents();
      vscode.postMessage({ type: 'ready' });
    });

    function wireEvents() {
      $('activeClient').addEventListener('change', () => {
        state.activeClientId = $('activeClient').value;
        selectedClientId = state.activeClientId;
        setDirty(true);
        renderClients();
      });
      $('activePrompt').addEventListener('change', () => {
        state.activePromptId = $('activePrompt').value;
        selectedPromptId = state.activePromptId;
        setDirty(true);
        renderPrompts();
      });
      $('streaming').addEventListener('change', () => {
        state.useStreamingResponse = $('streaming').checked;
        setDirty(true);
      });
      $('copyToClipboard').addEventListener('change', () => {
        state.copyToClipboard = $('copyToClipboard').checked;
        setDirty(true);
      });
      $('locale').addEventListener('input', () => {
        state.locale = $('locale').value;
        setDirty(true);
      });
      $('diffMode').addEventListener('change', () => {
        state.diffMode = $('diffMode').value;
        setDirty(true);
      });
      $('addClient').addEventListener('click', () => openClientModal());
      $('editClient').addEventListener('click', () => openClientModal(selectedClientId));
      $('removeClient').addEventListener('click', removeSelectedClient);
      $('setToken').addEventListener('click', () => postClient('setSecret'));
      $('clearToken').addEventListener('click', () => postClient('clearSecret'));
      $('verifyClient').addEventListener('click', () => postClient('verify'));
      $('addPrompt').addEventListener('click', () => openPromptModal());
      $('editPrompt').addEventListener('click', () => openPromptModal(selectedPromptId));
      $('removePrompt').addEventListener('click', removeSelectedPrompt);
      $('addExclusion').addEventListener('click', addExclusion);
      $('removeExclusion').addEventListener('click', removeExclusion);
      $('apply').addEventListener('click', save);
      $('discard').addEventListener('click', () => vscode.postMessage({ type: 'ready' }));
      $('resetDefaults').addEventListener('click', resetDefaults);
      $('cancelClient').addEventListener('click', closeClientModal);
      $('saveClient').addEventListener('click', saveClientModal);
      $('cancelPrompt').addEventListener('click', closePromptModal);
      $('savePrompt').addEventListener('click', savePromptModal);
      $('clientModal').addEventListener('click', (event) => {
        if (event.target === $('clientModal')) closeClientModal();
      });
      $('promptModal').addEventListener('click', (event) => {
        if (event.target === $('promptModal')) closePromptModal();
      });
      $('promptContent').addEventListener('input', renderPromptPreview);
      $('promptHint').addEventListener('input', renderPromptPreview);
      $('promptPrevious').addEventListener('input', renderPromptPreview);
    }

    function render() {
      if (!state) return;
      $('streaming').checked = state.useStreamingResponse;
      $('copyToClipboard').checked = state.copyToClipboard;
      $('locale').value = state.locale;
      $('diffMode').value = state.diffMode;
      renderClients();
      renderPrompts();
      renderExclusions();
    }

    function renderClients() {
      $('activeClient').innerHTML = state.clients.map((client) => '<option value="' + escapeHtml(client.id) + '">' + escapeHtml(client.name) + '</option>').join('');
      $('activeClient').value = state.activeClientId;

      $('clientRows').innerHTML = state.clients.map((client) => {
        const selected = client.id === selectedClientId ? ' class="selected"' : '';
        const token = providerNeedsToken(client.provider) ? (secretStatus[client.id] ? 'stored' : 'not set') : 'not required';
        return '<tr data-id="' + escapeHtml(client.id) + '"' + selected + '><td>' + escapeHtml(client.name) + '</td><td>' + escapeHtml(providerLabels[client.provider] || client.provider) + '</td><td>' + escapeHtml(client.model || '') + '</td><td>' + token + '</td></tr>';
      }).join('');

      document.querySelectorAll('#clientRows tr').forEach((row) => {
        row.addEventListener('click', () => {
          selectedClientId = row.dataset.id;
          state.activeClientId = selectedClientId;
          renderClients();
        });
        row.addEventListener('dblclick', () => openClientModal(row.dataset.id));
      });
    }

    function renderPrompts() {
      $('activePrompt').innerHTML = state.prompts.map((prompt) => '<option value="' + escapeHtml(prompt.id) + '">' + escapeHtml(prompt.name) + '</option>').join('');
      $('activePrompt').value = state.activePromptId;

      $('promptRows').innerHTML = state.prompts.map((prompt) => {
        const selected = prompt.id === selectedPromptId ? ' class="selected"' : '';
        return '<tr data-id="' + escapeHtml(prompt.id) + '"' + selected + '><td>' + escapeHtml(prompt.name) + '</td><td>' + escapeHtml(prompt.description) + '</td><td>' + prompt.numberOfPreviousCommits + '</td></tr>';
      }).join('');

      document.querySelectorAll('#promptRows tr').forEach((row) => {
        row.addEventListener('click', () => {
          selectedPromptId = row.dataset.id;
          state.activePromptId = selectedPromptId;
          renderPrompts();
        });
        row.addEventListener('dblclick', () => openPromptModal(row.dataset.id));
      });
    }

    function renderExclusions() {
      $('exclusionRows').innerHTML = state.exclusions.map((glob) => {
        const selected = glob === selectedExclusion ? ' class="selected"' : '';
        return '<tr data-glob="' + escapeHtml(glob) + '"' + selected + '><td>' + escapeHtml(glob) + '</td></tr>';
      }).join('');

      document.querySelectorAll('#exclusionRows tr').forEach((row) => {
        row.addEventListener('click', () => {
          selectedExclusion = row.dataset.glob;
          renderExclusions();
        });
      });
    }

    function openClientModal(clientId) {
      editingClientId = clientId || null;
      const client = editingClientId ? state.clients.find((item) => item.id === editingClientId) : makeClient('openai');
      if (!client) return;
      clientDraftProvider = client.provider;
      $('clientModalTitle').textContent = editingClientId ? 'Edit LLM Client' : 'Add LLM Client';
      renderProviderList();
      fillClientForm(client);
      $('clientModal').classList.add('open');
    }

    function renderProviderList() {
      $('providerList').innerHTML = providers.map((provider) => {
        const selected = provider === clientDraftProvider ? ' selected' : '';
        return '<div class="provider-item' + selected + '" data-provider="' + provider + '">' + escapeHtml(providerLabels[provider] || provider) + '</div>';
      }).join('');
      document.querySelectorAll('.provider-item').forEach((item) => {
        item.addEventListener('click', () => {
          clientDraftProvider = item.dataset.provider;
          renderProviderList();
          applyProviderDefaults();
          updateClientProviderVisibility();
        });
      });
    }

    function fillClientForm(client) {
      $('clientName').value = client.name;
      $('clientBaseUrl').value = client.baseUrl || '';
      $('clientModel').value = client.model || '';
      $('clientTimeout').value = client.timeoutSeconds;
      $('clientTemperature').value = client.temperature;
      $('clientTopP').value = client.topP == null ? '' : client.topP;
      $('clientTopK').value = client.topK == null ? '' : client.topK;
      $('clientMaxTokens').value = client.maxTokens;
      $('clientCliPath').value = client.cliPath || '';
      $('clientReasoning').value = client.codexReasoningEffort || 'medium';
      $('clientCleanupRegex').value = client.cleanupRegex || '';
      $('clientCleanupIgnoreCase').checked = client.cleanupRegexIgnoreCase;
      updateClientProviderVisibility();
    }

    function applyProviderDefaults() {
      const providerDefault = providerDefaultClient(clientDraftProvider);
      $('clientBaseUrl').value = providerDefault.baseUrl || '';
      $('clientModel').value = providerDefault.model || '';
      $('clientTimeout').value = providerDefault.timeoutSeconds;
      $('clientTemperature').value = providerDefault.temperature;
      $('clientTopP').value = providerDefault.topP == null ? '' : providerDefault.topP;
      $('clientTopK').value = providerDefault.topK == null ? '' : providerDefault.topK;
      $('clientMaxTokens').value = providerDefault.maxTokens;
      $('clientCliPath').value = providerDefault.cliPath || '';
      $('clientReasoning').value = providerDefault.codexReasoningEffort || 'medium';
      $('clientCleanupRegex').value = providerDefault.cleanupRegex || '';
      $('clientCleanupIgnoreCase').checked = Boolean(providerDefault.cleanupRegexIgnoreCase);
      if (!editingClientId) {
        $('clientName').value = providerDefault.name || providerLabels[clientDraftProvider] || clientDraftProvider;
      }
    }

    function updateClientProviderVisibility() {
      const isCli = clientDraftProvider === 'codex-cli' || clientDraftProvider === 'claude-code';
      document.querySelectorAll('.cli-only').forEach((el) => el.classList.toggle('hidden', !isCli));
      document.querySelectorAll('.codex-only').forEach((el) => el.classList.toggle('hidden', clientDraftProvider !== 'codex-cli'));
    }

    function saveClientModal() {
      const client = {
        id: editingClientId || makeId(),
        name: $('clientName').value.trim() || (providerLabels[clientDraftProvider] || clientDraftProvider),
        provider: clientDraftProvider,
        model: $('clientModel').value.trim(),
        baseUrl: $('clientBaseUrl').value.trim(),
        timeoutSeconds: numberValue('clientTimeout', 60),
        temperature: numberValue('clientTemperature', 0.2),
        topP: optionalNumberValue('clientTopP'),
        topK: optionalNumberValue('clientTopK'),
        maxTokens: Math.max(${minimumCommitMessageTokens}, numberValue('clientMaxTokens', ${defaultMaxOutputTokens})),
        cleanupRegex: $('clientCleanupRegex').value,
        cleanupRegexIgnoreCase: $('clientCleanupIgnoreCase').checked,
        cliPath: $('clientCliPath').value.trim(),
        codexReasoningEffort: $('clientReasoning').value
      };
      if (editingClientId) {
        state.clients = state.clients.map((item) => item.id === editingClientId ? client : item);
      } else {
        state.clients.push(client);
        selectedClientId = client.id;
        state.activeClientId = client.id;
      }
      closeClientModal();
      setDirty(true);
      renderClients();
    }

    function closeClientModal() {
      $('clientModal').classList.remove('open');
      editingClientId = null;
    }

    function removeSelectedClient() {
      if (state.clients.length <= 1) {
        setStatus('At least one LLM client is required.', 'error');
        return;
      }
      state.clients = state.clients.filter((client) => client.id !== selectedClientId);
      state.activeClientId = state.clients[0].id;
      selectedClientId = state.activeClientId;
      setDirty(true);
      renderClients();
    }

    function openPromptModal(promptId) {
      editingPromptId = promptId || null;
      const prompt = editingPromptId ? state.prompts.find((item) => item.id === editingPromptId) : makePrompt();
      if (!prompt) return;
      $('promptModalTitle').textContent = editingPromptId ? 'Edit Prompt' : 'Add Prompt';
      $('promptName').value = prompt.name;
      $('promptDescription').value = prompt.description;
      $('promptPrevious').value = prompt.numberOfPreviousCommits;
      $('promptContent').value = prompt.content;
      const readonly = prompt.canBeChanged === false;
      $('promptName').disabled = readonly;
      $('promptDescription').disabled = readonly;
      $('promptContent').disabled = readonly;
      $('savePrompt').disabled = readonly;
      renderPromptPreview();
      $('promptModal').classList.add('open');
    }

    function savePromptModal() {
      const prompt = {
        id: editingPromptId || makeId(),
        name: $('promptName').value.trim() || 'Prompt',
        description: $('promptDescription').value.trim(),
        content: $('promptContent').value,
        numberOfPreviousCommits: numberValue('promptPrevious', 5),
        canBeChanged: true
      };
      if (editingPromptId) {
        state.prompts = state.prompts.map((item) => item.id === editingPromptId ? { ...prompt, canBeChanged: item.canBeChanged } : item);
      } else {
        state.prompts.push(prompt);
        selectedPromptId = prompt.id;
        state.activePromptId = prompt.id;
      }
      closePromptModal();
      setDirty(true);
      renderPrompts();
    }

    function closePromptModal() {
      $('promptModal').classList.remove('open');
      editingPromptId = null;
      $('savePrompt').disabled = false;
    }

    function removeSelectedPrompt() {
      const prompt = state.prompts.find((item) => item.id === selectedPromptId);
      if (!prompt || prompt.canBeChanged === false) {
        setStatus('Default prompts cannot be removed.', 'error');
        return;
      }
      state.prompts = state.prompts.filter((item) => item.id !== selectedPromptId);
      state.activePromptId = state.prompts[0].id;
      selectedPromptId = state.activePromptId;
      setDirty(true);
      renderPrompts();
    }

    function renderPromptPreview() {
      const previousCount = numberValue('promptPrevious', 5);
      const previous = Array.from({ length: previousCount }, (_, index) => 'Previous commit message ' + (index + 1)).join('\\n');
      let content = $('promptContent').value;
      content = content.replaceAll('{locale}', $('locale').value || 'English');
      content = content.replaceAll('{branch}', 'feature/example');
      content = replaceHint(content, $('promptHint').value);
      content = content.replaceAll('{previousCommitMessages}', previous);
      content = content.replaceAll('{taskId}', '');
      content = content.replaceAll('{taskSummary}', '');
      content = content.replaceAll('{taskDescription}', '');
      content = content.replaceAll('{taskTimeSpent}', '');
      const diff = 'Repository: /workspace/example\\n--- a/example.ts\\n+++ b/example.ts\\n@@\\n-console.log("old")\\n+console.log("new")';
      $('promptPreview').value = content.includes('{diff}') ? content.replaceAll('{diff}', diff) : content + '\\n' + diff;
    }

    function replaceHint(content, hint) {
      return content.replace(/\\{[^{}]*(\\$hint)[^{}]*}/g, (value) => {
        if (!hint.trim()) return '';
        return value.replace('$hint', hint.trim()).replace(/[{}]/g, '');
      }).replaceAll('{hint}', hint.trim());
    }

    function addExclusion() {
      const value = $('newExclusion').value.trim();
      if (!value) return;
      if (!state.exclusions.includes(value)) {
        state.exclusions.push(value);
        selectedExclusion = value;
        setDirty(true);
      }
      $('newExclusion').value = '';
      renderExclusions();
    }

    function removeExclusion() {
      if (!selectedExclusion) return;
      state.exclusions = state.exclusions.filter((glob) => glob !== selectedExclusion);
      selectedExclusion = '';
      setDirty(true);
      renderExclusions();
    }

    function postClient(type) {
      const client = state.clients.find((item) => item.id === selectedClientId);
      if (!client) return;
      setStatus(type === 'verify' ? 'Verifying configuration...' : 'Working...');
      vscode.postMessage({ type, client, state });
    }

    function save() {
      syncTopLevelFields();
      vscode.postMessage({ type: 'save', state });
      setStatus('Saving settings...');
    }

    function resetDefaults() {
      const client = makeClient('openai');
      state.clients = [client];
      state.activeClientId = client.id;
      state.prompts = makeDefaultPrompts();
      state.activePromptId = 'basic';
      state.locale = 'English';
      state.diffMode = 'stagedThenWorkingTree';
      state.exclusions = [];
      state.useStreamingResponse = false;
      state.copyToClipboard = false;
      selectedClientId = client.id;
      selectedPromptId = 'basic';
      setDirty(true);
      render();
    }

    function syncTopLevelFields() {
      state.activeClientId = $('activeClient').value || selectedClientId;
      state.activePromptId = $('activePrompt').value || selectedPromptId;
      state.locale = $('locale').value.trim() || 'English';
      state.diffMode = $('diffMode').value;
      state.useStreamingResponse = $('streaming').checked;
      state.copyToClipboard = $('copyToClipboard').checked;
    }

    function makeClient(provider) {
      const providerDefault = providerDefaultClient(provider);
      return {
        id: makeId(),
        name: providerDefault.name || providerLabels[provider] || provider,
        provider,
        model: providerDefault.model || '',
        baseUrl: providerDefault.baseUrl || '',
        timeoutSeconds: providerDefault.timeoutSeconds == null ? 60 : providerDefault.timeoutSeconds,
        temperature: providerDefault.temperature == null ? 0.2 : providerDefault.temperature,
        topP: providerDefault.topP,
        topK: providerDefault.topK,
        maxTokens: providerDefault.maxTokens == null ? ${defaultMaxOutputTokens} : providerDefault.maxTokens,
        cleanupRegex: providerDefault.cleanupRegex || '',
        cleanupRegexIgnoreCase: Boolean(providerDefault.cleanupRegexIgnoreCase),
        cliPath: providerDefault.cliPath || '',
        codexReasoningEffort: providerDefault.codexReasoningEffort || 'medium'
      };
    }

    function providerDefaultClient(provider) {
      return defaults[provider] || {
        name: providerLabels[provider] || provider,
        provider,
        model: '',
        baseUrl: '',
        timeoutSeconds: 60,
        temperature: 0.2,
        maxTokens: ${defaultMaxOutputTokens},
        cleanupRegex: '',
        cleanupRegexIgnoreCase: false,
        cliPath: '',
        codexReasoningEffort: 'medium'
      };
    }

    function makePrompt() {
      return {
        id: makeId(),
        name: '',
        description: '',
        content: 'Write a concise commit message in {locale} for the following diff:\\n{diff}',
        numberOfPreviousCommits: 5,
        canBeChanged: true
      };
    }

    function makeDefaultPrompts() {
      return [
        {
          id: 'basic',
          name: 'Basic',
          description: 'Basic prompt that generates a decent commit message.',
          content: 'Write an insightful but concise Git commit message in a complete sentence in present tense for the following diff without prefacing it with anything, the response must be in the language {locale} and must NOT be longer than 74 characters. The sent text will be the differences between files, where deleted lines are prefixed with a single minus sign and added lines are prefixed with a single plus sign.\\n{Use this hint to improve the commit message: $hint}\\nPrevious commit messages:\\n{previousCommitMessages}\\n{diff}',
          numberOfPreviousCommits: 5,
          canBeChanged: false
        },
        {
          id: 'conventional',
          name: 'Conventional',
          description: 'Prompt for commit messages following the conventional commit convention.',
          content: 'Write a commit message in the conventional commit convention. I\\'ll send you an output of \\'git diff --staged\\' command, and you convert it into a commit message. Lines must not be longer than 74 characters. Use {locale} language to answer. End commit title with issue number if you can get it from the branch name: {branch} in parenthesis.\\n{Use this hint to improve the commit message: $hint}\\nPrevious commit messages:\\n{previousCommitMessages}\\n{diff}',
          numberOfPreviousCommits: 5,
          canBeChanged: false
        },
        {
          id: 'gitmoji',
          name: 'GitMoji',
          description: 'Prompt for generating commit messages with GitMoji.',
          content: 'Write a concise commit message from \\'git diff --staged\\' output in the format [EMOJI] [TYPE](file/topic): [description in {locale}]. Use GitMoji emojis, present tense, active voice, max 120 characters per line, no code blocks.\\nPrevious commit messages:\\n{previousCommitMessages}\\n---\\n{diff}',
          numberOfPreviousCommits: 5,
          canBeChanged: false
        }
      ];
    }

    function providerNeedsToken(provider) {
      return provider === 'openai' || provider === 'openai-compatible' || provider === 'anthropic' || provider === 'gemini';
    }

    function numberValue(id, fallback) {
      const value = Number($(id).value);
      return Number.isFinite(value) ? value : fallback;
    }

    function optionalNumberValue(id) {
      const raw = $(id).value.trim();
      if (!raw) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    }

    function makeId() {
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    function setDirty(value) {
      dirty = value;
      $('apply').disabled = !dirty;
    }

    function setStatus(message, kind) {
      const status = $('status');
      status.textContent = message;
      status.style.color = kind === 'error' ? 'var(--vscode-errorForeground)' : kind === 'ok' ? 'var(--vscode-testing-iconPassed)' : 'var(--muted)';
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
