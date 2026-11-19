// 全局反馈单例：绑定 antd <App> 上下文里的 message / modal 实例，
// 供 Pinia store 的 toast 与各页面的确认弹窗使用（二者都需要主题感知）。
// 由 AppFeedbackBridge.vue 在 <a-app> 挂载时注入；未注入时静默降级。
import type { MessageInstance } from 'ant-design-vue/es/message/interface';
import type { ModalStaticFunctions } from 'ant-design-vue/es/modal/confirm';

type ModalApi = Omit<ModalStaticFunctions, 'warn'>;

let messageApi: MessageInstance | null = null;
let modalApi: ModalApi | null = null;

export function bindFeedbackApi(api: { message: MessageInstance; modal: ModalApi } | null) {
  messageApi = api?.message ?? null;
  modalApi = api?.modal ?? null;
}

export type FeedbackType = 'success' | 'error' | 'info';

export function notify(type: FeedbackType, content: string) {
  messageApi?.[type](content);
}

export interface ConfirmOptions {
  title: string;
  content?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}

// 用主题感知的 Modal.confirm 替代 window.confirm，返回 Promise<boolean>，
// 确认 true / 取消 false；未挂载（如组件树之外）时直接视为取消。
export function confirm(options: ConfirmOptions): Promise<boolean> {
  const api = modalApi;
  if (!api) return Promise.resolve(false);
  return new Promise((resolve) => {
    api.confirm({
      title: options.title,
      content: options.content,
      okText: options.okText ?? '确定',
      cancelText: options.cancelText ?? '取消',
      okType: options.danger ? 'danger' : 'primary',
      centered: true,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
