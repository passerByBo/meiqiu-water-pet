// 3D 黑猫模型（动漫风格）：卡通着色 + 黑色描边 + 动漫大眼睛 + 圆滚滚的身体 + 红项圈小铃铛
// 全部由代码搭建，所有动作由"姿势参数"驱动（关节结构和旧版一致，动作逻辑不用改）
import * as THREE from 'three';
import { clamp, damp, pickRandom, randomBetween } from '../shared/geometry';

/** 关键姿势：每个姿势定义各关节角度，实际姿势是它们的加权混合 */
const KEY_POSES = {
  stand:   { hipsHeight: .37, hipsPitch: 0,    hipsShift: 0,    frontUpper: 0,    frontKnee: 0,   backUpper: 0,    backKnee: 0,   neckPitch: 0 },
  sit:     { hipsHeight: .15, hipsPitch: -.55, hipsShift: -.08, frontUpper: .45,  frontKnee: .05, backUpper: -.5,  backKnee: 2.4, neckPitch: .45 },
  lie:     { hipsHeight: .2,  hipsPitch: .04,  hipsShift: 0,    frontUpper: -1.45, frontKnee: .25, backUpper: -1.2, backKnee: 2.5, neckPitch: .2 },
  stretch: { hipsHeight: .36, hipsPitch: .3,   hipsShift: -.05, frontUpper: -1.0, frontKnee: 0,   backUpper: .15,  backKnee: 0,   neckPitch: -.3 },
  lifted:  { hipsHeight: .3,  hipsPitch: -.9,  hipsShift: 0,    frontUpper: .9,   frontKnee: .15, backUpper: .9,   backKnee: .15, neckPitch: .65 },
};
type KeyPoseName = keyof typeof KEY_POSES;
type JointName = keyof typeof KEY_POSES.stand;
export const POSE_NAMES = Object.keys(KEY_POSES) as KeyPoseName[];
const JOINT_NAMES = Object.keys(KEY_POSES.stand) as JointName[];
const TAIL_SEGMENT_COUNT = 12;

// ---------------- 配色 ----------------
const COLORS = {
  fur: 0x2a2a36,          // 动漫里的黑猫：深石板色，才看得出明暗
  outline: 0x060609,      // 描边
  rim: 0x9fb6ff,          // 边缘的冷色高光
  pink: 0xff9db3,         // 鼻子、内耳、肉垫
  collar: 0xe8424f,       // 红项圈
  bell: 0xf5c542,         // 金铃铛
};
const OUTLINE_THICKNESS = .022;
/** 项圈前面比后面低多少（弧度）：头和身子的接缝是前低后高的 */
const COLLAR_FRONT_DROP = .35;

export function createDefaultPose() {
  return {
    stand: 0, sit: 1, lie: 0, stretch: 0, lifted: 0,
    walkAmount: 0, headYaw: 0, headPitch: 0, headRoll: 0,
    eyeOpen: 1, squint: 0, pupilX: 0, pupilY: 0, pupilWidth: 1,
    earBack: 0, earPerk: 0, mouthOpen: 0,
    tailLift: .2, tailSwing: .25, tailSpeed: 2, tailWrap: 0,
    groom: 0, bounce: 0, legKick: 0, breathRate: 2.2,
    crouch: 0,        // 压低身子（蹑手蹑脚）
    pawsOnLedge: 0,   // 两只前爪扒在边沿上
    airborne: 0,      // 跳在半空：前爪往前伸、后腿往后蹬
    knock: 0,         // 用右前爪敲窗户
    holdSign: 0,      // 举着小牌子
    wiggle: 0,        // 扑之前扭屁股
    rollAngle: 0,     // 打滚的角度（直接设置，不做平滑）
    cupVisible: 0,    // 身边是否放着小水杯
    cupPush: 0,       // 推杯子的进度 0~1（直接设置，不做平滑）
    special: 0,       // 每种动物特有动作的程度：仓鼠鼓腮帮 / 柴犬吐舌头 / 金鱼吐泡泡（猫没用到）
  };
}
export type CatPose = ReturnType<typeof createDefaultPose>;
/** 这些参数由大脑按时间精确控制，不做平滑（否则打滚、推杯子会被"拖慢"） */
const NON_DAMPED_POSE_KEYS = new Set<keyof CatPose>(['rollAngle', 'cupPush']);

interface Leg {
  upper: THREE.Group;
  knee: THREE.Group;
}

interface AnimeEye {
  group: THREE.Group;
  /** 睁眼时显示的部分（虹膜、瞳孔、高光） */
  openParts: THREE.Group;
  pupil: THREE.Mesh;
  /** 开心眯眼 ^ */
  happyArc: THREE.Mesh;
  /** 闭眼 ‿（睡觉、眨眼） */
  closedArc: THREE.Mesh;
}

