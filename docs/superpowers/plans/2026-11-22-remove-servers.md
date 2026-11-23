# Remove and re-add a Plex server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an account stop using a Plex server for itself only, and add it back, from Settings.

**Architecture:** The per-account switch `UserServerAccess.enabled` already exists and `servers_for` already honours it; nothing sets it and `full_sync` bypasses it by iterating `discover_servers`' result. Add an endpoint that flips it, list removed servers with a per-account flag, make `full_sync` honour it, and add Remove / Add back to `ServerPanel`.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest; React + TanStack Query + Tailwind tokens.

**Spec:** `docs/superpowers/specs/2026-11-22-remove-servers-design.md`

## Global Constraints

- Nothing already imported is deleted or hidden; grids and `on_plex` unchanged.
- Changing the switch requires only the caller's own `UserServerAccess` row, never ownership.
- `discover_servers` must never write `access.enabled`.
- Frontend: tokens only, no raw hex; status never colour-alone; every button shows a pending state (CLAUDE.md "Frontend conventions").

## Review Focus

- A server the caller has no access row for → `PATCH …/access` is 404, not a silent create (test in Task 1).
- An owner removing their **own** server → `full_sync` must still skip it (`client_for` falls back to the owner token, so the skip has to happen at the server list, not at the client) (test in Task 2).
- Another account on the same server is unaffected by my removal (test in Task 1).
- plex.tv unreachable during sync → fallback path `servers_for(user)` still excludes removed servers (covered: `servers_for` already filters; asserted in Task 2's test by both paths sharing one filter).
- A removed server must not appear in `/api/media/places` (already filters on `access.enabled`; no new code, assert in Task 1).

---

### Task 1: Per-account switch on the API

**Files:**
- Modify: `backend/app/schemas.py` (`ServerOut`, new `ServerAccessUpdate`)
- Modify: `backend/app/services/sync_service.py` (`servers_for`)
- Modify: `backend/app/routers/sync.py` (`list_servers`, new route)
- Test: `backend/tests/test_api.py`

**Interfaces:**
- Produces: `ServerOut.access_enabled: bool = True`; `ServerAccessUpdate(BaseModel)` with `enabled: bool`;
  `SyncService.servers_for(user, *, with_libraries=False, include_removed=False) -> list[PlexServer]`;
  `PATCH /api/servers/{server_id}/access` body `{enabled: bool}` → `ServerOut`.

- [ ] **Step 1: Write the failing tests** in `tests/test_api.py`, following `test_listing_servers_serialises_libraries`' setup (a server, the tester's `UserServerAccess`):
  - `test_removing_a_server_is_per_account`: a second user also has access; `PATCH /api/servers/{id}/access {"enabled": false}` → 200, body `access_enabled is False`; tester's access row `.enabled is False`; the other user's row still `True`; `GET /api/servers` still lists it with `access_enabled False`; `GET /api/media/places` does not name it.
  - `test_adding_a_server_back`: after removing, `PATCH … {"enabled": true}` → `access_enabled True`.
  - `test_removing_needs_access_not_ownership`: server with `owner_user_id=None` → 200 for the tester.
  - `test_removing_a_server_without_access_is_404`: no access row → 404, and no row is created.
- [ ] **Step 2: Run** `.venv/Scripts/python.exe -m pytest -q tests/test_api.py -k "server_is_per_account or adding_a_server or needs_access or without_access"` — expect 404/405 failures.
- [ ] **Step 3: Implement.** `servers_for(include_removed=True)` drops only the `UserServerAccess.enabled` clause (keep `PlexServer.enabled`). `list_servers` calls it with `include_removed=True`, loads the caller's access rows for those servers, and returns `ServerOut.model_validate(s).model_copy(update={"access_enabled": access.enabled})`; sort removed servers last. New route sets `access.enabled`, commits, returns the same shape (`db.refresh(server, ["libraries"])` as `update_server` does).
- [ ] **Step 4: Run** the same tests plus `-k server` — all pass.
- [ ] **Step 5: Commit** `Let an account remove a Plex server for itself`.

### Task 2: Sync honours the switch

**Files:**
- Modify: `backend/app/services/sync_service.py` (`full_sync`, ~line 1816)
- Test: `backend/tests/test_sync_logic.py`

**Interfaces:**
- Consumes: `servers_for` from Task 1.

- [ ] **Step 1: Write the failing tests:**
  - `test_discovery_does_not_re_add_a_removed_server`: access row `enabled=False`; monkeypatch `service.plex_tv.get_resources` to return that server's resource; after `discover_servers(user)` the row is still `enabled is False`.
  - `test_full_sync_skips_a_server_the_account_removed`: user **owns** the server (`owner_user_id=user.id`), access `enabled=False`; monkeypatch `discover_servers` to return `[server]` and `sync_libraries` to record calls; run `full_sync`; `sync_libraries` never called with that server and `run.stats["servers"] == 0`.
- [ ] **Step 2: Run** `-k "re_add_a_removed or skips_a_server"` — first may already pass (pins the invariant); second fails.
- [ ] **Step 3: Implement:** after discovery, `servers = await self.servers_for(user)` regardless of what discovery returned (discovery is now only a refresh). Add a one-line comment why.
- [ ] **Step 4: Run** full backend suite and `ruff check app tests` — all pass.
- [ ] **Step 5: Commit** `Sync skips a server the account removed`.

### Task 3: Remove / Add back in Settings

**Files:**
- Modify: `frontend/src/lib/types.ts` (`Server.access_enabled: boolean`)
- Modify: `frontend/src/lib/api.ts` (`servers.setAccess(id: number, enabled: boolean) => patch<Server>(\`/api/servers/${id}/access\`, { enabled })`)
- Modify: `frontend/src/pages/Settings.tsx` (`ServerPanel`)

- [ ] **Step 1: Implement.** `ServerPanel`: when `access_enabled`, a `btn-outline` **Remove** beside Test; when not, render the card dimmed (`text-dim`), a written "Removed" label beside the name, a one-line explanation ("Not synced for your account. Everything already imported stays."), and only an **Add back** button — no URL field, no libraries. Mutation shows `<Spinner />` and disables while pending; on success toast (`Removed {name}.` / `{name} is back. It syncs on the next run.`) and invalidate `['servers']`.
- [ ] **Step 2: Verify** `npx tsc --noEmit && npm run check:design && npm run build` — clean.
- [ ] **Step 3: Screenshot** Settings in both themes via `python docs/shots/shots.py --out <scratchpad>/shots` (seed a second server with access disabled if the seed has only one; scratch only) and read the images.
- [ ] **Step 4: Commit** `Remove and add back a server from Settings`, plus a CHANGELOG entry under a new unreleased heading.
