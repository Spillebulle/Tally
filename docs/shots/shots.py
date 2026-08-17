"""Preview harness driver: build, seed, run and screenshot Tally.

    python docs/shots/shots.py --out <scratch>/shots

does the whole thing end to end from a clean state:

1. builds the frontend and copies it where `backend/app/main.py` serves the
   SPA from (`backend/app/static/`, exactly like the Dockerfile does),
2. seeds a scratch SQLite database via `seed.py`,
3. starts the backend against that database and waits for `/api/health`,
4. hands off to `capture.mjs` (Node, since Playwright lives in
   `frontend/node_modules` — see docs/shots/README.md) to log in and
   screenshot every page in both themes,
5. shuts the backend down, always, even if an earlier step failed.

Only the standard library is used here; nothing new to install for this half.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
FRONTEND_DIR = REPO_ROOT / "frontend"
STATIC_DIR = BACKEND_DIR / "app" / "static"
VENV_PYTHON = BACKEND_DIR / ".venv" / "Scripts" / "python.exe"

ALL_PAGES = [
    "login", "dashboard", "movies", "shows", "anime", "watchlist",
    "history", "stats", "settings", "item",
]


def log(msg: str) -> None:
    print(f"[shots] {msg}", flush=True)


def run(cmd: str, *, cwd: Path, timeout: int | None = None) -> None:
    log(f"$ {cmd}  (cwd={cwd})")
    subprocess.run(cmd, cwd=str(cwd), shell=True, check=True, timeout=timeout)


def build_frontend() -> None:
    run("npm run build", cwd=FRONTEND_DIR, timeout=600)

    dist = FRONTEND_DIR / "dist"
    if not dist.is_dir():
        raise RuntimeError(f"Frontend build did not produce {dist}")

    # Mirrors the Dockerfile's `COPY --from=frontend /build/dist ./app/static`
    # so the same locally-run backend serves it the same way. static/ is
    # gitignored — this is a build artifact, not a source edit.
    if STATIC_DIR.exists():
        shutil.rmtree(STATIC_DIR)
    shutil.copytree(dist, STATIC_DIR)
    log(f"Copied {dist} -> {STATIC_DIR}")


def seed(data_dir: Path, *, fresh: bool) -> dict:
    cmd = [str(VENV_PYTHON), str(SCRIPT_DIR / "seed.py"), "--data-dir", str(data_dir)]
    if fresh:
        cmd.append("--fresh")
    log(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, check=True, timeout=300)
    info_path = data_dir / "seed-info.json"
    return json.loads(info_path.read_text())


def is_port_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) != 0


def wait_for_health(base_url: str, *, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/api/health", timeout=2) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
            last_err = exc
        time.sleep(0.5)
    raise RuntimeError(f"Backend never answered /api/health within {timeout}s: {last_err}")


def start_backend(data_dir: Path, port: int, log_file: Path) -> subprocess.Popen:
    env = dict(os.environ)
    env["DATA_DIR"] = str(data_dir)
    env["PUBLIC_URL"] = f"http://127.0.0.1:{port}"
    env["HOST"] = "127.0.0.1"
    env["PORT"] = str(port)
    env.setdefault("LOG_LEVEL", "INFO")

    log_handle = open(log_file, "w", encoding="utf-8")
    proc = subprocess.Popen(
        [
            str(VENV_PYTHON), "-m", "uvicorn", "app.main:app",
            "--host", "127.0.0.1", "--port", str(port),
        ],
        cwd=str(BACKEND_DIR),
        env=env,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
    )
    proc._log_handle = log_handle  # keep a reference so it isn't GC'd early
    return proc


def stop_backend(proc: subprocess.Popen | None, port: int) -> None:
    """Shut the backend down and confirm the port is actually free.

    A run that leaves this behind is worse than one that fails loudly: the
    *next* run's health check would then be answered by the stale process
    instead of the one it just started, silently serving screenshots from
    whatever database that old process happened to be pointed at. That
    happened once during development of this harness — worth being paranoid
    about here.
    """
    if proc is not None and proc.poll() is None:
        log("Stopping backend...")
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            log("Backend did not exit in time; killing it")
            proc.kill()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass

        if proc.poll() is None and sys.platform == "win32":
            # Popen.kill() is TerminateProcess and should already be final,
            # but taskkill /T also reaps anything uvicorn spawned under it.
            log("Process still alive after kill(); falling back to taskkill /T /F")
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
            )

        handle = getattr(proc, "_log_handle", None)
        if handle:
            handle.close()

    # Whether or not we had a `proc` to stop, the port must be free before we
    # report success — a leaked process from an earlier, unrelated run could
    # still be sitting on it.
    for _ in range(20):
        if is_port_free(port):
            return
        time.sleep(0.25)
    log(f"WARNING: port {port} is still in use after stopping the backend. "
        f"Check for a stray python.exe/uvicorn process holding it.")


def capture(out_dir: Path, base_url: str, themes: list[str], pages: list[str], width: int, height: int, seed_info: dict) -> None:
    env = dict(os.environ)
    env["TALLY_BASE_URL"] = base_url
    env["TALLY_OUT"] = str(out_dir)
    env["TALLY_THEMES"] = ",".join(themes)
    env["TALLY_PAGES"] = ",".join(pages)
    env["TALLY_WIDTH"] = str(width)
    env["TALLY_HEIGHT"] = str(height)
    env["TALLY_USERNAME"] = seed_info["username"]
    env["TALLY_PASSWORD"] = seed_info["password"]
    env["TALLY_ITEM_ID"] = str(seed_info["sample_item_id"])

    cmd = ["node", str(SCRIPT_DIR / "capture.mjs")]
    log(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=str(SCRIPT_DIR), env=env, check=True, timeout=600)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="Directory to write screenshots into (never the repo)")
    parser.add_argument("--theme", choices=["dark", "light", "both"], default="both")
    parser.add_argument("--pages", nargs="+", default=ALL_PAGES, help="Subset of pages to capture")
    parser.add_argument("--port", type=int, default=8931)
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--data-dir", default=None, help="Where to build the scratch database (default: <out>/_data)")
    parser.add_argument("--no-build", action="store_true", help="Skip `npm run build` and reuse backend/app/static as-is")
    parser.add_argument("--no-seed", action="store_true", help="Skip seeding and reuse whatever is already in --data-dir")
    args = parser.parse_args()

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    data_dir = Path(args.data_dir).resolve() if args.data_dir else out_dir / "_data"
    data_dir.mkdir(parents=True, exist_ok=True)

    if not VENV_PYTHON.is_file():
        raise SystemExit(f"Expected the backend virtualenv at {VENV_PYTHON} — see README.md")

    themes = ["dark", "light"] if args.theme == "both" else [args.theme]

    if not args.no_build:
        build_frontend()
    else:
        log("Skipping frontend build (--no-build)")

    if not args.no_seed:
        seed_info = seed(data_dir, fresh=True)
    else:
        info_path = data_dir / "seed-info.json"
        if not info_path.is_file():
            raise SystemExit(f"--no-seed given but {info_path} does not exist; run without it once first")
        seed_info = json.loads(info_path.read_text())
        log("Skipping seeding (--no-seed), reusing existing database")

    if not is_port_free(args.port):
        # Silently proceeding here is exactly how this bit during development:
        # a leaked process from an earlier run answered the health check, and
        # every screenshot after that came from its (stale) database instead
        # of the one this invocation just seeded, with no error anywhere.
        raise SystemExit(
            f"Port {args.port} is already in use — refusing to start another "
            f"backend on it. Something (maybe a leaked process from a previous "
            f"run of this script) is already listening there; find and stop it, "
            f"or pass --port to use a different one."
        )

    base_url = f"http://127.0.0.1:{args.port}"
    log_file = out_dir / "server.log"
    proc = None
    try:
        proc = start_backend(data_dir, args.port, log_file)
        try:
            wait_for_health(base_url)
        except RuntimeError:
            tail = log_file.read_text(encoding="utf-8", errors="replace")[-4000:]
            log(f"Backend log tail:\n{tail}")
            raise
        log(f"Backend is up at {base_url}")

        capture(out_dir, base_url, themes, args.pages, args.width, args.height, seed_info)
    finally:
        stop_backend(proc, args.port)

    log(f"Done. Screenshots in {out_dir}")


if __name__ == "__main__":
    main()
