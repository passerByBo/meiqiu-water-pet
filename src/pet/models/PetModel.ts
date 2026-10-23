// 所有动物模型的共同接口：大脑只管生成"姿势参数"，每种动物自己决定怎么把参数变成动作。
// 例如 walkAmount 对猫、仓鼠、柴犬是迈腿，对金鱼是摆尾巴游；special 是每种动物的特有动作
import type * as THREE from 'three';
import type { CatPose } from '../BlackCatModel';

/** 姿势参数（所有动物共用一套） */
export type PetPose = CatPose;

export interface PetModel {
  /** 放进场景里的根节点；脚底中心（金鱼是悬浮点正下方）在原点 */
  readonly root: THREE.Group;
  update(targetPose: PetPose, walkPhase: number, elapsedSeconds: number, deltaSeconds: number): void;
  /** 提醒时举的小牌子上的字 */
  setSignText(text: string): void;
  /** 穿上装扮（none 或装扮 id） */
  setAccessory(id: string): void;
}
