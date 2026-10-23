// 造型预览页（只在开发时用）：把煤球的各种姿势排在一起，方便检查和调整造型
import { createDefaultPose, POSE_NAMES, type CatPose } from '../pet/BlackCatModel';
import { PetScene } from '../pet/petScene';

interface PreviewCase {
  title: string;
  background: 'light' | 'blue' | 'dark';
  yaw: number;
  isWalking?: boolean;
  setPose: (pose: CatPose) => void;
}

const only = (pose: CatPose, name: (typeof POSE_NAMES)[number]) => { POSE_NAMES.forEach(item => { pose[item] = 0; }); pose[name] = 1; };

const PREVIEW_CASES: PreviewCase[] = [
  { title: '坐着看你', background: 'light', yaw: .35, setPose: pose => { only(pose, 'sit'); pose.tailLift = .3; } },
  { title: '侧面散步', background: 'light', yaw: Math.PI / 2, isWalking: true, setPose: pose => { only(pose, 'stand'); pose.tailLift = .95; pose.tailSwing = .2; pose.tailSpeed = 4; } },
  { title: '开心 ^ ^', background: 'blue', yaw: 0, setPose: pose => { only(pose, 'sit'); pose.squint = 1; pose.tailLift = 1.3; pose.headRoll = .2; } },
  { title: '提醒：喵～', background: 'blue', yaw: -.2, setPose: pose => { only(pose, 'sit'); pose.earPerk = 1; pose.headPitch = -.2; pose.pupilWidth = 1.8; pose.mouthOpen = 1; pose.tailLift = .9; } },
  { title: '扒着窗口偷看', background: 'dark', yaw: 0, setPose: pose => { only(pose, 'sit'); pose.pawsOnLedge = 1; pose.earPerk = 1; pose.headRoll = .25; pose.pupilX = .6; } },
  { title: '舔爪洗脸', background: 'light', yaw: .5, setPose: pose => { only(pose, 'sit'); pose.groom = 1; pose.squint = .6; } },
  { title: '睡觉 Zzz', background: 'dark', yaw: .7, setPose: pose => { only(pose, 'lie'); pose.eyeOpen = 0; pose.headPitch = .35; pose.tailLift = -.3; pose.tailWrap = 1; pose.breathRate = 1.3; } },
  { title: '被拎起来', background: 'blue', yaw: .2, setPose: pose => { only(pose, 'lifted'); pose.legKick = 1; pose.earBack = .8; pose.eyeOpen = 1.15; pose.pupilWidth = 2.2; pose.tailLift = -1; } },
  { title: '举牌提醒', background: 'light', yaw: 0, setPose: pose => { only(pose, 'sit'); pose.holdSign = 1; pose.pawsOnLedge = .7; pose.earPerk = 1; pose.tailLift = .8; } },
  { title: '敲窗户', background: 'light', yaw: -1.1, setPose: pose => { only(pose, 'sit'); pose.knock = 1; pose.earPerk = 1; pose.tailLift = .6; } },
  { title: '跳起来', background: 'blue', yaw: Math.PI / 2, setPose: pose => { only(pose, 'stand'); pose.airborne = 1; pose.tailLift = 1.2; } },
  { title: '推杯子', background: 'dark', yaw: .9, setPose: pose => { only(pose, 'sit'); pose.cupVisible = 1; pose.cupPush = .35; pose.earBack = .6; pose.knock = .6; } },
  { title: '打滚', background: 'light', yaw: 1.2, setPose: pose => { only(pose, 'lie'); pose.rollAngle = 2.4; pose.squint = 1; pose.legKick = .4; } },
  { title: '扑之前扭屁股', background: 'blue', yaw: .4, setPose: pose => { only(pose, 'stand'); pose.crouch = 1; pose.wiggle = 1; pose.earPerk = 1; pose.pupilWidth = 2.3; } },
];

const grid = document.getElementById('grid')!;
const scenes = PREVIEW_CASES.map(previewCase => {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.innerHTML = `<div class="stage ${previewCase.background}"><canvas></canvas></div><div class="caption">${previewCase.title}</div>`;
  grid.appendChild(cell);
  const scene = new PetScene(cell.querySelector('canvas')!);
  const pose = createDefaultPose();
  previewCase.setPose(pose);
  scene.catModel.root.rotation.y = previewCase.yaw;
  return { scene, pose, previewCase, walkPhase: 0 };
});

let lastTime = performance.now();
let elapsedSeconds = 0;
function animate(now: number): void {
  requestAnimationFrame(animate);
  const deltaSeconds = Math.min(.05, (now - lastTime) / 1000);
  lastTime = now;
  elapsedSeconds += deltaSeconds;
  for (const item of scenes) {
    if (item.previewCase.isWalking) {
      item.walkPhase += deltaSeconds * 8;
      item.pose.walkAmount = 1;
    }
    item.scene.catModel.update(item.pose, item.walkPhase, elapsedSeconds, deltaSeconds);
    item.scene.render();
  }
}
requestAnimationFrame(animate);

// 方便截图时调参
(window as unknown as { previewScenes: typeof scenes }).previewScenes = scenes;
