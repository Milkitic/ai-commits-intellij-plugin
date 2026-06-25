# AI Commits for VS Code

Generate Git commit messages from diffs with LLMs. This is a VS Code port of the IntelliJ-based AI Commits plugin in the parent repository.

## Features

- Generate a commit message from staged Git changes.
- Optionally generate from working tree changes, including untracked files.
- Use staged changes first and automatically fall back to working tree changes when nothing is staged.
- Write the result directly into the Source Control commit input.
- Use the same prompt variables as the IntelliJ plugin: `{locale}`, `{diff}`, `{branch}`, `{hint}`, `{previousCommitMessages}`, `{taskId}`, `{taskSummary}`, `{taskDescription}`, and `{taskTimeSpent}`.
- Store API keys in VS Code SecretStorage.
- Exclude changed files with glob patterns.
- Include Git `textconv` output for supported non-text files, such as documents converted by a local diff driver.

## Providers

- OpenAI
- OpenAI-compatible APIs
- Anthropic
- Gemini
- Ollama
- Codex CLI
- Claude Code

OpenAI-compatible APIs can be used for services such as GitHub Models, LM Studio, LocalAI, and other chat-completions-compatible endpoints.

## Usage

1. Open a Git workspace in VS Code.
2. Stage the files you want included in the commit message.
3. Run `AI Commits: Select Provider`.
4. For API providers, run `AI Commits: Set API Key`.
5. Run `AI Commits: Generate Commit Message` from the Command Palette or the Source Control title bar.

For the full settings UI, run `AI Commits: Open Settings`. The custom settings page mirrors the IntelliJ plugin layout with:

- Active LLM client selection
- LLM client table with add, edit, remove, token, and verify actions
- Locale and diff mode controls
- Prompt table with add, edit, remove, and preview support
- Exclusion glob management

Use `AI Commits: Generate Commit Message with Hint` to pass extra context into prompts that include `{hint}` or the conditional hint form:

```text
{Use this hint to improve the commit message: $hint}
```

Use `AI Commits: Preview Prompt` to inspect the exact prompt before it is sent.

## Git textconv

AI Commits runs `git diff --textconv`, so Git diff drivers configured on your machine or in the current repository can convert supported non-text files into textual diffs before the prompt is sent to the LLM.

For example, a repository can opt docx files into a `docx` diff driver:

```gitattributes
*.docx diff=docx
```

Then define the converter in your global Git config or this repository's local Git config:

```bash
git config --global diff.docx.textconv "pandoc --to=plain"
# or, for this repository only:
git config diff.docx.textconv "pandoc --to=plain"
```

Use whichever textconv command is installed on your machine. The extension does not bundle document converters; it asks Git to run the configured command and includes Git's textual diff output.

## Settings

The main settings are:

- `aiCommits.provider`: LLM provider.
- `aiCommits.model`: Model ID. Leave blank to use the provider default.
- `aiCommits.baseUrl`: Provider base URL. Leave blank to use the provider default.
- `aiCommits.promptPreset`: `basic`, `conventional`, `gitmoji`, or `custom`.
- `aiCommits.customPrompt`: Custom prompt content when `promptPreset` is `custom`.
- `aiCommits.diffMode`: `stagedThenWorkingTree`, `staged`, or `workingTree`.
- `aiCommits.exclusions`: Glob patterns for changed files to omit from the diff.
- `aiCommits.cleanupRegex`: Regex removed from the generated message.
- `aiCommits.cliPath`: Path to the Codex CLI or Claude Code executable. Leave blank to use `codex` or `claude` from `PATH`.

API keys are stored with `AI Commits: Set API Key`; they are not saved in settings.

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code from this directory to launch an Extension Development Host.

## Port Notes

The IntelliJ plugin can compute diffs from selected files and lines in the commit dialog. VS Code's public Git extension API does not expose the exact same commit-dialog selection model, so this port uses staged changes by default and falls back to working tree changes when nothing is staged.
