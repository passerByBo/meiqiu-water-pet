// 3D 金鱼"墨墨"（参考 demo/金鱼.jpeg，熊猫狮头金鱼）：黑色带鳞片的身子、白色的头、头顶鼓鼓的"肉瘤"、
// 红红的小嘴、圆溜溜的大眼睛和腮红、像纱裙一样飘逸的四叶大尾巴。
// 没有腿，悬浮在空中游：平时轻轻上下浮动、尾巴慢慢飘；移动时摆尾巴、身子左右扭；睡觉时沉低一点、鳍慢下来。
// 特有动作 special：张嘴吐泡泡
import * as THREE from 'three';
import type { PetSkin } from '../skins';
import type { PetModel, PetPose } from './PetModel';
import { createDefaultPose } from '../BlackCatModel';
import { Blinker, createAccessoryMeshes, createAnimeEye, CupProp, EYE_PALETTES, showAccessory, createCanvasTexture, dampPose, drawBlush, ModelBuilder, SignProp, updateEyes, type PetEye } from './modelToolkit';

/** 默认外观（熊猫狮头）的颜色；皮肤只替换其中一部分（见 skins.ts） */
export const DEFAULT_COLORS = {
  outline: 0x07070b,    // 描边
  rim: 0xa9cbff,        // 边缘高光
  scaleOutline: 0x040407, // 鳞片的描边和高光
  scaleRim: 0xbcd2ff,
  gillRed: 0xd23a4c,    // 鳃缝里的红色
  finRoot: 0x101018,    // 鳍：根部 → 中间 → 末梢（越往外越透明），鳍条
  finMiddle: 0x1a1826,
  finTip: 0x463e60,
  finRay: 0x8c82af,
  body: 0x1b1b25,       // 黑色身子
  scale: 0x20202c,      // 鳞片：只比身子亮一丁点，靠边缘一点点冷色高光看出一片一片
  head: 0xfff4ea,       // 白色的头、头后面的白圈
  wen: 0xffe5d2,        // 头顶的肉瘤：比头稍微暖一点的白（带一点点桃色），看得出是鼓起来的一块块
  mouth: 0xe8323c,      // 红嘴巴
};
/** 悬浮高度（身体中心离"地面"多高） */
const HOVER_HEIGHT = .62;
const BUBBLE_COUNT = 4;
const NON_DAMPED = new Set(['rollAngle', 'cupPush']);
const FAST = new Set(['squint', 'mouthOpen', 'eyeOpen', 'pupilWidth', 'airborne', 'special']);

/** 0xRRGGBB → 'rgba(r, g, b, alpha)' */
const toRgba = (color: number, alpha: number) => `rgba(${color >> 16 & 255}, ${color >> 8 & 255}, ${color & 255}, ${alpha})`;

/** 鳍的贴图：根部深、末梢渐渐变透明，带一条条从根部放射出去的鳍条（颜色跟着皮肤） */
const drawFin = (colors: typeof DEFAULT_COLORS) => (context: CanvasRenderingContext2D, size: number) => {
  const gradient = context.createLinearGradient(0, 0, size, 0);
  gradient.addColorStop(0, toRgba(colors.finRoot, 1));
  gradient.addColorStop(.6, toRgba(colors.finMiddle, .93));
  gradient.addColorStop(1, toRgba(colors.finTip, .45));
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  context.strokeStyle = toRgba(colors.finRay, .28);
  context.lineWidth = size * .01;
  for (let index = 0; index <= 14; index++) {
    const endY = index / 14 * size;
    context.beginPath();
    context.moveTo(0, size / 2 + (endY - size / 2) * .25);
    context.quadraticCurveTo(size * .5, size / 2 + (endY - size / 2) * .7, size, endY);
    context.stroke();
  }
};

/**
 * 一片柔软的"纱"鳍：一整块网格，根部窄、末梢宽、末端是圆弧形。
 * 每帧让一道波浪从根部传到末梢（像旗子在风里飘），边缘还会轻轻抖，所以看起来是软的、连续的。
 * 网格在自己的 XY 平面上：根部在原点，沿 +x 方向展开
 */
class VeilFin {
  readonly mesh: THREE.Mesh;
  private readonly restPositions: Float32Array;
  private readonly lengthSegments = 14;
  private readonly widthSegments = 10;

