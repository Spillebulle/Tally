# Troubleshooting

Symptoms, what causes them, and what to do. Turn `LOG_LEVEL=DEBUG` on when you
want to see more, and turn it back down before pasting logs anywhere: at `DEBUG`
the HTTP client logs full URLs, and TMDB keys and Plex tokens ride in the query
string.

## Plex sign-in opens, but nothing happens after approving

`PUBLIC_URL` does not match the address you are actually using. Plex sends your
browser back to that address, so if it says `localhost` and you reached Tally on
`192.168.1.50`, the browser is sent somewhere it cannot go. Fix it and restart.
**Settings → About** shows the value the running instance has.

## "Permission denied: /data"

The mounted directory is owned by a different user than the container. Either
set `PUID` and `PGID` to the owner's ids (`id -u` and `id -g` on the host), or
`sudo chown -R 1000:1000 ./data`.

If you passed a `user:` override in compose, the entrypoint cannot fix ownership
for you and says so instead of failing later. Drop the override, or chown the
directory on the host to match it.

## "Could not reach plex.tv", or nothing syncs and the log mentions name resolution

The container cannot resolve DNS. Check it directly:

```bash
docker exec tally getent hosts plex.tv
```

Empty output confirms it. `cat /etc/resolv.conf` inside the container shows
which resolver it is using.

**If that resolver is a Pi-hole or AdGuard Home, this is the usual cause.** Every
container on the host shares one apparent source address (the Docker bridge
gateway, typically `172.17.0.1`), so they all count against a single client's
query budget. Pi-hole's default is 1000 queries per minute, and once tripped it
drops *every* query from that address until the window resets. Its log shows
`RATE_LIMIT  Client 172.17.0.1 has been rate-limited`.

Raise the limit in `/etc/pihole/pihole-FTL.conf` (`RATE_LIMIT=0/0` disables it),
then run `pihole restartdns`. Ad-blocking DNS can also filter Plex domains
outright, so check its query log for `plex.tv` and allow it if so.

Failing that, point the container at a public resolver, which skips your local
DNS for Tally alone:

```yaml
services:
  tally:
    dns:
      - 1.1.1.1
```

## No servers found

Open **Settings → Plex servers** and press **Refresh**, which asks plex.tv
again which servers this account can reach.

If it still finds nothing, your Plex token may have expired. Sign out from the
avatar menu in the top right and sign back in with Plex.

## A server is listed but not responding

Each server card has a **Test connection** button that asks that server whether
it answers on the address in use. If it does not, set the address by hand in
**Server address** on the same card and press **Save**. **Auto-detect** puts it
back to the addresses Plex advertises.

This is the usual fix when Plex advertises a route the Tally container cannot
take: a Plex server running in Docker advertises its host's internal addresses
too, and a container on a custom bridge network cannot always reach a
`localhost` address on the host.

## Posters are missing or low quality

Add a `TMDB_API_KEY` and restart. Provider keys are read when Tally starts, so
the Metadata pane cannot change them and a restart is required. Then run a full
re-import from **Settings → Syncing → Danger → Re-import
everything**.

Three things make this look worse than it is:

**Films and Shows sort by "Added, newest first" by default**, so anything
imported in one early batch sits together on the last pages. Missing artwork
therefore tends to look like one whole page being blank rather than a scatter.

**Titles on no Plex server have no artwork to borrow.** Watchlist entries, and
things you watched before the file was removed, lean on Plex Discover and TMDB
instead. Tally retries the metadata providers once a week for anything still
without a poster, so a large library fills in over days rather than in one run.

**A title whose filename Plex kept as its name may never match.** Tally recovers
a real title from a release name where it safely can, but it refuses a provider
result that does not name the same title, and a filename that misspells the film
by one character gets no match and no poster. Those refusals are logged, so
`docker logs tally | grep -i refus` is the thing that explains a blank tile.

Artwork from Plex is fetched through Tally rather than linked to directly, so it
works from anywhere Tally itself is reachable and a poster no longer breaks
because it was saved with a LAN address. Images are cached by your browser for a
week.

## A show is in the wrong section

Open **Settings → Plex servers** and set that library's dropdown to **Always
anime** or **Never anime**. Your override always wins, over every title in the
library.

To re-judge everything instead, an administrator can press **Re-detect anime**
under **Settings → Library → Danger**. Libraries you have set by hand
keep what you set. What the detection weighs is in `anime.md`.

## The sync button does nothing, or says a sync is already running

Only one sync per account runs at a time, and asking for a second while one is
in flight is answered with "already running" rather than starting it. The header
control shows the phase of the run in progress and offers **Cancel sync**, which
stops it after the current step.

A run interrupted by a hard restart is closed automatically the next time Tally
starts, so a container killed mid-sync does not leave the button dead.

## Statistics are filed under the wrong day

Which day a play belongs to is decided by a timezone, not by the container's
clock. The interface sends your browser's zone with every statistics request, so
it is normally right without you doing anything. The API takes a `tz` parameter
(an IANA name such as `Europe/Oslo`), falling back to the zone set under
**Settings → Appearance → Time zone**, and then to UTC.

So a Grafana panel or a script that does not send `tz` is answered in whatever
that setting says, and in UTC while it is left on **Follow this device**. Set it
to your own zone to move those. Every response names the zone it used in an
`X-Tally-Timezone` header.

`TZ` on the container sets the clock zone the log is written in and nothing
else. Setting it does not move a day boundary.
