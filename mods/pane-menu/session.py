#!/usr/bin/env python3
"""Sleep and wake a Claude session in a Herdr terminal (the pane menu's "Sleep session" / "Wake session").

  session.py sleep <terminal>   types /exit, then labels the terminal with the session Claude printed
  session.py wake <terminal>    types `cd <cwd> && claude --resume <id>` into the shell left behind
  session.py toggle <terminal>  sleep when Claude runs there, else wake

<terminal> is an hc address (`t7`, or `pi/t7` for another machine): hc reaches every machine.
The pane stays: Herdr starts Claude as `shell -c 'claude ...; exec shell'`, so after /exit
the terminal is back at its shell.

A sleeping terminal carries two hc labels, the same ones another machine's own
auto-sleep can set: `sleep.session` (the session id) and `sleep.cwd`
(the folder to resume in). Wake clears them to empty, which counts as awake. So either side
wakes what the other put to sleep, and neither wakes a session twice.

A terminal also carries `claude.session` / `claude.cwd`, the last Claude session started in it,
written by a SessionStart hook (claude/settings-hook.json). Wake falls back to them, so a
session killed without sleeping (a reboot, a crash) can still be woken.
Runs detached (the menu is closed by then); it logs to ~/.local/state/herdr-sessions/session.log.
"""
import json, os, re, shutil, subprocess, sys, time

HC = shutil.which("hc") or os.path.expanduser("~/.local/bin/hc")
DIR = os.path.expanduser("~/.local/state/herdr-sessions")
RESUME = re.compile(r"claude --resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")


def hc(*args):
    return subprocess.run([HC, *args], capture_output=True, text=True, timeout=30)


def info(t):
    r = hc("get", t, "--json")
    try:
        d = json.loads(r.stdout)
        return d.get("terminal", d)
    except ValueError:
        return None


def running(d):
    # Herdr's status has app "claude-code" only while Claude runs; a foreground named claude counts too.
    d = d or {}
    return (d.get("status") or {}).get("app") == "claude-code" or (d.get("foreground") or {}).get("name") == "claude"


def screen(t):
    return hc("read", t, "--lines", "200").stdout


def key(c):
    # hc keys names keys: a capital typed as itself comes out lowercase, so send shift+<letter>.
    return "space" if c == " " else f"shift+{c.lower()}" if c.isupper() else c


def type_text(t, text):
    # One key per character: hc send would wrap the text in <hc from=...> tags once the
    # terminal has run an agent. hc keys can't type & (so no &&); True when every key was taken.
    return hc("keys", t, *[key(c) for c in text], "enter").returncode == 0


def log(msg):
    with open(os.path.join(DIR, "session.log"), "a") as f:
        f.write(f"{time.strftime('%F %T')} {msg}\n")


def sleep(t):
    d = info(t)
    if not running(d):
        return log(f"sleep {t}: not running Claude")
    cwd = (d.get("foreground") or {}).get("cwd") or d.get("cwd") or ""
    # Count the resume lines already on screen: a session woken in this terminal printed its
    # id when it last slept, and waking resumes the same id, so "a new id" never shows up;
    # one more resume line than before does.
    before = len(RESUME.findall(screen(t)))
    if (d.get("status") or {}).get("state") == "working":
        hc("keys", t, "esc")  # stop the turn so /exit isn't queued behind it
        time.sleep(1.5)
    type_text(t, "/exit")
    for _ in range(40):
        time.sleep(0.5)
        ids = RESUME.findall(screen(t))
        found = ids[before:] if len(ids) > before else []
        if found:
            hc("label", t, f"sleep.session={found[-1]}", f"sleep.cwd={cwd}")
            return log(f"sleep {t}: {found[-1]} in {cwd}")
    log(f"sleep {t}: no resume id seen")


def resumable(d):
    # (session id, folder) to wake: the slept one, else the last one started here (SessionStart hook).
    labels = (d or {}).get("labels") or {}
    if labels.get("sleep.session"):
        return labels["sleep.session"], labels.get("sleep.cwd") or ""
    return labels.get("claude.session") or "", labels.get("claude.cwd") or ""


def wake(t):
    d = info(t)
    if not d:
        return log(f"wake {t}: no such terminal")
    sid, cwd = resumable(d)
    if not sid:
        return log(f"wake {t}: not asleep")
    if running(d):
        return log(f"wake {t}: Claude is already running")
    # `;`, not `&&` (hc keys can't type &); fish and bash both take it.
    line = f"cd '{cwd}'; claude --resume {sid}" if cwd else f"claude --resume {sid}"
    if not type_text(t, line):
        return log(f"wake {t}: couldn't type {line}")
    hc("label", t, "sleep.session=", "sleep.cwd=")
    log(f"wake {t}: {sid}")


if __name__ == "__main__":
    os.makedirs(DIR, exist_ok=True)
    action, t = sys.argv[1], sys.argv[2]
    try:
        toggle = lambda t: sleep(t) if running(info(t)) else wake(t)
        {"sleep": sleep, "wake": wake, "toggle": toggle}[action](t)
    except Exception as e:  # detached: keep a trace
        log(f"{action} {t}: {e!r}")
