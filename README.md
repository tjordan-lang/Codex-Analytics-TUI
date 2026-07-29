# Codex Analytics TUI

A simple terminal-based monitor for Codex usage.

## What it shows

- Every usage limit Codex reports (currently weekly)
- Current local Codex session info

## What it does

- Reads local Codex data from your machine
- Displays usage in a terminal UI
- Does not send your data anywhere

## How to run

```bash
node ~/codex-usage-monitor.mjs
```

## Notes

- This tool is local-only.
- It shows usage data for the machine it is run on.
- It may display local Codex session titles and metadata.
- If Codex restores the 5-hour limit, it appears automatically beside the weekly limit.
