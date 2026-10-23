<template>
  <div class="pet-root">
    <canvas ref="catCanvas" class="cat-canvas" :style="canvasStyle"></canvas>
    <div ref="effectsLayer" class="effects-layer"></div>
    <div
      ref="bubble"
      class="speech-bubble"
      :class="{ visible: petUiState.isBubbleVisible }"
      :style="{ left: `${petUiState.bubbleAnchorX}px`, top: `${petUiState.bubbleAnchorY}px` }"
    >
      <div class="bubble-text">{{ petUiState.bubbleText }}</div>
      <div v-if="petUiState.showReminderActions" class="bubble-actions">
        <button class="primary" @click="controller?.onPrimaryClicked()">
          {{ petUiState.activeCustomReminderId ? '做完啦 ✅' : '喝完啦 💧' }}
        </button>
        <button class="secondary" @click="controller?.onSnoozeClicked()">等一下嘛</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue';
import { CAT_CANVAS_LEFT, CAT_CANVAS_SIZE, CAT_CANVAS_TOP } from './constants';
import { PetController, petUiState } from './PetController';

const catCanvas = ref<HTMLCanvasElement>();
const effectsLayer = ref<HTMLElement>();
const bubble = ref<HTMLElement>();
const controller = shallowRef<PetController>();

const canvasStyle = {
  left: `${CAT_CANVAS_LEFT}px`,
  top: `${CAT_CANVAS_TOP}px`,
  width: `${CAT_CANVAS_SIZE}px`,
  height: `${CAT_CANVAS_SIZE}px`,
};

onMounted(async () => {
  controller.value = new PetController({ canvas: catCanvas.value!, effectsLayer: effectsLayer.value!, bubble: bubble.value! });
  await controller.value.start();
});
</script>

<style scoped>
.pet-root {
  position: relative;
  width: 100%;
  height: 100%;
  font-family: "Microsoft YaHei UI", system-ui, sans-serif;
}
.cat-canvas {
  position: absolute;
}
.effects-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* 对话气泡：尖角指向猫头顶 */
.speech-bubble {
  position: absolute;
  width: 220px;
  transform: translate(-50%, -100%) translateY(6px) scale(.96);
  background: #fff;
  color: #333;
  border-radius: 14px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.5;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .28);
  opacity: 0;
  transition: opacity .2s, transform .2s;
  pointer-events: none;
}
.speech-bubble.visible {
  opacity: 1;
  transform: translate(-50%, -100%);
  pointer-events: auto;
}
.speech-bubble::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -8px;
  margin-left: -8px;
  border: 8px solid transparent;
  border-top-color: #fff;
  border-bottom: 0;
}
.bubble-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.bubble-actions button {
  flex: 1;
  border: 0;
  border-radius: 8px;
  padding: 5px 0;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
}
.bubble-actions .primary {
  background: #4fb4f5;
  color: #fff;
  font-weight: bold;
}
.bubble-actions .secondary {
  background: #eee;
  color: #555;
}
</style>

<style>
/* 漂浮的小特效（爱心、Zzz、喵、👀），由控制器动态创建，所以不用 scoped */
.floating-effect {
  position: absolute;
  pointer-events: none;
  font-size: 18px;
  font-weight: bold;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, .6);
  animation: float-away 1.6s ease-out forwards;
}
@keyframes float-away {
  0% { opacity: 0; transform: translate(0, 6px) scale(.8); }
  20% { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--drift-x, 10px), -46px) scale(1.1); }
}
</style>
