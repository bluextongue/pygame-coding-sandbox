# -*- coding: utf-8 -*-
from __future__ import annotations
import os
import subprocess
import sys


def _friendly_sandbox_path(raw: str) -> str:
  r"""Make SANDBOX_ROOT safe for chdir, tkinter/turtle, and relative filenames.

  Rust often passes a canonical path with a ``\\?\\`` (extended-length) prefix on
  Windows; some Tk/PhotoImage code handles that poorly. UNC paths need ``\\server\share`` form.
  """
  p = os.path.normpath(os.path.expandvars(os.path.expanduser(raw)))
  if os.name == "nt" and p.startswith("\\\\?\\"):
    rest = p[4:]
    if rest.upper().startswith("UNC\\"):
      return "\\\\" + rest[4:]
    return rest
  return p


def _install_turtle_to_front() -> None:
  """Make turtle/tk windows appear in front of the Tauri app (same machine).

  Tk is owned by the Python process, which the OS can leave behind the host IDE
  (especially on macOS, where the menu bar shows *Python*). We wrap :func:`turtle.Screen`
  and bring the toplevel forward after the screen is created, with a few delayed retries
  for slow first maps (e.g. loading a multi-frame GIF before ``mainloop``).
  """
  from tkinter import TclError

  def _raise_tk_from_screen(s: object) -> None:
    try:
      cv = getattr(s, "cv", None)
      if cv is None:
        return
      root = cv.winfo_toplevel()

      def one() -> None:
        try:
          root.lift()
        except (TclError, TypeError, ValueError, RuntimeError, OSError):
          pass
        try:
          root.update_idletasks()
        except (TclError, RuntimeError, OSError):
          pass
        try:
          root.attributes("-topmost", True)
          def _un_top() -> None:
            try:
              root.attributes("-topmost", False)
            except TclError:
              pass
          root.after(80, _un_top)
        except TclError:
          pass
        try:
          root.focus_force()
        except (TclError, Exception):
          pass
        if sys.platform == "darwin":
          try:
            pid = str(os.getpid())
            subprocess.run(
              [
                "/usr/bin/osascript",
                "-e",
                f'tell application "System Events" to set frontmost of first process whose unix id is {pid} to true',
              ],
              check=False,
              capture_output=True,
              timeout=3,
              stdin=subprocess.DEVNULL,
            )
          except (FileNotFoundError, subprocess.SubprocessError, OSError, ValueError, TypeError):
            pass
        elif sys.platform == "win32":
          try:
            import ctypes
            hw = int(root.winfo_id())
            ctypes.windll.user32.SetForegroundWindow(hw)  # best-effort; may be ignored by policy
          except (OSError, ValueError, TypeError, AttributeError, ImportError, Exception):
            pass

      # Same tick + later — child window can map only after a long setup (GIF frame loop).
      for delay in (0, 80, 400, 1200):
        if delay:
          try:
            root.after(delay, one)
          except TclError:
            break
        else:
          one()
    except (AttributeError, Exception):
      return

  try:
    import turtle
  except ImportError:
    return

  if getattr(_install_turtle_to_front, "_done", False):
    return
  _orig_screen = turtle.Screen

  def _screen() -> object:
    s = _orig_screen()
    _raise_tk_from_screen(s)
    return s

  _install_turtle_to_front._done = True
  turtle.Screen = _screen


def _main() -> None:
  raw = os.environ.get("SANDBOX_ROOT", "")
  if not raw:
    print("SANDBOX_ROOT is not set", file=sys.stderr)
    raise SystemExit(1)
  base = _friendly_sandbox_path(raw)
  os.makedirs(base, exist_ok=True)
  # macOS: game folder is often a symlink (iCloud, etc.). CWD + relative paths like
  # "snake.png" must use the *resolved* project directory, same as the Assets panel.
  try:
    root = os.path.realpath(base)
  except OSError:
    root = base
  main_path = os.path.join(root, "main.py")
  if not os.path.isfile(main_path):
    print("main.py is missing; write some code in the editor first", file=sys.stderr)
    raise SystemExit(1)
  os.environ["SANDBOX_ROOT"] = root
  os.chdir(root)
  if root not in sys.path:
    sys.path.insert(0, root)

  with open(main_path, "r", encoding="utf-8") as f:
    src = f.read()
  code = compile(src, main_path, "exec")

  _install_turtle_to_front()

  def asset_path(name: str) -> str:
    return os.path.join(root, name)

  g: dict = {
    "__name__": "__main__",
    "__file__": main_path,
    "__builtins__": __builtins__,
    "ASSET_DIR": root,
    "asset_path": asset_path,
  }
  exec(code, g)


if __name__ == "__main__":
  _main()
