// 技能菜单（右键猫弹出）：所有技能统一在这里注册，以后加截屏、AI 对话只需要加一项
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';

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

export type SkillMenuEntry = CatSkill | { type: 'separator' };

const isSeparator = (entry: SkillMenuEntry): entry is { type: 'separator' } => 'type' in entry;

/** 用系统原生菜单弹出技能列表（原生菜单可以超出猫咪窗口的范围） */
export async function showSkillMenu(entries: SkillMenuEntry[], onComingSoon: (skill: CatSkill) => void): Promise<void> {
  const items = await Promise.all(entries.map(entry => {
    if (isSeparator(entry)) return PredefinedMenuItem.new({ item: 'Separator' });
    const text = `${entry.icon}  ${entry.label}${entry.comingSoon ? '（即将推出）' : ''}`;
    const action = () => (entry.comingSoon ? onComingSoon(entry) : entry.run?.());
    if (entry.isChecked) return CheckMenuItem.new({ id: entry.id, text, checked: entry.isChecked(), action });
    return MenuItem.new({ id: entry.id, text, action });
  }));
  const menu = await Menu.new({ items });
  await menu.popup();
}
