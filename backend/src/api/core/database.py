"""SQLAlchemy 2.0 async 引擎与会话。"""

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings


class Base(DeclarativeBase):
    """所有模型的基类。"""


_engine = create_async_engine(settings.database_url, pool_size=20, max_overflow=10)
_SessionFactory = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with _SessionFactory() as session:
        yield session


async def init_db() -> None:
    # MVP 用 metadata.create_all；V1 起迁移交给 alembic
    from .. import models  # noqa: F401  确保模型注册

    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def close_db() -> None:
    await _engine.dispose()
