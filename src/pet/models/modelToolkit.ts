// 建模工具箱：所有动物模型共用的卡通着色、描边、贴纸、眼睛、小牌子、阴影。
// 统一风格：三级明暗的卡通着色 + 边缘轮廓光 + 外描边 + 动漫高光大眼睛
import * as THREE from 'three';
import { clamp, randomBetween } from '../../shared/geometry';

/** 用 Canvas 画一张贴图 */
export function createCanvasTexture(draw: (context: CanvasRenderingContext2D, size: number) => void, size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
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

/** 一条粗弧线：opensUp = true 画 ∩（开心眯眼），false 画 ∪（闭眼） */
export const drawArc = (opensUp: boolean, color = '#0b0b10') => (context: CanvasRenderingContext2D, size: number) => {
  context.strokeStyle = color;
  context.lineWidth = size * .11;
  context.lineCap = 'round';
  context.beginPath();
  if (opensUp) context.arc(size / 2, size * .78, size * .34, Math.PI * 1.15, Math.PI * 1.85);
  else context.arc(size / 2, size * .22, size * .34, Math.PI * .15, Math.PI * .85);
  context.stroke();
};

/** 腮红：边缘柔和的粉色椭圆 */
export const drawBlush = (context: CanvasRenderingContext2D, size: number) => {
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 140, 170, .9)');
  gradient.addColorStop(1, 'rgba(255, 140, 170, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
};

/** 地面上的柔和圆影 */
const drawShadow = (context: CanvasRenderingContext2D, size: number) => {
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,.5)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
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

export interface ModelStyle {
  /** 描边颜色：浅色动物用深棕色描边更柔和 */
  outlineColor: number;
  outlineThickness: number;
  /** 边缘轮廓光的颜色 */
  rimColor: number;
}

/**
 * 搭模型用的工具：材质（同一种颜色只建一次）、带描边的椭球、贴在表面的贴纸。
 * 每个动物模型建一个，用自己的描边颜色和轮廓光颜色
 */
export class ModelBuilder {
  readonly sphereGeometry = new THREE.SphereGeometry(1, 40, 28);
  readonly discGeometry = new THREE.CircleGeometry(1, 40);
  private readonly toonGradient = createToonGradient();
  private readonly outlineMaterial: THREE.ShaderMaterial;
  private readonly toonMaterials = new Map<string, THREE.MeshToonMaterial>();

  constructor(private readonly style: ModelStyle) {
    this.outlineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        outlineColor: { value: new THREE.Color(style.outlineColor) },
        thickness: { value: style.outlineThickness },
      },
      // 把模型沿法线方向往外撑一点、只画背面，形成均匀的轮廓线
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

  /** 卡通材质 + 边缘轮廓光（同样的颜色和强度只建一次） */
  toon(color: number, rimStrength = .28, rimColor = this.style.rimColor): THREE.MeshToonMaterial {
    const key = `${color}-${rimStrength}-${rimColor}`;
    const cached = this.toonMaterials.get(key);
    if (cached) return cached;
    const material = new THREE.MeshToonMaterial({ color, gradientMap: this.toonGradient });
    material.onBeforeCompile = shader => {
      shader.uniforms.rimColor = { value: new THREE.Color(rimColor) };
      shader.uniforms.rimStrength = { value: rimStrength };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;\nuniform float rimStrength;')
        .replace('#include <opaque_fragment>', `
          float rimAmount = 1.0 - max(dot(normal, normalize(vViewPosition)), 0.0);
          outgoingLight += rimColor * smoothstep(.7, .78, rimAmount) * rimStrength;
          #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => key;
    this.toonMaterials.set(key, material);
    return material;
  }

  decal(texture: THREE.Texture): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthWrite: false });
  }

  solid(color: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color, toneMapped: false });
  }

  /** 给网格加描边（描边网格是它的子节点，跟着一起动） */
  withOutline<Mesh extends THREE.Mesh>(mesh: Mesh): Mesh {
    const outline = new THREE.Mesh(mesh.geometry, this.outlineMaterial);
    outline.raycast = () => {};
    mesh.add(outline);
    return mesh;
  }

  /** 椭球（大部分身体部件都是它） */
  ellipsoid(material: THREE.Material, radiusX: number, radiusY: number, radiusZ: number, x = 0, y = 0, z = 0, hasOutline = true): THREE.Mesh {
    const mesh = new THREE.Mesh(this.sphereGeometry, material);
    mesh.scale.set(radiusX, radiusY, radiusZ);
    mesh.position.set(x, y, z);
    return hasOutline ? this.withOutline(mesh) : mesh;
  }

  /** 贴在表面的平面贴纸（眼睛、鼻子、嘴巴、腮红） */
  sticker(material: THREE.Material, width: number, height: number, x: number, y: number, z: number, yaw = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(this.discGeometry, material);
    mesh.scale.set(width, height, 1);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    mesh.raycast = () => {};
    return mesh;
  }

  /**
   * 贴合椭球表面的弯曲贴纸（嘴巴、花纹等贴在弧面上时用，不会像平面贴纸那样边缘陷进去看不见）。
   * center / radii 是被贴的那个椭球；pitch 往下偏多少弧度、yaw 往右偏多少弧度；yawSpan / pitchSpan 是贴纸覆盖的角度范围
   */
  curvedSticker(material: THREE.Material, center: THREE.Vector3, radii: THREE.Vector3, yawSpan: number, pitchSpan: number, pitch = 0, yaw = 0): THREE.Mesh {
    // 球面坐标里正前方（+z）是 phi = π/2、theta = π/2
    const geometry = new THREE.SphereGeometry(1, 24, 16, Math.PI / 2 + yaw - yawSpan / 2, yawSpan, Math.PI / 2 + pitch - pitchSpan / 2, pitchSpan);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.copy(radii).multiplyScalar(1.012);   // 比表面高一点点，避免和表面闪烁打架
    mesh.position.copy(center);
    mesh.raycast = () => {};
    return mesh;
  }

  /** 地面阴影 */
  shadow(width: number, depth: number): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshBasicMaterial({ map: createCanvasTexture(drawShadow, 64), transparent: true, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = .005;
    shadow.raycast = () => {};
    return shadow;
  }

  /** 白色细胡须：每边两根，points 是 [起点, 终点] 的列表 */
  whiskers(segments: [THREE.Vector3, THREE.Vector3][], opacity = .55): THREE.LineSegments {
    const whiskers = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(segments.flat()),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity, toneMapped: false }),
    );
    whiskers.raycast = () => {};
    return whiskers;
  }
}

// ---------------- 眼睛 ----------------

export interface PetEye {
  group: THREE.Group;
  /** 睁眼时显示的部分 */
  openParts: THREE.Group;
  /** 虹膜 + 瞳孔（看向鼠标时移动；高光不动，所以眼睛看起来是亮晶晶、湿润的） */
  pupil: THREE.Object3D;
  /** 瞳孔本身（兴奋、吃惊时放大） */
  pupilDisc?: THREE.Object3D;
  /** 高光（会轻轻闪） */
  sparkles?: THREE.Object3D[];
  /** 开心眯眼 ^ */
  happyArc: THREE.Mesh;
  /** 闭眼 ‿ */
  closedArc: THREE.Mesh;
}

/** 眼睛的配色：虹膜从上（深）到下（亮）的渐变，加一道底部反光的颜色 */
export interface EyePalette {
  /** 虹膜外圈的深色描边 */
  rim: string;
  /** 虹膜顶部（被眼皮阴影压暗） */
  top: string;
  /** 虹膜中部 */
  middle: string;
  /** 虹膜底部（最亮） */
  bottom: string;
  /** 瞳孔颜色 */
  pupil: string;
  /** 底部的月牙形反光 */
  reflection: string;
  /** 虹膜上半部分眼皮阴影的浓淡（0~1）：太浓会显得眼睛没睁开 */
  lidShade: number;
  /** 虹膜外圈深色描边的粗细（占半径的比例） */
  rimWidth: number;
  /** 瞳孔大小（占虹膜的比例） */
  pupilSize: number;
  /** "五彩斑斓的黑"：在虹膜下半部分叠几团淡淡的彩色光（像黑欧泊石的变彩），不写就没有 */
  iridescence?: string[];
}

/** 动漫风格的虹膜：深色描边 + 上深下亮的渐变 + 上半部分的眼皮阴影 + 底部一道月牙形的反光 */
const drawPetIris = (palette: EyePalette) => (context: CanvasRenderingContext2D, size: number) => {
  const center = size / 2;
  context.fillStyle = palette.rim;
  context.beginPath();
  context.arc(center, center, center - 2, 0, Math.PI * 2);
  context.fill();
  const innerRadius = center * (1 - palette.rimWidth);
  const gradient = context.createLinearGradient(0, center - innerRadius, 0, center + innerRadius);
  gradient.addColorStop(0, palette.top);
  gradient.addColorStop(.5, palette.middle);
  gradient.addColorStop(1, palette.bottom);
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(center, center, innerRadius, 0, Math.PI * 2);
  context.fill();
  // 上半部分的眼皮阴影，让眼睛更有神
  const shade = context.createLinearGradient(0, center - innerRadius, 0, center);
  shade.addColorStop(0, `rgba(0, 0, 0, ${palette.lidShade})`);
  shade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = shade;
  context.beginPath();
  context.arc(center, center, innerRadius, 0, Math.PI * 2);
  context.fill();
  // 五彩斑斓的黑：沿着虹膜下半圈叠几团柔和的彩色光
  if (palette.iridescence) {
    context.save();
    context.beginPath();
    context.arc(center, center, innerRadius, 0, Math.PI * 2);
    context.clip();
    context.globalCompositeOperation = 'lighter';
    palette.iridescence.forEach((color, index) => {
      const angle = Math.PI * (.15 + index / Math.max(1, palette.iridescence!.length - 1) * .7);
      const glowX = center + Math.cos(angle) * innerRadius * .55;
      const glowY = center + Math.sin(angle) * innerRadius * .55;
      const glow = context.createRadialGradient(glowX, glowY, 0, glowX, glowY, innerRadius * .55);
      glow.addColorStop(0, color);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      context.fillStyle = glow;
      context.fillRect(0, 0, size, size);
    });
    context.restore();
  }
  // 底部的月牙形反光
  context.save();
  context.beginPath();
  context.arc(center, center, innerRadius, 0, Math.PI * 2);
  context.clip();
  context.fillStyle = palette.reflection;
  context.beginPath();
  context.ellipse(center, center + innerRadius * .78, innerRadius * .62, innerRadius * .3, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
};

/** 四角星形的小闪光 */
const drawSparkle = (context: CanvasRenderingContext2D, size: number) => {
  const center = size / 2;
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.moveTo(center, 0);
  context.quadraticCurveTo(center, center, size, center);
  context.quadraticCurveTo(center, center, center, size);
  context.quadraticCurveTo(center, center, 0, center);
  context.quadraticCurveTo(center, center, center, 0);
  context.fill();
};

/**
 * 灵动的动漫眼睛（仓鼠、柴犬、金鱼，风格和猫一致）：
 * 带颜色渐变的虹膜 + 圆瞳孔（兴奋时放大）+ 一大一小两个高光 + 一个会闪的小星星。
 * 看向别处时只移动虹膜和瞳孔，高光固定不动，眼睛就显得亮晶晶、水汪汪的。
 * side：-1 左眼 / 1 右眼（高光都在同一侧，看起来更有神）
 */
export function createAnimeEye(builder: ModelBuilder, radius: number, side: number, palette: EyePalette): PetEye {
  const group = new THREE.Group();
  const openParts = new THREE.Group();
  // 虹膜和瞳孔（一起移动）
  const pupil = new THREE.Group();
  pupil.add(builder.sticker(builder.decal(createCanvasTexture(drawPetIris(palette))), radius, radius * 1.12, 0, 0, 0));
  const pupilDisc = builder.sticker(builder.decal(createCanvasTexture((context, size) => {
    context.fillStyle = palette.pupil;
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    context.fill();
  }, 64)), radius * palette.pupilSize, radius * palette.pupilSize * 1.08, 0, radius * .04, .001);
  pupil.add(pupilDisc);
  openParts.add(pupil);
  // 高光（固定不动）
  const bigShine = builder.sticker(builder.solid(0xffffff), radius * .4, radius * .4, side * -radius * .28 + radius * .06, radius * .34, .003);
  const smallShine = builder.sticker(builder.solid(0xffffff), radius * .18, radius * .18, side * radius * .32 - radius * .04, -radius * .36, .003);
  const twinkle = builder.sticker(builder.decal(createCanvasTexture(drawSparkle, 64)), radius * .3, radius * .3, side * radius * .22, radius * .02, .004);
  openParts.add(bigShine, smallShine, twinkle);
  const happyArc = builder.sticker(builder.decal(createCanvasTexture(drawArc(true))), radius * 1.5, radius * 1.5, 0, 0, .002);
  const closedArc = builder.sticker(builder.decal(createCanvasTexture(drawArc(false))), radius * 1.5, radius * 1.5, 0, -radius * .2, .002);
  group.add(openParts, happyArc, closedArc);
  return { group, openParts, pupil, pupilDisc, sparkles: [bigShine, twinkle], happyArc, closedArc };
}

/** 三种动物的眼睛配色 */
export const EYE_PALETTES = {
  /** 仓鼠："五彩斑斓的黑"——大部分是油亮的黑，下半圈透出淡淡的紫、蓝、青、粉色光（像黑欧泊石） */
  hamster: {
    rim: '#030205', top: '#08060c', middle: '#120d1c', bottom: '#1e1730', pupil: '#020103', reflection: 'rgba(200, 190, 255, .4)',
    lidShade: .1, rimWidth: .05, pupilSize: .5,
    iridescence: ['rgba(150, 90, 255, .55)', 'rgba(70, 150, 255, .5)', 'rgba(60, 220, 200, .45)', 'rgba(255, 110, 190, .45)'],
  },
  /** 柴犬：深巧克力色，底部一道蜂蜜色的暖光（和橘色的毛分得开） */
  shiba: { rim: '#0d0604', top: '#1e0e08', middle: '#3c1d0f', bottom: '#74401f', pupil: '#070302', reflection: 'rgba(255, 205, 130, .42)', lidShade: .12, rimWidth: .05, pupilSize: .5 },
  /** 金鱼：深海蓝，底部泛着青色的水光 */
  goldfish: { rim: '#050913', top: '#0d1a33', middle: '#1f4a86', bottom: '#4fb3d9', pupil: '#03050b', reflection: 'rgba(170, 240, 255, .5)', lidShade: .4, rimWidth: .07, pupilSize: .46 },
} satisfies Record<string, EyePalette>;

/** 眨眼：每隔 2.5～6 秒眨一次 */
export class Blinker {
  private timer = randomBetween(1, 3);
  private amount = 0;

  /** 返回当前睁眼的比例（眨眼时短暂变小） */
  update(deltaSeconds: number): number {
    this.timer -= deltaSeconds;
    if (this.timer <= 0) { this.amount = 1; this.timer = randomBetween(2.5, 6); }
    this.amount = Math.max(0, this.amount - deltaSeconds * 7);
    return this.amount > .5 ? (1 - this.amount) * 2 : 1 - this.amount * .2;
  }
}

/**
 * 按姿势更新眼睛：睁眼程度、开心眯眼、闭眼、看向目标、瞳孔放大缩小、高光轻轻闪
 */
export function updateEyes(
  eyes: PetEye[],
  pose: { eyeOpen: number; squint: number; pupilX: number; pupilY: number; pupilWidth: number },
  blinkScale: number,
  pupilTravel: number,
  elapsedSeconds = 0,
): void {
  const openness = pose.eyeOpen * blinkScale;
  const isHappyEyes = pose.squint > .55;
  const isClosedEyes = !isHappyEyes && openness < .14;
  // 瞳孔：平时 1，兴奋 / 吃惊（pupilWidth 变大）时放大，生气时缩小
  const pupilScale = clamp(.75 + pose.pupilWidth * .25, .7, 1.35);
  for (const [index, eye] of eyes.entries()) {
    eye.openParts.visible = !isHappyEyes && !isClosedEyes;
    eye.happyArc.visible = isHappyEyes;
    eye.closedArc.visible = isClosedEyes;
    eye.openParts.scale.y = clamp(openness * (1 - pose.squint * .45), .15, 1.3);
    eye.pupil.position.x = clamp(pose.pupilX, -1, 1) * pupilTravel;
    eye.pupil.position.y = clamp(pose.pupilY, -1, 1) * pupilTravel * .8;
    if (eye.pupilDisc) {
      // 第一次记下瞳孔原来的大小，以后都按原来的大小乘系数
      const baseScale: THREE.Vector3 = eye.pupilDisc.userData.baseScale ??= eye.pupilDisc.scale.clone();
      eye.pupilDisc.scale.set(baseScale.x * pupilScale, baseScale.y * pupilScale, 1);
    }
    // 高光轻轻地一闪一闪（两只眼睛错开一点，更自然）
    eye.sparkles?.forEach((sparkle, sparkleIndex) => {
      const twinkle = 1 + Math.sin(elapsedSeconds * (sparkleIndex ? 3.4 : 1.7) + index * 1.3) * (sparkleIndex ? .25 : .05);
      sparkle.scale.setScalar(sparkle.userData.baseScale ??= sparkle.scale.x);
      sparkle.scale.multiplyScalar(twinkle);
    });
  }
}

// ---------------- 小牌子（提醒时举着） ----------------

export class SignProp {
  readonly group = new THREE.Group();
  private readonly texture: THREE.CanvasTexture;
  private text = '';

  constructor(width = .66, height = .41) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 160;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false }));
    board.rotation.x = -.15;
    this.group.add(board);
    this.group.visible = false;
    this.setText('喝水！');
  }

  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    const canvas = this.texture.image as HTMLCanvasElement;
    drawSign(canvas.getContext('2d')!, canvas.width, canvas.height, text);
    this.texture.needsUpdate = true;
  }

  /** 举起来时从小变大"弹"出来，轻轻晃 */
  update(holdAmount: number, elapsedSeconds: number): void {
    this.group.visible = holdAmount > .05;
    this.group.scale.setScalar(Math.max(.001, holdAmount));
    this.group.rotation.z = Math.sin(elapsedSeconds * 3) * .06;
  }
}

// ---------------- 装扮（喝水达标解锁） ----------------

/**
 * 四种装扮的造型（所有动物共用，各模型自己决定戴在哪儿）：
 *   flower 小花发卡 / bow 粉色蝴蝶结 / crown 小皇冠：在自己的坐标里朝前（+z）
 *   scarf 暖暖小围巾：一个水平的圈（围着 y 轴），半径 scarfRadius，围巾尾巴垂在正前方
 */
export function createAccessoryMeshes(builder: ModelBuilder, scarfRadius: number): Record<'flower' | 'bow' | 'crown' | 'scarf', THREE.Group> {
  // 小花：五片花瓣 + 黄色花心
  const flower = new THREE.Group();
  const petalMaterial = builder.toon(0xffd1e0, .15);
  for (let index = 0; index < 5; index++) {
    const angle = index / 5 * Math.PI * 2;
    flower.add(builder.ellipsoid(petalMaterial, .045, .045, .02, Math.cos(angle) * .05, Math.sin(angle) * .05, 0));
  }
  flower.add(builder.ellipsoid(builder.toon(0xffd23f, .2), .028, .028, .022, 0, 0, .012));
  // 蝴蝶结：两个圆鼓鼓的翅膀 + 中间的结
  const bow = new THREE.Group();
  const bowMaterial = builder.toon(0xff6fa0, .2);
  for (const side of [-1, 1]) {
    const wing = builder.ellipsoid(bowMaterial, .07, .048, .03, side * .065, 0, 0);
    wing.rotation.z = side * -.35;
    bow.add(wing);
  }
  bow.add(builder.ellipsoid(bowMaterial, .03, .032, .032));
  // 皇冠：金色圆环 + 五个尖尖 + 红宝石
  const crown = new THREE.Group();
  const goldMaterial = builder.toon(0xf5c542, .45);
  const crownBand = builder.withOutline(new THREE.Mesh(new THREE.CylinderGeometry(.12, .11, .07, 24, 1, true), goldMaterial));
  crownBand.material.side = THREE.DoubleSide;
  crown.add(crownBand);
  for (let index = 0; index < 5; index++) {
    const angle = index / 5 * Math.PI * 2;
    const spike = builder.withOutline(new THREE.Mesh(new THREE.ConeGeometry(.026, .07, 10), goldMaterial));
    spike.position.set(Math.sin(angle) * .115, .065, Math.cos(angle) * .115);
    crown.add(spike);
  }
  crown.add(builder.ellipsoid(builder.toon(0xe8424f, .4), .025, .025, .012, 0, 0, .118));
  // 围巾：一个圈 + 前面垂下来的一截（带一道白条纹）
  const scarf = new THREE.Group();
  const scarfMaterial = builder.toon(0x5fa8e8, .2);
  const ring = builder.withOutline(new THREE.Mesh(new THREE.TorusGeometry(scarfRadius, .06, 12, 56), scarfMaterial));
  ring.rotation.x = Math.PI / 2;
  const tail = builder.ellipsoid(scarfMaterial, .065, .12, .028, scarfRadius * .4, -.13, scarfRadius * .92);
  tail.rotation.set(.1, 0, .25);
  const stripe = builder.ellipsoid(builder.toon(0xffffff, .1), .067, .018, .03, scarfRadius * .4, -.19, scarfRadius * .93, false);
  stripe.rotation.set(.1, 0, .25);
  scarf.add(ring, tail, stripe);
  for (const group of [flower, bow, crown, scarf]) group.visible = false;
  return { flower, bow, crown, scarf };
}

/** 只显示穿着的那一件装扮（none 或不认识的 id 就都不显示） */
export function showAccessory(accessories: Record<string, THREE.Group>, id: string): void {
  for (const [accessoryId, group] of Object.entries(accessories)) group.visible = accessoryId === id;
}

// ---------------- 小水杯（推杯子提醒、捣乱时用） ----------------

/** 浅蓝色的小马克杯：被推着往旁边滑，滑到边上就掉下去 */
export class CupProp {
  readonly group = new THREE.Group();

  /** basePosition：杯子放在宠物身边的位置；scale：杯子大小（小动物用小一点的杯子） */
  constructor(builder: ModelBuilder, private readonly basePosition: THREE.Vector3, scale = 1) {
    const cupMaterial = builder.toon(0x7cc4f5, .2);
    const cupBody = builder.withOutline(new THREE.Mesh(new THREE.CylinderGeometry(.085, .075, .17, 24), cupMaterial));
    cupBody.position.y = .085;
    const cupHandle = builder.withOutline(new THREE.Mesh(new THREE.TorusGeometry(.045, .014, 8, 16, Math.PI), cupMaterial));
    cupHandle.position.set(.085, .09, 0);
    cupHandle.rotation.z = -Math.PI / 2;
    const water = builder.sticker(builder.solid(0x3a8fd8), .075, .075, 0, .171, 0);
    water.rotation.x = -Math.PI / 2;
    this.group.add(cupBody, cupHandle, water);
    this.group.scale.setScalar(scale);
    this.group.visible = false;
  }

  /** visible：是否显示；push：被推的进度 0~1（前 60% 往旁边滑，后 40% 掉下去） */
  update(visible: number, push: number): void {
    this.group.visible = visible > .5;
    const slide = Math.min(push, .6) / .6;
    const fall = Math.max(0, push - .6) / .4;
    this.group.position.set(this.basePosition.x + slide * .35, this.basePosition.y - fall * fall * 1.6, this.basePosition.z);
    this.group.rotation.z = -fall * 1.8;
  }
}

/** 姿势参数平滑追向目标（眼睛、嘴巴这类要快一点） */
export function dampPose<Pose extends Record<string, number>>(current: Pose, target: Pose, deltaSeconds: number, nonDampedKeys: Set<string>, fastKeys: Set<string>): void {
  for (const key of Object.keys(target) as (keyof Pose & string)[]) {
    if (nonDampedKeys.has(key)) { current[key] = target[key]; continue; }
    const rate = fastKeys.has(key) ? 14 : 7;
    (current as Record<string, number>)[key] = current[key] + (target[key] - current[key]) * (1 - Math.exp(-rate * deltaSeconds));
  }
}
