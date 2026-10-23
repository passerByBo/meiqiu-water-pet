// 宠物造型预览（只在开发时用，打开 http://localhost:1420/species-preview.html）：
// 四种动物 × 七种姿势排在一起，方便检查和调整造型。
// 整页只用一个 WebGL 渲染器（浏览器对 WebGL 数量有限制），按格子分区域渲染
import * as THREE from 'three';
import { BlackCatModel, createDefaultPose, POSE_NAMES, type CatPose } from '../pet/BlackCatModel';
import { HamsterModel } from '../pet/models/HamsterModel';
import { ShibaModel } from '../pet/models/ShibaModel';
import { GoldfishModel } from '../pet/models/GoldfishModel';
import type { PetModel } from '../pet/models/PetModel';

// 网址参数：?only=1 只看第 2 种动物；?cell=360 把格子放大（检查细节用）
const searchParams = new URLSearchParams(window.location.search);
const CELL_SIZE = Number(searchParams.get('cell')) || 200;
const GAP = 8;
const LABEL_WIDTH = 90;
const HEADER_HEIGHT = 26;

interface SpecialMove {
  title: string;
  apply: (pose: CatPose) => void;
}

interface Species {
  name: string;
  create: () => PetModel;
  /** 特有动作（预览里每 4 秒轮换一个） */
  specials: SpecialMove[];
}

interface PoseColumn {
  title: string;
  background: 'light' | 'blue' | 'dark';
  yaw: number;
  isWalking?: boolean;
  isTurntable?: boolean;
  /** 特有动作这一列：轮换播放 */
  isSpecial?: boolean;
  /** 装扮这一列：四种装扮轮换着穿 */
  isAccessory?: boolean;
  setPose: (pose: CatPose, species: Species) => void;
}

const only = (pose: CatPose, name: (typeof POSE_NAMES)[number]) => { POSE_NAMES.forEach(item => { pose[item] = 0; }); pose[name] = 1; };

const ALL_SPECIES: Species[] = [
  { name: '🐈‍⬛ 煤球\n黑猫', create: () => new BlackCatModel(), specials: [
    { title: '舔爪洗脸', apply: pose => { only(pose, 'sit'); pose.groom = 1; pose.squint = .6; } },
  ] },
  { name: '🐹 团子\n仓鼠', create: () => new HamsterModel(), specials: [
    { title: '鼓腮帮子', apply: pose => { only(pose, 'sit'); pose.special = 1; pose.squint = .7; } },
  ] },
  { name: '🐕 小柴\n柴犬', create: () => new ShibaModel(), specials: [
    { title: '作揖拜拜', apply: pose => { only(pose, 'sit'); pose.special = 1; pose.squint = .9; pose.tailSwing = .9; pose.tailSpeed = 6; pose.earBack = .2; } },
    { title: '赖地耍赖', apply: pose => { only(pose, 'lie'); pose.special2 = 1; pose.eyeOpen = .45; pose.earBack = .6; pose.tailLift = -.2; } },
    { title: '螺旋桨尾巴', apply: pose => { only(pose, 'stand'); pose.special3 = 1; pose.squint = 1; pose.tailLift = 1.2; } },
  ] },
  { name: '🐟 墨墨\n金鱼', create: () => new GoldfishModel(), specials: [
    { title: '吐泡泡', apply: pose => { only(pose, 'sit'); pose.special = 1; } },
  ] },
];

const onlyIndex = searchParams.get('only');
const SPECIES = onlyIndex === null ? ALL_SPECIES : [ALL_SPECIES[Number(onlyIndex)]];

const COLUMNS: PoseColumn[] = [
  { title: '坐着看你', background: 'light', yaw: .35, setPose: pose => { only(pose, 'sit'); pose.tailLift = .3; } },
  { title: '走路 / 游', background: 'light', yaw: Math.PI / 2, isWalking: true, setPose: pose => { only(pose, 'stand'); pose.tailLift = .95; pose.tailSwing = .2; pose.tailSpeed = 4; } },
  { title: '开心', background: 'blue', yaw: 0, setPose: pose => { only(pose, 'sit'); pose.squint = 1; pose.tailLift = 1.3; pose.headRoll = .2; pose.bounce = 1; pose.tailSwing = .8; pose.tailSpeed = 7; } },
  { title: '睡觉', background: 'dark', yaw: .7, setPose: pose => { only(pose, 'lie'); pose.eyeOpen = 0; pose.headPitch = .35; pose.tailLift = -.3; pose.tailWrap = 1; pose.breathRate = 1.3; } },
  { title: '举牌提醒', background: 'light', yaw: 0, setPose: pose => { only(pose, 'sit'); pose.holdSign = 1; pose.pawsOnLedge = .7; pose.earPerk = 1; pose.tailLift = .8; } },
  { title: '特有动作', background: 'blue', yaw: .2, isSpecial: true, setPose: (pose, species) => species.specials[0].apply(pose) },
  { title: '旋转一圈', background: 'light', yaw: 0, isTurntable: true, setPose: pose => { only(pose, 'sit'); pose.tailLift = .5; } },
  { title: '装扮（轮换）', background: 'light', yaw: .3, isAccessory: true, setPose: pose => { only(pose, 'sit'); pose.tailLift = .5; } },
];