// ---------------- 用 Canvas 画动漫风格的贴图 ----------------
function createCanvasTexture(draw: (context: CanvasRenderingContext2D, size: number) => void, size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** 虹膜：深色描边 + 上深下亮的黄绿渐变 + 内圈阴影 */
const drawIris = (context: CanvasRenderingContext2D, size: number) => {
  const center = size / 2;
  context.fillStyle = '#14110a';
  context.beginPath();
  context.arc(center, center, center - 2, 0, Math.PI * 2);
  context.fill();
  const gradient = context.createLinearGradient(0, 14, 0, size - 14);
  gradient.addColorStop(0, '#4f6a0c');
  gradient.addColorStop(.45, '#a8d42c');
  gradient.addColorStop(1, '#f1ff96');
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(center, center, center - 14, 0, Math.PI * 2);
  context.fill();
  // 上半部分的眼皮阴影，让眼睛更有神
  const shade = context.createLinearGradient(0, 14, 0, center);
  shade.addColorStop(0, 'rgba(20, 30, 0, .55)');
  shade.addColorStop(1, 'rgba(20, 30, 0, 0)');
  context.fillStyle = shade;
  context.beginPath();
  context.arc(center, center, center - 14, 0, Math.PI * 2);
  context.fill();
};

/** 一条粗弧线：opensUp = true 画 ∩（开心眯眼），false 画 ∪（闭眼） */
const drawArc = (opensUp: boolean) => (context: CanvasRenderingContext2D, size: number) => {
  context.strokeStyle = '#0b0b10';
  context.lineWidth = size * .11;
  context.lineCap = 'round';
  context.beginPath();
  if (opensUp) context.arc(size / 2, size * .78, size * .34, Math.PI * 1.15, Math.PI * 1.85);
  else context.arc(size / 2, size * .22, size * .34, Math.PI * .15, Math.PI * .85);
  context.stroke();
};

/** "ω" 小嘴 */
const drawCatMouth = (context: CanvasRenderingContext2D, size: number) => {
  context.strokeStyle = '#0b0b10';
  context.lineWidth = size * .07;
  context.lineCap = 'round';
  const radius = size * .17;
  context.beginPath();
  context.arc(size / 2 - radius, size * .38, radius, Math.PI * .1, Math.PI * .95);
  context.stroke();
  context.beginPath();
  context.arc(size / 2 + radius, size * .38, radius, Math.PI * .05, Math.PI * .9);
  context.stroke();
};

/** 圆角倒三角的粉鼻子 */
const drawNose = (context: CanvasRenderingContext2D, size: number) => {
  context.fillStyle = '#ff9db3';
  context.strokeStyle = '#0b0b10';
  context.lineWidth = size * .05;
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(size * .18, size * .3);
  context.quadraticCurveTo(size / 2, size * .18, size * .82, size * .3);
  context.quadraticCurveTo(size * .62, size * .78, size / 2, size * .8);
  context.quadraticCurveTo(size * .38, size * .78, size * .18, size * .3);
  context.fill();
  context.stroke();
};

/** 腮红：边缘柔和的粉色椭圆 */
const drawBlush = (context: CanvasRenderingContext2D, size: number) => {
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 140, 170, .9)');
  gradient.addColorStop(1, 'rgba(255, 140, 170, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
};

/** 小牌子：白底圆角 + 黑色描边 + 大字 */
function drawSign(context: CanvasRenderingContext2D, width: number, height: number, text: string): void {
  context.clearRect(0, 0, width, height);
  const radius = 26, inset = 8;
  context.fillStyle = '#fffaf0';
  context.strokeStyle = '#0b0b10';
  context.lineWidth = 8;
  context.beginPath();
  context.roundRect(inset, inset, width - inset * 2, height - inset * 2, radius);
  context.fill();
  context.stroke();
  context.fillStyle = '#1b1b24';
  const fontSize = text.length <= 3 ? 64 : text.length <= 5 ? 48 : 36;
  context.font = `bold ${fontSize}px "Microsoft YaHei UI", sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, width / 2, height / 2 + 4, width - 40);
}

/** 卡通着色用的 3 级明暗 */
function createToonGradient(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([125, 200, 255]), 3, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** 卡通材质 + 边缘冷色高光（动漫里常见的"轮廓光"） */
function createToonMaterial(color: number, gradientMap: THREE.Texture, rimStrength = .28): THREE.MeshToonMaterial {
  const material = new THREE.MeshToonMaterial({ color, gradientMap });
  material.onBeforeCompile = shader => {
    shader.uniforms.rimColor = { value: new THREE.Color(COLORS.rim) };
    shader.uniforms.rimStrength = { value: rimStrength };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;\nuniform float rimStrength;')
      .replace('#include <opaque_fragment>', `
        float rimAmount = 1.0 - max(dot(normal, normalize(vViewPosition)), 0.0);
        outgoingLight += rimColor * smoothstep(.7, .78, rimAmount) * rimStrength;
        #include <opaque_fragment>`);
  };
  return material;
}

/** 描边：把模型沿法线方向往外撑一点、只画背面，形成均匀的黑色轮廓线 */
function createOutlineMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      outlineColor: { value: new THREE.Color(COLORS.outline) },
      thickness: { value: OUTLINE_THICKNESS },
    },
    vertexShader: `
      uniform float thickness;
      void main() {
        vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        worldPosition.xyz += worldNormal * thickness;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }`,
    fragmentShader: `
      uniform vec3 outlineColor;
      void main() { gl_FragColor = vec4(outlineColor, 1.0); }`,
    side: THREE.BackSide,
  });
}

export class BlackCatModel {
  readonly root = new THREE.Group();
  readonly currentPose: CatPose = createDefaultPose();

