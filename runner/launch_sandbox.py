# -*- coding: utf-8 -*-
from __future__ import annotations
import os
import sys

def _main() -> None:
  root = os.environ.get("SANDBOX_ROOT", "")
  if not root:
    print("SANDBOX_ROOT is not set", file=sys.stderr)
    raise SystemExit(1)
  os.makedirs(root, exist_ok=True)
  main_path = os.path.join(root, "main.py")
  if not os.path.isfile(main_path):
    print("main.py is missing; write some code in the editor first", file=sys.stderr)
    raise SystemExit(1)
  os.chdir(root)  # pygame.image.load("sprite.png") from same folder as main.py
  with open(main_path, "r", encoding="utf-8") as f:
    src = f.read()
  code = compile(src, main_path, "exec")
  g: dict = {
    "__name__": "__main__",
    "__file__": main_path,
    "__builtins__": __builtins__,
  }
  exec(code, g)

if __name__ == "__main__":
  _main()
