#!/usr/bin/env python3
"""Small, deliberately non-networked Python runner for Aurora."""
from __future__ import annotations
import json
import os
import pwd
import resource
import select
import selectors
import signal
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
SOCKET_PATH = "/run/aurora-python/runner.sock"
MAX_CODE_CHARS = 16_000
MAX_REQUEST_BYTES = 131_072
MAX_OUTPUT_BYTES = 16_000
MAX_RESPONSE_BYTES = 100_000
WALL_SECONDS = 3

_run_lock = threading.Lock()


def nobody_ids() -> tuple[int, int]:
  """Return the uid and primary gid of the unprivileged script user."""
  user = pwd.getpwnam("nobody")
  return user.pw_uid, user.pw_gid


def execute_child(code: str) -> None:
  """Drop privilege and execute submitted source with non-creatable processes."""
  uid, gid = nobody_ids()
  os.setgroups([])
  os.setgid(gid)
  os.setuid(uid)
  resource.setrlimit(resource.RLIMIT_CPU, (WALL_SECONDS + 1, WALL_SECONDS + 1))
  resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024,) * 2)
  resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES))
  resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
  # This remains in force across exec: submitted code cannot fork or start threads.
  resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
  os.execve(
    sys.executable,
    [sys.executable, "-I", "-c", code],
    {"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONUNBUFFERED": "1"},
  )


def kill_group(process: subprocess.Popen[bytes]) -> None:
  """Kill the runner-created process group if it is still present."""
  try:
    os.killpg(process.pid, signal.SIGKILL)
  except ProcessLookupError:
    pass


def client_disconnected(connection: socket.socket) -> bool:
  """Return whether the peer has closed its Unix-socket request."""
  try:
    ready, _, _ = select.select([connection], [], [], 0)
  except OSError:
    return True
  if not ready:
    return False
  try:
    return not connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
  except (BlockingIOError, InterruptedError):
    return False
  except OSError:
    return True


def cleanup_workdir(workdir: str, uid: int, gid: int) -> None:
  """Remove a script directory as its owner, without granting root DAC override."""
  subprocess.run(
    [
      sys.executable,
      "-I",
      "-c",
      "import shutil, sys; shutil.rmtree(sys.argv[1])",
      workdir,
    ],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    cwd="/tmp",
    env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
    user=uid,
    group=gid,
    extra_groups=[],
    timeout=WALL_SECONDS,
    check=True,
  )


def run_script(code: str, connection: socket.socket | None = None) -> tuple[bool, str]:
  """Execute one source string and return bounded output after verified cleanup."""
  uid, gid = nobody_ids()
  workdir = tempfile.mkdtemp(prefix="aurora-python-", dir="/tmp")
  os.chown(workdir, uid, gid)
  output = bytearray()
  reason: str | None = None
  process: subprocess.Popen[bytes] | None = None
  selector = selectors.DefaultSelector()
  result: tuple[bool, str] | None = None
  try:
    process = subprocess.Popen(
      [sys.executable, "-I", str(Path(__file__).resolve()), "--child", code],
      stdin=subprocess.DEVNULL,
      stdout=subprocess.PIPE,
      stderr=subprocess.STDOUT,
      cwd=workdir,
      env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONUNBUFFERED": "1"},
      start_new_session=True,
      close_fds=True,
    )
    assert process.stdout is not None
    os.set_blocking(process.stdout.fileno(), False)
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + WALL_SECONDS
    while process.poll() is None:
      if connection is not None and client_disconnected(connection):
        reason = "Execution cancelled.\n"
        break
      if time.monotonic() >= deadline:
        reason = "Execution timed out.\n"
        break
      for key, _ in selector.select(0.05):
        chunk = os.read(key.fd, 4096)
        if not chunk:
          selector.unregister(key.fileobj)
          continue
        output.extend(chunk)
        if len(output) > MAX_OUTPUT_BYTES:
          reason = "Output limit exceeded.\n"
          break
      if reason:
        break
    # RLIMIT_NPROC prevents descendants from holding this pipe open.
    kill_group(process)
    process.wait()
    while selector.get_map():
      for key, _ in selector.select(0.05):
        chunk = os.read(key.fd, 4096)
        if chunk:
          output.extend(chunk)
        else:
          selector.unregister(key.fileobj)
    if len(output) > MAX_OUTPUT_BYTES:
      reason = reason or "Output limit exceeded.\n"
    if reason:
      suffix = reason.encode()
      result = (
        False,
        output[: MAX_OUTPUT_BYTES - len(suffix)].decode("utf-8", "replace") + reason,
      )
    else:
      result = process.returncode == 0, output[:MAX_OUTPUT_BYTES].decode("utf-8", "replace")
  finally:
    if process is not None and process.poll() is None:
      kill_group(process)
      process.wait()
    selector.close()
    try:
      cleanup_workdir(workdir, uid, gid)
    except (OSError, subprocess.SubprocessError) as error:
      print(f"Sandbox cleanup failed for {workdir}: {error}", file=sys.stderr)
      result = False, "Sandbox cleanup failed; execution data may remain.\n"
  if result is None:
    raise RuntimeError("Script execution ended without a result")
  return result


