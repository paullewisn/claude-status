# claude-status

A Claude Code mod that adds a one-row status band above the prompt, centred in the window:

```
APPROVED | CONTEXT | REVIEW WANTED
```

Indicators are dark grey when idle.

| Indicator | Lights up | Colour | Flashes |
|---|---|---|---|
| `APPROVED` | The latest PR linked in the chat is approved | green | no |
| `CONTEXT` | Context window is at 60% or more | amber; red from 80% | red only |
| `REVIEW WANTED` | A non-draft PR is waiting for your review | amber | yes |

`REVIEW WANTED` is clickable only while it is flashing amber. A click forces an immediate lookup of reviews and approval, and a highlight sweeps across the text, at the same width, until the lookup finishes.

## Install

```
/plugin marketplace add paullewisn/claude-status
/plugin install status --marketplace paullewisn/claude-status
```

## Position

Mods that draw above the prompt stack in load order: the first loaded is drawn lowest. For `status` to sit at the bottom, below other band mods such as Clawd, list it before them in `enabledPlugins` in `~/.claude/settings.json`:

```json
"enabledPlugins": {
  "status@claude-status": true,
  "clawd@clawd-pet": true
}
```

Restart Claude Code after changing the order. The order is otherwise the order the plugins were installed in.

## How it works

- **Reviews**: checked at session start and every 20 minutes.
  - GitHub: `gh search prs --review-requested=@me`. Needs `gh auth login`.
  - Azure DevOps: only when `STATUS_ADO_ORG` is set (for example `https://dev.azure.com/my-org`). Needs `az login`.
- **Approval**: the last PR URL (GitHub or Azure DevOps) that appears in the chat is the linked PR.
  - GitHub: open and `reviewDecision` is `APPROVED`.
  - Azure DevOps: active, at least one approving vote and no rejecting or waiting votes. Needs `az login`.
  - Checked at session start, every 20 minutes, when a new PR link appears, and on click.
- **Context**: read from the session every 2 seconds.
