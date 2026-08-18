<!--
  The Docker Hub listing's description. Not a second README.

  Docker Hub renders Markdown and does not render raw HTML, so the README's
  banner cannot be reused: it is a <picture> element, which is what gives
  GitHub its dark and light swap. The URL completion in
  peter-evans/dockerhub-description rewrites Markdown links and images only,
  so the README's relative HTML paths reached Docker Hub untouched and
  resolved to nothing. Every link here is therefore absolute and every image
  is Markdown.

  Keep this short. It exists to say what the image is, how to run it, and
  where the real documentation lives. Anything longer belongs in the README
  or under docs/, where it will be kept in step.
-->

![Tally](https://raw.githubusercontent.com/Spillebulle/Tally/main/docs/images/banner.png)

**A self-hosted watch tracker that keeps your films, series and anime in step
with Plex, in both directions.**

Reads your Plex history · talks to plex.tv, TMDB, TheTVDB and MyAnimeList ·
saves everything in one SQLite file you own.

## Run it

```yaml
# docker-compose.yml
services:
  tally:
    image: spillebulle/tally:latest
    ports: ["8080:8080"]
    volumes: ["./data:/data"]
    environment:
      PUBLIC_URL: http://192.168.1.50:8080
    restart: unless-stopped
```

```bash
docker compose up -d
```

Then open the address you set as `PUBLIC_URL` and press **Continue with Plex**.
The first account to sign in becomes the administrator.

`PUBLIC_URL` must be the address you actually type in the browser. Plex sends
you back to it after sign-in, so a wrong value is the one setting that breaks
the login flow.

## Tags

`0.4.1` and `0.4` pin a release. `latest` moves with every release, so pin a
version in production. Every tag is built for `linux/amd64` and `linux/arm64`,
and the same images are on
[GHCR](https://github.com/Spillebulle/Tally/pkgs/container/tally).

## The settings that matter on day one

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | The address you reach Tally on. Used for the Plex sign-in redirect and the webhook URL. |
| `TMDB_API_KEY` | none | Posters, backdrops and descriptions. A free key is the single biggest visual improvement. |
| `PUID` / `PGID` | `1000` | The user and group to run as. Set them to whoever owns your `./data` directory. |

Tally works with no API keys at all, falling back to whatever artwork your Plex
server already has. Every other setting is in
[the configuration page](https://github.com/Spillebulle/Tally/blob/main/docs/configuration.md).

## Documentation

Everything lives in the
[repository](https://github.com/Spillebulle/Tally): what it does and what it
does not do yet in the
[README](https://github.com/Spillebulle/Tally#readme), and the
[API](https://github.com/Spillebulle/Tally/blob/main/docs/api.md),
[Grafana and Prometheus](https://github.com/Spillebulle/Tally/blob/main/docs/integrations/grafana.md),
[backups](https://github.com/Spillebulle/Tally/blob/main/docs/backups.md) and
[troubleshooting](https://github.com/Spillebulle/Tally/blob/main/docs/troubleshooting.md)
under `docs/`.

GNU General Public License v3.0. Tally is not affiliated with Plex, TMDB,
TheTVDB or MyAnimeList.
