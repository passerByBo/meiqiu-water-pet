// 3D 仓鼠"团子"（参考 demo/仓鼠.png）：奶黄色的背、白肚皮白脸颊、圆滚滚的饭团身材、
// 小圆耳朵（内侧粉色）、咖啡红色亮晶晶的大眼睛、粉鼻子、两颗小门牙、粉色小爪子抱在胸前、几乎看不到的小尾巴。
// 没有脖子，头和身子连在一起；平时直立坐着（像参考图），走路时趴下四条腿小碎步。
// 特有动作 special：把腮帮子塞得鼓鼓的
import * as THREE from 'three';
import type { PetModel, PetPose } from './PetModel';
import { createDefaultPose } from '../BlackCatModel';
import { Blinker, createAnimeEye, EYE_PALETTES, createCanvasTexture, dampPose, drawBlush, ModelBuilder, SignProp, updateEyes, type PetEye } from './modelToolkit';

const COLORS = {
  cream: 0xecbf86,      // 奶黄色的毛（参考图里偏金黄的奶油色）
  earOuter: 0xd99f68,   // 耳朵外侧（比身上深一点）
  white: 0xfff8ee,      // 白肚皮、白脸颊
  pink: 0xf6a9b4,       // 耳朵内侧、小爪子
  nose: 0xee8a9a,
};

/**
 * 三种身体姿态下各部位的位置（直立坐着 / 四脚着地 / 趴着），实际位置按姿势权重混合。
 * 仓鼠没有脖子：大头直接"压"在圆身子上，头和身子重叠一大块，看起来就是一整个饭团
 */
const POSTURES = {
  upright: { bodyY: .48, bodyScale: [.47, .48, .42], bellyY: .4, bellyZ: .18, bellyScale: [.35, .36, .28], headY: .86, headZ: .14, headPitch: 0, pawY: .62, pawZ: .44, pawX: .085, footZ: .26, shoulderY: .55, shoulderZ: .3, hipY: .14, hipZ: .14 },
  fours: { bodyY: .4, bodyScale: [.46, .38, .52], bellyY: .3, bellyZ: .12, bellyScale: [.36, .26, .42], headY: .64, headZ: .5, headPitch: .08, pawY: .05, pawZ: .3, pawX: .16, footZ: -.22, shoulderY: .26, shoulderZ: .28, hipY: .2, hipZ: -.2 },
  lying: { bodyY: .31, bodyScale: [.52, .31, .55], bellyY: .22, bellyZ: .12, bellyScale: [.4, .2, .43], headY: .47, headZ: .52, headPitch: .05, pawY: .05, pawZ: .44, pawX: .17, footZ: -.16, shoulderY: .17, shoulderZ: .38, hipY: .15, hipZ: -.14 },
};
type PostureValues = typeof POSTURES.upright;

const UP_AXIS = new THREE.Vector3(0, 1, 0);
const NON_DAMPED = new Set(['rollAngle', 'cupPush']);
const FAST = new Set(['squint', 'mouthOpen', 'eyeOpen', 'pupilWidth', 'airborne', 'special']);

/** 小嘴巴：倒 Y 形的"ω"嘴 + 两颗小门牙 */
const drawHamsterMouth = (context: CanvasRenderingContext2D, size: number) => {
  context.strokeStyle = '#4a2d22';
  context.lineWidth = size * .06;
  context.lineCap = 'round';
  // 两颗门牙
  context.fillStyle = '#ffffff';
  context.fillRect(size * .41, size * .42, size * .085, size * .16);
  context.fillRect(size * .505, size * .42, size * .085, size * .16);
  context.lineWidth = size * .025;
  context.strokeRect(size * .41, size * .42, size * .085, size * .16);
  context.strokeRect(size * .505, size * .42, size * .085, size * .16);
  // ω 嘴
  context.lineWidth = size * .06;
  const radius = size * .14;
  context.beginPath();
  context.arc(size / 2 - radius, size * .3, radius, Math.PI * .1, Math.PI * .95);
  context.stroke();
  context.beginPath();
  context.arc(size / 2 + radius, size * .3, radius, Math.PI * .05, Math.PI * .9);
  context.stroke();
};

