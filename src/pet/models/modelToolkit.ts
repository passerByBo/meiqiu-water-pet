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
  /** 眼珠（看向鼠标时移动） */
  pupil: THREE.Object3D;
  /** 开心眯眼 ^ */
  happyArc: THREE.Mesh;
  /** 闭眼 ‿ */
  closedArc: THREE.Mesh;
}

/**
 * 黑豆豆眼（仓鼠、柴犬、金鱼）：黑色圆眼珠 + 一大一小两个高光，可选一圈眼圈颜色（金鱼的红眼圈）。
 * side：-1 左眼 / 1 右眼（高光都在同一侧，看起来更有神）
 */
export function createBeadEye(builder: ModelBuilder, radius: number, side: number, ringColor?: number): PetEye {
  const group = new THREE.Group();
  const openParts = new THREE.Group();
  if (ringColor !== undefined) openParts.add(builder.sticker(builder.solid(ringColor), radius * 1.22, radius * 1.22, 0, 0, -.001));
  const pupil = new THREE.Group();
  pupil.add(builder.sticker(builder.solid(0x0a0a0e), radius, radius, 0, 0, 0));
  pupil.add(builder.sticker(builder.solid(0xffffff), radius * .38, radius * .38, side * -radius * .3 + radius * .1, radius * .38, .002)); // 大高光
  pupil.add(builder.sticker(builder.solid(0xffffff), radius * .16, radius * .16, side * radius * .32 - radius * .05, -radius * .4, .002)); // 小高光
  openParts.add(pupil);
  const happyArc = builder.sticker(builder.decal(createCanvasTexture(drawArc(true))), radius * 1.5, radius * 1.5, 0, 0, .002);
  const closedArc = builder.sticker(builder.decal(createCanvasTexture(drawArc(false))), radius * 1.5, radius * 1.5, 0, -radius * .2, .002);
  group.add(openParts, happyArc, closedArc);
  return { group, openParts, pupil, happyArc, closedArc };
}

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

/** 按姿势更新眼睛：睁眼程度、开心眯眼、闭眼、看向目标 */
export function updateEyes(eyes: PetEye[], pose: { eyeOpen: number; squint: number; pupilX: number; pupilY: number }, blinkScale: number, pupilTravel: number): void {
  const openness = pose.eyeOpen * blinkScale;
  const isHappyEyes = pose.squint > .55;
  const isClosedEyes = !isHappyEyes && openness < .14;
  for (const eye of eyes) {
    eye.openParts.visible = !isHappyEyes && !isClosedEyes;
    eye.happyArc.visible = isHappyEyes;
    eye.closedArc.visible = isClosedEyes;
    eye.openParts.scale.y = clamp(openness * (1 - pose.squint * .45), .15, 1.3);
    eye.pupil.position.x = clamp(pose.pupilX, -1, 1) * pupilTravel;
    eye.pupil.position.y = clamp(pose.pupilY, -1, 1) * pupilTravel * .8;
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

/** 姿势参数平滑追向目标（眼睛、嘴巴这类要快一点） */
export function dampPose<Pose extends Record<string, number>>(current: Pose, target: Pose, deltaSeconds: number, nonDampedKeys: Set<string>, fastKeys: Set<string>): void {
  for (const key of Object.keys(target) as (keyof Pose & string)[]) {
    if (nonDampedKeys.has(key)) { current[key] = target[key]; continue; }
    const rate = fastKeys.has(key) ? 14 : 7;
    (current as Record<string, number>)[key] = current[key] + (target[key] - current[key]) * (1 - Math.exp(-rate * deltaSeconds));
  }
}
