// 猫咪窗口入口
import { createApp } from 'vue';
import PetView from './PetView.vue';

createApp(PetView).mount('#app');

// 开发模式改代码时：整页刷新，不做"热替换"。
// 热替换会新建一个控制器，但旧控制器的动画循环和事件监听还在跑，两个控制器抢着移动窗口、切换点击穿透，
// 表现为猫一直闪烁抖动、点不动
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => window.location.reload());
}
