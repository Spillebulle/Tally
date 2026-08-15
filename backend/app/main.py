"""Tally — a self-hosted watch tracker with deep Plex integration."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .db import init_db
from .routers import (
    api_keys,
    auth,
    history,
    images,
    library,
    stats,
    sync,
    users,
    watchlist,
    webhooks,
)
from .services.plex_server import close_pool
from .services.plex_tv import PlexTVError, PlexUnreachableError
from .services.scheduler import shutdown_scheduler, start_scheduler

settings = get_settings()

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
log = logging.getLogger("tally")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    start_scheduler()
    log.info("%s is ready on %s", settings.app_name, settings.public_url)
    try:
        yield
    finally:
        shutdown_scheduler()
        await close_pool()


app = FastAPI(
    title="Tally",
    description="Track what you watch, in sync with Plex.",
    version=sync.VERSION,
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

for router in (
    auth.router,
    users.router,
    library.router,
    history.router,
    watchlist.router,
    stats.router,
    sync.router,
    webhooks.router,
    images.router,
    api_keys.router,
):
    app.include_router(router)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "version": sync.VERSION, "app": settings.app_name}


@app.exception_handler(PlexTVError)
async def plex_tv_error(request: Request, exc: PlexTVError) -> JSONResponse:
    """Report Plex problems as Plex problems.

    Failing to reach plex.tv is not a bug in Tally, and routing it through the
    catch-all below answers "Something went wrong — check the logs" when the
    API already knows the cause. A DNS failure inside the container and an
    expired token need completely different fixes, so say which one it is.
    """
    unreachable = isinstance(exc, PlexUnreachableError)
    # Deliberately not log.exception: this is an expected operational failure,
    # and a full traceback for a DNS problem buries the one useful line.
    log.warning("plex.tv request failed on %s: %s", request.url.path, exc)
    return JSONResponse(
        status_code=503 if unreachable else 502,
        content={"detail": str(exc)},
    )


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Something went wrong. Check the server logs for details."},
    )


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

FRONTEND_DIR = Path(__file__).resolve().parent / "static"

# Test index.html rather than the directory: an empty or half-written `static/`
# used to raise at import time, because StaticFiles refuses a missing `assets/`.
# That turns a partial build — or a stray directory — into a container that
# cannot boot at all, rather than one serving the API without a UI.
if (FRONTEND_DIR / "index.html").is_file():
    if (FRONTEND_DIR / "assets").is_dir():
        app.mount(
            "/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets"
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> FileResponse:
        """Serve the SPA, letting client-side routing own unknown paths."""
        candidate = FRONTEND_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIR / "index.html")
else:  # pragma: no cover - development without a built frontend

    @app.get("/", include_in_schema=False)
    async def root() -> dict:
        return {
            "app": settings.app_name,
            "message": "Frontend not built. Run `npm run build` in ./frontend.",
            "docs": "/api/docs",
        }
