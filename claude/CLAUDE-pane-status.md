# Pane status in Herdr

When running in Herdr (`$HC_TERMINAL_ID` is set), to let the user see at a glance what each session is doing, set your pane's status when you start a piece of work and as the last tool call of every reply. Keep it to one short line, about 40 characters, saying what you're doing and on what:

```bash
hc label "$HC_TERMINAL_ID" "status=Building: parser fix" "status.color=blue" >/dev/null
```

A hook in `settings.json` clears the status each time the user sends a message, so set it again in every reply. Colours: `blue` working, `yellow` waiting for the user's answer, `red` blocked on something only the user can do, `green` done. No other colours. Examples: "Waiting: which folder to use?" yellow, "Restart computer" red, "Done: PR #137 ready" green.
