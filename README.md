# pi-waza-rules

A [pi](https://github.com/earendil-works/pi) extension that downloads rules from [tw93/Waza](https://github.com/tw93/Waza/tree/main/rules) and adds them to the system prompt as a `waza_rules` section. You choose which rules to load and in what order.

## Install

```bash
pi install npm:pi-waza-rules
# or
pi install git:github.com/xlsdg/pi-waza-rules
```

The first session start downloads `waza-routing`, `anti-patterns`, and `clarity`. No config file is needed.

## Uninstall

```bash
pi remove npm:pi-waza-rules
# or
pi remove git:github.com/xlsdg/pi-waza-rules

# optional: delete the config and rule cache
rm -rf ~/.pi/agent/extensions/pi-waza-rules
```

If you set `PI_CODING_AGENT_DIR`, use that directory instead of `~/.pi/agent`.

## Configure

Create `~/.pi/agent/extensions/pi-waza-rules/config.json`. Every field is optional:

```json
{
  "ref": "main",
  "rules": ["waza-routing", "anti-patterns", "clarity"],
  "checkIntervalHours": 24
}
```

| Field | Default | Meaning |
|---|---|---|
| `ref` | `"main"` | `"main"` or a Waza release tag such as `"v3.40.0"`. A tag keeps the rules fixed. |
| `rules` | `["waza-routing", "anti-patterns", "clarity"]` | File names in Waza's `rules/` directory without `.md`, injected in this order. An empty array adds no rules. |
| `checkIntervalHours` | `24` | How often to check GitHub for changes. `0` checks on every session start. |

The file is read at each session start. An invalid value is ignored with a warning and falls back to its default.

`waza-routing` only helps when the Waza skills are installed. `durable-context` is already included in Waza skills, so do not load it here.

## Updates

At session start, if the last complete check is older than `checkIntervalHours` or a configured rule is not cached, the extension makes one GitHub API request listing `rules/` with each file's git blob sha. It downloads only files whose sha differs from the local copy. A rule name missing from Waza produces a warning and is not looked up again until the interval passes.

- Each request times out after 5 seconds. Closing the session cancels pending requests.
- Set `GITHUB_TOKEN` or `GH_TOKEN` to raise the API limit (60 requests per hour per IP without a token). The token is sent only to `api.github.com`.
- If the check fails, the extension uses the local copies, shows a warning, and retries at the next session start. With no local copy, it adds no rules.

Rules are cached in `~/.pi/agent/extensions/pi-waza-rules/.cache/<ref>/`, and `.checked` there records the last complete check. Deleting the directory is safe: the next session downloads the rules again.

The rules belong to [Waza](https://github.com/tw93/Waza) by Tw93 and are released under its MIT license.
