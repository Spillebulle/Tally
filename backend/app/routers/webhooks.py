"""Plex webhook receiver.

Plex posts webhooks as ``multipart/form-data`` with the JSON in a ``payload``
field. The endpoint is unauthenticated by necessity — Plex offers no way to send
credentials — so it is written to be safe when hit by anyone: it only ever
matches events to *already linked* accounts and known servers, and never creates
users or grants access.
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Form, Request

from ..deps import DbSession
from ..services.webhooks import handle_webhook

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])


@router.post("/plex")
async def plex_webhook(
    request: Request, db: DbSession, payload: str | None = Form(default=None)
) -> dict:
    raw = payload
    if raw is None:
        # Some proxies re-encode the request as plain JSON.
        try:
            body = await request.json()
        except Exception:
            return {"status": "ignored", "reason": "unreadable payload"}
        data = body
    else:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return {"status": "ignored", "reason": "malformed JSON payload"}

    if not isinstance(data, dict):
        return {"status": "ignored", "reason": "unexpected payload shape"}

    try:
        return await handle_webhook(db, data)
    except Exception as exc:
        # Never 500 at Plex: it retries and eventually disables the webhook.
        log.exception("Webhook handling failed")
        return {"status": "error", "reason": str(exc)}
