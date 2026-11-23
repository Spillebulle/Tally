# Remove and re-add a Plex server, per account

Approved 2026-11-22.

## Why

A friend's server shared with an account (here: "plex", Oliver's) is synced
whether the account wants it or not, and because a non-owner token is refused
`/accounts`, every run ends "Partly done". There is no way to stop using a
server: discovery re-adds every plex.tv resource on each sync, the global
`PlexServer.enabled` switch is owner/admin-only, affects every account, and
hides the server from Settings with no way back.

## Goals

- An account can remove a server **for itself only**; other accounts are
  untouched.
- The removal survives every later sync and discovery.
- The account can add it back from Settings.
- A removed server is not scanned, imported from or polled for that account, so
  its runs no longer report its errors.

## Non-goals / anti-goals

- **Nothing already imported is deleted or hidden.** Items, plays, ratings and
  watchlist entries stay. Grids keep showing every title as today ("option 1").
- `on_plex` keeps its current meaning (any server in Tally).
- No manual entry of servers plex.tv does not list.
- The global `PlexServer.enabled` switch is left as it is.

## Approaches

1. **Use the existing `UserServerAccess.enabled` column (picked).** Already
   per-user, already read by `servers_for`; it is simply unset by anything and
   bypassed by `full_sync`, which iterates `discover_servers`' result directly.
2. A new tombstone table/column — duplicates (1).
3. Delete the `UserServerAccess` row — discovery recreates it on the next sync.

## Design

- `PATCH /api/servers/{id}/access` `{enabled: bool}` → requires only the
  caller's own `UserServerAccess` row (404 if none); returns the server.
- `GET /api/servers` lists the caller's servers **including** removed ones, each
  with a per-account `access_enabled` flag, so Settings can offer "Add back".
- `discover_servers` never touches `access.enabled`; `full_sync` iterates only
  servers where the caller's access is enabled (and the server is enabled).
- `/api/media/places` and anything else built on `servers_for` keep excluding
  removed servers (they already filter on `access.enabled`).
- Settings: each server card gets **Remove**; a removed server renders greyed,
  labelled "Removed" (text, not colour alone), with **Add back** and nothing
  else. Pending state on click.
- Re-adding resumes from `last_history_sync_at`; nothing is reset.

## Left to the builder

Exact copy, button placement within `ServerPanel`, whether removed servers sort
last.
