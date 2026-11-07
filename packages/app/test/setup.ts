import '@testing-library/jest-dom/vitest';

// AntD 响应式监听依赖 window.matchMedia，jsdom 未实现——标准 polyfill
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// jsdom 无滚动行为（ChatPage 发送后 scrollTo）
Element.prototype.scrollTo = () => {};

// 测试环境里 window.Blob 是 jsdom 的，没有 text() / arrayBuffer()；
// 全局 Blob 可能是 Node 的，已经有这两个方法。补丁要打在窗口上的构造函数上。
for (const BlobCtor of new Set([globalThis.Blob, window.Blob].filter((ctor) => ctor))) {
  if (typeof BlobCtor.prototype.arrayBuffer !== 'function') {
    BlobCtor.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
        reader.readAsArrayBuffer(this);
      });
    };
  }
  if (typeof BlobCtor.prototype.text !== 'function') {
    BlobCtor.prototype.text = function text(this: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
        reader.readAsText(this);
      });
    };
  }
}
