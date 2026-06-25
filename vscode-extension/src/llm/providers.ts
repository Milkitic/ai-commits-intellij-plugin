import { getEffectiveBaseUrl, getEffectiveModel, minimumCommitMessageTokens, Provider, Settings } from '../config';
import { compactObject, expectObject, expectString, fetchJson, fetchJsonLines, fetchSse } from './http';
import { LlmError, LlmProvider, GenerateOptions } from './types';
import { runClaudeCodeCli, runCodexCli } from './cli';

export function createProvider(provider: Provider): LlmProvider {
  switch (provider) {
    case 'openai':
    case 'openai-compatible':
      return new OpenAiCompatibleProvider(provider === 'openai');
    case 'anthropic':
      return new AnthropicProvider();
    case 'gemini':
      return new GeminiProvider();
    case 'ollama':
      return new OllamaProvider();
    case 'codex-cli':
      return {
        generate: (prompt, options) => runCodexCli(prompt, options.settings, options.cancellationToken)
      };
    case 'claude-code':
      return {
        generate: (prompt, options) => runClaudeCodeCli(prompt, options.settings, options.cancellationToken)
      };
  }
}

class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly requireApiKey: boolean) {}

  async generate(prompt: string, options: GenerateOptions): Promise<string> {
    const apiKey = options.apiKey;
    if (this.requireApiKey && !apiKey) {
      throw new LlmError('API key is not configured. Run "AI Commits: Set API Key".');
    }

    const settings = options.settings;
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    };

    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const body = compactObject({
      model: getEffectiveModel(settings),
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: settings.temperature,
      top_p: settings.topP,
      max_tokens: outputTokenLimit(settings)
    });

    if (settings.useStreamingResponse) {
      return this.generateStreaming(settings, headers, body, options);
    }

    const response = expectObject(await fetchJson(
      `${getEffectiveBaseUrl(settings)}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      },
      settings.timeoutSeconds,
      options.cancellationToken
    ), 'OpenAI-compatible');

    const choices = response.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new LlmError('Provider response did not include choices.');
    }

    const firstChoice = expectObject(choices[0], 'OpenAI-compatible choice');
    const message = expectObject(firstChoice.message, 'OpenAI-compatible message');
    return expectString(message.content, 'message content');
  }

  private async generateStreaming(
    settings: Settings,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    options: GenerateOptions
  ): Promise<string> {
    let text = '';

    await fetchSse(
      `${getEffectiveBaseUrl(settings)}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...body,
          stream: true
        })
      },
      settings.timeoutSeconds,
      options.cancellationToken,
      async (event) => {
        if (event.data === '[DONE]') {
          return;
        }

        const payload = parseStreamingPayload(event.data, 'OpenAI-compatible stream');
        const choices = payload.choices;
        if (!Array.isArray(choices)) {
          return;
        }

        for (const choice of choices) {
          const delta = expectObject(expectObject(choice, 'OpenAI-compatible stream choice').delta, 'OpenAI-compatible delta');
          const content = delta.content;
          if (typeof content === 'string' && content.length > 0) {
            text += content;
            await options.onText?.(text);
          }
        }
      }
    );

    return expectString(text, 'message content');
  }
}

class AnthropicProvider implements LlmProvider {
  async generate(prompt: string, options: GenerateOptions): Promise<string> {
    if (!options.apiKey) {
      throw new LlmError('API key is not configured. Run "AI Commits: Set API Key".');
    }

    const settings = options.settings;
    const body = compactObject({
      model: getEffectiveModel(settings),
      max_tokens: outputTokenLimit(settings),
      temperature: settings.temperature,
      top_p: settings.topP,
      top_k: settings.topK,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });
    const headers = {
      'content-type': 'application/json',
      'x-api-key': options.apiKey,
      'anthropic-version': '2023-06-01'
    };

    if (settings.useStreamingResponse) {
      return this.generateStreaming(settings, headers, body, options);
    }

    const response = expectObject(await fetchJson(
      `${getEffectiveBaseUrl(settings)}/messages`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      },
      settings.timeoutSeconds,
      options.cancellationToken
    ), 'Anthropic');

    const content = response.content;
    if (!Array.isArray(content)) {
      throw new LlmError('Anthropic response did not include content.');
    }

    const text = content
      .map((item) => expectObject(item, 'Anthropic content block').text)
      .filter((value): value is string => typeof value === 'string')
      .join('');

    return expectString(text, 'text content');
  }

  private async generateStreaming(
    settings: Settings,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    options: GenerateOptions
  ): Promise<string> {
    let text = '';

    await fetchSse(
      `${getEffectiveBaseUrl(settings)}/messages`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...body,
          stream: true
        })
      },
      settings.timeoutSeconds,
      options.cancellationToken,
      async (event) => {
        if (event.data === '[DONE]') {
          return;
        }

        const payload = parseStreamingPayload(event.data, 'Anthropic stream');
        if (payload.type === 'error') {
          const error = expectObject(payload.error, 'Anthropic stream error');
          throw new LlmError(expectString(error.message, 'error message'));
        }

        const delta = payload.delta && typeof payload.delta === 'object'
          ? payload.delta as Record<string, unknown>
          : undefined;
        const contentBlock = payload.content_block && typeof payload.content_block === 'object'
          ? payload.content_block as Record<string, unknown>
          : undefined;
        const chunk = typeof delta?.text === 'string'
          ? delta.text
          : typeof contentBlock?.text === 'string'
            ? contentBlock.text
            : '';

        if (chunk) {
          text += chunk;
          await options.onText?.(text);
        }
      }
    );

    return expectString(text, 'text content');
  }
}