  constructor(length: number, rootWidth: number, tipWidth: number, material: THREE.Material) {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let row = 0; row <= this.lengthSegments; row++) {
      const along = row / this.lengthSegments;
      // 宽度：从根部慢慢张开，越往后越宽
      const halfWidth = (rootWidth + (tipWidth - rootWidth) * Math.sin(along * Math.PI / 2)) / 2;
      for (let column = 0; column <= this.widthSegments; column++) {
        const across = column / this.widthSegments * 2 - 1;
        // 末端是圆弧：中间最长，两边短一点
        const x = along * length * (1 - .16 * across * across * along);
        positions.push(x, across * halfWidth, 0);
        uvs.push(along, (across + 1) / 2);
      }
    }
    for (let row = 0; row < this.lengthSegments; row++) {
      for (let column = 0; column < this.widthSegments; column++) {
        const corner = row * (this.widthSegments + 1) + column;
        const next = corner + this.widthSegments + 1;
        indices.push(corner, next, corner + 1, corner + 1, next, next + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    this.restPositions = new Float32Array(positions);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.raycast = () => {};
  }

  /**
   * wavePhase：摆动的相位（游得越快走得越快）；amplitude：波浪幅度；flutter：边缘抖动的强度
   */
  update(wavePhase: number, amplitude: number, elapsedSeconds: number, flutter = 1): void {
    const positions = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let row = 0; row <= this.lengthSegments; row++) {
      const along = row / this.lengthSegments;
      for (let column = 0; column <= this.widthSegments; column++) {
        const across = column / this.widthSegments * 2 - 1;
        const index = row * (this.widthSegments + 1) + column;
        // 一道波浪从根部传到末梢，越往后摆得越大；再加上边缘的细碎抖动
        const wave = amplitude * Math.pow(along, 1.5) * Math.sin(wavePhase - along * 2.6 + across * .4);
        const ripple = .03 * flutter * along * along * Math.sin(elapsedSeconds * 5.5 + across * 5 + along * 4);
        positions.setZ(index, this.restPositions[index * 3 + 2] + wave + ripple);
      }
    }
    positions.needsUpdate = true;
  }
}

/** 一片尾鳍：外面套一层组用来定方向（左右张开、上翘下垂、整体摆动），里面的纱鳍自己飘 */
interface TailLobe {
  holder: THREE.Group;
  fin: VeilFin;
  /** -1 左 / 1 右 */
  side: number;
  /** 1 上面那一对 / -1 下面那一对 */
  level: number;
}

export class GoldfishModel implements PetModel {
  readonly root = new THREE.Group();
  private readonly currentPose: PetPose = createDefaultPose();
  private readonly blinker = new Blinker();
  /** 悬浮的高度和上下浮动 */
  private readonly swim = new THREE.Group();
  /** 鱼身（转向、扭动、翻滚都作用在它上面） */
  private readonly fish = new THREE.Group();
  private readonly bodyMesh: THREE.Mesh;
  private readonly eyes: PetEye[] = [];
  private readonly mouth = new THREE.Group();
  /** 鳃盖（左右各一片）：呼吸时后边缘往外掀开，露出下面红色的鳃 */
  private readonly gillCovers: THREE.Group[] = [];
  private readonly tailLobes: TailLobe[] = [];
  private readonly dorsalHolder = new THREE.Group();
  private readonly dorsalFin: VeilFin;
  private readonly sideFins: { holder: THREE.Group; fin: VeilFin; side: number; isPectoral: boolean }[] = [];
  /** 泡泡：age < 0 表示没在用；start 是吐出来时嘴巴的位置 */
  private readonly bubbles: { mesh: THREE.Mesh; age: number; start: THREE.Vector3 }[] = [];
  private bubbleTimer = 0;
  private gulpTimer = 2;
  private gulpAmount = 0;
  private swimPhase = 0;
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly sign = new SignProp(.6, .37);
  private readonly cup: CupProp;
  private readonly accessories: Record<string, THREE.Group>;

  /** 这套皮肤的颜色（默认颜色 + 皮肤替换的部分） */
  private readonly colors: typeof DEFAULT_COLORS;

