// 用 AI 生成的 3D 模型（GLB 文件，带骨骼）做的四足宠物（黑猫、柴犬……）。
// 模型来源和绑骨流程见 docs/3D模型制作流程.md：骨骼名字和 BlackCatModel 的关节一一对应
// （hips → chest → neck → head，四条腿 upper → knee，尾巴 tail_0..N），
// 所以这里直接沿用 BlackCatModel 的关键姿势数值，把姿势参数换算成骨骼角度。
// 加载、材质、点击检测等公共部分在 GltfPetModelBase。
//
// 和代码搭的模型相比，AI 模型是一整块网格：眼睛、耳朵、嘴巴不能单独动（不会眨眼、竖耳朵、张嘴），
// 装扮暂时也没有挂上去；走路、坐、趴、转头、甩尾巴、举牌子、推杯子都支持。
import * as THREE from 'three';
import { KEY_POSES, POSE_NAMES, type CatPose } from '../BlackCatModel';
import { clamp, damp } from '../../shared/geometry';
import { dampPose } from './modelToolkit';
import { GltfPetModelBase, MODEL_AXIS_X, MODEL_AXIS_Y, MODEL_AXIS_Z, type BoneRig, type GltfModelOptions } from './GltfPetModelBase';
import type { PetPose } from './PetModel';
import type { PetSkin } from '../skins';

type JointName = keyof typeof KEY_POSES.stand;
type LegName = 'frontLeft' | 'frontRight' | 'backLeft' | 'backRight';
const LEG_NAMES: LegName[] = ['frontLeft', 'frontRight', 'backLeft', 'backRight'];
const JOINT_NAMES = Object.keys(KEY_POSES.stand) as JointName[];
const NON_DAMPED_KEYS = new Set(['rollAngle', 'cupPush']);
const FAST_KEYS = new Set(['squint', 'mouthOpen', 'eyeOpen', 'pupilWidth', 'airborne']);
/** 代码版黑猫站着时臀部离地的高度：AI 模型的高度偏移按它的臀部高度等比例换算 */
const CODE_MODEL_HIPS_HEIGHT = KEY_POSES.stand.hipsHeight;
/** AI 模型静止时尾巴是竖起来的，大约相当于 tailLift = 1.2 */
const REST_TAIL_LIFT = 1.2;
/** 代码版尾巴有 12 节，AI 模型只有几根尾巴骨，尾巴整体上下弯的角度按节数折算 */
const CODE_TAIL_SEGMENTS = 12;
/** 每根尾巴骨最多弯多少（弧度）：骨头少，弯太多关节处的网格会被拧扁 */
const MAX_TAIL_BEND = .45;

export class GltfQuadrupedModel extends GltfPetModelBase {
  private tailBones: BoneRig[] = [];
  /** 每条腿的脚掌在膝盖骨坐标里的位置（绑骨脚本把膝盖放在腿的正中间，所以膝盖到脚 ≈ 大腿根到膝盖） */
  private readonly footOffsets: Partial<Record<LegName, THREE.Vector3>> = {};
  /** 代码版的高度偏移换算到这个模型上的比例 */
  private heightRatio = 1;
  private readonly tailLiftScale: number;

  private readonly tailPitchAngles: number[] = [];
  private readonly tailYawAngles: number[] = [];
  private tailTurnOffset = 0;
  private previousRootYaw = 0;
  private readonly bodyOffset = new THREE.Vector3();
  private readonly sideAxis = new THREE.Vector3();
  private readonly footPoint = new THREE.Vector3();

  constructor(skin: PetSkin, options: GltfModelOptions) {
    super(skin, options, {
      shadowSize: [1.1, 1.6], shadowZ: .1,
      signPosition: new THREE.Vector3(0, .45, .95), cupPosition: new THREE.Vector3(.5, 0, .55),
      roughness: 1,
    });
    this.tailLiftScale = options.tailLiftScale ?? 1;
  }

  protected onModelLoaded(): boolean {
    // 约定：模型的静止姿势就是"四脚站好"（腿不直要在 Blender 里修好再导出，见 docs/3D模型制作流程.md），
    // 所以这里不扣除骨头的倾斜——修腿时骨头会跟着网格歪一点，扣掉反而会把腿扳回原来的样子
    for (const legName of LEG_NAMES) {
      const knee = this.bones[`${legName}_knee`];
      if (knee) this.footOffsets[legName] = new THREE.Vector3(0, knee.restPosition.length(), 0);
    }
    for (let index = 0; this.bones[`tail_${index}`]; index++) this.tailBones.push(this.bones[`tail_${index}`]);
    this.tailPitchAngles.push(...this.tailBones.map(() => 0));
    this.tailYawAngles.push(...this.tailBones.map(() => 0));
    const hips = this.bones.hips;
    if (hips) this.heightRatio = hips.restModelPosition.y * this.holder.scale.y / CODE_MODEL_HIPS_HEIGHT;
    return !!hips && !!this.bones.neck && !!this.bones.head;
  }

