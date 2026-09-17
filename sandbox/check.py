#!/usr/bin/env python3
"""Minimal real checks for the Unix-socket runner; run as root in its image."""
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, "/usr/local/bin")
import runner


def request(path: str, code: str) -> dict[str, object]:
  """Send one complete local runner request and decode its JSON response."""
  body = json.dumps({"code": code}).encode()
  client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
  client.connect(path)
  client.sendall(
    b"POST /run HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
    + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
    + body
  )
  response = bytearray()
  while chunk := client.recv(4096):
    response.extend(chunk)
  client.close()
  return json.loads(response.split(b"\r\n\r\n", 1)[1])


def cancel(path: str) -> None:
  """Start a request then close it, asking the runner to cancel its script."""
  body = json.dumps({"code": "while True: pass"}).encode()
  client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
  client.connect(path)
  client.sendall(
    b"POST /run HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
    + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
    + body
  )
  client.close()


def main() -> None:
  """Exercise execution limits and post-execution cleanup through the socket."""
  directory = tempfile.mkdtemp(prefix="aurora-python-check-")
  os.chmod(directory, 0o755)
  path = os.path.join(directory, "runner.sock")
  server = runner.create_server(path)
  thread = threading.Thread(target=server.serve_forever, daemon=True)
  thread.start()
  try:
    result = request(path, "print(6 * 7)")
    assert result == {"success": True, "output": "42\n"}, result

    result = request(path, "raise ValueError('expected')")
    assert not result["success"] and "ValueError: expected" in result["output"], result

    result = request(path, "while True: pass")
    assert not result["success"] and "timed out" in result["output"].lower(), result

    result = request(path, "print('x' * 20000)")
    assert not result["success"] and "Output limit exceeded" in result["output"], result

    result = request(
      path,
      "import socket\ns = socket.socket(socket.AF_UNIX)\ns.connect(" + repr(path) + ")",
    )
    assert not result["success"] and "Permission denied" in result["output"], result

    result = request(path, "import subprocess\nsubprocess.run(['true'])")
    assert not result["success"] and "Resource temporarily unavailable" in result["output"], result

    cancel(path)
    for _ in range(20):
      result = request(path, "print('available')")
      if result == {"success": True, "output": "available\n"}:
        break
      assert result["output"] == "Runner busy; try again shortly", result
      time.sleep(0.05)
    else:
      raise AssertionError("cancelled request did not release the runner")

    result = request(
      path,
      "from pathlib import Path\np = Path.cwd()\nPath('leftover').write_text('x')\nprint(p)",
    )
    assert result["success"], result
    assert not Path(str(result["output"]).strip()).exists(), result
  finally:
    server.shutdown()
    server.server_close()
    shutil.rmtree(directory, ignore_errors=True)
  print("runner checks passed")


if __name__ == "__main__":
  main()
