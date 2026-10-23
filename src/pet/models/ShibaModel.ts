// 3D 柴犬"小柴"（参考 demo/柴犬.jpeg）：赤褐色的背、"里白"（嘴巴、脸颊、胸口、肚子、四肢内侧是奶白色）、
// 奶白色的"豆豆眉"、立起来的三角耳、黑鼻头、咧嘴微笑、白袜子、卷在背上的卷尾巴、蓝色项圈。
// 骨架和猫一样（四条腿 + 脖子 + 头），腿更长一点，嘴巴往前突出。
// 特有动作：special 作揖拜拜 / special2 赖地耍赖 / special3 螺旋桨尾巴扭屁股（开心地张嘴吐一点舌头）
import * as THREE from 'three';
import type { PetModel, PetPose } from './PetModel';
import { createDefaultPose, POSE_NAMES } from '../BlackCatModel';
import { Blinker, createAccessoryMeshes, createAnimeEye, CupProp, EYE_PALETTES, showAccessory, createCanvasTexture, dampPose, drawBlush, ModelBuilder, SignProp, updateEyes, type PetEye } from './modelToolkit';

const COLORS = {
  fur: 0xd8742c,        // 赤褐色（参考图里偏红的橘棕色）
  cream: 0xfff4e6,      // 里白
  earInner: 0xf3cdb4,
  nose: 0x1d1714,
  collar: 0x2e6cc4,     // 蓝项圈
  bell: 0xe0353f,       // 红铃铛：和橘色的毛、白胸口、蓝项圈都分得开
  bellRing: 0xf5c542,   // 挂铃铛的金色小环
  tongue: 0xe8546b,     // 舌头
};

/** 关键姿势（和猫一样的关节，腿更长） */
const KEY_POSES = {
  stand:   { hipsHeight: .45, hipsPitch: 0,    hipsShift: 0,    frontUpper: 0,     frontKnee: 0,   backUpper: 0,    backKnee: 0,   neckPitch: -.05 },
  sit:     { hipsHeight: .19, hipsPitch: -.62, hipsShift: -.08, frontUpper: .52,   frontKnee: .02, backUpper: -.55, backKnee: 2.4, neckPitch: .5 },
  lie:     { hipsHeight: .22, hipsPitch: .04,  hipsShift: 0,    frontUpper: -1.45, frontKnee: .2,  backUpper: -1.25, backKnee: 2.5, neckPitch: .2 },
  stretch: { hipsHeight: .43, hipsPitch: .32,  hipsShift: -.05, frontUpper: -1.0,  frontKnee: 0,   backUpper: .15,  backKnee: 0,   neckPitch: -.3 },
  lifted:  { hipsHeight: .34, hipsPitch: -.9,  hipsShift: 0,    frontUpper: .9,    frontKnee: .15, backUpper: .9,   backKnee: .15, neckPitch: .65 },
};
/** 特有动作的全身姿势：按动作程度混进上面的关节角度 */
const SPECIAL_POSES = {
  /** 作揖：后腿蹲坐、上半身立起来，两只前爪弯着并拢在胸前 */
  beg:  { hipsHeight: .17, hipsPitch: -1.15, hipsShift: -.1, frontUpper: -.35, frontKnee: 1.7, backUpper: -.75, backKnee: 2.5, neckPitch: .95 },
  /** 赖地：整只趴平，前腿往前伸直、后腿往后蹬直（像青蛙一样摊开），下巴贴地 */
  flop: { hipsHeight: .18, hipsPitch: .02,  hipsShift: 0,   frontUpper: -1.5, frontKnee: .1,  backUpper: 1.45, backKnee: .05, neckPitch: .3 },
};
type JointName = keyof typeof KEY_POSES.stand;
const JOINT_NAMES = Object.keys(KEY_POSES.stand) as JointName[];
const NON_DAMPED = new Set(['rollAngle', 'cupPush']);
const FAST = new Set(['squint', 'mouthOpen', 'eyeOpen', 'pupilWidth', 'airborne', 'special']);

