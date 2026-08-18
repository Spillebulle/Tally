# Plex webhooks

Getting Plex to tell Tally the moment something is played, rather than waiting
for the next sync.

**This needs a Plex Pass**, and it is strictly an optimisation. Everything a
webhook delivers is also picked up by the periodic history sync, so a missed one
costs nothing. Tally works perfectly well without it. How the periodic sync
works is in `../sync.md`.

## Setting one up

1. Open **Settings → Plex servers**, and find **Live updates** at the bottom
   of the pane. Press **Copy** beside the webhook address. It is your
   `PUBLIC_URL` with `/api/webhooks/plex` on the end.
2. In Plex, go to **Settings → Webhooks**, press **Add Webhook**, and paste
   the address.

Your Plex server has to be able to reach that address, which is the same
requirement `PUBLIC_URL` already has for the sign-in redirect. If sign-in works
from the machine Plex runs on, the webhook will reach Tally too.

## What arrives

Tally acts on `media.scrobble`, `media.play`, `media.resume`, `media.pause`,
`media.stop` and `media.rate`, and ignores everything else Plex sends.

A scrobble becomes a watch event immediately. The periodic history import will
later see the same play from Plex's own history, described with a different key,
so it looks for a recent webhook event for the same title and **adopts** it
rather than inserting a second row. A missed play is free; a doubled one is not,
so this is the direction the reconciliation runs in.

## Why the endpoint takes no credentials

Plex offers no way to send credentials with a webhook, so `POST
/api/webhooks/plex` has to accept an unauthenticated request. Everything in the
payload is therefore treated as attacker-supplied, and the endpoint is written to
be safe when hit by anyone:

* **It matches an account, or it ignores the event.** A payload is matched on
  the Plex account id, then on the server-side account id for home users, then
  on `plex_username`. It never matches a local Tally username: doing so let a
  forged payload write watch events into an account with no Plex link at all,
  needing nothing but a guessable name.
* **It matches a known server, or it ignores the event.** The payload's server
  uuid must already be a server Tally knows. There is deliberately no "use the
  first enabled server" fallback, which attributed a payload with no server
  block at all to an arbitrary one.
* **It never creates a user and never grants access.** Only accounts and servers
  that are already linked can be named.
* **It never answers `5xx`.** Plex retries a failing webhook and then disables
  it, so an unreadable payload or an internal error is answered with an
  ignored-status body instead.

An event Tally ignores says why in the response body, which is what to look at
if plays are not appearing.
