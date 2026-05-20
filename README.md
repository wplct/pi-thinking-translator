# Pi Thinking Translator

Pi extension package for translating visible assistant thinking/reasoning summaries.

> Work in progress. See [TODO.md](./TODO.md).

## Goal

This package aims to make visible assistant thinking easier to inspect when the user prefers another language.

Current behavior:

- Detect configured visible assistant thinking-like blocks after an assistant message finishes.
- Translate headings and body text with a configurable Pi model.
- Merge the translation into the same source block so it appears directly under the original text while keeping the native thinking style.
- Strip extension-added translation blocks from future model context and compaction inputs.
- Keep only the latest few persisted translation blocks by default to reduce uninstall-time context pollution.
- Keep display minimal: no `EN` / `ZH` labels, no extra title, and no repeated source text.

Open work:

- Confirm the appended translation block does not pollute future LLM context.
- Add optional API translator backends.

## Install

During local development:

```bash
pi -e /Users/wplct/Developer/yaozhishi/pi-thinking-translator
```

After publishing as a git package:

```bash
pi install git:github.com/yourname/pi-thinking-translator@v0.1.0
```

After publishing to npm:

```bash
pi install npm:pi-thinking-translator
```

## Configuration

The extension does not create a config file automatically and does not choose a default translator model. Built-in defaults are used unless you explicitly override them:

```json
{
  "enabled": true,
  "targetLanguage": "Simplified Chinese",
  "contentTypes": ["thinking"],
  "minLatinChars": 24,
  "maxPersistedTranslations": 3
}
```

Configuration files are optional partial overrides. They follow Pi's global/project convention:

1. Built-in defaults
2. Global config: `~/.pi/agent/thinking-translator.json`
3. Project config: `.pi/thinking-translator.json`

Project config overrides global config. Use the status command to inspect the effective config:

```bash
/thinking-translator
/thinking-translator status
```

Create a disabled template explicitly when you want one:

```bash
/thinking-translator init --global
/thinking-translator init --project
```

To enable translation, add a model that already exists in Pi's model registry, for example through `~/.pi/agent/models.json`, then set `enabled` to `true`:

```json
{
  "enabled": true,
  "translatorModel": {
    "provider": "ollama",
    "id": "your-model-id"
  }
}
```

If translation is enabled but `translatorModel` is missing or cannot be found, the extension shows a warning and skips translation without affecting the main assistant message.

`contentTypes` controls which content blocks are translated. Pi's documented message content blocks include `text`, `image`, `thinking`, and `toolCall`; this extension supports textual blocks only: `thinking`, `reasoning`, `reasoning_summary`, and `text`. The default is `thinking` only, because ordinary `text` is the final assistant answer.

Enable `text` only if you also want normal assistant responses translated for display:

```json
{
  "contentTypes": ["thinking", "text"]
}
```

When `text` is enabled, the translated answer is appended under the original answer in the UI. The extension still restores the original block before future model context and compaction.

`maxPersistedTranslations` controls how many assistant messages keep display translations in the session file. Set it to `0` if you want translations to be shown only during the current turn and removed from persisted history after the turn finishes.

## Development

```bash
npm install
npm run check
```

## Package Layout

```text
pi-thinking-translator/
  package.json
  README.md
  TODO.md
  extensions/
    thinking-translator.ts
```

## Security Notes

Extensions run with full system permissions. Translation backends may receive the visible blocks enabled by `contentTypes`, including final assistant answers if `text` is enabled. Use a local model if that content should not leave your machine.

The current implementation stores translations as display metadata on the source block, then restores the original block in `context` and `session_before_compact` events so display translations do not enter future model context or compaction summaries. To reduce risk if the extension is later removed, the session file is pruned on startup and after each agent turn so only the latest `maxPersistedTranslations` translated assistant messages remain.
