import * as vscode from 'vscode';
import { LlmError } from './types';

export interface SseEvent {
  event?: string;
  data: string;
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutSeconds: number,
  cancellationToken: vscode.CancellationToken
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  const cancellation = cancellationToken.onCancellationRequested(() => controller.abort());

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    const text = await response.text();

    if (!response.ok) {
      throw new LlmError(`HTTP ${response.status}: ${truncate(text)}`);
    }

    if (!text.trim()) {
      return {};
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new LlmError(`Provider returned invalid JSON: ${String(error)}`);
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new LlmError(cancellationToken.isCancellationRequested ? 'Generation cancelled.' : 'Generation timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    cancellation.dispose();
  }
}

export async function fetchSse(
  url: string,
  init: RequestInit,
  timeoutSeconds: number,
  cancellationToken: vscode.CancellationToken,
  onEvent: (event: SseEvent) => void | Promise<void>
): Promise<void> {
  let buffer = '';

  await fetchTextStream(url, init, timeoutSeconds, cancellationToken, async (chunk) => {
    buffer += normalizeStreamChunk(chunk);
    let boundary = buffer.indexOf('\n\n');

    while (boundary !== -1) {
      const record = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseEvent(record);
      if (event) {
        await onEvent(event);
      }
      boundary = buffer.indexOf('\n\n');
    }
  });

  const event = parseSseEvent(buffer);
  if (event) {
    await onEvent(event);
  }
}

export async function fetchJsonLines(
  url: string,
  init: RequestInit,
  timeoutSeconds: number,
  cancellationToken: vscode.CancellationToken,
  onLine: (line: Record<string, unknown>) => void | Promise<void>
): Promise<void> {
  let buffer = '';

  await fetchTextStream(url, init, timeoutSeconds, cancellationToken, async (chunk) => {
    buffer += normalizeStreamChunk(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      await parseJsonLine(line, onLine);
    }
  });

  await parseJsonLine(buffer, onLine);
}

async function fetchTextStream(
  url: string,
  init: RequestInit,
  timeoutSeconds: number,
  cancellationToken: vscode.CancellationToken,
  onChunk: (chunk: string) => void | Promise<void>
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  const cancellation = cancellationToken.onCancellationRequested(() => controller.abort());

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new LlmError(`HTTP ${response.status}: ${truncate(await response.text())}`);
    }

    if (!response.body) {
      throw new LlmError('Provider did not return a streaming response body.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      await onChunk(decoder.decode(value, { stream: true }));
    }

    const finalChunk = decoder.decode();
    if (finalChunk) {
      await onChunk(finalChunk);
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new LlmError(cancellationToken.isCancellationRequested ? 'Generation cancelled.' : 'Generation timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    cancellation.dispose();
  }
}

export function expectObject(value: unknown, description: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new LlmError(`Invalid ${description} response.`);
}

export function expectString(value: unknown, description: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  throw new LlmError(`Provider response did not include ${description}.`);
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined || value[key] === null) {
      delete value[key];
    }
  }
  return value;
}

function truncate(value: string, maxLength = 1000): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function normalizeStreamChunk(chunk: string): string {
  return chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseSseEvent(record: string): SseEvent | undefined {
  if (!record.trim()) {
    return undefined;
  }

  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const line of record.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');

    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  return {
    event: eventName,
    data: dataLines.join('\n')
  };
}

async function parseJsonLine(
  line: string,
  onLine: (line: Record<string, unknown>) => void | Promise<void>
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  try {
    await onLine(expectObject(JSON.parse(trimmed) as unknown, 'stream line'));
  } catch (error) {
    if (error instanceof LlmError) {
      throw error;
    }
    throw new LlmError(`Provider returned invalid streaming JSON: ${String(error)}`);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
