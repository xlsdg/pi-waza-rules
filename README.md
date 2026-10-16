# pi-waza-rules

A [pi](https://github.com/earendil-works/pi) extension that downloads rules from [tw93/Waza](https://github.com/tw93/Waza/tree/main/rules) and adds them to the system prompt as a `waza_rules` section. You choose which rules to load and in what order.

## Install

```bash
pi install npm:pi-waza-rules
# or
pi install git:github.com/xlsdg/pi-waza-rules
```

On the first session start it downloads `waza-routing`, `anti-patterns`, and `clarity` and shows `Waza rules active (...)`. No config file is needed.

## Configure

Create `~/.pi/agent/extensions/pi-waza-rules/config.json` (if you set `PI_CODING_AGENT_DIR`, use that directory instead of `~/.pi/agent`). Every field is optional:

```json
{
  "ref": "main",
  "rules": ["waza-routing", "anti-patterns", "clarity"],
  "checkIntervalHours": 24
}
```

| Field | Default | Meaning |
|---|---|---|
| `ref` | `"main"` | `"main"` or a Waza release tag such as `"v3.40.0"`. Use a tag to keep the rules fixed until you change it. |
| `rules` | `["waza-routing", "anti-patterns", "clarity"]` | Rule names, injected in this order. A name is a file name in Waza's `rules/` directory without `.md`. An empty array adds no rules. |
| `checkIntervalHours` | `24` | How often to check GitHub for changes. `0` checks on every session start. |

The extension reads the file at each session start, so a change applies to the next session. An invalid value is ignored with a warning, and that field falls back to its default.

`waza-routing` only helps when the Waza skills are installed, because it points the model at them. `durable-context` is a shared preamble that Waza skills already include, so it does not need to be loaded here.

Package updates do not touch this file, and `pi remove` does not delete it. The same applies to the rule cache.

## Updates

The extension checks for updates at session start when the last complete check is older than `checkIntervalHours`, or when a configured rule is neither cached nor known to be missing from Waza. One GitHub API request lists `rules/` with each file's git blob sha. The extension compares that sha with one computed from the local copy and downloads only the files that differ. A rule name that Waza does not have is reported as a warning and is not looked up again until the interval passes.

Each request has its own 5-second timeout. Closing or replacing the session cancels any request still running. Set `GITHUB_TOKEN` or `GH_TOKEN` to raise GitHub's API limit; the token is sent only to `api.github.com`.

If the check fails (offline, timeout, or GitHub's limit of 60 unauthenticated requests per hour per IP), the extension keeps using the local copies, shows a warning, and tries again at the next session start. If there is no local copy either, it adds no rules to the prompt.

Downloaded rules are stored in `~/.pi/agent/extensions/pi-waza-rules/.cache/<ref>/`, next to `config.json`, so the git and npm installs behave the same and updating or removing the package does not touch them. The `.checked` file in that directory records the last complete check. You can delete the directory at any time; the next session downloads the rules again.

The rules belong to [Waza](https://github.com/tw93/Waza) by Tw93 and are released under its MIT license.
