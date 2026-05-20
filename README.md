# Pi Thinking Translator

Pi extension package for translating visible assistant thinking/reasoning summaries.

> Work in progress. See [TODO.md](./TODO.md).

## Goal

This package aims to make visible assistant thinking easier to inspect when the user prefers another language.

Current behavior:

- Detect visible assistant `thinking` / `reasoning` blocks after an assistant message finishes.
- Translate headings and body text with a configurable Pi model.
- Append the translation as an extra `thinking` block so it uses the same visual style as native thinking.
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

Create `~/.pi/agent/thinking-translator.json` if you want to override defaults:

```json
{
  "enabled": true,
  "targetLanguage": "Simplified Chinese",
  "minLatinChars": 24,
  "translatorModel": {
    "provider": "ollama",
    "id": "qwen2.5:3b-instruct"
  }
}
```

The translator model must already be available in Pi's model registry, for example through `~/.pi/agent/models.json`.

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

Extensions run with full system permissions. Translation backends may receive visible thinking/reasoning text. Use a local model if that content should not leave your machine.

The current implementation appends the translation as an extra `thinking` block for matching visual style. Context isolation still needs explicit verification before publishing.