  update(targetPose: PetPose, walkPhase: number, elapsedSeconds: number, deltaSeconds: number): void {
    const pose = this.currentPose;
    dampPose(pose, targetPose, deltaSeconds, NON_DAMPED_KEYS, FAST_KEYS);
    this.sign.update(pose.holdSign, elapsedSeconds);
    this.cup.update(pose.cupVisible, pose.cupPush);
    this.shadow.material.opacity = (1 - pose.lifted) * (1 - pose.airborne * .6);
    this.root.position.y = Math.abs(Math.sin(elapsedSeconds * 7)) * .1 * pose.bounce;
    if (!this.isLoaded) return;

    // ---- 混合关键姿势（和 BlackCatModel 一样） ----
    const totalWeight = POSE_NAMES.reduce((sum, name) => sum + pose[name], 0) || 1;
    const blended = {} as Record<JointName, number>;
    for (const joint of JOINT_NAMES) {
      blended[joint] = POSE_NAMES.reduce((sum, name) => sum + KEY_POSES[name][joint] * pose[name], 0) / totalWeight;
    }
    const walk = pose.walkAmount;
    const swing = Math.min(walk, 1.4) * .5;
    const legPhase: Record<LegName, number> = { frontLeft: walkPhase, backRight: walkPhase, frontRight: walkPhase + Math.PI, backLeft: walkPhase + Math.PI };
    const bobOffset = Math.cos(walkPhase * 2) * .02 * Math.min(walk, 1);

    // ---- 身体：臀部升降（相对站姿的偏移，按模型大小换算）+ 前后倾 + 扭屁股 + 打滚 ----
    // 走路时身体的上下起伏（bobOffset）放到踩地修正之后再加，否则会被修正抵消掉
    const hips = this.bones.hips;
    const rollLift = (1 - Math.cos(pose.rollAngle)) * .3;
    hips.bone.position.copy(hips.restPosition);
    this.offsetBone(hips, this.bodyOffset.set(
      0,
      (blended.hipsHeight - CODE_MODEL_HIPS_HEIGHT - pose.crouch * .1) * this.heightRatio + rollLift,
      blended.hipsShift * this.heightRatio,
    ));
    this.poseBone(hips, [
      [MODEL_AXIS_X, blended.hipsPitch + Math.sin(walkPhase * 2) * .02 * Math.min(walk, 1) - pose.airborne * .25],
      [MODEL_AXIS_Y, Math.sin(elapsedSeconds * 22) * .12 * pose.wiggle],
      [MODEL_AXIS_Z, pose.rollAngle],
    ]);
    // 不做呼吸起伏：缩放 chest 骨头会连带缩放它下面的脖子、头和前腿

    // ---- 腿（角度算法和 BlackCatModel 完全一样） ----
    // 先用"不迈步"的站姿量脚的高度做踩地修正，再换成真正的走路姿势：
    // 如果用迈步中的腿来量，最低的那只脚每半步换一只，身体会一顿一顿的（实测一步里上下跳 11cm，看起来一拐一拐）
    const legAngles = (legName: LegName, includeGait: boolean): [number, number] => {
      const isFront = legName.startsWith('front');
      const phase = legPhase[legName];
      const gait = includeGait ? swing : 0;
      let upperAngle = (isFront ? blended.frontUpper : blended.backUpper) + Math.sin(phase) * gait;
      let kneeAngle = (isFront ? blended.frontKnee : blended.backKnee) + Math.max(0, -Math.cos(phase)) * gait * 1.5;
      kneeAngle += pose.crouch * (isFront ? .35 : .5);
      upperAngle += pose.crouch * (isFront ? -.2 : -.25);
      if (includeGait) upperAngle += Math.sin(elapsedSeconds * 13 + phase * 1.7) * .3 * pose.legKick;
      if (legName === 'frontRight') {
        upperAngle += -2.25 * pose.groom;
        kneeAngle += 2.15 * pose.groom + Math.sin(elapsedSeconds * 6) * .15 * pose.groom;
        upperAngle += (-1.4 + Math.sin(elapsedSeconds * 16) * .35) * pose.knock;
        kneeAngle += .5 * pose.knock;
      }
      if (isFront) {
        upperAngle += -2.0 * pose.pawsOnLedge;
        kneeAngle += 1.7 * pose.pawsOnLedge;
      }
      upperAngle += (isFront ? -.9 : .9) * pose.airborne;
      return [upperAngle, kneeAngle];
    };
    const poseLegs = (includeGait: boolean) => {
      for (const legName of LEG_NAMES) {
        const [upperAngle, kneeAngle] = legAngles(legName, includeGait);
        this.poseBone(this.bones[`${legName}_upper`], [[MODEL_AXIS_X, upperAngle]]);
        this.poseBone(this.bones[`${legName}_knee`], [[MODEL_AXIS_X, kneeAngle]]);
      }
    };
    poseLegs(false);
    this.keepFeetOnGround(pose);
    if (walk > 0 || pose.legKick > 0) poseLegs(true);
    this.offsetBone(hips, this.bodyOffset.set(0, bobOffset, 0));

    // ---- 头 ----
    const groomNod = Math.sin(elapsedSeconds * 9) * .08 * pose.groom;
    this.poseBone(this.bones.neck, [
      [MODEL_AXIS_X, blended.neckPitch + pose.headPitch * .5 + .35 * pose.groom - pose.crouch * .12],
      [MODEL_AXIS_Y, pose.headYaw * .5 + .3 * pose.groom],
    ]);
    this.poseBone(this.bones.head, [
      [MODEL_AXIS_X, pose.headPitch * .5 + groomNod - bobOffset * 2],
      [MODEL_AXIS_Y, pose.headYaw * .5],
      [MODEL_AXIS_Z, pose.headRoll],
    ]);

    this.updateTail(pose, elapsedSeconds, deltaSeconds);
  }

