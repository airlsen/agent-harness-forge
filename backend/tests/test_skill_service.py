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
            await skill_service.write_file(db, skill_id, 'references/readme.md', '发布的附件')
            await skill_service.write_file(db, skill_id, 'scripts/check.py', 'print("ok")')
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
                assert 'published-name' in archive.read('published-name/SKILL.md').decode()
                assert archive.read('published-name/references/readme.md').decode() == '发布的附件'
                assert archive.read('published-name/scripts/check.py').decode() == 'print("ok")'
            with zipfile.ZipFile(io.BytesIO(current[0])) as archive:
                assert 'draft-name' in archive.read('draft-name/SKILL.md').decode()
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
            assert public['files'] == [
                {'path': 'references/readme.md', 'bytes': len('发布的附件'.encode()), 'source': 'manual'},
                {'path': 'scripts/check.py', 'bytes': len(b'print("ok")'), 'source': 'manual'},
            ]
            assert (await skill_service.published_file(db, skill_id, 'references/readme.md'))['content'] == '发布的附件'
            with pytest.raises(HTTPException) as missing:
                await skill_service.published_file(db, skill_id, 'references/other.md')
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
            await skill_service.write_file(db, skill_id, 'references/note.md', '附件内容')
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


def test_skill_files_convert_legacy_entries_and_validate_paths():
    from src.api.services.skill_files import skill_files, validate_file_path

    legacy = {'filename': 'glossary.md', 'path': 'skills/3/references/abc-glossary.md', 'bytes': 9}
    current = {'path': 'assets/report.md', 'storage': 'skills/3/files/def-report.md', 'bytes': 5, 'source': 'agent'}
    assert skill_files([legacy, current, {'bad': True}, 'x']) == [
        {'path': 'references/glossary.md', 'storage': 'skills/3/references/abc-glossary.md', 'bytes': 9, 'source': 'manual'},
        {'path': 'assets/report.md', 'storage': 'skills/3/files/def-report.md', 'bytes': 5, 'source': 'agent'},
    ]
    # 同一路径以后出现的为准
    newer = {**current, 'storage': 'skills/3/files/xyz-report.md'}
    assert [item['storage'] for item in skill_files([current, newer])] == ['skills/3/files/xyz-report.md']

    assert validate_file_path(' references/rules.md ') == 'references/rules.md'
    assert validate_file_path('assets/data.json') == 'assets/data.json'
    assert validate_file_path('scripts/run.py') == 'scripts/run.py'
    for path, message in [
        ('scripts/run.exe', '只支持'),
        ('SKILL.md', '主文档'),
        ('rules.md', '目录/文件名'),
        ('references/a/b.md', '目录/文件名'),
        ('../references/x.md', '目录/文件名'),
        ('docs/x.md', 'references/、assets/ 或 scripts/'),
        ('references/.hidden.md', '文件名'),
        ('references/规则.md', '文件名'),
        ('references/data.json', '.md'),
        ('assets/run.sh', '.json'),
    ]:
        with pytest.raises(ValueError, match=message):
            validate_file_path(path)


