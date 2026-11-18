import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.models.skill import Skill, SkillRevision
from src.api.services.skill_service import (
    _slug,
    create_skill,
    publish_skill,
    restore_revision,
    update_draft,
    validate_content,
)


@pytest.mark.asyncio
async def test_skill_lifecycle_keeps_publications_immutable():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    content = '---\nname: customer-support\ndescription: "A useful support workflow"\n---\n\n# Steps\n\nDo the work.'
    async with sessions() as db:
        created = await create_skill(db, "Support", "Help customers", content, "tester")
        first_revision = created["currentRevisionId"]
        updated_content = content + "\n\n## Escalation\n\nEscalate unresolved cases.\n"
        updated = await update_draft(db, created["id"], updated_content, "Add escalation", "tester")
        assert updated["revision"] == 2
        published = await publish_skill(db, created["id"], "tester")
        assert published["publishedVersion"] == 1
        published_snapshot = await db.get(SkillRevision, published["currentRevisionId"])
        next_draft = await update_draft(db, created["id"], content, "Revise draft", "tester")
        assert next_draft["status"] == "draft"
        assert next_draft["publishedRevisionId"] == published["publishedRevisionId"]
        assert published_snapshot.content == updated_content
        restored = await restore_revision(db, created["id"], first_revision, "tester")
        assert restored["content"] == content
        assert restored["status"] == "draft"
    await engine.dispose()


def test_skill_markdown_validation():
    good = '---\nname: customer-support\ndescription: "A useful support workflow"\n---\n\n# Steps\n\nDo the work.'
    assert validate_content(good) == []
    assert "有效的 name" in " ".join(validate_content('---\nname: Bad Name\ndescription: x\n---\n\nBody'))
    assert validate_content('not markdown')
    assert validate_content('---\nname: ok\ndescription: valid\n---\n')


def test_skill_markdown_size_limit():
    content = '---\nname: x\ndescription: ok\n---\n' + ('x' * 64000)
    assert any('64 KB' in issue for issue in validate_content(content))


def test_reference_filename_is_sanitized():
    assert _slug('../../hello world.md') == 'hello-world.md'
    assert _slug('') == 'reference.txt'
