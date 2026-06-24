import { PromptPreset, Settings } from './config';

interface PromptDefinition {
  name: string;
  description: string;
  content: string;
}

export const defaultPrompts: Record<Exclude<PromptPreset, 'custom'>, PromptDefinition> = {
  basic: {
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
      '{diff}'
  },
  conventional: {
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
      '{diff}'
  },
  gitmoji: {
    name: 'GitMoji',
    description: 'Prompt for generating commit messages with GitMoji.',
    content:
      "Write a concise commit message from 'git diff --staged' output in the format " +
      '`[EMOJI] [TYPE](file/topic): [description in {locale}]`. Use GitMoji emojis (e.g., ✨ -> feat), ' +
      'present tense, active voice, max 120 characters per line, no code blocks.\n' +
      'Previous commit messages:\n' +
      '{previousCommitMessages}\n' +
      '---\n' +
      '{diff}'
  }
};

export interface PromptInput {
  settings: Settings;
  diff: string;
  branch?: string;
  hint?: string;
  previousCommitMessages: string[];
}

export function constructPrompt(input: PromptInput): string {
  let content = getPromptTemplate(input.settings);

  content = content.replaceAll('{locale}', input.settings.locale);
  content = replaceBranch(content, input.branch);
  content = replaceHint(content, input.hint);
  content = content.replaceAll('{previousCommitMessages}', input.previousCommitMessages.join('\n'));
  content = replaceTaskVariables(content);

  if (content.includes('{diff}')) {
    return content.replaceAll('{diff}', input.diff);
  }

  return `${content}\n${input.diff}`;
}

export function cleanupGeneratedMessage(message: string, settings: Settings): string {
  let cleaned = message.trim();
  if (!settings.cleanupRegex.trim()) {
    return cleaned;
  }

  try {
    const flags = settings.cleanupRegexIgnoreCase ? 'gi' : 'g';
    cleaned = cleaned.replace(new RegExp(settings.cleanupRegex, flags), '').trim();
  } catch {
    // Invalid cleanup patterns should not discard a generated message.
  }
  return cleaned;
}

function getPromptTemplate(settings: Settings): string {
  if (settings.promptContent?.trim()) {
    return settings.promptContent;
  }

  if (settings.promptPreset === 'custom') {
    return settings.customPrompt.trim() || defaultPrompts.basic.content;
  }

  return defaultPrompts[settings.promptPreset].content;
}

function replaceBranch(content: string, branch?: string): string {
  if (!content.includes('{branch}')) {
    return content;
  }
  return content.replaceAll('{branch}', branch?.trim() || 'main');
}

function replaceHint(content: string, hint?: string): string {
  const normalizedHint = hint?.trim();
  const conditionalHintRegex = /\{[^{}]*(\$hint)[^{}]*}/g;

  content = content.replace(conditionalHintRegex, (value) => {
    if (!normalizedHint) {
      return '';
    }
    return value.replace('$hint', normalizedHint).replace(/[{}]/g, '');
  });

  return content.replaceAll('{hint}', normalizedHint || '');
}

function replaceTaskVariables(content: string): string {
  return content
    .replaceAll('{taskId}', '')
    .replaceAll('{taskSummary}', '')
    .replaceAll('{taskDescription}', '')
    .replaceAll('{taskTimeSpent}', '');
}
