import os
import tempfile
from pathlib import Path

import pytest

# The settings object is cached and reads DATA_DIR at import time, so this must
# be set before anything under `app` is imported.
_TMP = Path(tempfile.mkdtemp(prefix="tally-tests-"))
os.environ.setdefault("DATA_DIR", str(_TMP))
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-tally-suite")
os.environ.setdefault("PUBLIC_URL", "http://testserver")

import httpx  # noqa: E402
import pytest_asyncio  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.db import get_session  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest_asyncio.fixture(autouse=True)
async def _isolate_plex_connection_pool():
    """Plex connections are pooled process-wide, so they outlive a test.

    A test that monkeypatches httpx would otherwise leave its stub in the pool
    for whatever runs next — and, the other way round, would find a real client
    already pooled and never see its own stub.

    Both modules pool: `plex_server` for the media server, `plex_tv` for the
    cloud APIs.
    """
    from app.services.plex_server import close_pool
    from app.services.plex_tv import close_pool as close_plex_tv_pool

    await close_pool()
    await close_plex_tv_pool()
    yield
    await close_pool()
    await close_plex_tv_pool()


@pytest_asyncio.fixture
async def engine():
    # Each test gets a private file-backed database. In-memory SQLite would give
    # every connection its own empty schema.
    path = _TMP / f"test-{os.urandom(6).hex()}.db"
    eng = create_async_engine(f"sqlite+aiosqlite:///{path}")
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()
    path.unlink(missing_ok=True)


@pytest_asyncio.fixture
async def session_factory(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest_asyncio.fixture
async def db(session_factory):
    async with session_factory() as session:
        yield session


@pytest_asyncio.fixture
async def client(session_factory):
    async def override():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def bare_client(client):
    """A second client with no cookies, sharing the same app and database.

    `authed_client` *is* `client` with a session cookie attached, so anything
    testing credentials other than that cookie needs a genuinely anonymous
    caller — otherwise the cookie answers the request and the test proves
    nothing.
    """
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest_asyncio.fixture
async def authed_client(client):
    """A client with a session cookie for a freshly registered admin user."""
    response = await client.post(
        "/api/auth/register", json={"username": "tester", "password": "password123"}
    )
    assert response.status_code == 201, response.text
    return client