/**
 * 柴犬的招牌笑（闭着嘴）：鼻子下面一条短竖线，再往两边咧开、嘴角上翘的 w 形嘴，
 * 线条要粗、弧度要明显，远看也能看清嘴巴的形状
 */
const drawShibaSmile = (context: CanvasRenderingContext2D, size: number) => {
  context.strokeStyle = '#2a1c16';
  context.lineWidth = size * .065;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(size * .5, size * .1);
  context.lineTo(size * .5, size * .3);
  context.moveTo(size * .12, size * .2);
  context.quadraticCurveTo(size * .3, size * .52, size * .5, size * .3);
  context.quadraticCurveTo(size * .7, size * .52, size * .88, size * .2);
  context.stroke();
};

interface Leg {
  upper: THREE.Group;
  knee: THREE.Group;
}

export class ShibaModel implements PetModel {
  readonly root = new THREE.Group();
  private readonly currentPose: PetPose = createDefaultPose();
  private readonly blinker = new Blinker();
  private readonly hips = new THREE.Group();
  private readonly torso: THREE.Mesh;
  private readonly chest = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly ears: { group: THREE.Group; side: number }[] = [];
  private readonly eyes: PetEye[] = [];
  /** 下巴（下颌）：绕后端转动，张嘴时往下张开；舌头长在它上面 */
  private readonly jaw = new THREE.Group();
  /** 伸出嘴外、垂在下巴前面的那半截舌头（吐舌头时才伸出来） */
  private readonly tongueTip = new THREE.Group();
  private readonly blushMaterial: THREE.MeshBasicMaterial;
  private readonly legs: Record<'frontLeft' | 'frontRight' | 'backLeft' | 'backRight', Leg>;
  private readonly tailBase = new THREE.Group();
  /** 项圈（连同铃铛）：每帧抵消身子的前后倾斜，保持水平地套在脖子上 */
  private readonly collarGroup = new THREE.Group();
  private readonly bell = new THREE.Group();
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly sign = new SignProp();
  private readonly cup: CupProp;
  private readonly accessories: Record<string, THREE.Group>;

