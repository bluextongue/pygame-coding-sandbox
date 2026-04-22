# -*- coding: utf-8 -*-
from __future__ import annotations
import ast
import importlib
import os
import re
import site
import subprocess
import sys

# Fallback if main.py is not valid Python for ast.parse
_PYGAME_IMPORT = re.compile(
  r"^\s*(import\s+pygame\b|from\s+pygame\b)",
  re.MULTILINE,
)


def _source_needs_pygame(source: str) -> bool:
  """True if the script imports the pygame API (ast; regex fallback for syntax errors / BOM)."""
  try:
    tree = ast.parse(source)
  except SyntaxError:
    return _PYGAME_IMPORT.search(source) is not None
  for node in ast.walk(tree):
    if isinstance(node, ast.Import):
      for a in node.names:
        n = a.name
        if n == "pygame" or n.startswith("pygame."):
          return True
    if isinstance(node, ast.ImportFrom) and node.module:
      m = node.module
      if m == "pygame" or m.startswith("pygame."):
        return True
  return _PYGAME_IMPORT.search(source) is not None


def _refresh_sys_path_for_new_pip_installs() -> None:
  """Pip can install into a user site dir created mid-process; that path is not on sys.path yet."""
  importlib.invalidate_caches()
  try:
    p = site.getusersitepackages()
  except (AttributeError, OSError, ValueError):
    p = None
  if p and os.path.isdir(p):
    if p not in sys.path:
      try:
        site.addsitedir(p)
      except (OSError, TypeError, ValueError):
        sys.path.insert(0, p)
  try:
    g = getattr(site, "getsitepackages", None)
    if g is not None:
      for d in g():
        if d and os.path.isdir(d) and d not in sys.path:
          try:
            site.addsitedir(d)
          except (OSError, TypeError, ValueError):
            sys.path.insert(0, d)
  except (AttributeError, OSError, TypeError, ValueError):
    pass


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


def _try_import_pygame() -> bool:
  try:
    import pygame  # noqa: F401
    return True
  except ImportError:
    return False


def _pip_install_pygame(extra_args: list[str] | None = None) -> int:
  cmd = [sys.executable, "-m", "pip", "install"]
  if extra_args:
    cmd.extend(extra_args)
  cmd.append("pygame")
  r = subprocess.run(
    cmd,
    stdin=subprocess.DEVNULL,
    timeout=600,
  )
  return r.returncode


def _ensure_pygame_if_needed(source: str) -> None:
  """If main.py imports pygame, ensure the module exists (auto pip install once)."""
  if not _source_needs_pygame(source):
    return
  if _try_import_pygame():
    return
  print(
    "pygame is not installed for this Python — installing once (needs network)…",
    file=sys.stderr,
  )
  for i, extra in enumerate((None, ["--user"])):
    rc = _pip_install_pygame(extra)
    if rc != 0 and i == 0:
      print(
        "pip install (system) did not complete; trying: pip install --user pygame …",
        file=sys.stderr,
      )
    _refresh_sys_path_for_new_pip_installs()
    if _try_import_pygame():
      return
  subprocess.run(
    [sys.executable, "-m", "pip", "install", "--user", "--upgrade", "pygame"],
    check=False,
    stdin=subprocess.DEVNULL,
    timeout=600,
  )
  _refresh_sys_path_for_new_pip_installs()
  if _try_import_pygame():
    return
  print(
    "Could not install or import pygame for this interpreter. In a terminal run:\n  "
    f"  {sys.executable} -m pip install --user pygame\n"
    "If that works, the app must Run with that same python (the one in PATH: python3 / python).",
    file=sys.stderr,
  )
  raise SystemExit(1)


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

      def take_keys() -> None:
        """Match :meth:`turtle.TurtleScreen._listen` — keys are bound to the canvas, which must
        use ``focus_force()`` (not ``focus_set()``) on macOS/Windows or key events never arrive.
        """
        if sys.platform == "win32":
          try:
            import ctypes
            from ctypes import wintypes

            u32 = ctypes.windll.user32
            u32.SetForegroundWindow.argtypes = (wintypes.HWND,)
            u32.SetForegroundWindow.restype = wintypes.BOOL
            u32.SetForegroundWindow(wintypes.HWND(int(root.winfo_id())))
          except (OSError, ValueError, TypeError, AttributeError, ImportError, Exception):
            pass
        try:
          cv.focus_force()
        except (TclError, TypeError, ValueError, RuntimeError, OSError):
          pass

      def one(_first: bool) -> None:
        # Do not focus the *root* — keys are for the canvas. Lift + topmost, then canvas focus.
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
        take_keys()

      try:
        cv.bind("<Button-1>", lambda _e: take_keys(), add="+")
      except (TclError, TypeError, ValueError, RuntimeError, OSError):
        pass

      # Same tick + later — child window can map only after a long setup (GIF frame loop).
      for i, delay in enumerate((0, 80, 400, 1200)):
        first = i == 0
        if delay:
          try:
            root.after(delay, lambda f=first: one(f))
          except TclError:
            break
        else:
          one(first)
    except (AttributeError, Exception):
      return

  try:
    import turtle
  except ImportError:
    return

  if getattr(_install_turtle_to_front, "_done", False):
    return

  # CPython's turtle binds key events to the canvas. Each `onkey` / `onkeypress` should be
  # followed by `listen()` (which calls `cv.focus_force()`). Many games forget `listen()`,
  # so we re-apply the same focus step after every key binding. See turtle.TurtleScreen._listen.
  _ts = turtle.TurtleScreen
  _orig_onkey = _ts.onkey
  _orig_onkeypress = _ts.onkeypress

  def _onkey_hook(self: object, fun, key) -> None:  # type: ignore[no-untyped-def]
    _orig_onkey(self, fun, key)
    if fun is not None:
      try:
        self._listen()  # focus_force on canvas, same as listen()
      except (TclError, TypeError, ValueError, RuntimeError, OSError, AttributeError):
        pass

  def _onkeypress_hook(self: object, fun, key=None) -> None:  # type: ignore[no-untyped-def]
    _orig_onkeypress(self, fun, key)
    if fun is not None:
      try:
        self._listen()
      except (TclError, TypeError, ValueError, RuntimeError, OSError, AttributeError):
        pass

  _ts.onkey = _onkey_hook
  _ts.onkeypress = _onkeypress_hook

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

  with open(main_path, "r", encoding="utf-8-sig") as f:
    src = f.read()
  _ensure_pygame_if_needed(src)
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