  constructor(skin?: PetSkin) {
    const COLORS = { ...DEFAULT_COLORS, ...skin?.colors };
    this.colors = COLORS;
    const builder = new ModelBuilder({ outlineColor: COLORS.outline, outlineThickness: .018, rimColor: COLORS.rim });
    const bodyMaterial = builder.toon(COLORS.body, .5);
    const headMaterial = builder.toon(COLORS.head, .12, 0xffffff);
    const wenMaterial = builder.toon(COLORS.wen, .12, 0xffffff);
    const finMaterial = new THREE.MeshBasicMaterial({ map: createCanvasTexture(drawFin(COLORS)), transparent: true, side: THREE.DoubleSide, toneMapped: false, depthWrite: false });

    this.shadow = builder.shadow(.9, 1.1);
    this.root.add(this.shadow, this.swim);
    this.swim.add(this.fish);

    // ---------- 身体：黑色的蛋形身子，前面一圈白色，接着白色的头（熊猫配色） ----------
    this.fish.scale.setScalar(1.12);
    this.bodyMesh = builder.ellipsoid(bodyMaterial, .34, .35, .44, 0, 0, -.1);
    this.fish.add(this.bodyMesh);
    // 头后面的白色：一层贴着身子的白"皮"，后边缘是一条不规则的波浪线——
    // 有的地方白色往后伸进黑色身子，有的地方黑色往前咬进白色，黑白互相交错（像真的熊猫金鱼那样）
    this.fish.add(this.createWhiteCollar(headMaterial));
    this.addScales();
    const headCenter = new THREE.Vector3(0, .02, .25);
    const headRadii = new THREE.Vector3(.3, .29, .28);
    this.fish.add(builder.ellipsoid(headMaterial, headRadii.x, headRadii.y, headRadii.z, headCenter.x, headCenter.y, headCenter.z));

    // 头顶和两腮的肉瘤：几颗圆润的大鼓包贴在头的表面上（颜色比头暖一点点，不加描边；避开眼睛和嘴巴）
    const bumpDirections: [number, number, number][] = [   // [左右角度, 仰角, 大小]
      [0, 80, .17], [-55, 62, .16], [55, 62, .16], [-128, 58, .15], [128, 58, .15], [0, 50, .13], [180, 70, .14],
      [-95, 25, .14], [95, 25, .14], [-75, 52, .12], [75, 52, .12],   // 两腮靠后下方留给鱼鳃
    ];
    for (const [azimuthDegrees, elevationDegrees, radius] of bumpDirections) {
      const azimuth = THREE.MathUtils.degToRad(azimuthDegrees);
      const elevation = THREE.MathUtils.degToRad(elevationDegrees);
      const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
      const position = direction.multiply(headRadii).multiplyScalar(.86).add(headCenter);
      this.fish.add(builder.ellipsoid(wenMaterial, radius, radius * .85, radius, position.x, position.y, position.z, false));
    }

    this.addGills();

    // 圆溜溜的大眼睛：朝前、带高光，正面看是一副乖巧的样子
    for (const side of [-1, 1]) {
      const eye = createAnimeEye(builder, .082, side, { ...EYE_PALETTES.goldfish, ...skin?.eyes });
      eye.group.position.set(side * .15, .06, .492);
      eye.group.rotation.set(-.05, side * .42, 0);
      this.fish.add(eye.group);
      this.eyes.push(eye);
    }
    // 粉粉的腮红
    const blushMaterial = builder.decal(createCanvasTexture(drawBlush, 64));
    blushMaterial.opacity = .55;
    for (const side of [-1, 1]) this.fish.add(builder.sticker(blushMaterial, .07, .04, side * .19, -.05, .462, side * .55));

    // 小小的红嘴巴：一圈红色的嘴唇，张嘴吐泡泡时变成 O 形
    const lips = new THREE.Mesh(new THREE.TorusGeometry(.026, .012, 10, 20), builder.toon(COLORS.mouth, .2, 0xffffff));
    this.mouth.add(lips);
    this.mouth.add(builder.sticker(builder.solid(0x5a0f17), .022, .022, 0, 0, -.004));
    this.mouth.position.set(0, -.1, .512);
    this.fish.add(this.mouth);

    // ---------- 鳍（都是会飘的纱） ----------
    // 四叶大尾巴（狮头金鱼的招牌）：上面一对往上翘、下面一对往下垂，左右张开
    for (const level of [1, -1]) {
      for (const side of [-1, 1]) {
        const holder = new THREE.Group();
        holder.position.set(side * .03, level * .06, -.46);
        const fin = new VeilFin(level > 0 ? .66 : .72, .2, .74, finMaterial);
        holder.add(fin.mesh);
        this.fish.add(holder);
        this.tailLobes.push({ holder, fin, side, level });
      }
    }
    // 背鳍：长在背上、往后倒，竖着的一片
    this.dorsalFin = new VeilFin(.3, .34, .28, finMaterial);
    this.dorsalFin.mesh.rotation.z = Math.PI / 2 + .55;   // 先竖起来，再往后倒
    this.dorsalHolder.add(this.dorsalFin.mesh);
    this.dorsalHolder.position.set(0, .3, -.02);
    this.dorsalHolder.rotation.y = -Math.PI / 2;
    this.fish.add(this.dorsalHolder);
    // 胸鳍（两侧小扇子，一直轻轻扇）和腹鳍（下面两片小的）
    for (const side of [-1, 1]) {
      for (const isPectoral of [true, false]) {
        const holder = new THREE.Group();
        holder.position.set(side * (isPectoral ? .26 : .1), isPectoral ? -.14 : -.28, isPectoral ? .12 : .02);
        const fin = isPectoral ? new VeilFin(.2, .07, .2, finMaterial) : new VeilFin(.19, .06, .15, finMaterial);
        holder.add(fin.mesh);
        this.fish.add(holder);
        this.sideFins.push({ holder, fin, side, isPectoral });
      }
    }

    // ---------- 泡泡 ----------
    const bubbleMaterial = new THREE.MeshBasicMaterial({ color: 0xdff3ff, transparent: true, opacity: .55, toneMapped: false, depthWrite: false });
    const bubbleShineMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .9, toneMapped: false, depthWrite: false });
    for (let index = 0; index < BUBBLE_COUNT; index++) {
      const bubble = new THREE.Mesh(builder.sphereGeometry, bubbleMaterial);
      const shine = new THREE.Mesh(builder.sphereGeometry, bubbleShineMaterial);
      shine.scale.setScalar(.25);
      shine.position.set(-.35, .35, .6);
      bubble.add(shine);
      bubble.visible = false;
      bubble.raycast = () => {};
      this.swim.add(bubble);
      this.bubbles.push({ mesh: bubble, age: -1, start: new THREE.Vector3() });
    }