  /**
   * 踩地修正：代码版的关键姿势是按代码版猫的身材调的，AI 模型身体更长、腿更短，直接套用会悬空或陷进地里
   * （比如坐下时胸口被抬得更高，前爪离地）。摆好姿势后量一下最低那只脚离地多高，把身体整体挪回地面。
   * 被拎起来、跳在半空、打滚翻过来的时候不修正
   */
  private keepFeetOnGround(pose: CatPose): void {
    const weight = (1 - pose.lifted) * (1 - pose.airborne) * Math.max(0, Math.cos(pose.rollAngle));
    if (weight <= 0) return;
    this.root.updateMatrixWorld(true);
    let lowestFootHeight = Infinity;
    for (const legName of LEG_NAMES) {
      const knee = this.bones[`${legName}_knee`], footOffset = this.footOffsets[legName];
      if (!knee || !footOffset) continue;
      this.footPoint.copy(footOffset).applyMatrix4(knee.bone.matrixWorld);
      lowestFootHeight = Math.min(lowestFootHeight, this.root.worldToLocal(this.footPoint).y);
    }
    if (!Number.isFinite(lowestFootHeight)) return;
    this.offsetBone(this.bones.hips, this.bodyOffset.set(0, -lowestFootHeight * weight, 0));
  }

  /** 尾巴：根部按 tailLift 抬起 / 放下，每节左右摆（根部先动、尾尖慢半拍），转身时被甩出去再回弹 */
  private updateTail(pose: CatPose, elapsedSeconds: number, deltaSeconds: number): void {
    const rootYawChange = Math.atan2(Math.sin(this.root.rotation.y - this.previousRootYaw), Math.cos(this.root.rotation.y - this.previousRootYaw));
    this.previousRootYaw = this.root.rotation.y;
    this.tailTurnOffset = clamp(this.tailTurnOffset - rootYawChange * 1.6, -1.4, 1.4);
    this.tailTurnOffset = damp(this.tailTurnOffset, 0, 2.5, deltaSeconds);

    const segmentCount = this.tailBones.length;
    const anglePerBone = CODE_TAIL_SEGMENTS / Math.max(segmentCount, 1);
    this.tailBones.forEach((rig, index) => {
      const progress = segmentCount > 1 ? index / (segmentCount - 1) : 0;
      // 摆动：越往尾尖幅度稍大一点、节奏慢半拍。不能照搬代码版（12 节、每节幅度随序号变大）再乘倍数：
      // AI 模型只有 4 根骨头，尾尖那根会被转到 75°，网格在关节处被拧扁，看起来像少了一节
      const wave = Math.sin(elapsedSeconds * pose.tailSpeed - index * .6) * pose.tailSwing * (.25 + progress * .15);
      const liftDelta = (pose.tailLift - REST_TAIL_LIFT) * this.tailLiftScale;
      const targetPitch = index === 0
        ? clamp(liftDelta * .75, -1.2, .6)
        : clamp((liftDelta * .06 - pose.tailWrap * .02) * anglePerBone, -MAX_TAIL_BEND, MAX_TAIL_BEND);
      const targetYaw = clamp(wave + pose.tailWrap * .3 + this.tailTurnOffset * .2 * progress, -MAX_TAIL_BEND, MAX_TAIL_BEND);
      const followRate = 20 - progress * 13;
      this.tailPitchAngles[index] = damp(this.tailPitchAngles[index], targetPitch, followRate, deltaSeconds);
      this.tailYawAngles[index] = damp(this.tailYawAngles[index], targetYaw, followRate, deltaSeconds);
      // 左右摆的轴：垂直于骨头和左右方向（尾巴横着时是 y 轴，竖着时是 z 轴）
      this.sideAxis.crossVectors(MODEL_AXIS_X, rig.restDirection).normalize();
      this.poseBone(rig, [[MODEL_AXIS_X, this.tailPitchAngles[index]], [this.sideAxis, this.tailYawAngles[index]]]);
    });
  }
}
