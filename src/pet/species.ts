// 宠物种类登记表：每种动物的默认名字、自称和叫声、特有动作的说明（只有资料，不含 3D 模型，设置窗口也能用）。
// 以后加新动物：在这里登记一条、写一个模型（models/ 下实现 PetModel 接口，并在 speciesModels.ts 里登记）、
// 在动作库里给它加特有动作即可

export type PetSpecies = 'cat' | 'hamster' | 'shiba' | 'goldfish';

export interface SpeciesInfo {
  id: PetSpecies;
  /** 种类名（设置里显示） */
  label: string;
  icon: string;
  /** 默认名字（设置里可以改） */
  defaultName: string;
  /** 一句话介绍（设置里显示） */
  description: string;
  /** 自称：台词里的"本喵"换成它 */
  selfName: string;
  /** 叫声字：台词里的"喵"换成它（例如"喵～" → "汪～"） */
  soundWord: string;
  /** 会不会走路（金鱼是游的：不舔爪子、不挠痒痒……动作库按这个过滤） */
  hasLegs: boolean;
  /** 特有动作（姿势参数 special / special2 / special3 分别代表什么），给动作配置和调试看 */
  specialMoves: string[];
}

export const SPECIES: Record<PetSpecies, SpeciesInfo> = {
  cat: {
    id: 'cat', label: '黑猫', icon: '🐈‍⬛', defaultName: '煤球', description: '傲娇又黏人的小黑猫，会巡视、偷看、捣乱',
    selfName: '本喵', soundWord: '喵', hasLegs: true, specialMoves: [],
  },
  hamster: {
    id: 'hamster', label: '仓鼠', icon: '🐹', defaultName: '团子', description: '圆滚滚的奶黄仓鼠，爱鼓腮帮子、洗脸、囤东西',
    selfName: '本仓鼠', soundWord: '吱', hasLegs: true, specialMoves: ['鼓腮帮子'],
  },
  shiba: {
    id: 'shiba', label: '柴犬', icon: '🐕', defaultName: '小柴', description: '笑眯眯的柴犬，会作揖、赖地耍赖、开心了尾巴转成螺旋桨',
    selfName: '本汪', soundWord: '汪', hasLegs: true, specialMoves: ['作揖拜拜', '赖地耍赖', '螺旋桨尾巴'],
  },
  goldfish: {
    id: 'goldfish', label: '金鱼', icon: '🐟', defaultName: '墨墨', description: '熊猫配色的狮头金鱼，在桌面上空游来游去、吐泡泡',
    selfName: '本鱼', soundWord: '咕噜', hasLegs: false, specialMoves: ['吐泡泡'],
  },
};

export const SPECIES_LIST = Object.values(SPECIES);

export function speciesInfo(id: string | undefined): SpeciesInfo {
  return SPECIES[(id ?? 'cat') as PetSpecies] ?? SPECIES.cat;
}

/**
 * 把猫的台词换成当前动物的口吻：本喵 → 本汪、喵～ → 汪～、黑猫 → 柴犬……
 * 预生成的语音是每种动物单独生成的，这里只处理气泡文字（代码和配置里写的保底台词都是猫的口吻）
 */
export function adaptTextToSpecies(text: string, species: SpeciesInfo): string {
  if (species.id === 'cat' || !text) return text;
  return text
    .replace(/本喵/g, species.selfName)
    .replace(/小黑猫|黑猫/g, `小${species.label}`)
    .replace(/猫猫拳/g, species.id === 'shiba' ? '狗狗拳' : species.id === 'hamster' ? '仓鼠拳' : '鱼鱼拳')
    .replace(/喵呜/g, `${species.soundWord}${species.soundWord}`)
    .replace(/喵/g, species.soundWord);
}