  private blinkTimer = 2;
  private blinkAmount = 0;
  private earTwitchTimer = 3;
  private earTwitchSide = 1;
  private earTwitchAmount = 0;

  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly hips = new THREE.Group();
  private readonly torso: THREE.Mesh;
  private readonly chest = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly mouthOpening: THREE.Mesh;
  private readonly blushMaterial: THREE.MeshBasicMaterial;
  private readonly eyes: AnimeEye[] = [];
  private readonly ears: { group: THREE.Group; side: number }[] = [];
  private readonly legs: Record<'frontLeft' | 'frontRight' | 'backLeft' | 'backRight', Leg>;
  private readonly tailBase = new THREE.Group();
  private readonly tailSegments: THREE.Group[] = [];
  private readonly tailMesh: THREE.Mesh;
  private readonly tailOutline: THREE.Mesh;
  private readonly tailTip: THREE.Mesh;
  private readonly tailJointPoints: THREE.Vector3[];
  /** 每节尾巴当前的角度（带惯性地追向目标角度） */
  private readonly tailPitchAngles = new Array<number>(TAIL_SEGMENT_COUNT + 1).fill(0);
  private readonly tailYawAngles = new Array<number>(TAIL_SEGMENT_COUNT + 1).fill(0);
  /** 猫转身时尾巴被"甩"出去的量，会慢慢回弹 */
  private tailTurnOffset = 0;
  private previousRootYaw = 0;
  private readonly bell = new THREE.Group();
  /** 项圈（连同铃铛）：每帧抵消身子的前后倾斜，保持水平地套在脖子上 */
  private readonly collarGroup = new THREE.Group();
  /** 道具：举在胸前的小牌子、身边的小水杯 */
  private readonly sign = new THREE.Group();
  private readonly signTexture: THREE.CanvasTexture;
  private signText = '';
  private readonly cup = new THREE.Group();

  constructor() {
    // ---------- 材质 ----------
    const toonGradient = createToonGradient();
    const furMaterial = createToonMaterial(COLORS.fur, toonGradient);
    const pinkMaterial = createToonMaterial(COLORS.pink, toonGradient, .15);
    const collarMaterial = createToonMaterial(COLORS.collar, toonGradient, .25);
    const bellMaterial = createToonMaterial(COLORS.bell, toonGradient, .4);
    const outlineMaterial = createOutlineMaterial();
    const decal = (texture: THREE.Texture, transparent = true) =>
      new THREE.MeshBasicMaterial({ map: texture, transparent, toneMapped: false, depthWrite: false });
    const solidDecal = (color: number) => new THREE.MeshBasicMaterial({ color, toneMapped: false });

    const sphereGeometry = new THREE.SphereGeometry(1, 40, 28);
    const discGeometry = new THREE.CircleGeometry(1, 40);

    /** 给网格加描边（描边网格是它的子节点，跟着一起动） */
    const withOutline = <Mesh extends THREE.Mesh>(mesh: Mesh): Mesh => {
      const outline = new THREE.Mesh(mesh.geometry, outlineMaterial);
      outline.raycast = () => {};
      mesh.add(outline);
      return mesh;
    };
    const ellipsoid = (material: THREE.Material, radiusX: number, radiusY: number, radiusZ: number, x = 0, y = 0, z = 0, hasOutline = true) => {
      const mesh = new THREE.Mesh(sphereGeometry, material);
      mesh.scale.set(radiusX, radiusY, radiusZ);
      mesh.position.set(x, y, z);
      return hasOutline ? withOutline(mesh) : mesh;
    };
    /** 贴在脸上的平面贴纸（眼睛、鼻子、嘴巴、腮红） */
    const sticker = (material: THREE.Material, width: number, height: number, x: number, y: number, z: number, yaw = 0) => {
      const mesh = new THREE.Mesh(discGeometry, material);
      mesh.scale.set(width, height, 1);
      mesh.position.set(x, y, z);
      mesh.rotation.y = yaw;
      mesh.raycast = () => {};
      return mesh;
    };

    // ---------- 地面阴影 ----------
    const shadowTexture = createCanvasTexture((context, size) => {
      const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, 'rgba(0,0,0,.5)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
    }, 64);
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.6),
      new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.set(0, .005, .2);
    this.shadow.raycast = () => {};
    this.root.add(this.shadow);

    // ---------- 身体：圆滚滚的"饭团"身材 ----------
    this.root.add(this.hips);
    this.torso = ellipsoid(furMaterial, .34, .32, .42, 0, .1, .2);
    this.hips.add(this.torso);
    this.hips.add(ellipsoid(furMaterial, .34, .31, .28, 0, .08, .02)); // 圆屁股
    this.chest.position.set(0, .12, .48);
    this.hips.add(this.chest);
    this.chest.add(ellipsoid(furMaterial, .3, .31, .26));

