import * as vscode from 'vscode';
import { LlmError } from './types';

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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
