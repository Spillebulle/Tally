"""Aggregate viewing statistics."""
from __future__ import annotations

from collections import Counter
from datetime import UTC, date, datetime, time, timedelta

from fastapi import APIRouter, Query
from sqlalchemy import and_, func, select

from ..deps import CurrentUser, DbSession
from ..models import MediaItem, MediaType, UserMediaState, WatchEvent
from ..schemas import StatCount, StatsOut

router = APIRouter(prefix="/api/stats", tags=["stats"])

# Fallbacks for items whose runtime we never learned, so totals stay plausible.
DEFAULT_EPISODE_MINUTES = 24
DEFAULT_MOVIE_MINUTES = 110


def _streaks(days: list[date]) -> tuple[int, int]:
    """Current and longest consecutive-day watching streaks."""
    if not days:
        return 0, 0
    unique = sorted(set(days))

    longest = run = 1
    for previous, current in zip(unique, unique[1:], strict=False):
        run = run + 1 if (current - previous).days == 1 else 1
        longest = max(longest, run)

    today = date.today()
    # A streak stays "current" if it includes today or yesterday; requiring
    # today would reset every streak at midnight.
    if unique[-1] < today - timedelta(days=1):
        return 0, longest

    current_streak = 1
    for previous, following in zip(reversed(unique[:-1]), reversed(unique[1:]), strict=False):
        if (following - previous).days == 1:
            current_streak += 1
        else:
            break
    return current_streak, longest


@router.get("", response_model=StatsOut)
async def get_stats(
    db: DbSession,
    user: CurrentUser,
    days: int = Query(365, ge=7, le=3650),
    anime_only: bool = False,
) -> StatsOut:
    since_day = date.today() - timedelta(days=days)
    # Compare timestamp-to-timestamp; a bare date would be an implicit coercion.
    since = datetime.combine(since_day, time.min, tzinfo=UTC)

    conditions = [WatchEvent.user_id == user.id, WatchEvent.watched_at >= since]
    if anime_only:
        conditions.append(MediaItem.is_anime.is_(True))

    rows = (
        await db.execute(
            select(
                WatchEvent.watched_at,
                MediaItem.media_type,
                MediaItem.runtime_minutes,
                MediaItem.genres,
                MediaItem.is_anime,
                MediaItem.show_id,
            )
            .join(MediaItem, MediaItem.id == WatchEvent.media_item_id)
            .where(and_(*conditions))
        )
    ).all()

    movies = episodes = anime_count = 0
    runtime_total = 0
    genre_counter: Counter[str] = Counter()
    by_day: Counter[str] = Counter()
    by_month: Counter[str] = Counter()
    watch_days: list[date] = []
    shows_seen: set[int] = set()

    for watched_at, media_type, runtime, genres, is_anime, show_id in rows:
        day = watched_at.date()
        watch_days.append(day)
        by_day[day.isoformat()] += 1
        by_month[day.strftime("%Y-%m")] += 1

        if media_type == MediaType.MOVIE:
            movies += 1
            runtime_total += runtime or DEFAULT_MOVIE_MINUTES
        elif media_type == MediaType.EPISODE:
            episodes += 1
            runtime_total += runtime or DEFAULT_EPISODE_MINUTES
            if show_id:
                shows_seen.add(show_id)
        else:
            runtime_total += runtime or 0

        if is_anime:
            anime_count += 1
        for genre in genres or []:
            genre_counter[genre] += 1

    completed_shows = int(
        await db.scalar(
            select(func.count(UserMediaState.id))
            .join(MediaItem, MediaItem.id == UserMediaState.media_item_id)
            .where(
                UserMediaState.user_id == user.id,
                MediaItem.media_type == MediaType.SHOW,
                UserMediaState.view_count > 0,
            )
        )
        or 0
    )

    rating_rows = (
        await db.execute(
            select(UserMediaState.rating).where(
                UserMediaState.user_id == user.id,
                UserMediaState.rating.is_not(None),
            )
        )
    ).scalars()
    ratings = [float(r) for r in rating_rows]
    average_rating = round(sum(ratings) / len(ratings), 2) if ratings else None

    distribution: Counter[str] = Counter()
    for value in ratings:
        # Bucket to whole stars (Plex's 0-10 maps to 5 stars).
        distribution[str(int(round(value / 2)))] += 1

    current_streak, longest_streak = _streaks(watch_days)

    # Fill gaps so the activity chart shows real zero days rather than skipping.
    activity_by_day = []
    cursor = max(since_day, date.today() - timedelta(days=min(days, 180)))
    while cursor <= date.today():
        activity_by_day.append(
            StatCount(label=cursor.isoformat(), value=by_day.get(cursor.isoformat(), 0))
        )
        cursor += timedelta(days=1)

    return StatsOut(
        total_movies_watched=movies,
        total_episodes_watched=episodes,
        total_shows_watched=max(completed_shows, len(shows_seen)),
        total_anime_watched=anime_count,
        total_runtime_minutes=runtime_total,
        watch_events=len(rows),
        average_rating=average_rating,
        current_streak_days=current_streak,
        longest_streak_days=longest_streak,
        top_genres=[
            StatCount(label=name, value=count)
            for name, count in genre_counter.most_common(12)
        ],
        activity_by_day=activity_by_day,
        activity_by_month=[
            StatCount(label=month, value=count) for month, count in sorted(by_month.items())
        ],
        by_type=[
            StatCount(label="Movies", value=movies),
            StatCount(label="Episodes", value=episodes),
            StatCount(label="Anime", value=anime_count),
        ],
        rating_distribution=[
            StatCount(label=star, value=distribution.get(star, 0))
            for star in ("1", "2", "3", "4", "5")
        ],
    )


@router.get("/summary")
async def summary(db: DbSession, user: CurrentUser) -> dict:
    """Small counters for the dashboard header."""
    async def count(*conditions) -> int:
        return int(await db.scalar(select(func.count(MediaItem.id)).where(*conditions)) or 0)

    library_movies = await count(MediaItem.media_type == MediaType.MOVIE)
    library_shows = await count(MediaItem.media_type == MediaType.SHOW)
    library_anime = await count(
        MediaItem.is_anime.is_(True),
        MediaItem.media_type.in_([MediaType.MOVIE, MediaType.SHOW]),
    )
    watched_events = int(
        await db.scalar(
            select(func.count(WatchEvent.id)).where(WatchEvent.user_id == user.id)
        )
        or 0
    )
    return {
        "library_movies": library_movies,
        "library_shows": library_shows,
        "library_anime": library_anime,
        "watch_events": watched_events,
    }
