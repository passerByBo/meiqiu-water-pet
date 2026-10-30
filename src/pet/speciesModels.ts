// 每种动物对应的 3D 模型（单独放一个文件：设置窗口只需要动物资料，不用打包 3D 模型）
import { BlackCatModel } from './BlackCatModel';
import { GoldfishModel } from './models/GoldfishModel';
import { GltfFishModel } from './models/GltfFishModel';
import { GltfQuadrupedModel } from './models/GltfQuadrupedModel';
import { HamsterModel } from './models/HamsterModel';
import { ShibaModel } from './models/ShibaModel';
import type { PetModel } from './models/PetModel';
import type { PetSpecies } from './species';
import { findSkin, type PetSkin } from './skins';

const MODEL_FACTORIES: Record<PetSpecies, (skin: PetSkin) => PetModel> = {
  cat: skin => new BlackCatModel(skin),
  hamster: skin => new HamsterModel(skin),
  shiba: skin => new ShibaModel(skin),
  goldfish: skin => new GoldfishModel(skin),
};

/** 造一只宠物：skinId 是皮肤（见 skins.ts），找不到就用默认外观；皮肤指定了模型文件就用 AI 生成的模型 */
export function createPetModel(species: PetSpecies, skinId?: string): PetModel {
  const skin = findSkin(species, skinId);
  if (skin.model) return species === 'goldfish' ? new GltfFishModel(skin, skin.model) : new GltfQuadrupedModel(skin, skin.model);
  return (MODEL_FACTORIES[species] ?? MODEL_FACTORIES.cat)(skin);
}