// ---- 页面上的格子（背景和文字），3D 画在上面盖着的一张大画布上 ----
const grid = document.getElementById('grid')!;
const specialCaptions = new Map<Species, HTMLElement>();
grid.style.gridTemplateColumns = `${LABEL_WIDTH}px repeat(${COLUMNS.length}, ${CELL_SIZE}px)`;
document.documentElement.style.setProperty('--cell-size', `${CELL_SIZE}px`);
grid.appendChild(document.createElement('div'));
for (const column of COLUMNS) {
  const header = document.createElement('div');
  header.className = 'header';
  header.textContent = column.title;
  grid.appendChild(header);
}
for (const species of SPECIES) {
  const label = document.createElement('div');
  label.className = 'species';
  label.style.whiteSpace = 'pre-line';
  label.textContent = species.name;
  grid.appendChild(label);
  for (const column of COLUMNS) {
    const cell = document.createElement('div');
    cell.className = `cell ${column.background}`;
    if (column.isSpecial) {
      // 特有动作的名字写在格子底部（轮换时跟着换）
      cell.style.position = 'relative';
      const caption = document.createElement('div');
      caption.className = 'special-caption';
      caption.textContent = species.specials[0].title;
      cell.appendChild(caption);
      specialCaptions.set(species, caption);
    }
    grid.appendChild(cell);
  }
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const width = LABEL_WIDTH + COLUMNS.length * (CELL_SIZE + GAP);
const height = HEADER_HEIGHT + GAP + SPECIES.length * (CELL_SIZE + GAP);
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(width, height);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.setScissorTest(true);
renderer.setClearColor(0x000000, 0);

// 和桌面上一样的相机和灯光
const camera = new THREE.PerspectiveCamera(26, 1, .1, 50);
camera.position.set(0, 2.15, 5.5);
camera.lookAt(0, .64, 0);
const createScene = (): THREE.Scene => {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe2ebff, 0x2a241e, 1.0));
  const keyLight = new THREE.DirectionalLight(0xfff2e0, 2.4);
  keyLight.position.set(2.5, 4, 3.5);
  const rimLightLeft = new THREE.DirectionalLight(0xc4d8ff, 3.2);
  rimLightLeft.position.set(-3, 2.5, -3.5);
  const rimLightRight = new THREE.DirectionalLight(0xffe2c4, 1.8);
  rimLightRight.position.set(3.2, 1.6, -3);
  scene.add(keyLight, rimLightLeft, rimLightRight);
  return scene;
};

const cells = SPECIES.flatMap((species, row) => COLUMNS.map((column, columnIndex) => {
  const scene = createScene();
  const model = species.create();
  scene.add(model.root);
  const pose = createDefaultPose();
  column.setPose(pose, species);
  model.setSignText('喝水！');
  return {
    scene, model, pose, column, species, specialIndex: 0,
    left: LABEL_WIDTH + GAP + columnIndex * (CELL_SIZE + GAP),
    top: HEADER_HEIGHT + GAP + row * (CELL_SIZE + GAP),
    walkPhase: 0,
  };
}));

let lastTime = performance.now();
let elapsedSeconds = 0;
function animate(now: number): void {
  requestAnimationFrame(animate);
  const deltaSeconds = Math.min(.05, (now - lastTime) / 1000);
  lastTime = now;
  elapsedSeconds += deltaSeconds;
  // 特有动作这一列：每 4 秒换下一个
  // 网址参数 ?special=1 可以直接停在第 2 个特有动作（检查用）
  const forcedSpecial = searchParams.get('special');
  const specialRound = forcedSpecial === null ? Math.floor(elapsedSeconds / 4) : Number(forcedSpecial);
  for (const cell of cells) {
    if (cell.column.isSpecial && cell.species.specials.length > 1) {
      const index = specialRound % cell.species.specials.length;
      if (index !== cell.specialIndex) {
        cell.specialIndex = index;
        const freshPose = createDefaultPose();
        cell.species.specials[index].apply(freshPose);
        Object.assign(cell.pose, freshPose);
        const caption = specialCaptions.get(cell.species);
        if (caption) caption.textContent = cell.species.specials[index].title;
      }
    }
    if (cell.column.isAccessory) {
      // 网址参数 ?accessory=crown 可以直接看某一件
      const accessories = ['flower', 'bow', 'scarf', 'crown'];
      cell.model.setAccessory(searchParams.get('accessory') ?? accessories[Math.floor(elapsedSeconds / 2.5) % accessories.length]);
    }
    if (cell.column.isWalking) {
      cell.walkPhase += deltaSeconds * 8;
      cell.pose.walkAmount = 1;
    }
    cell.model.root.rotation.y = cell.column.isTurntable ? elapsedSeconds * .8 : cell.column.yaw;
    cell.model.update(cell.pose, cell.walkPhase, elapsedSeconds, deltaSeconds);
    // 每个格子只渲染自己那一块（y 轴从下往上算）
    const bottom = height - cell.top - CELL_SIZE;
    renderer.setViewport(cell.left, bottom, CELL_SIZE, CELL_SIZE);
    renderer.setScissor(cell.left, bottom, CELL_SIZE, CELL_SIZE);
    renderer.render(cell.scene, camera);
  }
}
requestAnimationFrame(animate);
