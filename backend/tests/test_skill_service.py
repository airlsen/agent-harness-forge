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
        assert created["publishedAt"] is None
        published = await publish_skill(db, created["id"], "tester")
        assert published["publishedVersion"] == 1
        assert published["publishedAt"] is not None
        published_snapshot = await db.get(SkillRevision, published["currentRevisionId"])
        next_draft = await update_draft(db, created["id"], content, "Revise draft", "tester")
        assert next_draft["status"] == "draft"
        assert next_draft["publishedRevisionId"] == published["publishedRevisionId"]
        assert next_draft["publishedAt"] == published["publishedAt"]
        listed = await skill_service.list_skills(db)
        assert listed[0]["publishedAt"] == published["publishedAt"]
        assert (await skill_service.list_published_skills(db))[0]["publishedAt"] == published["publishedAt"]
        assert published_snapshot.content == updated_content
        restored = await restore_revision(db, created["id"], first_revision, "tester")
        assert restored["content"] == content
        assert restored["status"] == "draft"
    await engine.dispose()


def test_skill_markdown_validation():
    good = '---\nname: customer-support\ndescription: "A useful support workflow"\n---\n\n# Steps\n\nDo the work.'
    assert validate_content(good) == []
    assert "有效的英文 name" in " ".join(validate_content('---\nname: Bad Name\ndescription: x\n---\n\nBody'))
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
            with pytest.raises(HTTPException) as unpublished:
                await skill_service.published_skill_detail(db, skill_id)
            assert unpublished.value.status_code == 404
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
            public = await skill_service.published_skill_detail(db, skill_id)
            assert public['name'] == '已发布名称'
            listed = await skill_service.list_published_skills(db)
            assert len(listed) == 1
            assert listed[0]['name'] == '已发布名称'
            assert listed[0]['machineName'] == 'published-name'
            assert 'content' not in listed[0]
            assert public['machineName'] == 'published-name'
            assert public['description'] == '稳定版本'
            assert public['version'] == 1
            assert 'draft-name' not in public['content']
            assert public['referenceFiles'] == [{'filename': 'readme.md', 'bytes': len('发布的附件'.encode())}]
            assert (await skill_service.published_reference_content(db, skill_id, 0))['content'] == '发布的附件'
            with pytest.raises(HTTPException) as missing:
                await skill_service.published_reference_content(db, skill_id, 1)
            assert missing.value.status_code == 404
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


def test_builtin_skill_design_is_a_valid_skill():
    """内置 skill-design 元 Skill 本身必须符合 Skill 规范，参考资料齐全。"""
    content = (skill_service.SKILL_DESIGN_DIR / 'SKILL.md').read_text(encoding='utf-8')
    assert validate_content(content) == []
    front, _ = skill_service.parse_skill_document(content)
    assert front['name'] == 'skill-design'
    assert 0 < len(front['title']) <= 120
    method, guides = skill_service.skill_design_method()
    assert method.startswith('# Skill 设计方法')
    assert '---' not in method.splitlines()[0]
    assert set(guides) == set(skill_service.SKILL_DESIGN_GUIDES)
    assert all(text.strip() for text in guides.values())
    # 正文里提到的参考资料名称都必须真实存在
    for name in skill_service.SKILL_DESIGN_GUIDES:
        assert f'skill_read_guide 读 {name}' in method


def test_authoring_history_keeps_recent_turns_in_order_and_bounded(monkeypatch):
    def message(role, content):
        return SkillAuthoringMessage(role=role, content=content, seq=0, authoring_session_id=1)

    history = skill_service.authoring_history(
        [message('user', '做个周报 Skill'), message('assistant', '谁来用？'), message('tool', '草稿已更新：初稿')]
    )
    assert history.startswith('## 之前的对话')
    assert history.index('维护者：做个周报 Skill') < history.index('助手：谁来用？') < history.index('系统记录：草稿已更新')
    assert skill_service.authoring_history([]) == ''
    assert skill_service.authoring_history([message('user', '  ')]) == ''

    long = skill_service.authoring_history([message('user', '长' * 5000)])
    assert '……（已截断）' in long and '长' * 2001 not in long

    # 超出总长度时丢弃最早的消息，保留最近的
    monkeypatch.setattr(skill_service, 'AUTHORING_HISTORY_TOTAL_CHARS', 20)
    bounded = skill_service.authoring_history([message('user', '最早的问题' * 3), message('assistant', '最近的回答')])
    assert '最近的回答' in bounded and '最早的问题' not in bounded


@pytest.mark.asyncio
async def test_authoring_session_bundle_carries_method_history_guides_and_output_budget(monkeypatch):
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    captured = {}

    async def fake_connection(db, secret=False):
        return {'configured': True, 'baseUrl': 'https://model.example', 'model': 'm', 'apiKey': 'k'}

    async def fake_create_session(bundle, user_ctx, model_config):
        captured['bundle'] = bundle
        return {'sessionId': f'runner-{len(captured)}'}

    policy = {'maxOutputTokens': 4096}

    async def fake_policy(db):
        return dict(policy)

    monkeypatch.setattr(skill_service, 'get_connection', fake_connection)
    monkeypatch.setattr(skill_service, 'get_policy', fake_policy)
    monkeypatch.setattr(skill_service.runner_client, 'create_session', fake_create_session)
    try:
        async with sessions() as db:
            created = await create_skill(db, '周报', '写周报时使用', None, 'tester')
            first = await skill_service.create_authoring_session(db, created['id'], 'tester')
            bundle = captured['bundle']
            prompt = bundle['profile_patch']['systemPrompt']
            assert '# Skill 设计方法' in prompt['workspace'][0]
            assert prompt['workspace'][1] == ''  # 还没有历史对话
            assert any('整体替换草稿' in rule for rule in prompt['safety'])
            meta = bundle['meta']
            assert 'skill_read_guide' in meta['builtin_tools']
            assert meta['policy']['allowedTools'] == meta['builtin_tools']
            # 企业策略低于 8192 时取 8192
            assert meta['policy']['maxOutputTokens'] == 8192
            authoring = meta['skillAuthoring']
            assert [guide['name'] for guide in authoring['guides']] == list(skill_service.SKILL_DESIGN_GUIDES)
            assert 'conversationContext' not in authoring

            # 有了对话记录后重建会话（如手动编辑后）：历史进入系统提示；企业策略更高时跟随策略
            row = await skill_service.get_authoring_session(db, created['id'], first['id'])
            await skill_service._append_message(db, row, 'user', '给财务团队用的周报')
            await skill_service._append_message(db, row, 'assistant', '好的，先确认数据来源。')
            policy['maxOutputTokens'] = 16384
            await skill_service.create_authoring_session(db, created['id'], 'tester')
            rebuilt = captured['bundle']
            history = rebuilt['profile_patch']['systemPrompt']['workspace'][1]
            assert '维护者：给财务团队用的周报' in history and '助手：好的，先确认数据来源。' in history
            assert rebuilt['meta']['policy']['maxOutputTokens'] == 16384
    finally:
        await engine.dispose()
