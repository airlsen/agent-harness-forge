/** Skill 快照目录物化（与执行引擎无关的纯文件操作）。 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { SKILL_SNAPSHOT, type RuntimeSkill } from './capabilities.js';

/**
 * 物化 Skill 快照目录：DATA/<id>/skills/<name>/<修订号>-<内容哈希>/，内容与控制面修订逐字节一致：
 * SKILL.md（完整原文，旧控制面未下发原文时不写）+ references/、assets/、scripts/ 附加文件，文件只读（0400）。
 *
 * - 每个 Skill 都有目录（即使只有 SKILL.md），skill 工具的 resourceBase 始终是这个目录；
 * - 先写临时目录再原子改名，已存在的同名快照直接复用（名字由内容哈希决定，内容必然相同）；
 * - 不再每次启动整体删除：旧修订的快照留在磁盘上，接续会话时历史里的旧路径仍可追溯，
 *   但只读根只包含本次装配的快照目录，模型无法再读取旧快照。快照与会话日志一样留在会话数据目录
 *   DATA/<id>/ 中（不属于工作区，不受产物保留期清理影响；单个 Skill 最大约 576 KB）。
 * 返回 Skill 名 → 快照目录；正文中的相对路径（如 references/rules.md）按这个目录解析。
 */
export async function materializeSkills(sessionDir: string, skills: RuntimeSkill[]) {
  const root = join(sessionDir, 'skills');
  const dirs: Record<string, string> = {};
  for (const skill of skills) {
    const snapshot = skill.snapshot;
    const parent = join(root, skill.name);
    const dir = join(parent, snapshot);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await pruneSkillParent(parent);
    if (!(await isDirectory(dir))) {
      const staging = join(parent, `.staging-${randomUUID()}`);
      try {
        await mkdir(staging, { mode: 0o700 });
        const files = [
          ...(skill.document !== undefined ? [{ path: 'SKILL.md', content: skill.document }] : []),
          ...skill.files,
        ];
        for (const file of files) {
          // 路径已由 SKILL_FILE_PATH 校验为允许的单层目录，这里再确认不越出 Skill 目录
          const target = join(staging, file.path);
          if (!target.startsWith(staging + sep)) throw new Error(`Skill 文件路径无效：${file.path}`);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, file.content, { mode: 0o400, flag: 'wx' });
        }
        await rename(staging, dir);
      } catch (error: any) {
        await rm(staging, { recursive: true, force: true });
        // 目标快照已由此前的启动写好（同名即同内容）：直接复用
        if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code) || !(await isDirectory(dir))) throw error;
      }
    }
    dirs[skill.name] = dir;
  }
  return dirs;
}
/** 清理中断留下的临时目录与旧版本 Runner 的平铺目录（references/ 等直接放在 Skill 名下）；快照目录保留 */
async function pruneSkillParent(parent: string) {
  for (const name of await readdir(parent)) {
    if (SKILL_SNAPSHOT.test(name)) continue;
    await rm(join(parent, name), { recursive: true, force: true });
  }
}
async function isDirectory(path: string) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}
