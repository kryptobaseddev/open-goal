"""Real PTY input + actual read-only OpenTUI tree/focus observations.

Screen text is diagnostic only. A label painted in chat cannot satisfy a
control assertion: we require a real Select renderable and its real effects.
"""
import codecs
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import unicodedata
import urllib.request

info = json.load(open(sys.argv[1]))
out = info["out"]
rows, cols = 42, 180
results = []


class Screen:
    def __init__(self):
        self.resize(rows, cols)
        self.pending = ""

    def resize(self, height, width):
        self.rows, self.cols = height, width
        self.grid = [[" "] * width for _ in range(height)]
        self.r = self.c = 0

    def feed(self, data):
        import re
        data = self.pending + data
        self.pending = ""
        i = 0
        while i < len(data):
            ch = data[i]
            if ch == "\x1b":
                if i + 1 == len(data):
                    self.pending = data[i:]
                    break
                match = re.match(r"\x1b\[([0-9;?<>=]*)([ -/]*)([@-~])", data[i:])
                if match:
                    args, _, command = match.groups()
                    nums = [int(n) for n in re.findall(r"\d+", args)]
                    n = max(1, nums[0] if nums else 1)
                    if command in ("H", "f"):
                        fields = args.split(";")
                        self.r = int(fields[0] or "1") - 1
                        self.c = int(fields[1] or "1") - 1 if len(fields) > 1 else 0
                    elif command == "A": self.r -= n
                    elif command == "B": self.r += n
                    elif command == "C": self.c += n
                    elif command == "D": self.c -= n
                    elif command == "G": self.c = n - 1
                    elif command == "d": self.r = n - 1
                    elif command == "J" and nums and nums[0] in (2, 3): self.grid = [[" "] * self.cols for _ in range(self.rows)]
                    elif command == "K" and 0 <= self.r < self.rows:
                        mode = nums[0] if nums else 0
                        start, end = (0, self.cols) if mode == 2 else (0, self.c + 1) if mode == 1 else (self.c, self.cols)
                        for x in range(max(0, start), min(self.cols, end)): self.grid[self.r][x] = " "
                    i += match.end()
                    continue
                if data[i + 1] in ("[", "]", "P"):
                    end = data.find("\x07", i + 2) if data[i + 1] == "]" else -1
                    terminator = data.find("\x1b\\", i + 2)
                    if terminator >= 0 and (end < 0 or terminator < end): end, advance = terminator, 2
                    else: advance = 1
                    if end < 0:
                        self.pending = data[i:]
                        break
                    i = end + advance
                    continue
                i += 2
                continue
            if ch == "\r": self.c = 0
            elif ch == "\n": self.r = min(self.rows - 1, self.r + 1)
            elif ch == "\b": self.c = max(0, self.c - 1)
            elif ch >= " " and not unicodedata.combining(ch):
                if 0 <= self.r < self.rows and 0 <= self.c < self.cols: self.grid[self.r][self.c] = ch
                self.c += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
            i += 1

    def text(self):
        return "\n".join("".join(line).rstrip() for line in self.grid)