class GeminiProvider implements LlmProvider {
  async generate(prompt: string, options: GenerateOptions): Promise<string> {
    if (!options.apiKey) {
      throw new LlmError('API key is not configured. Run "AI Commits: Set API Key".');
    }

    const settings = options.settings;
    const model = encodeURIComponent(getEffectiveModel(settings));
    const body = compactObject({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: prompt
            }
          ]
        }
      ],
      generationConfig: compactObject({
        temperature: settings.temperature,
        topP: settings.topP,
        topK: settings.topK,
        maxOutputTokens: outputTokenLimit(settings)
      })
    });

    if (settings.useStreamingResponse) {
      return this.generateStreaming(settings, model, body, options);
    }

    const response = expectObject(await fetchJson(
      `${getEffectiveBaseUrl(settings)}/models/${model}:generateContent?key=${encodeURIComponent(options.apiKey)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      },
      settings.timeoutSeconds,
      options.cancellationToken
    ), 'Gemini');

    const candidates = response.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new LlmError('Gemini response did not include candidates.');
    }

    const firstCandidate = expectObject(candidates[0], 'Gemini candidate');
    const content = expectObject(firstCandidate.content, 'Gemini candidate content');
    const parts = content.parts;
    if (!Array.isArray(parts)) {
      throw new LlmError('Gemini response did not include content parts.');
    }

    const text = parts
      .map((part) => expectObject(part, 'Gemini content part').text)
      .filter((value): value is string => typeof value === 'string')
      .join('');

    return expectString(text, 'text content');
  }

  private async generateStreaming(
    settings: Settings,
    model: string,
    body: Record<string, unknown>,
    options: GenerateOptions
  ): Promise<string> {
    let text = '';

    await fetchSse(
      `${getEffectiveBaseUrl(settings)}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(options.apiKey ?? '')}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      },
      settings.timeoutSeconds,
      options.cancellationToken,
      async (event) => {
        if (event.data === '[DONE]') {
          return;
        }

        const chunk = extractGeminiText(parseStreamingPayload(event.data, 'Gemini stream'));
        if (chunk) {
          text += chunk;
          await options.onText?.(text);
        }
      }
    );

    return expectString(text, 'text content');
  }
}

class OllamaProvider implements LlmProvider {
  async generate(prompt: string, options: GenerateOptions): Promise<string> {
    const settings = options.settings;
    const body = compactObject({
      model: getEffectiveModel(settings),
      stream: settings.useStreamingResponse,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      options: compactObject({
        temperature: settings.temperature,
        top_p: settings.topP,
        top_k: settings.topK,
        num_predict: outputTokenLimit(settings)
      })
    });

    if (settings.useStreamingResponse) {
      return this.generateStreaming(settings, body, options);
    }

    const response = expectObject(await fetchJson(
      `${getEffectiveBaseUrl(settings)}/api/chat`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      },
      settings.timeoutSeconds,
      options.cancellationToken
    ), 'Ollama');

    const message = response.message;
    if (message && typeof message === 'object') {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === 'string') {
        return content;
      }
    }

    return expectString(response.response, 'message content');
  }

  private async generateStreaming(
    settings: Settings,
    body: Record<string, unknown>,
    options: GenerateOptions
  ): Promise<string> {
    let text = '';

    await fetchJsonLines(
      `${getEffectiveBaseUrl(settings)}/api/chat`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      },
      settings.timeoutSeconds,
      options.cancellationToken,
      async (line) => {
        if (typeof line.error === 'string') {
          throw new LlmError(line.error);
        }

        const message = line.message && typeof line.message === 'object'
          ? line.message as Record<string, unknown>
          : undefined;
        const chunk = typeof message?.content === 'string'
          ? message.content
          : typeof line.response === 'string'
            ? line.response
            : '';

        if (chunk) {
          text += chunk;
          await options.onText?.(text);
        }
      }
    );

    return expectString(text, 'message content');
  }
}

function outputTokenLimit(settings: Settings): number {
  return Math.max(minimumCommitMessageTokens, Math.floor(settings.maxTokens || 0));
}

function parseStreamingPayload(data: string, description: string): Record<string, unknown> {
  try {
    return expectObject(JSON.parse(data) as unknown, description);
  } catch (error) {
    if (error instanceof LlmError) {
      throw error;
    }
    throw new LlmError(`Provider returned invalid streaming JSON: ${String(error)}`);
  }
}

function extractGeminiText(payload: Record<string, unknown>): string {
  const candidates = payload.candidates;
  if (!Array.isArray(candidates)) {
    return '';
  }

  return candidates
    .flatMap((candidate) => {
      const content = expectObject(expectObject(candidate, 'Gemini stream candidate').content, 'Gemini stream content');
      const parts = content.parts;
      return Array.isArray(parts) ? parts : [];
    })
    .map((part) => expectObject(part, 'Gemini stream part').text)
    .filter((value): value is string => typeof value === 'string')
    .join('');
}
