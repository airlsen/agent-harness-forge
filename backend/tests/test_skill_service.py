import io
import zipfile

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.models.skill import Skill, SkillRevision, SkillAuthoringMessage, SkillAuthoringSession
from src.api.services import skill_service
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


@pytest.mark.asyncio
async def test_archives_use_selected_revision_and_reference_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(skill_service, 'SKILL_ROOT', tmp_path / 'skills')
    monkeypatch.setattr(skill_service.settings, 'data_dir', tmp_path)
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    content = '---\nname: published-name\ntitle: 已发布名称\ndescription: 稳定版本\n---\n\n# 内容\n'
    try:
        async with sessions() as db:
            created = await create_skill(db, '名称', '说明', content, 'tester')
            skill_id = created['id']
            await skill_service.add_reference(db, skill_id, 'readme.md', '发布的附件')
            await publish_skill(db, skill_id, 'tester')
            await update_draft(
                db, skill_id,
                content.replace('published-name', 'draft-name').replace('已发布名称', '草稿名称'),
                'new draft', 'tester',
            )
            published = await skill_service.skill_archive(db, skill_id, 'published')
            current = await skill_service.skill_archive(db, skill_id, 'current')
            assert published[1] == 'published-name'
            assert current[1] == 'draft-name'
            with zipfile.ZipFile(io.BytesIO(published[0])) as archive:
                assert 'published-name' in archive.read('SKILL.md').decode()
                assert archive.read('references/readme.md').decode() == '发布的附件'
            with zipfile.ZipFile(io.BytesIO(current[0])) as archive:
                assert 'draft-name' in archive.read('SKILL.md').decode()
            view = await skill_service.skill_detail(db, skill_id)
            assert view['machineName'] == 'draft-name'
            assert view['publishedMachineName'] == 'published-name'
            assert view['publishedName'] == '已发布名称'
            with pytest.raises(HTTPException) as error:
                await skill_service.delete_draft(db, skill_id)
            assert error.value.status_code == 409
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_delete_draft_removes_authoring_data_and_reference_files(tmp_path, monkeypatch):
    monkeypatch.setattr(skill_service, 'SKILL_ROOT', tmp_path / 'skills')
    monkeypatch.setattr(skill_service.settings, 'data_dir', tmp_path)
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessions() as db:
            created = await create_skill(db, '名称', '说明', None, 'tester')
            skill_id = created['id']
            await skill_service.add_reference(db, skill_id, 'note.md', '附件内容')
            authoring = SkillAuthoringSession(skill_id=skill_id, status='idle')
            db.add(authoring)
            await db.flush()
            db.add(SkillAuthoringMessage(authoring_session_id=authoring.id, seq=1, role='user', content='test'))
            await db.commit()
            assert (tmp_path / 'skills' / str(skill_id)).exists()
            await skill_service.delete_draft(db, skill_id)
            assert await db.get(Skill, skill_id) is None
            assert (await db.scalars(select(SkillRevision).where(SkillRevision.skill_id == skill_id))).all() == []
            assert (await db.scalars(select(SkillAuthoringSession).where(SkillAuthoringSession.skill_id == skill_id))).all() == []
            assert (await db.scalars(select(SkillAuthoringMessage))).all() == []
            assert not (tmp_path / 'skills' / str(skill_id)).exists()
    finally:
        await engine.dispose()
