# Backing up and restoring

What lives in `/data`, what each file is worth, and how to take a copy that
restores cleanly.

## What is in there

```
data/
├── tally.db            your history, ratings, watchlist, notes and saved views
├── tally.db-wal        recent writes, not yet folded into tally.db
├── tally.db-shm        SQLite's shared-memory index for the file above
├── .secret_key         signs sessions, encrypts stored Plex tokens
├── .plex_client_id     this install's identity to Plex
└── themes/<user_id>/   each account's own .umbertheme files
```

Copy that directory and you have a complete backup. There is nothing outside it:
the container holds no state of its own, and every setting is an environment
variable you already have in your compose file.

## Taking the copy

**Stop Tally first, or copy all three `tally.db*` files together.** The database
runs in write-ahead logging mode, so a commit lives in `tally.db-wal` for a while
before it reaches `tally.db`. Copying `tally.db` on its own from a running
instance gives you a database that is missing whatever was recent, which is the
half of a backup you most wanted.

```bash
docker compose stop tally
cp -a ./data ./data-backup-$(date +%F)
docker compose start tally
```

Restoring is the same operation backwards: stop the container, put the directory
back, start it again. Keep the file ownership, or set `PUID` and `PGID` to
whoever owns the restored copy. That is in `configuration.md`.

## Keep `.secret_key` with it

`.secret_key` signs session cookies and derives the key that encrypts stored
Plex tokens. Restoring `tally.db` without it leaves every stored token
undecryptable, so **every user has to sign in and link Plex again**. No watch
history, ratings or watchlist entries are lost, and nothing else breaks, but it
is an avoidable round of confusion for everyone in the household.

Setting `SECRET_KEY` as an environment variable instead of letting Tally
generate one means the file does not matter, because the value is already in
your compose file. Whichever you choose, that value is as sensitive as the Plex
tokens it protects: anything that can read it can decrypt them.

`.plex_client_id` is this install's identity to Plex. Losing it costs you
nothing but a new entry in your Plex account's authorised-devices list.
