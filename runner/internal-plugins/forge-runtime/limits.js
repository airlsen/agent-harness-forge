/** forge-runtime 的会话工作区配额与路径上限（工作区配额检查与路径守卫共用） */

/** 单文件上限：write / edit 写入后的文件大小（Runner 原始下载上限为 20 MB） */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 每个会话工作区最多保存的文件数 */
export const MAX_FILES = 1000;
/** 每个会话工作区的产物总量上限 */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** 工作区路径：最大目录深度与路径长度（控制面同步时路径不超过 256 字符） */
export const MAX_DEPTH = 16;
export const MAX_PATH_CHARS = 256;
