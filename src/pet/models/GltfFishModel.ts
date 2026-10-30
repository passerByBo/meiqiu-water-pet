// 用 AI 生成的 3D 模型（GLB 文件，带骨骼）做的金鱼。
// 骨骼由 tools/blender/rig_fish.py 生成：body（根）→ head；body → spine → tail_0 → tail_1；body → fin_left / fin_right。
// 游动节奏和 GoldfishModel（代码版金鱼）一样：悬浮着上下浮动，移动时摆尾巴快、幅度大，睡觉时沉低一点、慢下来；
// 身体那串骨头从前往后一节节慢半拍地左右摆，形成鱼游泳的 S 形波浪；胸鳍一直扇。
// 不会眨眼、张嘴、吐泡泡（AI 模型是一整块网格）
import * as THREE from 'three';
import { dampPose } from './modelToolkit';
import { GltfPetModelBase, MODEL_AXIS_X, MODEL_AXIS_Y, MODEL_AXIS_Z, type BoneRig, type GltfModelOptions } from './GltfPetModelBase';
import type { PetPose } from './PetModel';
import type { PetSkin } from '../skins';

/** 悬浮高度（身体中心离"地面"多高），和代码版金鱼一样 */
const HOVER_HEIGHT = .62;
const NON_DAMPED_KEYS = new Set(['rollAngle', 'cupPush']);
const FAST_KEYS = new Set(['squint', 'mouthOpen', 'eyeOpen', 'pupilWidth', 'airborne', 'special']);
/** 从身体到尾鳍的骨头，以及每节摆动的幅度（越往后越大）和比前一节慢多少（弧度） */
const SWIM_CHAIN: { name: string; amplitude: number }[] = [
  { name: 'spine', amplitude: .22 },
  { name: 'tail_0', amplitude: .4 },
  { name: 'tail_1', amplitude: .5 },
];
const WAVE_LAG = .8;
/** 每节最多转多少：骨头少，转太多会把尾柄拧扁 */
const MAX_BEND = .55;

export class GltfFishModel extends GltfPetModelBase {
  private swimPhase = 0;
  /** 身体中心（body 骨头）静止时离模型原点多高（已乘放大倍数）：悬浮高度按它来对齐 */
  private bodyCenterHeight = 0;
  private chain: (BoneRig | undefined)[] = [];

  constructor(skin: PetSkin, options: GltfModelOptions) {
    super(skin, options, {
      shadowSize: [.9, 1.1], shadowZ: 0,
      signPosition: new THREE.Vector3(0, .3, .66), cupPosition: new THREE.Vector3(.42, 0, .5),
      // 鱼比毛绒动物光滑一点，但不能像塑料（Tripo 给的粗糙度只有 0.26）
      roughness: .78,
    });
  }

  protected onModelLoaded(): boolean {
    const body = this.bones.body;
    if (body) this.bodyCenterHeight = body.restModelPosition.y * this.holder.scale.y;
    this.chain = SWIM_CHAIN.map(item => this.bones[item.name]);
    return !!body && !!this.bones.tail_0;
  }

  update(targetPose: PetPose, _walkPhase: number, elapsedSeconds: number, deltaSeconds: number): void {
    const pose = this.currentPose;
    dampPose(pose, targetPose, deltaSeconds, NON_DAMPED_KEYS, FAST_KEYS);
    this.sign.update(pose.holdSign, elapsedSeconds);
    this.cup.update(pose.cupVisible, pose.cupPush);

    // ---- 游动节奏：移动时摆尾巴快、幅度大；休息时慢慢飘；被拎起来时拼命扑腾 ----
    const swimEffort = Math.min(pose.walkAmount, 1.6) + pose.lifted * 2 + pose.wiggle;
    const restfulness = pose.lie;
    const beatSpeed = 2.2 + swimEffort * 6 - restfulness * 1.1;
    this.swimPhase += beatSpeed * deltaSeconds;
    const beatAmplitude = .3 + swimEffort * .25 + pose.tailSwing * .15;

    // ---- 悬浮：上下浮动；睡觉时沉低一点；开心时一蹦一蹦 ----
    const bob = Math.sin(elapsedSeconds * 1.6) * .04 + Math.abs(Math.sin(elapsedSeconds * 7)) * .12 * pose.bounce;
    const hoverHeight = HOVER_HEIGHT - restfulness * .17 - pose.crouch * .1 + bob;
    this.holder.position.y = hoverHeight - this.bodyCenterHeight;
    // 影子：鱼离地越高影子越淡
    this.shadow.material.opacity = (.45 - (hoverHeight - .3) * .3) * (1 - pose.lifted);
    if (!this.isLoaded) return;

    // ---- 整条鱼：转头 = 整条鱼转过去；游的时候身子左右扭；可以打滚（body 是根骨头，转它就是转整条鱼） ----
    const bodyWiggle = Math.sin(this.swimPhase) * .07 * (swimEffort + .3);
    this.poseBone(this.bones.body, [
      [MODEL_AXIS_Y, pose.headYaw * .4 + bodyWiggle + Math.sin(elapsedSeconds * 22) * .1 * pose.wiggle],
      [MODEL_AXIS_X, pose.headPitch * .4 + restfulness * .15 - pose.airborne * .3],
      [MODEL_AXIS_Z, pose.rollAngle + pose.headRoll * .6 + Math.sin(elapsedSeconds * .9) * .04],
    ]);
    // 头往身子扭动的反方向稍微偏一点，看起来是身子在甩、头比较稳
    this.poseBone(this.bones.head, [[MODEL_AXIS_Y, -bodyWiggle * .6]]);

    // ---- 身体到尾鳍：一节比一节慢半拍地左右摆；尾巴抬高（开心）时尾鳍往上翘一点 ----
    this.chain.forEach((rig, index) => {
      const bend = Math.sin(this.swimPhase - (index + 1) * WAVE_LAG) * beatAmplitude * SWIM_CHAIN[index].amplitude;
      const clamped = Math.max(-MAX_BEND, Math.min(MAX_BEND, bend));
      this.poseBone(rig, [[MODEL_AXIS_Y, clamped], [MODEL_AXIS_X, index === SWIM_CHAIN.length - 1 ? -pose.tailLift * .06 : 0]]);
    });

    // ---- 胸鳍一直扇；洗脸 / 招手时扇得很快 ----
    const flapSpeed = 5 + pose.groom * 12 + pose.knock * 14 + swimEffort * 3;
    for (const [name, side] of [['fin_left', -1], ['fin_right', 1]] as const) {
      const flap = Math.sin(elapsedSeconds * flapSpeed + side) * (.3 + pose.groom * .3);
      this.poseBone(this.bones[name], [[MODEL_AXIS_Z, side * flap]]);
    }
  }
}
