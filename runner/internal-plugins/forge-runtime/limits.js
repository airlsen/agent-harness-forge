/** forge-runtime 的会话工作区配额与读取上限（工作区工具与路径校验共用） */

/** 单文件上限：workspace_write 可写、workspace_read 可读的最大文件（Runner 原始下载上限为 20 MB） */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 每个会话工作区最多保存的文件数 */
export const MAX_FILES = 1000;
/** 每个会话工作区的产物总量上限 */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** workspace_present 单次最多声明的交付文件数 */
export const MAX_PRESENTED = 4;
/** workspace_read 分页时单次最多返回的行数 */
export const MAX_READ_LINES = 2000;
/** workspace_read 单次返回给模型的最大字符数：超过时分段，避免撑爆上下文 */
export const MAX_READ_CHARS = 256000;
/** 工作区路径：最大目录深度与路径长度（控制面同步时路径不超过 256 字符） */
export const MAX_DEPTH = 16;
export const MAX_PATH_CHARS = 256;