class RunnerHandler(BaseHTTPRequestHandler):
  """Handle one local Python-run request."""

  protocol_version = "HTTP/1.1"

  def setup(self) -> None:
    """Set a finite socket timeout after standard handler setup."""
    super().setup()
    self.connection.settimeout(5)

  def log_message(self, format: str, *args: object) -> None:
    """Keep routine local request logging out of container output."""

  def reply(self, status: int, success: bool, output: str) -> None:
    """Write one bounded JSON response."""
    payload = json.dumps({"success": success, "output": output}).encode()
    if len(payload) > MAX_RESPONSE_BYTES:
      payload = b'{"success":false,"output":"Runner response exceeded its limit"}'
      status = 500
    self.send_response(status)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(payload)))
    self.send_header("Connection", "close")
    self.end_headers()
    try:
      self.wfile.write(payload)
    except (BrokenPipeError, ConnectionResetError):
      pass

  def do_POST(self) -> None:
    """Validate and execute the sole local runner endpoint."""
    if self.path != "/run":
      self.reply(404, False, "Not found")
      return
    try:
      length = int(self.headers.get("Content-Length", ""))
    except ValueError:
      self.reply(400, False, "Content-Length is required")
      return
    if length < 0 or length > MAX_REQUEST_BYTES:
      self.reply(413, False, "Request is too large")
      return
    try:
      body = self.rfile.read(length)
      data = json.loads(body)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
      self.reply(400, False, "Invalid JSON request")
      return
    code = data.get("code") if isinstance(data, dict) else None
    if not isinstance(code, str):
      self.reply(400, False, "code must be a string")
      return
    if len(code) > MAX_CODE_CHARS:
      self.reply(413, False, "Python code exceeds 16000 characters")
      return
    if not _run_lock.acquire(blocking=False):
      self.reply(503, False, "Runner busy; try again shortly")
      return
    try:
      success, output = run_script(code, self.connection)
      self.reply(200, success, output)
    finally:
      _run_lock.release()


class ThreadingUnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
  """Threaded Unix HTTP server; admission still permits one execution."""

  daemon_threads = True
  allow_reuse_address = True


def create_server(path: str = SOCKET_PATH) -> ThreadingUnixHTTPServer:
  """Create the root-owned private Unix-socket server."""
  socket_path = Path(path)
  socket_path.parent.mkdir(parents=True, exist_ok=True)
  try:
    socket_path.unlink()
  except FileNotFoundError:
    pass
  old_umask = os.umask(0o077)
  try:
    server = ThreadingUnixHTTPServer(str(socket_path), RunnerHandler)
  finally:
    os.umask(old_umask)
  os.chmod(socket_path, 0o600)
  return server


def main() -> None:
  """Serve the runner until the container stops."""
  server = create_server()
  try:
    server.serve_forever()
  finally:
    server.server_close()
    try:
      os.unlink(SOCKET_PATH)
    except FileNotFoundError:
      pass


if __name__ == "__main__":
  if len(sys.argv) == 3 and sys.argv[1] == "--child":
    execute_child(sys.argv[2])
  else:
    main()