    // 红项圈 + 金铃铛：Q 版大头和身子直接连在一起、看不到脖子，所以项圈套在"头和身子的接缝"上——
    // 前面在下巴底下（低）、后面在后脑勺下面（高），是一个前低后高的斜圈；细一点，刚好露出一圈；铃铛挂在下巴下面
    this.collarGroup.position.set(0, .07, .02);
    this.chest.add(this.collarGroup);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(.27, .03, 10, 56), collarMaterial);
    collar.rotation.x = Math.PI / 2;
    this.collarGroup.add(withOutline(collar));
    this.bell.position.set(0, -.055, .295);
    this.bell.add(withOutline(new THREE.Mesh(new THREE.TorusGeometry(.018, .007, 6, 12), bellMaterial)));   // 挂铃铛的小环
    this.bell.children[0].position.y = .045;
    this.bell.add(ellipsoid(bellMaterial, .046, .046, .046));
    this.bell.add(ellipsoid(solidDecal(0x5a3d06), .024, .006, .008, 0, -.016, .041, false)); // 铃铛开口
    this.collarGroup.add(this.bell);

    // ---------- 头部（Q 版大头） ----------
    this.neck.position.set(0, .18, .08);
    this.chest.add(this.neck);
    this.head.position.set(0, .24, .08);
    this.head.scale.setScalar(1.22);
    this.neck.add(this.head);
    this.head.add(ellipsoid(furMaterial, .42, .36, .38));
    this.head.add(ellipsoid(furMaterial, .19, .15, .17, -.17, -.1, .16)); // 左边肉嘟嘟的脸颊
    this.head.add(ellipsoid(furMaterial, .19, .15, .17, .17, -.1, .16));  // 右边脸颊

    // 五官贴纸
    this.head.add(sticker(decal(createCanvasTexture(drawNose)), .045, .036, 0, -.035, .386));
    this.head.add(sticker(decal(createCanvasTexture(drawCatMouth)), .075, .05, 0, -.088, .372));
    this.mouthOpening = sticker(solidDecal(0x6b1f2b), .03, .001, 0, -.1, .371);
    this.head.add(this.mouthOpening);
    this.blushMaterial = decal(createCanvasTexture(drawBlush, 64));
    this.blushMaterial.opacity = .4;
    for (const side of [-1, 1]) this.head.add(sticker(this.blushMaterial, .075, .042, side * .21, -.065, .32, side * .6));

    // 动漫大眼睛：虹膜贴图 + 可移动缩放的竖瞳 + 两个高光 + 眯眼 / 闭眼的弧线
    const irisMaterial = decal(createCanvasTexture(drawIris));
    const happyArcMaterial = decal(createCanvasTexture(drawArc(true)));
    const closedArcMaterial = decal(createCanvasTexture(drawArc(false)));
    const pupilMaterial = solidDecal(0x07070a);
    const highlightMaterial = solidDecal(0xffffff);
    for (const side of [-1, 1]) {
      const group = new THREE.Group();
      group.position.set(side * .15, .025, .356);
      group.rotation.set(-.05, side * .38, 0);
      const openParts = new THREE.Group();
      openParts.add(sticker(irisMaterial, .1, .118, 0, 0, 0));
      const pupil = sticker(pupilMaterial, .032, .078, 0, 0, .002);
      openParts.add(pupil);
      openParts.add(sticker(highlightMaterial, .03, .03, side * -.028 + .012, .045, .004));   // 大高光
      openParts.add(sticker(highlightMaterial, .014, .014, side * .03 - .01, -.045, .004));   // 小高光
      const happyArc = sticker(happyArcMaterial, .1, .1, 0, 0, .002);
      const closedArc = sticker(closedArcMaterial, .1, .1, 0, -.02, .002);
      group.add(openParts, happyArc, closedArc);
      this.head.add(group);
      this.eyes.push({ group, openParts, pupil, happyArc, closedArc });
    }

    // 胡须（每边两根，白色细线）
    const whiskerPoints: THREE.Vector3[] = [];
    for (const side of [-1, 1]) {
      whiskerPoints.push(new THREE.Vector3(side * .26, -.06, .3), new THREE.Vector3(side * .5, -.03, .24));
      whiskerPoints.push(new THREE.Vector3(side * .26, -.09, .3), new THREE.Vector3(side * .49, -.11, .25));
    }
    const whiskers = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(whiskerPoints),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .55, toneMapped: false }),
    );
    whiskers.raycast = () => {};
    this.head.add(whiskers);

    // 耳朵：圆角三角形，外黑内粉
    const earShape = new THREE.Shape();
    earShape.moveTo(-.14, 0);
    earShape.quadraticCurveTo(-.1, .19, -.025, .27);
    earShape.quadraticCurveTo(0, .295, .025, .27);
    earShape.quadraticCurveTo(.1, .19, .14, 0);
    earShape.quadraticCurveTo(0, -.04, -.14, 0);
    const earGeometry = new THREE.ExtrudeGeometry(earShape, { depth: .03, bevelEnabled: true, bevelThickness: .02, bevelSize: .016, bevelSegments: 3, curveSegments: 12 });
    earGeometry.translate(0, 0, -.015);
    const innerEarGeometry = new THREE.ShapeGeometry(earShape, 12);
    for (const side of [-1, 1]) {
      const earGroup = new THREE.Group();
      earGroup.position.set(side * .22, .22, -.03);
      const outerEar = withOutline(new THREE.Mesh(earGeometry, furMaterial));
      outerEar.rotation.y = side * .3;
      const innerEar = new THREE.Mesh(innerEarGeometry, pinkMaterial);
      innerEar.scale.setScalar(.6);
      innerEar.position.set(0, .03, .04);
      innerEar.raycast = () => {};
      outerEar.add(innerEar);
      earGroup.add(outerEar);
      this.head.add(earGroup);
      this.ears.push({ group: earGroup, side });
    }

    // ---------- 四条肉乎乎的小短腿 ----------
    const upperLegGeometry = new THREE.CapsuleGeometry(.105, .12, 8, 20);
    const lowerLegGeometry = new THREE.CapsuleGeometry(.095, .07, 8, 20);
    const createLeg = (parent: THREE.Object3D, x: number, y: number, z: number): Leg => {
      const upper = new THREE.Group();
      upper.position.set(x, y, z);
      const upperMesh = withOutline(new THREE.Mesh(upperLegGeometry, furMaterial));
      upperMesh.position.y = -.08;
      upper.add(upperMesh);
      const knee = new THREE.Group();
      knee.position.y = -.17;
      upper.add(knee);
      const lowerMesh = withOutline(new THREE.Mesh(lowerLegGeometry, furMaterial));
      lowerMesh.position.y = -.06;
      knee.add(lowerMesh);
      knee.add(ellipsoid(furMaterial, .115, .07, .135, 0, -.13, .03));          // 圆爪子
      knee.add(ellipsoid(pinkMaterial, .055, .012, .06, 0, -.198, .03, false)); // 粉肉垫（翻起时能看到）
      parent.add(upper);
      return { upper, knee };
    };
    this.legs = {
      frontLeft: createLeg(this.chest, -.15, -.12, .02),
      frontRight: createLeg(this.chest, .15, -.12, .02),
      backLeft: createLeg(this.hips, -.18, 0, 0),
      backRight: createLeg(this.hips, .18, 0, 0),
    };

    // ---------- 尾巴：看不见的关节 + 每帧重建的平滑管子 + 毛茸茸的圆尾尖 ----------
    this.tailBase.position.set(0, .14, -.24);
    this.hips.add(this.tailBase);
    let parentSegment: THREE.Group = this.tailBase;
    for (let index = 0; index <= TAIL_SEGMENT_COUNT; index++) {
      const segment = new THREE.Group();
      segment.position.z = index === 0 ? 0 : -.07;
      parentSegment.add(segment);
      this.tailSegments.push(segment);
      parentSegment = segment;
    }
    this.tailMesh = new THREE.Mesh(new THREE.BufferGeometry(), furMaterial);
    this.tailOutline = new THREE.Mesh(this.tailMesh.geometry, outlineMaterial);
    this.tailOutline.raycast = () => {};
    this.tailMesh.add(this.tailOutline);
    this.hips.add(this.tailMesh);
    this.tailTip = ellipsoid(furMaterial, .088, .088, .088); // 毛茸茸的圆尾尖
    this.hips.add(this.tailTip);
    this.tailJointPoints = this.tailSegments.map(() => new THREE.Vector3());

    // ---------- 道具：小牌子（举在胸前，两只前爪扶着） ----------
    const signCanvas = document.createElement('canvas');
    signCanvas.width = 256;
    signCanvas.height = 160;
    this.signTexture = new THREE.CanvasTexture(signCanvas);
    this.signTexture.colorSpace = THREE.SRGBColorSpace;
    const signBoard = new THREE.Mesh(new THREE.PlaneGeometry(.66, .41), new THREE.MeshBasicMaterial({ map: this.signTexture, transparent: true, toneMapped: false }));
    signBoard.position.set(0, .42, .72);
    signBoard.rotation.x = -.15;
    this.sign.add(signBoard);
    this.sign.visible = false;
    this.root.add(this.sign);
    this.setSignText('喝水！');

    // ---------- 道具：小水杯（浅蓝色马克杯） ----------
    const cupMaterial = createToonMaterial(0x7cc4f5, toonGradient, .2);
    const cupBody = withOutline(new THREE.Mesh(new THREE.CylinderGeometry(.085, .075, .17, 24), cupMaterial));
    cupBody.position.y = .085;
    const cupHandle = withOutline(new THREE.Mesh(new THREE.TorusGeometry(.045, .014, 8, 16, Math.PI), cupMaterial));
    cupHandle.position.set(.085, .09, 0);
    cupHandle.rotation.z = -Math.PI / 2;
    const water = sticker(solidDecal(0x3a8fd8), .075, .075, 0, .171, 0);
    water.rotation.x = -Math.PI / 2;
    this.cup.add(cupBody, cupHandle, water);
    this.cup.visible = false;
    this.root.add(this.cup);

    // ---------- 装扮（喝水达标解锁）：都挂在头或胸口上，跟着一起动 ----------
    // 小花发卡：右耳根前面，五片花瓣 + 黄色花心
    const flower = new THREE.Group();
    const petalMaterial = createToonMaterial(0xffd1e0, toonGradient, .15);
    for (let index = 0; index < 5; index++) {
      const angle = index / 5 * Math.PI * 2;
      flower.add(ellipsoid(petalMaterial, .045, .045, .02, Math.cos(angle) * .05, Math.sin(angle) * .05, 0));
    }
    flower.add(ellipsoid(createToonMaterial(0xffd23f, toonGradient, .2), .028, .028, .022, 0, 0, .012));
    flower.position.set(.2, .24, .2);
    flower.rotation.set(-.2, .45, 0);
    this.head.add(flower);
    // 粉色蝴蝶结：左耳根，两个圆鼓鼓的翅膀 + 中间的结
    const bow = new THREE.Group();
    const bowMaterial = createToonMaterial(0xff6fa0, toonGradient, .2);
    for (const side of [-1, 1]) {
      const wing = ellipsoid(bowMaterial, .07, .048, .03, side * .065, 0, 0);
      wing.rotation.z = side * -.35;
      bow.add(wing);
    }
    bow.add(ellipsoid(bowMaterial, .03, .032, .032));
    bow.position.set(-.21, .26, .14);
    bow.rotation.set(-.15, -.45, .25);
    this.head.add(bow);
    // 暖暖小围巾：套在项圈的位置（比项圈粗一圈），前面垂下一截围巾尾巴
    const scarf = new THREE.Group();
    const scarfMaterial = createToonMaterial(0x5fa8e8, toonGradient, .2);
    // 围巾和项圈一样挂在项圈组里，坐着站着都平平地围在脖子上
    const scarfRing = withOutline(new THREE.Mesh(new THREE.TorusGeometry(.28, .06, 12, 56), scarfMaterial));
    scarfRing.rotation.x = Math.PI / 2;
    const scarfTail = ellipsoid(scarfMaterial, .065, .12, .028, .12, -.13, .28);
    scarfTail.rotation.set(.1, 0, .25);
    const scarfStripe = ellipsoid(createToonMaterial(0xffffff, toonGradient, .1), .067, .018, .03, .12, -.19, .29, false);
    scarfStripe.rotation.set(.1, 0, .25);
    scarf.add(scarfRing, scarfTail, scarfStripe);
    this.collarGroup.add(scarf);
    // 小皇冠：头顶两只耳朵中间，金色圆环 + 五个尖尖 + 红宝石
    const crown = new THREE.Group();
    const goldMaterial = createToonMaterial(COLORS.bell, toonGradient, .45);
    const crownBand = withOutline(new THREE.Mesh(new THREE.CylinderGeometry(.12, .11, .07, 24, 1, true), goldMaterial));
    crownBand.material.side = THREE.DoubleSide;
    crown.add(crownBand);
    for (let index = 0; index < 5; index++) {
      const angle = index / 5 * Math.PI * 2;
      const spike = withOutline(new THREE.Mesh(new THREE.ConeGeometry(.026, .07, 10), goldMaterial));
      spike.position.set(Math.sin(angle) * .115, .065, Math.cos(angle) * .115);
      crown.add(spike);
    }
    crown.add(ellipsoid(createToonMaterial(0xe8424f, toonGradient, .4), .025, .025, .012, 0, 0, .118));
    crown.position.set(0, .37, .02);
    crown.rotation.x = -.12;
    this.head.add(crown);
    this.accessories = new Map([['flower', flower], ['bow', bow], ['scarf', scarf], ['crown', crown]]);
    this.setAccessory('none');
  }

  private readonly accessories: Map<string, THREE.Group>;

  /** 穿上装扮（none 或 flower / bow / scarf / crown）；不认识的 id 当作不穿 */
  setAccessory(id: string): void {
    for (const [accessoryId, group] of this.accessories) group.visible = accessoryId === id;
    this.bell.visible = id !== 'scarf'; // 围巾会盖住铃铛
  }

  /** 每帧调用：让当前姿势平滑追向目标姿势，再把参数应用到各个关节 */
  update(targetPose: CatPose, walkPhase: number, elapsedSeconds: number, deltaSeconds: number): void {
    const pose = this.currentPose;
    for (const key of Object.keys(targetPose) as (keyof CatPose)[]) {
      if (NON_DAMPED_POSE_KEYS.has(key)) { pose[key] = targetPose[key]; continue; }
      const isFastParameter = key === 'squint' || key === 'mouthOpen' || key === 'eyeOpen' || key === 'pupilWidth' || key === 'airborne';
      pose[key] = damp(pose[key], targetPose[key], isFastParameter ? 14 : 7, deltaSeconds);
    }

    // ---- 混合关键姿势 ----
    const totalWeight = POSE_NAMES.reduce((sum, name) => sum + pose[name], 0) || 1;
    const blended = {} as Record<JointName, number>;
    for (const joint of JOINT_NAMES) {
      blended[joint] = POSE_NAMES.reduce((sum, name) => sum + KEY_POSES[name][joint] * pose[name], 0) / totalWeight;
    }

    // ---- 走路步态（对角线两条腿同步，像小跑） ----
    const walk = pose.walkAmount;
    const swing = Math.min(walk, 1.4) * .5;
    const legPhase = { frontLeft: walkPhase, backRight: walkPhase, frontRight: walkPhase + Math.PI, backLeft: walkPhase + Math.PI };
    const bobOffset = Math.cos(walkPhase * 2) * .02 * Math.min(walk, 1);

    // ---- 身体 ----
    // 打滚时身体抬高一点，翻过来时头和背不会钻到地底下
    const rollLift = (1 - Math.cos(pose.rollAngle)) * .3;
    this.hips.position.set(0, blended.hipsHeight - pose.crouch * .1 + bobOffset + rollLift, blended.hipsShift);
    this.hips.rotation.x = blended.hipsPitch + Math.sin(walkPhase * 2) * .02 * Math.min(walk, 1) - pose.airborne * .25;
    this.hips.rotation.y = Math.sin(elapsedSeconds * 22) * .12 * pose.wiggle;   // 扑之前扭屁股
    this.hips.rotation.z = pose.rollAngle;                                       // 打滚
    this.root.position.y = Math.abs(Math.sin(elapsedSeconds * 7)) * .1 * pose.bounce;
    const breath = 1 + Math.sin(elapsedSeconds * pose.breathRate) * .02;
    this.torso.scale.set(.34 * breath, .32 * breath, .42);

    // ---- 腿 ----
    for (const [legName, leg] of Object.entries(this.legs) as [keyof typeof legPhase, Leg][]) {
      const isFront = legName.startsWith('front');
      const phase = legPhase[legName];
      let upperAngle = (isFront ? blended.frontUpper : blended.backUpper) + Math.sin(phase) * swing;
      let kneeAngle = (isFront ? blended.frontKnee : blended.backKnee) + Math.max(0, -Math.cos(phase)) * swing * 1.5;
      kneeAngle += pose.crouch * (isFront ? .35 : .5);
      upperAngle += pose.crouch * (isFront ? -.2 : -.25);
      upperAngle += Math.sin(elapsedSeconds * 13 + phase * 1.7) * .3 * pose.legKick;
      if (legName === 'frontRight') {
        upperAngle += -2.25 * pose.groom;
        kneeAngle += 2.15 * pose.groom + Math.sin(elapsedSeconds * 6) * .15 * pose.groom;
      }
      if (isFront) {
        upperAngle += -2.0 * pose.pawsOnLedge;
        kneeAngle += 1.7 * pose.pawsOnLedge;
      }
      // 跳在半空：前爪往前伸、后腿往后蹬
      upperAngle += (isFront ? -.9 : .9) * pose.airborne;
      // 敲窗户：右前爪抬起来，一下一下往前敲
      if (legName === 'frontRight') {
        upperAngle += (-1.4 + Math.sin(elapsedSeconds * 16) * .35) * pose.knock;
        kneeAngle += .5 * pose.knock;
      }
      leg.upper.rotation.x = upperAngle;
      leg.knee.rotation.x = kneeAngle;
    }

    // ---- 头部 ----
    const groomNod = Math.sin(elapsedSeconds * 9) * .08 * pose.groom;
    this.neck.rotation.set(blended.neckPitch + pose.headPitch * .5 + .35 * pose.groom - pose.crouch * .12, pose.headYaw * .5 + .3 * pose.groom, 0);
    this.head.rotation.set(pose.headPitch * .5 + groomNod - bobOffset * 2, pose.headYaw * .5, pose.headRoll);

    // 项圈：沿着头和身子的接缝，前低后高；低头 / 抬头时跟着脖子转一半；铃铛一直竖直地挂着，跟着走路和摆头晃
    const collarTilt = COLLAR_FRONT_DROP + this.neck.rotation.x * .5;
    this.collarGroup.rotation.x = collarTilt;
    this.bell.rotation.set(-collarTilt - this.hips.rotation.x, 0, Math.sin(walkPhase * 2) * .25 * Math.min(walk, 1) + pose.headRoll * .6);

    // ---- 眼睛：睁眼 / 眨眼 / 开心眯成 ^ ^ / 睡觉闭成 ‿ ‿ ----
    this.blinkTimer -= deltaSeconds;
    if (this.blinkTimer <= 0) { this.blinkAmount = 1; this.blinkTimer = randomBetween(2.5, 6); }
    this.blinkAmount = Math.max(0, this.blinkAmount - deltaSeconds * 7);
    const blinkScale = this.blinkAmount > .5 ? (1 - this.blinkAmount) * 2 : 1 - this.blinkAmount * .2;
    const openness = pose.eyeOpen * blinkScale;
    const isHappyEyes = pose.squint > .55;
    const isClosedEyes = !isHappyEyes && openness < .14;
    for (const eye of this.eyes) {
      eye.openParts.visible = !isHappyEyes && !isClosedEyes;
      eye.happyArc.visible = isHappyEyes;
      eye.closedArc.visible = isClosedEyes;
      eye.openParts.scale.y = clamp(openness * (1 - pose.squint * .45), .15, 1.3);
      eye.pupil.position.x = clamp(pose.pupilX, -1, 1) * .028;
      eye.pupil.position.y = clamp(pose.pupilY, -1, 1) * .025;
      eye.pupil.scale.x = clamp(.032 * pose.pupilWidth, .012, .07);
    }
    this.blushMaterial.opacity = .35 + .5 * Math.max(pose.squint, pose.bounce);

    // ---- 耳朵 ----
    this.earTwitchTimer -= deltaSeconds;
    if (this.earTwitchTimer <= 0) { this.earTwitchAmount = 1; this.earTwitchSide = pickRandom([-1, 1]); this.earTwitchTimer = randomBetween(3, 8); }
    this.earTwitchAmount = Math.max(0, this.earTwitchAmount - deltaSeconds * 5);
    for (const ear of this.ears) {
      const twitch = ear.side === this.earTwitchSide ? Math.sin(this.earTwitchAmount * Math.PI) * .35 : 0;
      ear.group.rotation.x = -pose.earBack * .9 + pose.earPerk * .15;
      ear.group.rotation.z = ear.side * -(.28 + pose.earBack * .7) + ear.side * twitch;
    }

    // ---- 张嘴（喵喵叫、打哈欠） ----
    this.mouthOpening.visible = pose.mouthOpen > .05;
    this.mouthOpening.scale.y = .001 + pose.mouthOpen * .032;

    // ---- 尾巴：S 形弯曲 + 问号般的尾尖 + 跟随惯性（根部先动、尾尖慢半拍，转身时柔软地甩过去） ----
    const rootYawChange = Math.atan2(Math.sin(this.root.rotation.y - this.previousRootYaw), Math.cos(this.root.rotation.y - this.previousRootYaw));
    this.previousRootYaw = this.root.rotation.y;
    this.tailTurnOffset = clamp(this.tailTurnOffset - rootYawChange * 1.6, -1.4, 1.4);
    this.tailTurnOffset = damp(this.tailTurnOffset, 0, 2.5, deltaSeconds);
    this.tailBase.rotation.x = pose.tailLift * .75;
    this.tailSegments.forEach((segment, index) => {
      const progress = index / TAIL_SEGMENT_COUNT;
      // 自然的 S 形：根部向上翘、中段放平、尾尖再勾起来
      const restPitch = progress < .3 ? .1 : progress < .7 ? -.04 : .16 + .12 * Math.max(0, pose.tailLift - .3);
      const restYaw = Math.sin(progress * Math.PI * 2) * .05;
      const wave = Math.sin(elapsedSeconds * pose.tailSpeed - index * .45) * pose.tailSwing * (.25 + index * .06);
      const targetPitch = pose.tailLift * .06 + restPitch - pose.tailWrap * .02;
      const targetYaw = wave * .5 + restYaw + pose.tailWrap * .3 + this.tailTurnOffset * .14 * progress;
      // 越靠近尾尖跟得越慢，形成柔软的"甩动"
      const followRate = 20 - progress * 13;
      this.tailPitchAngles[index] = damp(this.tailPitchAngles[index], targetPitch, followRate, deltaSeconds);
      this.tailYawAngles[index] = damp(this.tailYawAngles[index], targetYaw, followRate, deltaSeconds);
      segment.rotation.x = this.tailPitchAngles[index];
      segment.rotation.y = this.tailYawAngles[index];
    });
    this.rebuildTailMesh();

    // ---- 小牌子：举起来时从小变大"弹"出来，轻轻晃 ----
    this.sign.visible = pose.holdSign > .05;
    this.sign.scale.setScalar(Math.max(.001, pose.holdSign));
    this.sign.rotation.z = Math.sin(elapsedSeconds * 3) * .06;

    // ---- 小水杯：被推着往旁边滑，滑到边上就掉下去 ----
    this.cup.visible = pose.cupVisible > .5;
    const slide = Math.min(pose.cupPush, .6) / .6;
    const fall = Math.max(0, pose.cupPush - .6) / .4;
    this.cup.position.set(.42 + slide * .35, -fall * fall * 1.6, .45);
    this.cup.rotation.z = -fall * 1.8;

    this.shadow.material.opacity = (1 - pose.lifted) * (1 - pose.airborne * .6);
  }

  /** 设置小牌子上的字（例如"喝水！""打卡！"） */
  setSignText(text: string): void {
    if (text === this.signText) return;
    this.signText = text;
    const canvas = this.signTexture.image as HTMLCanvasElement;
    drawSign(canvas.getContext('2d')!, canvas.width, canvas.height, text);
    this.signTexture.needsUpdate = true;
  }

  /** 沿尾巴关节生成一根毛茸茸的尾巴：根部稍细、中段蓬松、尾尖圆滚滚 */
  private rebuildTailMesh(): void {
    const tubularSegments = 32, radialSegments = 14;
    const radiusAt = (progress: number) => .068 + .032 * Math.sin(progress * Math.PI * .9);
    this.hips.updateMatrixWorld(true);
    const hipsInverse = this.hips.matrixWorld.clone().invert();
    this.tailSegments.forEach((segment, index) => {
      this.tailJointPoints[index].setFromMatrixPosition(segment.matrixWorld).applyMatrix4(hipsInverse);
    });
    const curve = new THREE.CatmullRomCurve3(this.tailJointPoints);
    const geometry = new THREE.TubeGeometry(curve, tubularSegments, 1, radialSegments, false);
    const positions = geometry.attributes.position;
    const ringCenter = new THREE.Vector3();
    const vertex = new THREE.Vector3();
    for (let ring = 0; ring <= tubularSegments; ring++) {
      const progress = ring / tubularSegments;
      curve.getPointAt(progress, ringCenter);
      const radius = radiusAt(progress);
      for (let side = 0; side <= radialSegments; side++) {
        const vertexIndex = ring * (radialSegments + 1) + side;
        vertex.fromBufferAttribute(positions, vertexIndex).sub(ringCenter).multiplyScalar(radius).add(ringCenter);
        positions.setXYZ(vertexIndex, vertex.x, vertex.y, vertex.z);
      }
    }
    geometry.computeVertexNormals();
    this.tailMesh.geometry.dispose();
    this.tailMesh.geometry = geometry;
    this.tailOutline.geometry = geometry;
    this.tailTip.position.copy(this.tailJointPoints[this.tailJointPoints.length - 1]);
  }
}
