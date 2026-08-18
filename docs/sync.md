# How syncing works

What a sync actually does, how a disagreement between Tally and Plex is settled,
and how long a half-finished title keeps its place on the dashboard.

## When it runs

Tally runs a full sync every `SYNC_INTERVAL_MINUTES` (30 by default) and polls
for playback in progress every `SESSIONS_POLL_SECONDS` (30 by default). Both are
in `configuration.md`.

You can also start one at any time from the **sync control in the header bar**,
which shows the phase while a run is in progress and offers **Cancel sync**. A
cancelled run stops after the current step, and everything it committed before
that point stands.

Three things you do in Tally do not wait for the next sync at all. Setting a
rating, marking something watched or unwatched, and adding or removing a
watchlist entry are each pushed to Plex as you do them. The periodic sync is
what catches changes made on the Plex side.

With a Plex Pass you can have Plex tell Tally the moment something is played,
rather than waiting for the next run. That is in `integrations/plex.md`.

## What one run does

Four of the phases run once for each Plex server you can reach, and the rest
run once for the whole account. In order:

| Phase | Per | What happens |
|---|---|---|
| Looking for Plex servers | account | Asks plex.tv which servers this account can reach. |
| Reading libraries | server | Which libraries exist, whether they hold anime, and the server's own On Deck window. |
| Scanning each library | server | Every title, committed a page at a time so progress is visible and a failure part-way through does not discard the rest. |
| Importing history | server | New plays. An incremental run asks Plex for everything since the last import, overlapping by one day because Plex can backdate an entry when a client syncs late. |
| Syncing ratings | server | Films and series only. Episode ratings exist in Plex but are rarely used and would triple the traffic. |
| Syncing your watchlist | account | Both directions, then removals. |
| Filling in missing artwork | account | Up to 100 titles per run, so a backlog drains over several syncs rather than turning one into an hour of provider traffic. |
| Fetching cast and crew | account | Up to 100 titles per run, for the same reason. |
| Checking what is playing now | account | The same poll the session timer runs. |

A **full re-import**, under **Settings → Syncing → Danger**, reads your
whole Plex history again and rescans every library. Nothing you have logged in
Tally is deleted by it, but it can take hours on a large library and your Plex
server is under load throughout.

## What syncs

Three switches under **Settings → Syncing**, per account:

| Switch | What it controls |
|---|---|
| Sync ratings with Plex | Star ratings flow both ways. |
| Sync watchlist with Plex | Adding or removing a title here mirrors to your Plex watchlist, and the other way round. |
| Write watch state back to Plex | Marking something watched in Tally also marks it watched on your server. |

Ratings and the watchlist stop moving in **both** directions when their switch
is off. Watch state is the one that only names one direction, and it means it:
turning it off stops Tally writing to Plex, and your Plex history is still
imported, because that is the thing Tally is for. Nothing already synced is
deleted either way.

## Which side wins

For every syncable field Tally stores both your local value and the last value
it saw on Plex. That third value is what lets it tell *which side changed*,
rather than guessing from whichever number is larger:

| Local | Plex | Result |
|---|---|---|
| unchanged | unchanged | nothing happens |
| changed | unchanged | pushed to Plex |
| unchanged | changed | pulled into Tally |
| changed | changed | the more recent change wins |

Two details follow from that, and both matter in practice:

**Clearing a rating is a change like any other.** Plex has no "unrate", so a
cleared rating is pushed as 0, and it is defended in a both-changed conflict the
same way any other value would be.

**No evidence is not evidence of nothing.** A title Tally cannot find in any
library it was able to read is left alone rather than treated as unrated. That
is what stops a temporarily unreachable library from wiping ratings.

When both sides changed and Tally has no local timestamp to argue with, Plex
wins.

## Watchlist removals are remembered, not deleted

Removing something from your watchlist marks the entry as removed and keeps the
row. If the row were deleted, the next pull from Plex would see the title
present remotely and absent locally, and add back exactly what you just removed.

Two consequences worth knowing:

**A removal that could not reach Plex is retried, not undone.** Tally records
that it *intends* the entry to be gone before the push, so a failed push is
retried on the next run rather than being read as "Plex still has it, put it
back".

**Removals are only mirrored when the whole watchlist arrived.** If any page of
the watchlist fails to fetch, the pass that mirrors removals is skipped
entirely, because "absent from Plex" is only meaningful when you have seen all
of Plex's answer.

## Continue watching

The dashboard shelf holds what you are part-way through: mid-episode playback,
and the next unwatched episode of anything you have started.

Plex ages an item off On Deck once you have not touched it for a while. In Plex
itself, that is **Settings → Library → "Weeks to consider for On Deck and
Continue Watching"**, 16 weeks out of the box. Tally reads it from your server
and applies the same window, so a show you stopped watching three years ago does
not sit at the top of the dashboard forever.

You can set your own window under **Settings → Library → Continue
watching**, using the **Drop off after** dropdown. It offers **Match Plex**,
which names the number your server reported, a set of fixed windows from 2 to 52
weeks, and **Never, keep everything**.

Three things about the window:

* **Nothing is ever deleted.** An item that drops off the shelf keeps its
  progress and stays in your library, your history and your statistics.
* **Only the server owner's token may read the setting from Plex.** On a server
  someone shares with you, Tally does not know the value until the owner syncs,
  and uses Plex's own default of 16 weeks until then. Settings says which of the
  two it is currently going on.
* **Plex reads 0 weeks as "switch On Deck off"; Tally reads it as "no
  cut-off".** An empty shelf reads as a broken page, so the two deliberately
  differ here. With more than one server, the most generous window wins.

## Whose data

Ratings, watch state and history are per user in Plex and only visible through
that user's own token, so Tally holds a token per person rather than reading
everything through the server owner's account. When it cannot work out which
Plex account a token belongs to, the history import is **skipped** for that
server rather than run without the filter: asking Plex for the whole server's
history would file every household member's plays under one account.
