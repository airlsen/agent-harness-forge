"""工作台元信息同步：展示名、英文标识、不可变发布版本。"""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.api.core.database import Base
from src.api.models.skill import SkillRevision
from src.api.services import skill_service


def document(title="客户工单", description="整理工单"):
    return f'---\nname: customer-support\ntitle: {title}\ndescription: "{description}"\n---\n\n## 步骤\n\n识别问题。\n'


def test_metadata_keeps_machine_identifier_separate():
    skill = SimpleNamespace(name="旧名称", description="旧说明")
    skill_service.sync_skill_metadata(skill, document())
    assert skill.name == "客户工单"
    assert skill.description == "整理工单"


def test_legacy_document_keeps_display_name():
    skill = SimpleNamespace(name="已有技能", description="旧说明")
    skill_service.sync_skill_metadata(skill, document().replace("title: 客户工单\n", ""))
    assert skill.name == "已有技能"
    assert skill.description == "整理工单"


@pytest.mark.parametrize(
    "content", [document(title="[]"), document(description=""), "---\n[broken\n---\nbody"]
)
def test_invalid_metadata_is_rejected(content):
    with pytest.raises(HTTPException) as error:
        skill_service.sync_skill_metadata(SimpleNamespace(name="原名", description="原说明"), content)
    assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_manual_assistant_restore_sync_without_mutating_publication():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            created = await skill_service.create_skill(db, "初始名称", "", document(), "admin")
            assert created["name"] == "客户工单"
            published = await skill_service.publish_skill(db, created["id"], "admin")
            published_id = published["publishedRevisionId"]
            updated = await skill_service.update_draft(db, created["id"], document("新名称"), "手动", "admin")
            assert updated["name"] == "新名称"
            row = await skill_service.get_skill(db, created["id"])
            await skill_service.add_revision(db, row, document("助手名称"), "助手", "assistant")
            assert row.name == "助手名称"
            immutable = await db.get(SkillRevision, published_id)
            assert immutable.content == document()
            restored = await skill_service.restore_revision(db, created["id"], published_id, "admin")
            assert restored["name"] == "客户工单"
            assert restored["publishedRevisionId"] == published_id
    finally:
        await engine.dispose()


def test_quoted_identifiers_and_delimiters_in_description():
    content = '---\nname: "true"\ntitle: 示例\ndescription: "包含 --- 分隔文字"\n---\n\n正文\n'
    assert skill_service.validate_content(content) == []
    skill = SimpleNamespace(name="旧名", description="")
    skill_service.sync_skill_metadata(skill, content)
    assert skill.description == "包含 --- 分隔文字"