screen = Screen()
decoder = codecs.getincrementaldecoder("utf-8")("replace")
pid, fd = pty.fork()
if pid == 0:
    os.chdir(info["project"])
    env = dict(os.environ, **info.get("env", {}))
    env.update(TERM="xterm-256color", COLUMNS=str(cols), LINES=str(rows), OCGOAL_PTY_PROBE_OUTPUT=info["observer"])
    os.execve(info["binary"], [info["binary"], "--server", info["url"], "--session", info["sessionID"]], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
os.set_blocking(fd, False)
raw = open(os.path.join(out, "pty.raw"), "wb")


def pump(seconds=0.1):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if select.select([fd], [], [], 0.05)[0]:
            try: data = os.read(fd, 65536)
            except BlockingIOError: continue
            except OSError: return
            raw.write(data)
            raw.flush()
            screen.feed(decoder.decode(data))


def send(data):
    os.write(fd, data)
    pump(0.2)


def observed():
    try: return json.load(open(info["observer"]))
    except (OSError, ValueError): return {}


def node(identifier):
    return next((n for n in observed().get("nodes", []) if n["id"] == identifier and n["visible"]), None)


def wait(predicate, reason, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pump()
        value = predicate()
        if value: return value
    raise AssertionError(reason)


def check(name, predicate):
    assert predicate, name
    results.append(name)
    open(os.path.join(out, name + ".screen.txt"), "w").write(screen.text())
    json.dump(observed(), open(os.path.join(out, name + ".tree.json"), "w"), indent=2)
    json.dump(owner_state(), open(os.path.join(out, name + ".state.json"), "w"), indent=2)
    print("ASSERT", name, "PASS", flush=True)


def owner_state():
    return json.load(urllib.request.urlopen(info["controlURL"] + "/state", timeout=5))


def choose(identifier, value):
    control = wait(lambda: node(identifier), "missing actual control " + identifier)
    assert control["select"], "not a native Select: " + identifier
    index = next(i for i, option in enumerate(control["options"]) if option["value"] == value)
    # Use the focus the product actually handed us. An unnecessary mouse
    # event can return input ownership to the host composer. No inspector
    # or HTTP endpoint invokes selection or changes focus for this driver.
    control = wait(lambda: node(identifier) if node(identifier) and node(identifier)["focused"] else None, "control did not receive native keyboard focus: " + identifier)
    delta = index - control["selectedIndex"]
    for _ in range(abs(delta)): send(b"\x1b[B" if delta > 0 else b"\x1b[A")
    send(b"\r")


try:
    wait(lambda: observed().get("route", {}).get("sessionID") == info["sessionID"], "TUI did not attach to primary")
    cards = wait(lambda: [n for n in observed().get("nodes", []) if n["id"].startswith("goal-card:") and n["select"]], "sidebar cards missing")
    check("two-rendered-cards", len(cards) == 2)
    send(b"\x1b[20~")  # proven OpenCode 2.0.26 F9, not the old leader probe
    manager = wait(lambda: node("goal-manager-list") if node("goal-manager-list") and node("goal-manager-list")["focused"] else None, "goal-less manager failed to open and take keyboard focus")
    expected_keys = {"live:" + info.get("firstSlug", "demo") + ":" + info["firstRunId"], "live:" + info.get("secondSlug", "second") + ":" + info["secondRunId"]}
    collection_ok = expected_keys.issubset({o["value"] for o in manager["options"]}) if info.get("managerOnly") else len(manager["options"]) == 2
    check("goal-less-native-manager", manager["select"] and manager["focused"] and collection_ok)
    first_key = "live:" + info.get("firstSlug", "demo") + ":" + info["firstRunId"]
    # Real pointer selection must expand the clicked row, not silently act
    # on whatever keyboard index happened to be selected previously.
    index = next(i for i, option in enumerate(manager["options"]) if option["value"] == first_key)
    x, y = manager["x"] + 4, manager["y"] + index * 2
    send(f"\x1b[<0;{x + 1};{y + 1}M\x1b[<0;{x + 1};{y + 1}m".encode())
    wait(lambda: node("goal-manager-details"), "pointer selection did not expand the actual row")
    check("expand-before-jump", observed()["route"]["sessionID"] == info["sessionID"])
    choose("goal-manager-actions", "jump")
    wait(lambda: observed().get("route", {}).get("sessionID") == info["firstSessionID"], "explicit jump did not focus selected session")
    check("explicit-session-jump", any(t["sessionID"] == info["firstSessionID"] and t["active"] for t in observed()["tabs"]))
    # Return to the actual original tab with its rendered tab strip. Tab
    # membership is observed independently of any matching transcript text.
    original_tab = next(t for t in observed()["tabs"] if t["sessionID"] == info["sessionID"])
    label = original_tab["title"]
    def tab_position():
        for y, line in enumerate(screen.grid[:4]):
            x = "".join(line).find(label)
            if x >= 0: return x + 1, y
        return None
    x, y = wait(tab_position, "original tab was not rendered in header")
    send(f"\x1b[<0;{x + 1};{y + 1}M\x1b[<0;{x + 1};{y + 1}m".encode())
    wait(lambda: observed().get("route", {}).get("sessionID") == info["sessionID"], "original tab click did not navigate")
    pump(0.3)
    if observed().get("panel", {}).get("name") != "goal-dashboard": send(b"\x1b[20~")
    if not node("goal-manager-details"):
        choose("goal-manager-list", first_key)
    wait(lambda: node("goal-manager-details"), "returning to the original tab did not preserve expanded details")
    # Pause via the selected manager action, not a direct fixture API call.
    actions = wait(lambda: node("goal-manager-actions"), "selected action controls missing")
    index = next(i for i, option in enumerate(actions["options"]) if option["value"] == "pause")
    x, y = actions["x"] + 4, actions["y"] + index
    send(f"\x1b[<0;{x + 1};{y + 1}M\x1b[<0;{x + 1};{y + 1}m".encode())
    wait(lambda: owner_state()["first"]["status"] == "paused", "selected pause did not execute")
    check("selected-action-isolated", owner_state()["second"]["status"] == "waiting")
    # Resize the real PTY and require actual focus/control bounds, not flat
    # transcript substring presence at a pretend narrow viewport.
    cols = 70
    screen.resize(rows, cols)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)
    wait(lambda: observed().get("width") == cols, "narrow resize not observed")
    # Host width and input ownership settle on separate render passes.
    # Require the actual native focus/bounds, not just the first width
    # snapshot. A permanently lost focus still fails this bounded wait.
    actions = wait(lambda: node("goal-manager-actions") if node("goal-manager-actions") and
                   node("goal-manager-actions")["focused"] and node("goal-manager-actions")["x"] >= 0 and
                   node("goal-manager-actions")["x"] + node("goal-manager-actions")["width"] <= cols and
                   node("goal-manager-actions")["y"] + node("goal-manager-actions")["height"] <= rows else None,
                   "narrow selected controls did not regain focus inside the viewport")
    check("narrow-focus-and-bounds", actions["focused"] and actions["x"] >= 0 and actions["x"] + actions["width"] <= cols and actions["y"] + actions["height"] <= rows)
    close = wait(lambda: node("goal-manager-close"), "no visible manager Close control")
    assert close["select"] and close["x"] + close["width"] <= cols and close["y"] + close["height"] <= rows, "Close control clipped"
    x, y = close["x"] + 2, close["y"]
    send(f"\x1b[<0;{x + 1};{y + 1}M\x1b[<0;{x + 1};{y + 1}m".encode())
    wait(lambda: observed().get("panel", {}).get("name") != "goal-dashboard" and not node("goal-manager"), "Close did not return to the basic session/sidebar")
    check("visible-close-to-sidebar", observed().get("route", {}).get("sessionID") == info["sessionID"])
    send(b"\x1b[20~")
    wait(lambda: node("goal-manager-actions") and node("goal-manager-actions")["focused"], "F9 reopen did not restore the selected action focus")
    check("f9-reopen-selected-focus", observed().get("route", {}).get("sessionID") == info["sessionID"])
    if info.get("decisionBridge"):
        choose("goal-manager-actions", "jump")
        wait(lambda: observed().get("route", {}).get("sessionID") == info["firstSessionID"], "resume popup target session not focused")
        request = urllib.request.Request(info["controlURL"] + "/resume-review", data=b"{}", method="POST")
        json.load(urllib.request.urlopen(request, timeout=10))
        def popup_control():
            # The host's dialog.select uses actual pointer-enabled row
            # boxes, not SelectRenderable. Require a real rendered handler,
            # one-row bounds and its exact label; never transcript alone.
            return next((n for n in observed().get("pointerControls", []) if n.get("visible") and n.get("mouseHandlers")
                         and 0 < n.get("height", 0) <= 2 and n.get("text", "").startswith("Resume selected goal")), None)
        popup = wait(popup_control, "no actual selectable resume popup control")
        check("delayed-form-native-popup", owner_state()["first"]["status"] == "paused")
        x, y = popup["x"] + 2, popup["y"]
        assert 0 <= x < cols and 0 <= y < rows, "resume popup row outside viewport"
        send(f"\x1b[<0;{x + 1};{y + 1}M\x1b[<0;{x + 1};{y + 1}m".encode())
        wait(lambda: owner_state()["first"]["status"] == "waiting", "real popup pick did not resume exact goal")
        check("popup-resume-delivered-once", owner_state()["first"]["runId"] == info["firstRunId"] and owner_state()["second"]["status"] == "waiting" and owner_state().get("firstResumes") == 1)
        request = urllib.request.Request(info["controlURL"] + "/pause-held", data=b"{}", method="POST")
        json.load(urllib.request.urlopen(request, timeout=10))
        wait(lambda: owner_state()["first"]["status"] == "paused", "QA cleanup could not pause inspected goal")
        x, y = wait(tab_position, "original tab missing after popup inspection")
        send(f"\x1b[<0;{x + 1};{y + 1}M\x1b[<0;{x + 1};{y + 1}m".encode())
        wait(lambda: observed().get("route", {}).get("sessionID") == info["sessionID"], "original tab not restored")
        if observed().get("panel", {}).get("name") != "goal-dashboard": send(b"\x1b[20~")
        if not node("goal-manager-details"): choose("goal-manager-list", first_key)
        wait(lambda: node("goal-manager-actions") and node("goal-manager-actions")["focused"], "selected actions not refocused")
    if info.get("managerOnly"):
        json.dump({"pass": True, "checks": results}, open(os.path.join(out, "pty-result.json"), "w"), indent=2)
        sys.exit(0)
    # Exit the old run via the real native confirmation, then perform a
    # fixture-owner fresh launch and prove the UI actually focuses its tab.
    choose("goal-manager-actions", "abort")
    pump(0.5)
    # Owner native form: the composer owns it; first offered option is Abort.
    send(b"\r")
    wait(lambda: owner_state()["first"]["status"] == "aborted", "native abort confirmation did not execute")
    request = urllib.request.Request(info["controlURL"] + "/fresh", data=b"{}", method="POST")
    response = json.load(urllib.request.urlopen(request, timeout=30))
    fresh = response["first"]["sessionID"]
    # Router navigation and tab hydration settle independently. Require
    # BOTH real observations before asserting focus; a route-only snapshot
    # can precede registration of the new native tab by one render pass.
    wait(lambda: observed().get("route", {}).get("sessionID") == fresh and
         any(t["sessionID"] == fresh and t["active"] for t in observed().get("tabs", [])), "fresh launch did not register and focus its new root tab")
    check("fresh-tab-focus", any(t["sessionID"] == fresh and t["active"] for t in observed()["tabs"]) and owner_state()["second"]["status"] == "waiting")
    json.dump({"pass": True, "checks": results}, open(os.path.join(out, "pty-result.json"), "w"), indent=2)
except Exception as error:
    print("GOAL-MANAGER-GATE FAIL", str(error), flush=True)
    open(os.path.join(out, "failure.screen.txt"), "w").write(screen.text())
    json.dump(observed(), open(os.path.join(out, "failure.tree.json"), "w"), indent=2)
    json.dump({"pass": False, "checks": results, "error": str(error)}, open(os.path.join(out, "pty-result.json"), "w"), indent=2)
    sys.exitcode = 1
finally:
    raw.close()
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    # An attached TUI can hang in shutdown after TERM. Bound cleanup of
    # ONLY the child this gate created; never kill a shared service/agent.
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            if os.waitpid(pid, os.WNOHANG)[0]: break
        except ChildProcessError: break
        time.sleep(0.05)
    else:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        try: os.waitpid(pid, 0)
        except ChildProcessError: pass
    os.close(fd)
sys.exit(getattr(sys, "exitcode", 0))
