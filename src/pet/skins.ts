// 皮肤登记表：每种动物有几套外观（毛色 / 描边 / 高光 / 项圈 / 眼睛颜色），参考真实品种的配色。
// 每套皮肤只写和默认外观不一样的颜色，没写的沿用模型里的默认颜色（见各模型文件里的 DEFAULT_COLORS）。
// 只有资料、不含 3D 代码，设置窗口也能用。
// 以后加皮肤：在这里加一条即可；colors 里的键名要和对应模型的 DEFAULT_COLORS 一致
import type { PetSpecies } from './species';
import type { EyePalette } from './models/modelToolkit';

export interface PetSkin {
  id: string;
  /** 皮肤名字（设置和右键菜单里显示） */
  name: string;
  /** 右键菜单里的小色点 */
  icon: string;
  /** 设置里色块显示的颜色（主色 + 辅色） */
  swatch: [string, string];
  /** 要替换的模型颜色（0xRRGGBB） */
  colors?: Record<string, number>;
  /** 仓鼠 / 柴犬 / 金鱼：眼睛配色（只写要改的部分） */
  eyes?: Partial<EyePalette>;
  /** 黑猫：虹膜从上到下的三段颜色 */
  catIris?: [string, string, string];
}

export const DEFAULT_SKIN_ID = 'default';

export const SKINS: Record<PetSpecies, PetSkin[]> = {
  cat: [
    { id: DEFAULT_SKIN_ID, name: '黑猫', icon: '⚫', swatch: ['#2a2a36', '#e8424f'] },
    {
      id: 'orange', name: '橘猫', icon: '🟠', swatch: ['#f0a050', '#2e6cc4'],
      colors: { fur: 0xeb9a4a, outline: 0x3a1e0c, rim: 0xfff0d0, collar: 0x2e6cc4, whisker: 0xfff6e6 },
      catIris: ['#7a4a08', '#e0a020', '#ffe58a'],
    },
    {
      id: 'white', name: '白猫', icon: '⚪', swatch: ['#f4f1ec', '#e8424f'],
      colors: { fur: 0xf2efea, outline: 0x4a4650, rim: 0xd6e4ff, whisker: 0x8a8a96 },
      catIris: ['#123a7a', '#3f8ce0', '#bfe6ff'],
    },
    {
      id: 'blue', name: '英短蓝猫', icon: '🔵', swatch: ['#7d8796', '#f5c542'],
      colors: { fur: 0x7a8494, outline: 0x1e222a, rim: 0xe0e8ff, collar: 0xf08a2e, whisker: 0xe8ecf4 },
      catIris: ['#7a3a08', '#e8862a', '#ffd28a'],
    },
  ],
  hamster: [
    { id: DEFAULT_SKIN_ID, name: '奶黄', icon: '🟡', swatch: ['#ecbf86', '#fff8ee'] },
    {
      id: 'silver', name: '银狐', icon: '⚪', swatch: ['#d9d6d2', '#ffffff'],
      colors: { cream: 0xdad6d1, earOuter: 0xb9b2ac, white: 0xffffff, outline: 0x4a4440, rim: 0xffffff },
      // 白色的仓鼠是红宝石色的眼睛
      eyes: { rim: '#1a0306', top: '#3a0a12', middle: '#7a1426', bottom: '#c8324a', pupil: '#12020a', reflection: 'rgba(255, 190, 200, .45)', iridescence: undefined },
    },
    {
      id: 'purple', name: '紫仓', icon: '🟣', swatch: ['#9a95a8', '#f4f1f6'],
      colors: { cream: 0x9a94a8, earOuter: 0x7c768c, white: 0xf4f1f6, outline: 0x34303f, rim: 0xf0eaff },
    },
    {
      id: 'pudding', name: '布丁', icon: '🟠', swatch: ['#e8a24a', '#fff2dc'],
      colors: { cream: 0xe6a04a, earOuter: 0xc5802e, white: 0xfff2dc, outline: 0x5a3418, rim: 0xffe6c0 },
    },
  ],
  shiba: [
    { id: DEFAULT_SKIN_ID, name: '赤柴', icon: '🟠', swatch: ['#d8742c', '#2e6cc4'] },
    {
      id: 'black', name: '黑柴', icon: '⚫', swatch: ['#2b2526', '#e0353f'],
      colors: { fur: 0x2d2627, outline: 0x0c0808, rim: 0xffe2c8, collar: 0xe0353f, bell: 0xf5c542, bellRing: 0xf5c542 },
    },
    {
      id: 'white', name: '白柴', icon: '⚪', swatch: ['#f3e6d3', '#2e9c6a'],
      colors: { fur: 0xf2e4d0, cream: 0xfffaf2, outline: 0x6a4a35, rim: 0xffffff, collar: 0x2e9c6a },
    },
    {
      id: 'sesame', name: '胡麻柴', icon: '🟤', swatch: ['#9a6a45', '#3a8f7a'],
      colors: { fur: 0x9c6a44, outline: 0x2a170c, collar: 0x3a8f7a },
    },
  ],
  goldfish: [
    { id: DEFAULT_SKIN_ID, name: '熊猫狮头', icon: '⚫', swatch: ['#1b1b25', '#fff4ea'] },
    {
      id: 'redcap', name: '鹤顶红', icon: '🔴', swatch: ['#fff4ea', '#e8323c'],
      colors: { body: 0xfbf2ea, scale: 0xf2e6dc, head: 0xfff6ee, wen: 0xe8323c, outline: 0x4a3a40, rim: 0xffffff, scaleOutline: 0x8a7a80, scaleRim: 0xffffff,
        finRoot: 0xf0e6e0, finMiddle: 0xf6eee8, finTip: 0xffffff, finRay: 0xc8b8b0 },
    },
    {
      id: 'red', name: '红狮头', icon: '🟠', swatch: ['#e8552a', '#f58a4a'],
      colors: { body: 0xe8552a, scale: 0xf06a3a, head: 0xf27a40, wen: 0xf79a55, mouth: 0xb81c26, outline: 0x3a0a05, rim: 0xffd8a0, scaleOutline: 0x5a1508, scaleRim: 0xffd8a0, gillRed: 0xc22a30,
        finRoot: 0xe04a20, finMiddle: 0xec6a38, finTip: 0xffb080, finRay: 0xffd0a0 },
      eyes: { top: '#1a0d05', middle: '#3a2410', bottom: '#8a6030', reflection: 'rgba(255, 220, 160, .5)' },
    },
    {
      id: 'blue', name: '蓝狮头', icon: '🔵', swatch: ['#4a5a8a', '#dfe6f5'],
      colors: { body: 0x4a5a8a, scale: 0x56679c, head: 0xe2e8f6, wen: 0xeef2fc, outline: 0x10142a, rim: 0xc8dcff, scaleOutline: 0x1a2040, scaleRim: 0xd8e6ff,
        finRoot: 0x3a4a7a, finMiddle: 0x4a5c90, finTip: 0x9fb4e0, finRay: 0xc8d6f4 },
    },
  ],
};

/** 某种动物的某套皮肤；找不到就用默认皮肤 */
export function findSkin(species: PetSpecies, skinId: string | undefined): PetSkin {
  const skins = SKINS[species] ?? SKINS.cat;
  return skins.find(skin => skin.id === skinId) ?? skins[0];
}