    this.sign.group.position.set(0, .3, .66);
    this.root.add(this.sign.group);
    this.cup = new CupProp(builder, new THREE.Vector3(.42, 0, .5));
    this.root.add(this.cup.group);

    // 装扮：小花、蝴蝶结戴在头顶肉瘤的旁边；皇冠戴在最顶上；
    // 围巾围在头后面那一圈白色上（鱼的"脖子"），前低后高地斜着，正面看只在下巴底下露出一截
    this.accessories = createAccessoryMeshes(builder, .37);
    const { flower, bow, crown, scarf } = this.accessories;
    flower.position.set(.21, .3, .36);
    flower.rotation.set(-.3, .55, 0);
    bow.position.set(-.21, .31, .34);
    bow.rotation.set(-.3, -.55, .25);
    crown.position.set(0, .44, .18);
    crown.rotation.x = -.3;
    scarf.position.set(0, -.03, -.02);
    scarf.rotation.x = Math.PI / 2 - .55;   // 竖起来再往后倒：前面低（在下巴底下）、后面高（藏在肉瘤后面）
    this.fish.add(flower, bow, crown, scarf);
  }

  /**
   * 鱼鳃：头两侧靠后、偏下的位置各一片弧形的白色鳃盖（细描边勾出形状），下面藏着一道红色的鳃。
   * 鳃盖的前边缘是转轴，呼吸时后边缘往外掀开、露出红色的鳃，再合上
   */
  private addGills(): void {
    const gillBuilder = new ModelBuilder({ outlineColor: 0x3a3440, outlineThickness: .007, rimColor: 0xffffff });
    const gillMaterial = gillBuilder.toon(this.colors.head, .12, 0xffffff);
    const redGillMaterial = gillBuilder.toon(this.colors.gillRed, .2, 0xffffff);
    for (const side of [-1, 1]) {
      // 鳃在头和身子交接的那道折痕上（这里是最外面的一层，不会被头或身子盖住），偏下一点；朝外、稍微朝后
      const point = new THREE.Vector3(side * .287, -.02, .17);
      const normal = new THREE.Vector3(side, -.15, -.25).normalize();
      // 在表面上建一个局部坐标：x 朝鱼头前方、y 沿表面、z 朝外
      const forward = new THREE.Vector3(0, 0, 1).projectOnPlane(normal).normalize();
      const up = new THREE.Vector3().crossVectors(normal, forward).normalize();   // 保证是右手坐标系，两边都不会镜像
      const basis = new THREE.Matrix4().makeBasis(forward, up, normal);
      const gill = new THREE.Group();
      gill.position.copy(point);
      gill.quaternion.setFromRotationMatrix(basis);
      // 红色的鳃（不动，藏在鳃盖下面）
      gill.add(gillBuilder.ellipsoid(redGillMaterial, .07, .14, .012, -.065, 0, -.006, false));
      // 鳃盖：前边缘贴着转轴，往后伸出去一片弧形
      const cover = new THREE.Group();
      cover.add(gillBuilder.ellipsoid(gillMaterial, .09, .165, .02, -.072, 0, .004));
      gill.add(cover);
      this.fish.add(gill);
      this.gillCovers.push(cover);
    }
  }

  /**
   * 头后面那一圈白色：在身子椭球表面上铺一层网格（比身子大一丁点），从头部一直铺到一条不规则的分界线。
   * 分界线 = 几个不同频率的波浪叠在一起，绕身子一圈高低起伏，看起来是自然的、不规则的黑白交界
   */
  private createWhiteCollar(material: THREE.MeshToonMaterial): THREE.Mesh {
    const aroundSegments = 96, alongSegments = 12;
    const bodyCenter = new THREE.Vector3(0, 0, -.1);
    const bodyRadii = new THREE.Vector3(.34, .35, .44);
    const frontEdge = .42;                           // 往前一直铺到头里面（被头挡住）
    // 分界线的位置（身子坐标里的 z）：基础位置 + 三个不同频率的波浪
    const boundaryAt = (angle: number) => .12 + .055 * Math.sin(3 * angle + .6) + .035 * Math.sin(5 * angle + 1.9) + .02 * Math.sin(9 * angle + .3);
    const positions: number[] = [];
    const indices: number[] = [];
    for (let column = 0; column <= aroundSegments; column++) {
      const angle = column / aroundSegments * Math.PI * 2;
      const boundary = boundaryAt(angle);
      for (let row = 0; row <= alongSegments; row++) {
        const alongBody = boundary + (frontEdge - boundary) * row / alongSegments;
        // 比身子大 3.5%：身子"呼吸"时会胀大 2%，白皮要始终盖在外面
        const ring = Math.sqrt(Math.max(0, 1 - (alongBody / bodyRadii.z) ** 2)) * 1.035;
        positions.push(bodyCenter.x + bodyRadii.x * ring * Math.cos(angle), bodyCenter.y + bodyRadii.y * ring * Math.sin(angle), bodyCenter.z + alongBody);
      }
    }
    for (let column = 0; column < aroundSegments; column++) {
      for (let row = 0; row < alongSegments; row++) {
        const corner = column * (alongSegments + 1) + row;
        const next = corner + alongSegments + 1;
        indices.push(corner, corner + 1, next, corner + 1, next + 1, next);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const doubleSided = material.clone();
    doubleSided.side = THREE.DoubleSide;
    doubleSided.onBeforeCompile = material.onBeforeCompile;   // 保留轮廓光
    const collar = new THREE.Mesh(geometry, doubleSided);
    collar.raycast = () => {};
    return collar;
  }

  /**
   * 鳞片：像瓦片一样一片压一片——靠近头的一排压在后一排上面。
   * 每片是一个很薄、微微鼓起的圆片，排得比自己的直径还密（前后左右都互相重叠一半左右），
   * 并且后边缘往外翘一点，所以前一排的后边缘正好盖住后一排的前半片；只长在白圈后面的黑色身子两侧
   */
  private addScales(): void {
    const scaleBuilder = new ModelBuilder({ outlineColor: this.colors.scaleOutline, outlineThickness: .006, rimColor: this.colors.scaleRim });
    const scaleMaterial = scaleBuilder.toon(this.colors.scale, .45);
    const bodyCenter = new THREE.Vector3(0, 0, -.1);
    const bodyRadii = new THREE.Vector3(.34, .35, .44);
    const outward = new THREE.Vector3(0, 0, 1);
    const rowPositions = [-.07, -.15, -.23, -.31];      // 从头往尾巴，每排间隔比鳞片小（前后重叠）；第一排在黑白分界后面
    for (const side of [-1, 1]) {
      for (const [rowIndex, alongBody] of rowPositions.entries()) {
        const stagger = rowIndex % 2 === 0 ? 0 : 13;     // 一排一排错开半片
        for (const angleDegrees of [-39, -13, 13, 39].map(angle => angle + stagger)) {
          if (Math.abs(angleDegrees) > 46) continue;
          const angle = THREE.MathUtils.degToRad(angleDegrees);
          const ring = Math.sqrt(1 - (alongBody / bodyRadii.z) ** 2);
          const local = new THREE.Vector3(side * bodyRadii.x * ring * Math.cos(angle), bodyRadii.y * ring * Math.sin(angle), alongBody);
          const normal = new THREE.Vector3(local.x / bodyRadii.x ** 2, local.y / bodyRadii.y ** 2, local.z / bodyRadii.z ** 2).normalize();
          const scale = scaleBuilder.ellipsoid(scaleMaterial, .085, .078, .022);
          // 越靠近头的排越"高"（离身子表面远一点点），保证前一排压在后一排上面
          scale.position.copy(local).add(bodyCenter).addScaledVector(normal, .004 + (rowPositions.length - rowIndex) * .004);
          scale.quaternion.setFromUnitVectors(outward, normal);
          // 后边缘往外翘：绕着身子一圈的方向（切线）转一点
          const tangentAroundBody = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 0, 1)).normalize();
          scale.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(tangentAroundBody, side * -.22));
          this.fish.add(scale);
        }
      }
    }
  }

  update(targetPose: PetPose, _walkPhase: number, elapsedSeconds: number, deltaSeconds: number): void {
    const pose = this.currentPose;
    dampPose(pose, targetPose, deltaSeconds, NON_DAMPED, FAST);

    // ---- 游动节奏：移动时摆尾巴快、幅度大；休息时慢慢飘；被拎起来时拼命扑腾 ----
    const swimEffort = Math.min(pose.walkAmount, 1.6) + pose.lifted * 2 + pose.wiggle;
    const restfulness = pose.lie;
    const beatSpeed = 2.2 + swimEffort * 6 - restfulness * 1.1;
    this.swimPhase += beatSpeed * deltaSeconds;
    // 平时悬浮时尾巴也在优雅地飘（幅度不能太小，否则看起来是僵的）
    const beatAmplitude = .3 + swimEffort * .25 + pose.tailSwing * .15;

    // ---- 悬浮：上下浮动；睡觉时沉低一点；开心时一蹦一蹦 ----
    const bob = Math.sin(elapsedSeconds * 1.6) * .04 + Math.abs(Math.sin(elapsedSeconds * 7)) * .12 * pose.bounce;
    this.swim.position.y = HOVER_HEIGHT - restfulness * .17 - pose.crouch * .1 + bob;

    // ---- 鱼身：转头 = 整条鱼转过去；游的时候身子左右扭；可以打滚 ----
    const bodyWiggle = Math.sin(this.swimPhase) * .07 * (swimEffort + .3);
    this.fish.rotation.set(
      pose.headPitch * .4 + restfulness * .15 - pose.airborne * .3,
      pose.headYaw * .4 + bodyWiggle + Math.sin(elapsedSeconds * 22) * .1 * pose.wiggle,
      pose.rollAngle + pose.headRoll * .6 + Math.sin(elapsedSeconds * .9) * .04,
    );
    const breath = 1 + Math.sin(elapsedSeconds * pose.breathRate) * .02;
    this.bodyMesh.scale.set(.34 * breath, .35 * breath, .44);

    // ---- 四叶尾巴：整体跟着身子左右摆，纱面上一道道波浪往后传；尾巴抬高（开心）时张得更开 ----
    const spread = .5 + pose.tailLift * .1;
    for (const { holder, fin, side, level } of this.tailLobes) {
      holder.rotation.set(
        level * (.34 + pose.tailLift * .08) + Math.sin(elapsedSeconds * 1.3 + side) * .04,
        Math.PI / 2 - side * spread - Math.sin(this.swimPhase) * beatAmplitude * .45,
        0,
      );
      fin.update(this.swimPhase + side * .6 + level * .3, beatAmplitude * .55, elapsedSeconds, 1 + swimEffort * .5);
    }
    // ---- 背鳍：竖耳朵 = 背鳍竖起来，飞机耳 = 背鳍收起来 ----
    this.dorsalHolder.scale.set(1, Math.max(.35, 1 - pose.earBack * .6 + pose.earPerk * .1), 1);
    this.dorsalFin.update(this.swimPhase - .5, .08, elapsedSeconds, .6);
    // ---- 胸鳍一直扇；洗脸 / 招手时扇得很快；腹鳍轻轻飘 ----
    const flapSpeed = 5 + pose.groom * 12 + pose.knock * 14 + swimEffort * 3;
    for (const { holder, fin, side, isPectoral } of this.sideFins) {
      if (isPectoral) {
        holder.rotation.set(.3, side > 0 ? -.7 : Math.PI + .7, side * (.25 + Math.sin(elapsedSeconds * flapSpeed + side) * (.3 + pose.groom * .3)));
        fin.update(elapsedSeconds * flapSpeed, .05, elapsedSeconds, .5);
      } else {
        holder.rotation.set(0, side > 0 ? -1.3 : Math.PI + 1.3, -1 * side);
        fin.update(this.swimPhase + side, .05, elapsedSeconds, .5);
      }
    }

    // ---- 嘴巴：时不时一张一合；张嘴、吐泡泡时张成 O 形 ----
    this.gulpTimer -= deltaSeconds;
    if (this.gulpTimer <= 0) { this.gulpAmount = 1; this.gulpTimer = 1.5 + Math.random() * 3; }
    this.gulpAmount = Math.max(0, this.gulpAmount - deltaSeconds * 4);
    const mouthOpen = Math.max(pose.mouthOpen, pose.special * (.6 + Math.sin(elapsedSeconds * 9) * .4), Math.sin(this.gulpAmount * Math.PI) * .5);
    this.mouth.scale.set(1 + mouthOpen * .3, .65 + mouthOpen * .7, 1);

    // ---- 鱼鳃：一张一合地呼吸（游得越快呼吸越快），张开时露出红色的鳃 ----
    const gillOpen = (Math.sin(this.swimPhase * .55 + elapsedSeconds * 2.2) + 1) / 2 * (.7 + swimEffort * .2) + pose.special * .2;
    for (const cover of this.gillCovers) cover.rotation.y = Math.min(1, gillOpen) * .65;

    // ---- 吐泡泡：特有动作时一串一串地吐，平时偶尔吐一个 ----
    this.bubbleTimer -= deltaSeconds;
    const bubbleInterval = pose.special > .3 ? .35 : 6;
    if (this.bubbleTimer <= 0) {
      this.bubbleTimer = bubbleInterval * (.7 + Math.random() * .6);
      const free = this.bubbles.find(bubble => bubble.age < 0);
      if (free) {
        // 记下吐出来那一刻嘴巴的位置，泡泡从这里往上飘
        free.age = 0;
        this.fish.updateMatrixWorld(true);
        const mouthPosition = new THREE.Vector3();
        this.mouth.getWorldPosition(mouthPosition);
        free.start.copy(this.swim.worldToLocal(mouthPosition));
      }
    }
    const bubbleLifetime = 1.8;
    for (const bubble of this.bubbles) {
      if (bubble.age < 0) { bubble.mesh.visible = false; continue; }
      bubble.age += deltaSeconds;
      if (bubble.age > bubbleLifetime) { bubble.age = -1; bubble.mesh.visible = false; continue; }
      const progress = bubble.age / bubbleLifetime;
      bubble.mesh.visible = true;
      bubble.mesh.position.set(bubble.start.x + Math.sin(bubble.age * 6) * .03, bubble.start.y + .05 + progress * .7, bubble.start.z + .05);
      bubble.mesh.scale.setScalar(.025 + progress * .03);
    }

    updateEyes(this.eyes, pose, this.blinker.update(deltaSeconds), .015, elapsedSeconds);

    this.sign.update(pose.holdSign, elapsedSeconds);
    this.cup.update(pose.cupVisible, pose.cupPush);
    // 影子：鱼离地越高影子越淡
    this.shadow.material.opacity = (.45 - (this.swim.position.y - .3) * .3) * (1 - pose.lifted);
  }

  setSignText(text: string): void {
    this.sign.setText(text);
  }

  /** 穿上装扮（none 或 flower / bow / scarf / crown） */
  setAccessory(id: string): void {
    showAccessory(this.accessories, id);
  }
}
