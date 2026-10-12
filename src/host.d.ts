// 宿主注入的 `ctx`(new Function('ctx', code) 的形参)。只声明本插件用到的面;带 ? 的是较新宿主才有的,用前探测。
// 完整契约见 Forsion-Genesis/desktop/frontend/src/amadeus/plugins/types.ts。

interface HostChatMount {
  ready: Promise<{ ok: boolean; sessionId?: string; error?: string }>
  quote(text: string): void
  prefill(text: string): void
  dispose(): void
}
interface HostMarkdownEditor {
  getValue(): string
  update(patch: { value?: string; readOnly?: boolean }): void
  focus(): void
  dispose(): void
}

declare const ctx: {
  app: {
    readFile(path: string): Promise<string | null>
    writeFile(path: string, text: string): Promise<void>
    watchFile?(path: string, cb: () => void): () => void
    openFile(path: string): void
    hostPath?(path: string): string | null
  }
  registerFileType(def: { id: string; extensions: string[]; icon?: string; title?: string; mount(el: HTMLElement, file: { filePath: string }): (() => void) | void }): boolean | void
  registerEmbedRenderer(def: { id: string; match(target: string): boolean; mount(el: HTMLElement, embed: { target: string; pagePath: string }): (() => void) | void }): void
  registerFileCreator(def: { id: string; label: string; icon?: string; run(parentFolder: string): void | Promise<void> }): void
  registerView(view: { id: string; title: string; icon?: string; mount(el: HTMLElement): (() => void) | void }): void
  openView(viewId: string, opts?: { location?: 'main' | 'left' | 'right' | 'bottom' }): void
  viewLocations?: readonly string[]
  notify?(message: string, opts?: { level?: 'info' | 'success' | 'warning' | 'error'; title?: string }): void
  getLocale?(): 'zh' | 'en'
  subscribeLocale?(cb: (locale: 'zh' | 'en') => void): () => void
  loadData?<T = unknown>(): Promise<T | null>
  saveData?(value: unknown): Promise<void>
  tangu?: {
    /** 调同包引擎插件的路由(一问一答的 JSON;只在引擎跑在本机时可用)。 */
    request?(engineId: string, path: string, opts?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<unknown>
    mountChat?(el: HTMLElement, o?: { agent?: string; folder?: string; title?: string }): HostChatMount
  }
  ui?: {
    mountMarkdownEditor?(el: HTMLElement, opts: { value: string; label?: string; readOnly?: boolean; modes?: boolean; onChange?(markdown: string): void }): HostMarkdownEditor
  }
}

declare module '*.css' { const css: string; export default css }
