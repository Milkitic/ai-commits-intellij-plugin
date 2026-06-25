import * as vscode from 'vscode';
import { Settings } from '../config';

export interface GenerateOptions {
  settings: Settings;
  apiKey?: string;
  cancellationToken: vscode.CancellationToken;
  onText?: (text: string) => void | Promise<void>;
}

export interface LlmProvider {
  generate(prompt: string, options: GenerateOptions): Promise<string>;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}