  constructor() {
    const builder = new ModelBuilder({ outlineColor: 0x3a1f10, outlineThickness: .023, rimColor: 0xffe7c8 });
    const fur = builder.toon(COLORS.fur, .12);   // 轮廓光弱一点，毛色才不会被冲淡
    const cream = builder.toon(COLORS.cream, .08);

    this.shadow = builder.shadow(1.1, 1.7);
    this.shadow.position.z = .2;
    this.root.add(this.shadow, this.hips);

    // ---------- 身体：赤褐色的背 + 奶白色的肚子 ----------
    this.torso = builder.ellipsoid(fur, .31, .29, .44, 0, .1, .2);
    this.hips.add(this.torso);
    this.hips.add(builder.ellipsoid(fur, .31, .28, .27, 0, .08, .02));      // 屁股
    this.hips.add(builder.ellipsoid(cream, .25, .17, .34, 0, -.06, .22));    // 白肚子
    this.chest.position.set(0, .13, .5);
    this.hips.add(this.chest);
    this.chest.add(builder.ellipsoid(fur, .28, .3, .25));
    this.chest.add(builder.ellipsoid(cream, .19, .21, .13, 0, -.08, .15));   // 白胸口

    // 蓝项圈 + 红铃铛：套在"头和身子的接缝"上——前面在下巴底下（低）、后面在后脑勺下面（高），
    // 是一个前低后高的斜圈；细一点，刚好露出一圈；铃铛挂在下巴下面
    this.collarGroup.position.set(0, .15, .04);
    this.chest.add(this.collarGroup);
    const collar = builder.withOutline(new THREE.Mesh(new THREE.TorusGeometry(.232, .028, 10, 56), builder.toon(COLORS.collar, .15)));
    collar.rotation.x = Math.PI / 2;
    this.collarGroup.add(collar);
    // 红铃铛：金色小环挂着，圆圆的铃铛上有一道开口和一个小高光
    const bellLoop = builder.withOutline(new THREE.Mesh(new THREE.TorusGeometry(.016, .006, 6, 12), builder.toon(COLORS.bellRing, .4)));
    bellLoop.position.y = .055;
    const bellBall = builder.ellipsoid(builder.toon(COLORS.bell, .35, 0xffffff), .05, .05, .05);
    const bellSlit = builder.sticker(builder.solid(0x4a0d12), .026, .007, 0, -.018, .049);
    const bellShine = builder.sticker(builder.solid(0xffffff), .012, .012, -.018, .02, .047);
    this.bell.add(bellLoop, bellBall, bellSlit, bellShine);
    this.bell.position.set(0, -.085, .262);
    this.collarGroup.add(this.bell);

    // ---------- 头 ----------
    this.neck.position.set(0, .2, .08);
    this.chest.add(this.neck);
    this.head.position.set(0, .26, .1);
    this.head.scale.setScalar(1.12);
    this.neck.add(this.head);
    this.head.add(builder.ellipsoid(fur, .4, .35, .37));
    this.head.add(builder.ellipsoid(cream, .34, .19, .3, 0, -.13, .08));     // 白色的下半张脸
    for (const side of [-1, 1]) this.head.add(builder.ellipsoid(cream, .15, .12, .13, side * .24, -.1, .15)); // 毛茸茸的白脸颊
    // ---- 嘴巴：真的能张开的立体嘴 ----
    // 上嘴筒子（不动）+ 下巴（绕后端往下转）；中间是深色的口腔；舌头分两截都长在下巴上：
    // 里面一截平躺在下巴上（在嘴里），外面一截从下巴前端伸出嘴外、往下垂（吐舌头时才伸出来）
    const upperMuzzleCenter = new THREE.Vector3(0, -.085, .3);
    const upperMuzzleRadii = new THREE.Vector3(.17, .105, .16);
    this.head.add(builder.ellipsoid(cream, upperMuzzleRadii.x, upperMuzzleRadii.y, upperMuzzleRadii.z, upperMuzzleCenter.x, upperMuzzleCenter.y, upperMuzzleCenter.z));
    this.head.add(builder.ellipsoid(builder.solid(0x2b1714), .125, .045, .13, 0, -.155, .29, false));   // 口腔（深棕黑色）
    this.jaw.position.set(0, -.15, .2);                // 下巴的转轴在后面
    this.head.add(this.jaw);
    this.jaw.add(builder.ellipsoid(cream, .135, .05, .15, 0, -.015, .09));
    const tongueBuilder = new ModelBuilder({ outlineColor: 0x5a1a24, outlineThickness: .008, rimColor: 0xffffff });
    const tongueMaterial = tongueBuilder.toon(COLORS.tongue, .15, 0xffffff);
    const tongueGrooveMaterial = tongueBuilder.solid(0xb8344c);
    // 嘴里的那一截：平躺在下巴上
    this.jaw.add(tongueBuilder.ellipsoid(tongueMaterial, .06, .016, .11, 0, .03, .1));
    // 嘴外的那一截：从下巴前端伸出来，越过牙齿往下垂，舌尖稍微往前翘；中间一道浅沟
    this.tongueTip.position.set(0, .03, .2);
    const hangingTongue = tongueBuilder.ellipsoid(tongueMaterial, .055, .072, .016, 0, -.058, .03);
    hangingTongue.rotation.x = -.45;
    const groove = tongueBuilder.sticker(tongueGrooveMaterial, .005, .045, 0, -.055, .046);
    groove.rotation.x = -.45;
    this.tongueTip.add(hangingTongue, groove);
    this.jaw.add(this.tongueTip);
    this.head.add(builder.ellipsoid(builder.toon(COLORS.nose, .35, 0xffffff), .075, .052, .048, 0, -.015, .435)); // 黑鼻头（圆圆的，离嘴巴有一小段人中）
    this.head.add(builder.sticker(builder.solid(0xffffff), .022, .013, -.018, .012, .482));                  // 鼻头上的小白点高光
    // 上嘴唇：w 形的招牌笑线，贴合上嘴筒子的弧面（张嘴时就是上嘴唇的边）
    this.head.add(builder.curvedSticker(builder.decal(createCanvasTexture(drawShibaSmile)), upperMuzzleCenter, upperMuzzleRadii, 1.15, 1.4, .5));
    this.blushMaterial = builder.decal(createCanvasTexture(drawBlush, 64));
    this.blushMaterial.opacity = .35;
    for (const side of [-1, 1]) this.head.add(builder.sticker(this.blushMaterial, .065, .038, side * .25, -.06, .3, side * .6));
    // 琥珀色的大眼睛 + 奶白色豆豆眉
    for (const side of [-1, 1]) {
      const eye = createAnimeEye(builder, .084, side, EYE_PALETTES.shiba);
      eye.group.position.set(side * .15, .05, .342);
      eye.group.rotation.set(-.05, side * .42, 0);
      this.head.add(eye.group);
      this.eyes.push(eye);
      this.head.add(builder.sticker(builder.solid(COLORS.cream), .048, .03, side * .135, .16, .328, side * .38));
    }
    // 立起来的三角耳：外侧赤褐色，内侧浅粉
    const earShape = new THREE.Shape();
    earShape.moveTo(-.15, 0);
    earShape.quadraticCurveTo(-.11, .2, -.03, .29);
    earShape.quadraticCurveTo(0, .32, .03, .29);
    earShape.quadraticCurveTo(.11, .2, .15, 0);
    earShape.quadraticCurveTo(0, -.04, -.15, 0);
    const earGeometry = new THREE.ExtrudeGeometry(earShape, { depth: .05, bevelEnabled: true, bevelThickness: .025, bevelSize: .02, bevelSegments: 3, curveSegments: 12 });
    earGeometry.translate(0, 0, -.025);
    const innerEarGeometry = new THREE.ShapeGeometry(earShape, 12);
    for (const side of [-1, 1]) {
      const group = new THREE.Group();
      group.position.set(side * .21, .16, -.07);   // 耳根埋进头里，耳朵和头连成一体
      const outerEar = builder.withOutline(new THREE.Mesh(earGeometry, fur));
      outerEar.rotation.y = side * .25;
      const innerEar = new THREE.Mesh(innerEarGeometry, builder.toon(COLORS.earInner, .1));
      innerEar.scale.setScalar(.62);
      innerEar.position.set(0, .03, .055);
      innerEar.raycast = () => {};
      outerEar.add(innerEar);
      group.add(outerEar);
      this.head.add(group);
      this.ears.push({ group, side });
    }

    // ---------- 四条腿：上半截赤褐色，下半截是白袜子 ----------
    const upperLegGeometry = new THREE.CapsuleGeometry(.1, .15, 8, 20);
    const lowerLegGeometry = new THREE.CapsuleGeometry(.085, .09, 8, 20);
    const createLeg = (parent: THREE.Object3D, x: number, y: number, z: number): Leg => {
      const upper = new THREE.Group();
      upper.position.set(x, y, z);
      const upperMesh = builder.withOutline(new THREE.Mesh(upperLegGeometry, fur));
      upperMesh.position.y = -.09;
      upper.add(upperMesh);
      const knee = new THREE.Group();
      knee.position.y = -.2;
      upper.add(knee);
      const lowerMesh = builder.withOutline(new THREE.Mesh(lowerLegGeometry, cream));
      lowerMesh.position.y = -.07;
      knee.add(lowerMesh);
      knee.add(builder.ellipsoid(cream, .1, .06, .12, 0, -.16, .03));   // 白色小爪子
      parent.add(upper);
      return { upper, knee };
    };
    this.legs = {
      frontLeft: createLeg(this.chest, -.15, -.12, .02),
      frontRight: createLeg(this.chest, .15, -.12, .02),
      backLeft: createLeg(this.hips, -.18, 0, 0),
      backRight: createLeg(this.hips, .18, 0, 0),
    };

    // ---------- 卷尾巴：从屁股一根连续地往上、往前卷，尾巴尖搭在背上（稍微偏向一侧） ----------
    this.tailBase.position.set(0, .2, -.24);
    this.hips.add(this.tailBase);
    const tailCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, -.04, .04),
      new THREE.Vector3(0, .1, -.06),
      new THREE.Vector3(.01, .25, -.05),
      new THREE.Vector3(.03, .33, .06),
      new THREE.Vector3(.05, .3, .18),
      new THREE.Vector3(.07, .2, .22),
      new THREE.Vector3(.08, .13, .15),
    ]);
    this.tailBase.add(builder.withOutline(this.createTaperedTube(tailCurve, fur)));
    const tailTip = tailCurve.getPoint(1);
    this.tailBase.add(builder.ellipsoid(cream, .07, .07, .07, tailTip.x, tailTip.y, tailTip.z)); // 白色尾巴尖

    this.sign.group.position.set(0, .42, .72);
    this.root.add(this.sign.group);
    this.cup = new CupProp(builder, new THREE.Vector3(.46, 0, .6));
    this.root.add(this.cup.group);

    // 装扮：小花、蝴蝶结戴在耳根旁边；皇冠戴在两只耳朵中间；围巾围在项圈上（跟着项圈一起保持水平）
    this.accessories = createAccessoryMeshes(builder, .25);
    const { flower, bow, crown, scarf } = this.accessories;
    flower.position.set(.22, .2, .22);
    flower.rotation.set(-.2, .5, 0);
    bow.position.set(-.22, .22, .17);
    bow.rotation.set(-.15, -.5, .25);
    crown.position.set(0, .35, -.02);
    crown.rotation.x = -.12;
    this.head.add(flower, bow, crown);
    this.collarGroup.add(scarf);
  }

  /** 沿曲线生成一根粗细变化的管子：根部粗、中间蓬松、尾巴尖细一点（两端封口，看起来是一整根） */
  private createTaperedTube(curve: THREE.Curve<THREE.Vector3>, material: THREE.Material): THREE.Mesh {
    const tubularSegments = 40, radialSegments = 14;
    const geometry = new THREE.TubeGeometry(curve, tubularSegments, 1, radialSegments, false);
    const radiusAt = (progress: number) => .085 + .02 * Math.sin(progress * Math.PI) - .03 * progress;
    const positions = geometry.attributes.position;
    const ringCenter = new THREE.Vector3();
    const vertex = new THREE.Vector3();
    for (let ring = 0; ring <= tubularSegments; ring++) {
      const progress = ring / tubularSegments;
      curve.getPointAt(progress, ringCenter);
      for (let side = 0; side <= radialSegments; side++) {
        const index = ring * (radialSegments + 1) + side;
        vertex.fromBufferAttribute(positions, index).sub(ringCenter).multiplyScalar(radiusAt(progress)).add(ringCenter);
        positions.setXYZ(index, vertex.x, vertex.y, vertex.z);
      }
    }
    geometry.computeVertexNormals();
    const tube = new THREE.Mesh(geometry, material);
    // 根部封口：一个小球藏住管子的开口
    const start = curve.getPointAt(0);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(radiusAt(0), 16, 12), material);
    cap.position.copy(start);
    tube.add(cap);
    return tube;
  }

  update(targetPose: PetPose, walkPhase: number, elapsedSeconds: number, deltaSeconds: number): void {
    const pose = this.currentPose;
    dampPose(pose, targetPose, deltaSeconds, NON_DAMPED, FAST);

    // ---- 混合关键姿势 ----
    const totalWeight = POSE_NAMES.reduce((sum, name) => sum + pose[name], 0) || 1;
    const blended = {} as Record<JointName, number>;
    for (const joint of JOINT_NAMES) blended[joint] = POSE_NAMES.reduce((sum, name) => sum + KEY_POSES[name][joint] * pose[name], 0) / totalWeight;
    // 特有动作：作揖（special）、赖地（special2）、螺旋桨尾巴（special3）
    const begAmount = pose.special, flopAmount = pose.special2, propellerAmount = pose.special3;
    for (const joint of JOINT_NAMES) {
      blended[joint] += (SPECIAL_POSES.beg[joint] - blended[joint]) * begAmount;
      blended[joint] += (SPECIAL_POSES.flop[joint] - blended[joint]) * flopAmount;
    }
    // 作揖时一下一下地"拜"：前爪上下摆、上半身跟着点头
    const bow = Math.sin(elapsedSeconds * 6) * begAmount;
    blended.frontUpper += bow * .3;
    blended.hipsPitch += bow * .06;
    blended.neckPitch -= bow * .08;

    // ---- 走路：对角线两条腿同步（小跑） ----
    const walk = pose.walkAmount;
    const swing = Math.min(walk, 1.4) * .5;
    const legPhase = { frontLeft: walkPhase, backRight: walkPhase, frontRight: walkPhase + Math.PI, backLeft: walkPhase + Math.PI };
    const bobOffset = Math.cos(walkPhase * 2) * .02 * Math.min(walk, 1);

    // ---- 身体 ----
    const rollLift = (1 - Math.cos(pose.rollAngle)) * .32;
    this.hips.position.set(0, blended.hipsHeight - pose.crouch * .12 + bobOffset + rollLift, blended.hipsShift);
    this.hips.rotation.x = blended.hipsPitch + Math.sin(walkPhase * 2) * .02 * Math.min(walk, 1) - pose.airborne * .25;
    // 扭屁股（捣乱前、螺旋桨尾巴时）；赖地时身子左右蹭着地面耍赖
    this.hips.rotation.y = Math.sin(elapsedSeconds * 22) * .12 * pose.wiggle + Math.sin(elapsedSeconds * 16) * .14 * propellerAmount
      + Math.sin(elapsedSeconds * 2.6) * .05 * flopAmount;
    this.hips.rotation.z = pose.rollAngle + Math.sin(elapsedSeconds * 2.6) * .07 * flopAmount;
    // 开心地蹦（螺旋桨尾巴时原地小跳）
    this.root.position.y = Math.abs(Math.sin(elapsedSeconds * 7)) * .1 * pose.bounce + Math.abs(Math.sin(elapsedSeconds * 8)) * .06 * propellerAmount;
    const breath = 1 + Math.sin(elapsedSeconds * pose.breathRate) * .02;
    this.torso.scale.set(.31 * breath, .29 * breath, .44);

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
        upperAngle += (-1.4 + Math.sin(elapsedSeconds * 16) * .35) * pose.knock;
        kneeAngle += .5 * pose.knock;
      }
      if (isFront) {
        upperAngle += -2.0 * Math.max(pose.pawsOnLedge, pose.holdSign * .7);
        kneeAngle += 1.7 * Math.max(pose.pawsOnLedge, pose.holdSign * .7);
      }
      upperAngle += (isFront ? -.9 : .9) * pose.airborne;
      leg.upper.rotation.x = upperAngle;
      leg.knee.rotation.x = kneeAngle;
      // 作揖时两只前爪往中间并拢；赖地时四条腿稍微往外摊开
      const inward = legName === 'frontLeft' ? 1 : legName === 'frontRight' ? -1 : 0;
      const outward = legName.endsWith('Left') ? -1 : 1;
      leg.upper.rotation.z = inward * .3 * begAmount + outward * .25 * flopAmount;
    }

    // ---- 项圈：沿着头和身子的接缝，前低后高；低头 / 抬头时跟着脖子转一半；铃铛一直竖直地挂着，走路时轻轻晃 ----
    const collarTilt = .35 + this.neck.rotation.x * .5;
    this.collarGroup.rotation.x = collarTilt;
    // 坐着时头往前倾、会把项圈挡住：项圈跟着往下、往前挪一点，从正面看下巴底下也能看到项圈和铃铛
    this.collarGroup.position.set(0, .15 - this.neck.rotation.x * .13, .04 + this.neck.rotation.x * .06);
    this.bell.rotation.set(-collarTilt - this.hips.rotation.x, 0, Math.sin(walkPhase * 2) * .25 * Math.min(walk, 1) + pose.headRoll * .5);

    // ---- 头：柴犬很爱歪头 ----
    const groomNod = Math.sin(elapsedSeconds * 9) * .08 * pose.groom;
    this.neck.rotation.set(blended.neckPitch + pose.headPitch * .5 + .35 * pose.groom - pose.crouch * .12, pose.headYaw * .5 + .3 * pose.groom, 0);
    this.head.rotation.set(pose.headPitch * .5 + groomNod - bobOffset * 2 - flopAmount * .1, pose.headYaw * .5,
      pose.headRoll * 1.2 + Math.sin(elapsedSeconds * 8) * .12 * propellerAmount);

    // ---- 眼睛、耳朵（飞机耳）、嘴巴、舌头 ----
    updateEyes(this.eyes, pose, this.blinker.update(deltaSeconds), .018, elapsedSeconds);
    this.blushMaterial.opacity = .3 + .5 * Math.max(pose.squint, pose.bounce);
    for (const ear of this.ears) {
      ear.group.rotation.x = -pose.earBack * 1.1 + pose.earPerk * .12;
      ear.group.rotation.z = ear.side * -(.2 + pose.earBack * .5);
    }
    // ---- 张嘴、舌头 ----
    // 叫的时候张嘴；螺旋桨尾巴时开心地张着嘴喘气、吐出一点舌头；作揖时微微张嘴
    const openAmount = Math.min(1, Math.max(pose.mouthOpen, propellerAmount * .75, begAmount * .3));
    const panting = Math.sin(elapsedSeconds * 9) * .05 * propellerAmount;   // 喘气：下巴一张一合
    this.jaw.rotation.x = openAmount * .5 + panting;
    this.tongueTip.visible = propellerAmount > .03;
    this.tongueTip.scale.set(1, Math.max(.001, propellerAmount), Math.max(.001, propellerAmount));
    this.tongueTip.rotation.set(Math.sin(elapsedSeconds * 9 + .6) * .1 * propellerAmount, 0, Math.sin(elapsedSeconds * 4.5) * .08 * propellerAmount);

    // ---- 卷尾巴：开心时左右猛摇；螺旋桨尾巴时一圈一圈地转 ----
    const spin = elapsedSeconds * 16;
    this.tailBase.rotation.x = -(pose.tailLift - .6) * .25 + Math.cos(spin) * .45 * propellerAmount;
    this.tailBase.rotation.z = Math.sin(elapsedSeconds * pose.tailSpeed * 2.5) * pose.tailSwing * .55 * (1 - propellerAmount)
      + Math.sin(spin) * .7 * propellerAmount;

    this.sign.update(pose.holdSign, elapsedSeconds);
    this.cup.update(pose.cupVisible, pose.cupPush);
    this.shadow.material.opacity = (1 - pose.lifted) * (1 - pose.airborne * .6);
  }

  setSignText(text: string): void {
    this.sign.setText(text);
  }

  /** 穿上装扮（none 或 flower / bow / scarf / crown） */
  setAccessory(id: string): void {
    showAccessory(this.accessories, id);
  }
}
