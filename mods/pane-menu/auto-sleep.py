#!/usr/bin/env python3
"""Puts Claude sessions on this machine to sleep after an hour without activity.

Run by cron every 10 minutes:
  */10 * * * * python3 ~/.config/herdr-app/mods/pane-menu/auto-sleep.py

A session sleeps when Herdr's status for its terminal is `idle` or `done` and hasn't changed
for IDLE_MINUTES (status_ms). Working and blocked sessions are left alone: a blocked one is
waiting on the user, and sleeping it would drop the question it's showing. Sleeping is the pane
menu's "Sleep session" (session.py sleep): Claude exits and the terminal keeps the session id
in its sleep.session / sleep.cwd labels, so "Wake session" resumes it.

Only this machine's terminals (no `machine/` prefix): each machine runs its own.
`--report` prints every session, grouped: already sleeping, newly slept, still awake. `--dry-run` prints the same without sleeping anything. Logs to ~/.local/state/herdr-sessions/session.log.
"""
import json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import session  # noqa: E402  (session.py beside this file)

IDLE_MINUTES = 60


def terminals():
    d = json.loads(session.hc("ls", "--json").stdout or "[]")
    return d if isinstance(d, list) else d.get("terminals", [])


def slept_at():
    # When each terminal last went to sleep, from session.log ("<date> <time> sleep t5c: <id> in ...").
    out = {}
    try:
        for line in open(os.path.join(session.DIR, "session.log")):
            f = line.split()
            if len(f) > 3 and f[2] == "sleep" and f[3].endswith(":") and len(f) > 4 and "-" in f[4]:
                out[f[3][:-1]] = time.mktime(time.strptime(f"{f[0]} {f[1]}", "%Y-%m-%d %H:%M:%S")) * 1000
    except OSError:
        pass
    return out


def main(dry, report):
    os.makedirs(session.DIR, exist_ok=True)
    now = time.time() * 1000
    asleep, slept, awake = [], [], []
    for t in terminals():
        a = t.get("address", "")
        if "/" in a:
            continue
        d = session.info(a) or {}
        labels = d.get("labels") or {}
        where = labels.get("where", a)
        st = d.get("status") or {}
        idle_min = (now - (d.get("status_ms") or now)) / 60000
        if labels.get("sleep.session") and not session.running(d):
            asleep.append((where, a))
            continue
        if st.get("app") != "claude-code":
            continue
        if st.get("state") not in ("idle", "done") or idle_min < IDLE_MINUTES:
            awake.append((where, a, idle_min, st.get("state") or "?"))
            continue
        if not dry:
            session.log(f"auto-sleep {a} ({where}): idle {idle_min:.0f} min")
            session.sleep(a)
        slept.append((where, a, idle_min))
    if report:
        since = slept_at()
        ago = lambda a: f"{(now - since[a]) / 60000:.0f} min ago" if a in since else "time unknown"
        print(f"Already sleeping ({len(asleep)}):")
        for where, a in sorted(asleep):
            print(f"  {where:<40} slept {ago(a)}")
        print(f"\n{'Would sleep' if dry else 'Newly slept'} ({len(slept)}):")
        for where, a, m in sorted(slept):
            print(f"  {where:<40} idle {m:.0f} min")
        print(f"\nStill awake ({len(awake)}), sleep after {IDLE_MINUTES} min idle:")
        for where, a, m, state in sorted(awake, key=lambda x: -x[2]):
            print(f"  {where:<40} {state:<8} {m:.0f} min since last change")


if __name__ == "__main__":
    # Cron runs it quietly; --report prints the three groups.
    main("--dry-run" in sys.argv, "--report" in sys.argv or "--dry-run" in sys.argv)
