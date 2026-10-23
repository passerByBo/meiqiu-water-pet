// 所有动物模型的共同接口：大脑只管生成"姿势参数"，每种动物自己决定怎么把参数变成动作。
// 例如 walkAmount 对猫、仓鼠、柴犬是迈腿，对金鱼是摆尾巴游；special 是每种动物的特有动作
import type * as THREE from 'three';
import type { CatPose } from '../BlackCatModel';

/**
 * 姿势参数（所有动物共用一套）。其中 special / special2 / special3 是每种动物自己的特有动作：
 *   仓鼠：special 鼓腮帮子
 *   柴犬：special 作揖拜拜 / special2 赖地耍赖 / special3 螺旋桨尾巴扭屁股（开心地吐一点舌头）
 *   金鱼：special 吐泡泡
 */
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
