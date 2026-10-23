// 认出你在用什么软件：根据程序名和窗口标题分类（只在本地内存里判断，不保存不上传）

export type ActivityCategory =
  | 'chat'      // 聊天：微信、QQ、钉钉、飞书、企业微信
  | 'meeting'   // 开会：腾讯会议、Teams、Zoom
  | 'video'     // 看视频
  | 'shopping'  // 网购
  | 'browser'   // 其它网页
  | 'code'      // 写代码 / 终端
  | 'sheet'     // 表格
  | 'doc'       // 文档 / 笔记
  | 'slides'    // 幻灯片
  | 'music'     // 听歌
  | 'game'      // 游戏
  | 'files'     // 文件管理器
  | 'design'    // 设计软件
  | 'other';

/** 程序名（小写）→ 分类 */
const PROCESS_CATEGORIES: Record<string, ActivityCategory> = {
  'wechat.exe': 'chat', 'weixin.exe': 'chat', 'qq.exe': 'chat', 'tim.exe': 'chat', 'dingtalk.exe': 'chat',
  'feishu.exe': 'chat', 'lark.exe': 'chat', 'wxwork.exe': 'chat', 'telegram.exe': 'chat', 'slack.exe': 'chat', 'discord.exe': 'chat',
  'wemeetapp.exe': 'meeting', 'teams.exe': 'meeting', 'ms-teams.exe': 'meeting', 'zoom.exe': 'meeting',
  'potplayermini64.exe': 'video', 'potplayermini.exe': 'video', 'vlc.exe': 'video', 'bilibili.exe': 'video', 'qqlive.exe': 'video',
  'iqiyi.exe': 'video', 'youku.exe': 'video', 'douyin.exe': 'video',
  'code.exe': 'code', 'cursor.exe': 'code', 'idea64.exe': 'code', 'pycharm64.exe': 'code', 'webstorm64.exe': 'code', 'goland64.exe': 'code',
  'clion64.exe': 'code', 'devenv.exe': 'code', 'sublime_text.exe': 'code', 'notepad++.exe': 'code', 'hbuilderx.exe': 'code',
  'trae.exe': 'code', 'qoder.exe': 'code', 'windowsterminal.exe': 'code', 'powershell.exe': 'code', 'cmd.exe': 'code', 'wechatdevtools.exe': 'code',
  'excel.exe': 'sheet', 'et.exe': 'sheet',
  'winword.exe': 'doc', 'notepad.exe': 'doc', 'typora.exe': 'doc', 'obsidian.exe': 'doc', 'onenote.exe': 'doc', 'wps.exe': 'doc',
  'powerpnt.exe': 'slides', 'wpp.exe': 'slides',
  'cloudmusic.exe': 'music', 'qqmusic.exe': 'music', 'kugou.exe': 'music', 'kwmusic.exe': 'music', 'spotify.exe': 'music',
  'steam.exe': 'game', 'wegame.exe': 'game', 'yuanshen.exe': 'game', 'genshinimpact.exe': 'game', 'league of legends.exe': 'game',
  'explorer.exe': 'files',
  'photoshop.exe': 'design', 'illustrator.exe': 'design', 'figma.exe': 'design', 'blender.exe': 'design',
};

const BROWSER_PROCESSES = new Set(['chrome.exe', 'msedge.exe', 'firefox.exe', '360se.exe', '360chrome.exe', 'qqbrowser.exe', 'sogouexplorer.exe', 'opera.exe', 'brave.exe']);

/** 浏览器里按网页标题再细分 */
const BROWSER_TITLE_RULES: { pattern: RegExp; category: ActivityCategory }[] = [
  { pattern: /哔哩哔哩|bilibili|youtube|优酷|爱奇艺|腾讯视频|抖音|西瓜视频|芒果TV/i, category: 'video' },
  { pattern: /淘宝|天猫|京东|拼多多|taobao|tmall|jd\.com|1688|唯品会|闲鱼/i, category: 'shopping' },
  { pattern: /github|gitlab|gitee|stack ?overflow|csdn|掘金|leetcode|localhost/i, category: 'code' },
  { pattern: /腾讯会议|飞书会议|zoom/i, category: 'meeting' },
  { pattern: /语雀|飞书文档|腾讯文档|石墨|google docs|notion|有道云/i, category: 'doc' },
  { pattern: /微信网页版|web\.whatsapp/i, category: 'chat' },
];

export function classifyActivity(processName: string, title: string): ActivityCategory {
  const process = processName.toLowerCase();
  if (BROWSER_PROCESSES.has(process)) {
    return BROWSER_TITLE_RULES.find(rule => rule.pattern.test(title))?.category ?? 'browser';
  }
  // WPS 是一个程序打开所有文件，按标题里的文件类型区分
  if (process === 'wps.exe') {
    if (/\.(xlsx?|csv|et)\b/i.test(title)) return 'sheet';
    if (/\.(pptx?|dps)\b/i.test(title)) return 'slides';
  }
  if (/会议/.test(title) && process !== 'explorer.exe') return 'meeting';
  return PROCESS_CATEGORIES[process] ?? 'other';
}

/** 这个分类说明你正忙着（打字、开会），提醒要轻一点 */
export function isBusyCategory(category: ActivityCategory): boolean {
  return category === 'code' || category === 'sheet' || category === 'doc' || category === 'slides' || category === 'design';
}

/** 这个分类下猫要保持安静（不出声） */
export function isQuietCategory(category: ActivityCategory): boolean {
  return category === 'meeting';
}

/** 看视频、听歌时提醒不说话，只举牌 */
export function isWatchingCategory(category: ActivityCategory): boolean {
  return category === 'video' || category === 'music' || category === 'game';
}
