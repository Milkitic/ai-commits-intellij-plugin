import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getEffectiveModel, Settings } from '../config';
import { LlmError } from './types';

interface CliResult {
  stdout: string;
  stderr: string;
}

export async function runCodexCli(prompt: string, settings: Settings, cancellationToken: vscode.CancellationToken): Promise<string> {
  const cli = settings.cliPath || 'codex';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-commits-codex-'));
  const outputFile = path.join(tempDir, 'message.txt');
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--output-last-message',
    outputFile
  ];

  const model = getEffectiveModel(settings);
  if (model) {
    args.push('--model', model);
  }

  const reasoningEffort = settings.codexReasoningEffort.toLowerCase().replace(/\s+/g, '_');
  if (reasoningEffort) {
    args.push('--config', `model_reasoning_effort="${reasoningEffort}"`);
  }

  args.push('--', prompt);

  try {
    const result = await runCli(cli, args, settings.timeoutSeconds, cancellationToken);
    const outputMessage = await readFileIfExists(outputFile);
    const candidate = outputMessage.trim() || result.stdout.trim();
    if (!candidate) {
      throw new LlmError('No result from Codex CLI.');
    }
    return candidate;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function runClaudeCodeCli(prompt: string, settings: Settings, cancellationToken: vscode.CancellationToken): Promise<string> {
  const cli = settings.cliPath || 'claude';
  const args = ['-p', '--output-format', 'json'];

  const model = getEffectiveModel(settings);
  if (model) {
    args.push('--model', model);
  }

  args.push(prompt);
  const result = await runCli(cli, args, settings.timeoutSeconds, cancellationToken);

  try {
    const parsed = JSON.parse(result.stdout) as {
      is_error?: boolean;
      result?: string;
    };

    if (!parsed.result) {
      throw new LlmError('No result in Claude Code response.');
    }

    if (parsed.is_error) {
      throw new LlmError(parsed.result);
    }

    return parsed.result;
  } catch (error) {
    if (error instanceof LlmError) {
      throw error;
    }
    throw new LlmError(`Failed to parse Claude Code response: ${String(error)}`);
  }
}

function runCli(
  command: string,
  args: string[],
  timeoutSeconds: number,
  cancellationToken: vscode.CancellationToken
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      finish(new LlmError('CLI execution timed out.'));
      child.kill();
    }, timeoutSeconds * 1000);

    const cancellation = cancellationToken.onCancellationRequested(() => {
      finish(new LlmError('Generation cancelled.'));
      child.kill();
    });

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', (error) => finish(new LlmError(`Failed to start CLI: ${error.message}`)));
    child.on('close', (code) => {
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');

      if (code === 0) {
        finish(undefined, { stdout: stdoutText, stderr: stderrText });
      } else {
        finish(new LlmError(`CLI exited with code ${code}: ${stderrText || stdoutText}`));
      }
    });

    function finish(error?: Error, result?: CliResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      cancellation.dispose();

      if (error) {
        reject(error);
      } else if (result) {
        resolve(result);
      }
    }
  });
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}
