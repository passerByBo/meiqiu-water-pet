// 猫咪窗口入口
import { createApp } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import PetView from './PetView.vue';

// 把提示、警告和错误也转发到程序日志（猫咪窗口没有可见的控制台，出问题时靠日志排查）
const forwardToLog = (level: 'info' | 'warn' | 'error', parts: unknown[]) => {
  const message = parts.map(part => (part instanceof Error ? `${part.message}\n${part.stack ?? ''}` : typeof part === 'string' ? part : JSON.stringify(part))).join(' ');
  void invoke('frontend_log', { level, message }).catch(() => {});
};
for (const level of ['info', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...parts: unknown[]) => { original(...parts); forwardToLog(level, parts); };
}
window.addEventListener('error', event => forwardToLog('error', [event.error ?? event.message]));
window.addEventListener('unhandledrejection', event => forwardToLog('error', ['未处理的异步错误', event.reason]));

createApp(PetView).mount('#app');

// 开发模式改代码时：整页刷新，不做"热替换"。
// 热替换会新建一个控制器，但旧控制器的动画循环和事件监听还在跑，两个控制器抢着移动窗口、切换点击穿透，
// 表现为猫一直闪烁抖动、点不动
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => window.location.reload());
}
