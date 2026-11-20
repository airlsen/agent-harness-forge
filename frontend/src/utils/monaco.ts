import type * as Monaco from 'monaco-editor/editor';

let pending: Promise<typeof Monaco> | undefined;

/** 首次打开源码时加载；Worker 使用本地资源，部署不依赖 CDN。 */
export function loadMonaco() {
  return (pending ??= Promise.all([
    import('monaco-editor/editor'),
    import('monaco-editor/editor/editor.worker?worker'),
    import('monaco-editor/languages/definitions/markdown/register'),
    import('monaco-editor/languages/definitions/yaml/register'),
    import('monaco-editor/features/codeEditor/register'),
    import('monaco-editor/features/find/register'),
    import('monaco-editor/features/folding/register'),
    import('monaco-editor/features/bracketMatching/register'),
  ])
    .then(([monaco, { default: EditorWorker }]) => {
      self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
      return monaco;
    })
    .catch((error) => {
      pending = undefined;
      throw error;
    }));
}