export class HamsterModel implements PetModel {
  readonly root = new THREE.Group();
  private readonly currentPose: PetPose = createDefaultPose();
  private readonly blinker = new Blinker();
  private readonly bodyPivot = new THREE.Group();
  private readonly bodyMesh: THREE.Mesh;
  private readonly belly: THREE.Mesh;
  private readonly tail: THREE.Mesh;
  private readonly head = new THREE.Group();
  private readonly cheeks: THREE.Mesh[] = [];
  /** 头顶的两根呆毛 */
  private readonly ahoge = new THREE.Group();
  private readonly ears: { group: THREE.Group; side: number }[] = [];
  private readonly eyes: PetEye[] = [];
  private readonly mouthOpening: THREE.Mesh;
  private readonly blushMaterial: THREE.MeshBasicMaterial;
  /** 前爪和连着它的白色小胳膊 */
  private readonly frontPaws: { group: THREE.Group; arm: THREE.Mesh; side: number }[] = [];
  /** 后脚和连着它的奶黄色小短腿 */
  private readonly hindFeet: { mesh: THREE.Mesh; leg: THREE.Mesh; side: number }[] = [];
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly sign = new SignProp(.56, .35);

  constructor() {
    const builder = new ModelBuilder({ outlineColor: 0x5a3d2b, outlineThickness: .018, rimColor: 0xfff1dc });
    const cream = builder.toon(COLORS.cream, .22);
    const white = builder.toon(COLORS.white, .15);
    const pink = builder.toon(COLORS.pink, .12);

    this.shadow = builder.shadow(1.1, 1.2);
    this.root.add(this.shadow, this.bodyPivot);

    // ---------- 身体：奶黄色饭团 + 前面一大片白肚皮 + 小尾巴 ----------
    this.bodyMesh = builder.ellipsoid(cream, 1, 1, 1);
    this.belly = builder.ellipsoid(white, 1, 1, 1);
    this.tail = builder.ellipsoid(cream, .06, .055, .06);
    this.bodyPivot.add(this.bodyMesh, this.belly, this.tail);

    // ---------- 头：没有脖子，直接长在身子上 ----------
    this.bodyPivot.add(this.head);
    this.head.add(builder.ellipsoid(cream, .42, .36, .37));
    this.head.add(builder.ellipsoid(white, .3, .2, .27, 0, -.12, .13)); // 白色的下半张脸
    for (const side of [-1, 1]) {
      const cheek = builder.ellipsoid(white, .19, .16, .16, side * .22, -.12, .17); // 肉嘟嘟的颊囊
      this.head.add(cheek);
      this.cheeks.push(cheek);
    }
    // 粉鼻子、小嘴巴、张嘴、腮红
    this.head.add(builder.ellipsoid(builder.toon(COLORS.nose, .1), .04, .03, .024, 0, -.045, .392, false));
    this.head.add(builder.sticker(builder.decal(createCanvasTexture(drawHamsterMouth)), .09, .09, 0, -.125, .4));
    this.mouthOpening = builder.sticker(builder.solid(0x7a2a35), .03, .001, 0, -.145, .402);
    this.head.add(this.mouthOpening);
    this.blushMaterial = builder.decal(createCanvasTexture(drawBlush, 64));
    this.blushMaterial.opacity = .4;
    for (const side of [-1, 1]) this.head.add(builder.sticker(this.blushMaterial, .075, .042, side * .24, -.07, .33, side * .6));
    // 亮晶晶的大眼睛（深咖啡红，像黑葡萄；参考图里眼睛又大又亮）
    for (const side of [-1, 1]) {
      const eye = createAnimeEye(builder, .1, side, EYE_PALETTES.hamster);
      eye.group.position.set(side * .165, .05, .343);
      eye.group.rotation.set(-.05, side * .45, 0);
      this.head.add(eye.group);
      this.eyes.push(eye);
    }
    // 胡须
    const whiskerSegments: [THREE.Vector3, THREE.Vector3][] = [];
    for (const side of [-1, 1]) {
      whiskerSegments.push([new THREE.Vector3(side * .13, -.07, .38), new THREE.Vector3(side * .48, -.02, .31)]);
      whiskerSegments.push([new THREE.Vector3(side * .13, -.09, .38), new THREE.Vector3(side * .47, -.12, .32)]);
    }
    this.head.add(builder.whiskers(whiskerSegments, .7));
    // 头顶两根呆毛：从头顶冒出来，往外弯一个小弧（用细描边，不然线条太粗）
    const hairBuilder = new ModelBuilder({ outlineColor: 0x5a3d2b, outlineThickness: .006, rimColor: 0xfff1dc });
    const hairMaterial = hairBuilder.toon(COLORS.earOuter, .2);
    const hairCurves = [
      [new THREE.Vector3(-.02, .33, .04), new THREE.Vector3(-.035, .42, .07), new THREE.Vector3(-.01, .5, .05), new THREE.Vector3(.04, .51, .01)],
      [new THREE.Vector3(.025, .33, .03), new THREE.Vector3(.05, .4, .06), new THREE.Vector3(.09, .44, .04)],
    ];
    // 晃动的支点放在发根，晃的时候发根不会离开头顶
    const hairRoot = new THREE.Vector3(0, .33, .035);
    this.ahoge.position.copy(hairRoot);
    for (const worldPoints of hairCurves) {
      const points = worldPoints.map(point => point.clone().sub(hairRoot));
      const strand = hairBuilder.withOutline(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, .013, 8, false), hairMaterial));
      const tip = hairBuilder.ellipsoid(hairMaterial, .014, .014, .014, points[points.length - 1].x, points[points.length - 1].y, points[points.length - 1].z);
      this.ahoge.add(strand, tip);
    }
    this.head.add(this.ahoge);
    // 小圆耳朵：外侧深奶黄，内侧粉色
    const earOuter = builder.toon(COLORS.earOuter, .2);
    for (const side of [-1, 1]) {
      const group = new THREE.Group();
      group.position.set(side * .26, .27, -.02);
      group.add(builder.ellipsoid(earOuter, .125, .135, .045));
      group.add(builder.sticker(builder.solid(COLORS.pink), .085, .095, 0, -.005, .047));
      this.head.add(group);
      this.ears.push({ group, side });
    }

    // ---------- 小爪子 ----------
    // 前爪：粉色的小手，掌心朝下、两三个小指头（坐着时抱在下巴底下）
    for (const side of [-1, 1]) {
      const group = new THREE.Group();
      group.add(builder.ellipsoid(pink, .05, .042, .045));
      for (const offset of [-.025, 0, .025]) group.add(builder.ellipsoid(pink, .016, .016, .02, offset, -.035, .025, false));
      const arm = builder.ellipsoid(white, 1, 1, 1);
      this.bodyPivot.add(group, arm);
      this.frontPaws.push({ group, arm, side });
      // 后脚：粉色小脚丫，坐着时从肚子前面下方探出来一点点；用一截奶黄色小短腿连着身子
      const foot = builder.ellipsoid(pink, .055, .022, .075);
      const leg = builder.ellipsoid(cream, 1, 1, 1);
      this.bodyPivot.add(foot, leg);
      this.hindFeet.push({ mesh: foot, leg, side });
    }

    this.root.add(this.sign.group);
  }

  update(targetPose: PetPose, walkPhase: number, elapsedSeconds: number, deltaSeconds: number): void {
    const pose = this.currentPose;
    dampPose(pose, targetPose, deltaSeconds, NON_DAMPED, FAST);

    // ---- 混合三种姿态：直立坐着（sit、被拎起来）/ 四脚着地（站、走、伸懒腰）/ 趴着 ----
    const uprightWeight = pose.sit + pose.lifted;
    const foursWeight = pose.stand + pose.stretch;
    const total = uprightWeight + foursWeight + pose.lie || 1;
    const mix = (pick: (values: PostureValues) => number) =>
      (pick(POSTURES.upright) * uprightWeight + pick(POSTURES.fours) * foursWeight + pick(POSTURES.lying) * pose.lie) / total;
    const mixScale = (index: number, pick: (values: PostureValues) => number[]) => mix(values => pick(values)[index]);

    const walk = Math.min(pose.walkAmount, 1.4);
    const bob = Math.abs(Math.sin(walkPhase * 2)) * .035 * Math.min(walk, 1);
    const breath = 1 + Math.sin(elapsedSeconds * pose.breathRate) * .025;
    const rollLift = (1 - Math.cos(pose.rollAngle)) * .3;
    const crouchDrop = pose.crouch * .07;

    // ---- 身体 ----
    this.bodyPivot.position.y = bob + rollLift - crouchDrop;
    this.bodyPivot.rotation.set(-pose.airborne * .2, Math.sin(elapsedSeconds * 22) * .12 * pose.wiggle, pose.rollAngle);
    this.root.position.y = Math.abs(Math.sin(elapsedSeconds * 7)) * .1 * pose.bounce;
    const bodyScale = [0, 1, 2].map(index => mixScale(index, values => values.bodyScale));
    this.bodyMesh.scale.set(bodyScale[0] * breath, bodyScale[1] * breath, bodyScale[2] * (1 + pose.stretch * .15));
    this.bodyMesh.position.set(0, mix(values => values.bodyY), -pose.stretch * .05);
    this.belly.scale.set(...([0, 1, 2].map(index => mixScale(index, values => values.bellyScale)) as [number, number, number]));
    this.belly.position.set(0, mix(values => values.bellyY), mix(values => values.bellyZ));
    this.tail.position.set(Math.sin(elapsedSeconds * pose.tailSpeed * 2) * .03 * pose.tailSwing, mix(values => values.bodyY) - .12, -bodyScale[2] + .02);

    // ---- 头 ----
    const groomNod = Math.sin(elapsedSeconds * 9) * .06 * pose.groom;
    this.head.position.set(0, mix(values => values.headY) - pose.groom * .04, mix(values => values.headZ) + pose.stretch * .12);
    this.head.rotation.set(mix(values => values.headPitch) + pose.headPitch * .5 + groomNod, pose.headYaw * .6, pose.headRoll);

    // 呆毛跟着轻轻晃，走路、开心蹦的时候晃得更厉害
    const hairBounce = .08 + Math.min(walk, 1) * .15 + pose.bounce * .2;
    this.ahoge.rotation.set(Math.sin(elapsedSeconds * 4.2) * hairBounce * .5, 0, Math.sin(elapsedSeconds * 3.1) * hairBounce);

    // 特有动作：腮帮子塞得鼓鼓的
    for (const [index, cheek] of this.cheeks.entries()) {
      const side = index === 0 ? -1 : 1;
      const puff = 1 + pose.special * .65;
      cheek.scale.set(.19 * puff, .16 * (1 + pose.special * .45), .16 * puff);
      cheek.position.set(side * (.22 + pose.special * .07), -.12, .17);
    }

    // ---- 前爪：坐着时抱在胸前，四脚着地时撑在地上，走路时交替迈 ----
    for (const paw of this.frontPaws) {
      const stepPhase = walkPhase + (paw.side < 0 ? 0 : Math.PI);
      let x = paw.side * mix(values => values.pawX);
      let y = mix(values => values.pawY) + Math.max(0, Math.sin(stepPhase)) * .06 * Math.min(walk, 1);
      let z = mix(values => values.pawZ) + Math.cos(stepPhase) * .07 * Math.min(walk, 1);
      // 洗脸：两只爪子举到脸上搓搓
      x += (paw.side * .1 - x) * pose.groom;
      y += (.82 + Math.sin(elapsedSeconds * 10 + paw.side) * .04 - y) * pose.groom;
      z += (.42 - z) * pose.groom;
      // 举牌：两只爪子举高扶着牌子
      x += (paw.side * .17 - x) * pose.holdSign;
      y += (.72 - y) * pose.holdSign;
      z += (.5 - z) * pose.holdSign;
      // 扒着边沿：两只爪子往前伸
      y += (.66 - y) * pose.pawsOnLedge;
      z += (.5 - z) * pose.pawsOnLedge;
      // 敲窗户 / 招手：右爪抬起来一下一下地敲
      if (paw.side > 0) {
        y += (.85 + Math.sin(elapsedSeconds * 16) * .05 - y) * pose.knock;
        z += (.48 - z) * pose.knock;
      }
      // 被拎起来 / 跳起来：爪子张开乱蹬
      x += paw.side * .08 * (pose.lifted + pose.airborne);
      y += Math.sin(elapsedSeconds * 13 + paw.side) * .04 * pose.legKick;
      paw.group.position.set(x, y + bob + rollLift, z);
      // 小胳膊：从肩膀连到爪子（肩膀藏在身子里，所以爪子永远和身子连着）
      const shoulder = new THREE.Vector3(paw.side * .13, mix(values => values.shoulderY) + bob + rollLift, mix(values => values.shoulderZ));
      this.stretchLimb(paw.arm, shoulder, paw.group.position, .058);
    }

    // ---- 后脚：平时贴在地上，走路时交替抬起 ----
    for (const foot of this.hindFeet) {
      const stepPhase = walkPhase + (foot.side < 0 ? Math.PI : 0);
      const lift = Math.max(0, Math.sin(stepPhase)) * .05 * Math.min(walk, 1) + Math.max(0, Math.sin(elapsedSeconds * 13 + foot.side)) * .05 * pose.legKick;
      foot.mesh.position.set(foot.side * .15, .022 + lift + rollLift - pose.lifted * .02, mix(values => values.footZ) + Math.cos(stepPhase) * .06 * Math.min(walk, 1));
      foot.mesh.rotation.x = -pose.airborne * .6;
      // 小短腿：从屁股连到脚丫
      const hip = new THREE.Vector3(foot.side * .16, mix(values => values.hipY) + rollLift, mix(values => values.hipZ));
      this.stretchLimb(foot.leg, hip, foot.mesh.position, .07);
    }

    // ---- 眼睛、耳朵、嘴巴 ----
    updateEyes(this.eyes, pose, this.blinker.update(deltaSeconds), .02, elapsedSeconds);
    this.blushMaterial.opacity = .35 + .5 * Math.max(pose.squint, pose.bounce, pose.special);
    for (const ear of this.ears) {
      ear.group.rotation.set(-pose.earBack * .8 + pose.earPerk * .15, 0, ear.side * -(.35 + pose.earBack * .5));
    }
    this.mouthOpening.visible = pose.mouthOpen > .05;
    this.mouthOpening.scale.y = .001 + pose.mouthOpen * .03;

    // ---- 小牌子、阴影 ----
    this.sign.group.position.set(0, .62, .66);
    this.sign.update(pose.holdSign, elapsedSeconds);
    this.shadow.material.opacity = (1 - pose.lifted) * (1 - pose.airborne * .6);
  }

  /** 把一个椭球"撑"在两个点之间，当作一截圆滚滚的小胳膊 / 小短腿 */
  private stretchLimb(limb: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, radius: number): void {
    const direction = new THREE.Vector3().subVectors(to, from);
    const length = direction.length();
    limb.position.copy(from).addScaledVector(direction, .5);
    limb.scale.set(radius, Math.max(radius, length / 2 + radius * .4), radius);
    if (length > 1e-4) limb.quaternion.setFromUnitVectors(UP_AXIS, direction.normalize());
  }

  setSignText(text: string): void {
    this.sign.setText(text);
  }

  setAccessory(_id: string): void {
    // 装扮在编码阶段加
  }
}
