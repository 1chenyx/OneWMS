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
