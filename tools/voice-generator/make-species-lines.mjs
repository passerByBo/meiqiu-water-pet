// 由猫的台词清单（voice-lines.json）生成其它动物的台词清单（voice-lines.<种类>.json）：
//   台词 id、分组、情绪都不变（代码按 id / 分组找台词，换了动物不用改代码）；
//   文字换成这种动物的口吻（本喵 → 本仓鼠 / 本汪 / 本鱼，喵 → 吱 / 汪 / 咕噜……），只有猫才说得通的几句单独改写；
//   语气提示里的"小猫咪"换成这种动物，语速按动物性格整体调一下。
// 用法：node make-species-lines.mjs        然后用 generate-voice-lines.mjs --lines=... --output=... 生成语音
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

const SPECIES = {
  hamster: {
    selfName: '本仓鼠', sound: '吱', animal: '小仓鼠', owner: '铲屎官',
    speaker: 'zh_female_mengyatou_uranus_bigtts', speechRateOffset: 6,
    tone: '又软又糯、轻快机灵',
    rewrites: {
      'remind-02': '本仓鼠的小水瓶都快见底了，你的杯子呢？',
      'remind-04': '本仓鼠的腮帮子装满了瓜子，你的肚子装满水了吗？',
      'remind-angry-01': '吱！再不喝水，本仓鼠就把你的零食全部囤走！',
      'teaser-pounce-02': '看本仓鼠的旋风小爪！',
    },
  },
  shiba: {
    selfName: '本汪', sound: '汪', animal: '小柴犬', owner: '铲屎官',
    speaker: 'zh_female_mengyatou_uranus_bigtts', speechRateOffset: 4,
    tone: '元气满满、热情又爱撒娇',
    rewrites: {
      'remind-02': '本汪的水碗都快见底了，你的杯子呢？',
      'remind-04': '本汪最乖了，你也要乖乖喝水哦！',
      'remind-angry-01': '汪！再不喝水，本汪就赖在你键盘上不走了！',
      'teaser-pounce-02': '看本汪的狗狗拳！',
      'hug-start-01': '嘿嘿…抱抱好舒服',
    },
  },
  goldfish: {
    selfName: '本鱼', sound: '咕噜', animal: '小金鱼', owner: '主人',
    speaker: 'zh_female_mengyatou_uranus_bigtts', speechRateOffset: -6,
    tone: '慢悠悠、软软的、有点呆萌',
    rewrites: {
      'remind-02': '本鱼天天泡在水里，你怎么还不喝水呀？',
      'remind-04': '都说金鱼只有七秒记忆，可本鱼一直记得提醒你喝水！',
      'remind-angry-01': '咕噜！再不喝水，本鱼就对着你的屏幕吐泡泡！',
      'teaser-pounce-02': '看本鱼的泡泡攻击！',
    },
  },
};

/** 把猫的口吻换成这种动物的口吻 */
function adaptText(text, species) {
  return text
    .replace(/本喵/g, species.selfName)
    .replace(/呼噜呼噜|喵呜/g, `${species.sound}${species.sound}`)
    .replace(/喵/g, species.sound)
    .replace(/小猫咪|小猫|猫咪/g, species.animal)
    .replace(/铲屎官/g, species.owner);
}

const catLines = JSON.parse(await readFile(path.join(scriptDirectory, 'voice-lines.json'), 'utf8'));
for (const [speciesId, species] of Object.entries(SPECIES)) {
  const emotionStyles = Object.fromEntries(Object.entries(catLines.emotionStyles).map(([emotion, style]) => [emotion, {
    prompt: `${style.prompt.replace(/小猫咪/g, species.animal)}；整体是${species.tone}的感觉`,
    speechRate: Math.max(-50, Math.min(100, style.speechRate + species.speechRateOffset)),
  }]));
  const lines = catLines.lines.map(line => ({ ...line, text: species.rewrites[line.id] ?? adaptText(line.text, species) }));
  const output = {
    description: `${species.animal}的预生成台词清单（由 make-species-lines.mjs 根据猫的台词自动生成，不要手改；要改就改脚本里的规则或改写表）`,
    defaultSpeaker: species.speaker,
    emotionStyles,
    lines,
  };
  const fileName = `voice-lines.${speciesId}.json`;
  await writeFile(path.join(scriptDirectory, fileName), JSON.stringify(output, null, 2) + '\n');
  const changed = lines.filter((line, index) => line.text !== catLines.lines[index].text).length;
  console.log(`${fileName}：${lines.length} 句（${changed} 句换了口吻）`);
}