async def _memory_sessions():
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.asyncio
async def test_file_writes_and_deletes_are_revisions_that_keep_history(tmp_path, monkeypatch):
    monkeypatch.setattr(skill_service, 'SKILL_ROOT', tmp_path / 'skills')
    monkeypatch.setattr(skill_service.settings, 'data_dir', tmp_path)
    engine, sessions = await _memory_sessions()
    try:
        async with sessions() as db:
            created = await create_skill(db, '周报', '写周报时使用', None, 'tester')
            skill_id = created['id']
            first = await skill_service.write_file(db, skill_id, 'references/rules.md', '规则 v1')
            assert first.change_summary == '新建文件：references/rules.md'
            await skill_service.write_file(db, skill_id, 'assets/template.md', '# 模板', source='agent')
            updated = await skill_service.write_file(db, skill_id, 'references/rules.md', '规则 v2')
            assert updated.change_summary == '更新文件：references/rules.md'

            # 只改 SKILL.md 时文件清单原样沿用
            detail = await update_draft(db, skill_id, created['content'] + '\n补充\n', '手动编辑', 'tester')
            assert [(f['path'], f['source']) for f in detail['files']] == [
                ('references/rules.md', 'manual'),
                ('assets/template.md', 'agent'),
            ]
            current = detail['currentRevisionId']
            assert (await skill_service.revision_file(db, skill_id, current, 'references/rules.md'))['content'] == '规则 v2'
            # 历史修订读到的仍是当时的内容
            assert (await skill_service.revision_file(db, skill_id, first.id, 'references/rules.md'))['content'] == '规则 v1'

            deleted = await skill_service.delete_file(db, skill_id, 'assets/template.md')
            assert deleted.change_summary == '删除文件：assets/template.md'
            assert [f['path'] for f in (await skill_service.skill_detail(db, skill_id))['files']] == ['references/rules.md']
            with pytest.raises(HTTPException) as missing:
                await skill_service.delete_file(db, skill_id, 'assets/template.md')
            assert missing.value.status_code == 404
            # 恢复删除前的修订，文件随之恢复
            restored = await restore_revision(db, skill_id, updated.id, 'tester')
            assert [f['path'] for f in restored['files']] == ['references/rules.md', 'assets/template.md']
            revisions = await skill_service.revisions(db, skill_id)
            assert revisions[0]['files'][1] == {'path': 'assets/template.md', 'bytes': len('# 模板'.encode()), 'source': 'agent'}

            await skill_service.write_file(db, skill_id, 'scripts/run.py', 'print(1)')
            assert (await skill_service.skill_detail(db, skill_id))['files'][-1]['path'] == 'scripts/run.py'
            with pytest.raises(HTTPException) as too_big:
                await skill_service.write_file(db, skill_id, 'references/big.md', 'x' * 120_001)
            assert too_big.value.status_code == 413
            monkeypatch.setattr('src.api.services.skill_files.MAX_FILES', 3)
            with pytest.raises(HTTPException) as too_many:
                await skill_service.write_file(db, skill_id, 'references/third.md', '第三份')
            assert too_many.value.status_code == 413 and '最多 3 个' in too_many.value.detail
            # 覆盖已有文件不增加数量
            await skill_service.write_file(db, skill_id, 'references/rules.md', '规则 v3')

            # 被篡改的清单不能读到 Skill 目录以外的文件
            revision = await db.get(SkillRevision, (await skill_service.skill_detail(db, skill_id))['currentRevisionId'])
            outside = tmp_path / 'secret.md'
            outside.write_text('secret', encoding='utf-8')
            revision.reference_files = [{'path': 'references/x.md', 'storage': 'secret.md', 'bytes': 6}]
            await db.commit()
            with pytest.raises(HTTPException):
                await skill_service.revision_file(db, skill_id, revision.id, 'references/x.md')
            assert skill_service.skill_file_contents(revision) == []
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_agent_turn_saves_document_and_files_without_dropping_references(tmp_path, monkeypatch):
    """回归：助手保存 SKILL.md 时不能用插件回传的清单覆盖（此前会丢掉手动上传的参考资料）。"""
    monkeypatch.setattr(skill_service, 'SKILL_ROOT', tmp_path / 'skills')
    monkeypatch.setattr(skill_service.settings, 'data_dir', tmp_path)
    engine, sessions = await _memory_sessions()
    monkeypatch.setattr(skill_service, 'SessionFactory', sessions)

    async def fake_call(method, path, *args, **kwargs):
        return {}

    events = []

    async def fake_events(runner_id, message):
        for event in events:
            yield event

    monkeypatch.setattr(skill_service.runner_client, 'call', fake_call)
    monkeypatch.setattr(skill_service.runner_client, 'events', fake_events)
    try:
        async with sessions() as db:
            created = await create_skill(db, '周报', '写周报时使用', None, 'tester')
            skill_id = created['id']
            await skill_service.write_file(db, skill_id, 'references/manual.md', '手动上传')
            row = SkillAuthoringSession(skill_id=skill_id, runner_session_id='r1', status='idle')
            db.add(row)
            await db.commit()
            session_id = row.id
        new_content = created['content'] + '\n详见 references/rules.md。\n'
        events.extend([
            {'kind': 'skill_revision', 'payload': {'action': 'write_file', 'path': 'references/rules.md', 'content': '规则', 'summary': '拆出规则'}},
            # 旧插件格式：带了过期的 referenceFiles 也要忽略
            {'kind': 'skill_revision', 'payload': {'content': new_content, 'summary': '引用规则', 'referenceFiles': []}},
            {'kind': 'skill_revision', 'payload': {'action': 'delete_file', 'path': 'references/manual.md', 'summary': ''}},
        ])
        relayed = [event async for event in skill_service.run_authoring_turn(skill_id, session_id, '拆分')]
        assert [(e['payload']['action'], e['payload']['path']) for e in relayed] == [
            ('write_file', 'references/rules.md'),
            ('update_draft', 'SKILL.md'),
            ('delete_file', 'references/manual.md'),
        ]
        async with sessions() as db:
            history = await skill_service.revisions(db, skill_id)
            # 第二条（只改正文）保留了手动文件和刚写入的文件
            assert [f['path'] for f in history[1]['files']] == ['references/manual.md', 'references/rules.md']
            assert history[1]['content'] == new_content
            detail = await skill_service.skill_detail(db, skill_id)
            assert detail['files'] == [{'path': 'references/rules.md', 'bytes': len('规则'.encode()), 'source': 'agent'}]
            assert history[0]['changeSummary'] == '删除文件：references/manual.md'
            assert history[0]['source'] == 'agent'
    finally:
        await engine.dispose()
