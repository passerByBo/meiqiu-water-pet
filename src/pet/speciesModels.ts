// 每种动物对应的 3D 模型（单独放一个文件：设置窗口只需要动物资料，不用打包 3D 模型）
import { BlackCatModel } from './BlackCatModel';
import { GoldfishModel } from './models/GoldfishModel';
import { HamsterModel } from './models/HamsterModel';
import { ShibaModel } from './models/ShibaModel';
import type { PetModel } from './models/PetModel';
import type { PetSpecies } from './species';

const MODEL_FACTORIES: Record<PetSpecies, () => PetModel> = {
  cat: () => new BlackCatModel(),
  hamster: () => new HamsterModel(),
  shiba: () => new ShibaModel(),
  goldfish: () => new GoldfishModel(),
};

export function createPetModel(species: PetSpecies): PetModel {
  return (MODEL_FACTORIES[species] ?? MODEL_FACTORIES.cat)();
}
