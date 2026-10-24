// 技能菜单（右键宠物弹出）：所有技能统一在这里注册，以后加截屏、AI 对话只需要加一项
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';

export interface CatSkill {
  id: string;
  icon: string;
  label: string;
  /** 点击后执行 */
  run?: () => void;
  /** 有值时显示为勾选项 */
  isChecked?: () => boolean;
  /** 还没实现的技能：显示"即将推出" */
  comingSoon?: boolean;
}

/** 子菜单（例如"换宠物"下面列出所有宠物） */
export interface SkillSubmenu {
  type: 'submenu';
  id: string;
  icon: string;
  label: string;
  entries: SkillMenuEntry[];
}

export type SkillMenuEntry = CatSkill | SkillSubmenu | { type: 'separator' };

type NativeMenuItem = MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu;

/** 把一组菜单项转成系统原生菜单项（子菜单递归转换） */
async function buildItems(entries: SkillMenuEntry[], onComingSoon: (skill: CatSkill) => void): Promise<NativeMenuItem[]> {
  return Promise.all(entries.map(async (entry): Promise<NativeMenuItem> => {
    if ('type' in entry && entry.type === 'separator') return PredefinedMenuItem.new({ item: 'Separator' });
    if ('type' in entry && entry.type === 'submenu') {
      return Submenu.new({ id: entry.id, text: `${entry.icon}  ${entry.label}`, items: await buildItems(entry.entries, onComingSoon) });
    }
    const skill = entry as CatSkill;
    const text = `${skill.icon}  ${skill.label}${skill.comingSoon ? '（即将推出）' : ''}`;
    const action = () => (skill.comingSoon ? onComingSoon(skill) : skill.run?.());
    if (skill.isChecked) return CheckMenuItem.new({ id: skill.id, text, checked: skill.isChecked(), action });
    return MenuItem.new({ id: skill.id, text, action });
  }));
}

/** 用系统原生菜单弹出技能列表（原生菜单可以超出宠物窗口的范围） */
export async function showSkillMenu(entries: SkillMenuEntry[], onComingSoon: (skill: CatSkill) => void): Promise<void> {
  const menu = await Menu.new({ items: await buildItems(entries, onComingSoon) });
  await menu.popup();
}
