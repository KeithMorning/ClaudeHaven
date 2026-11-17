'use strict';

// 伪装画像：只保留两套 —— 台北（中文用户）与洛杉矶（美国本地用户）。
//
// 设计原则（2.0 简化决策）：
//   · 固定两套、手动切换，**不按出口 IP 自动推断时区**。真实出口只有内核起来
//     之后才知道，而 TZ/LANG 在会话启动那一刻就定死了，运行中改不动；
//     自动对齐要么两阶段启动、要么下次启动才生效，都不如让用户按节点挑画像。
//   · 挂 VPN 出境是全球用户日常，出口 IP 不必和时区同地区 —— 风控抓的是
//     「中国时区 / zh-CN / 名单内字体」，不是「时区与 IP 国家是否匹配」。
//   · 不做 Canvas/WebGL/音频假噪音、不随机指纹：开假噪音反而一眼被识破。
//   · 身份（hostname / machine-id）只生成一次，切换画像不重置，避免「像新机器」。
//   · 时区/语言/locale/Chrome 请求头/Chrome UI 语言一起切，保证画像内部自洽。
//     chromeLang 是浏览器语言的唯一真源：主进程以 CHROME_LANG 传进客机，
//     客机脚本不再各自从 LANG 猜（坑 25：四处猜法不齐导致「选了美区还是繁中」）。
//
// persona 会进 cfgFingerprint，切换画像必然触发会话重建 —— 这正是我们要的：
// 不能让旧会话带着旧 locale / 旧 Chrome 实例继续跑。

const list = [
  {
    id: 'tw-taipei',
    name: '中国台湾 · 台北',
    short: '台北',
    tz: 'Asia/Taipei',
    lang: 'zh_TW.UTF-8',
    chromeLang: 'zh-TW',
    label: '中国台湾地区·台北的用户挂 VPN',
    desc: 'UTC+8 作息对齐中文用户，地区标签不在受限名单内；默认画像。',
  },
  {
    // id 保留 'us'：旧 config.json 里可能已存这个值，换 id 会被 byId 兜底成台北。
    id: 'us',
    name: '美国 · 洛杉矶',
    short: '美国',
    tz: 'America/Los_Angeles',
    lang: 'en_US.UTF-8',
    chromeLang: 'en-US',
    label: '美国本地用户（美西）',
    desc: 'UTC-8 美西时区 + 全英文环境，适配洛杉矶（LAX）等美西节点。',
  },
];

const byId = (id) => list.find((p) => p.id === id) || list[0];

/**
 * 把画像应用到配置对象：只写 persona，并清掉 1.0.x 残留的 tz / lang。
 * tz / lang 是画像的派生值，不落盘 —— 运行时由主进程 `byId(cfg.persona)` 取，
 * 存进配置就会出现「画像切了、env 还是旧时区」的分叉（坑 23 的伴生问题）。
 */
function applyTo(cfg, id) {
  const p = byId(id);
  const next = { ...cfg, persona: p.id };
  delete next.tz;
  delete next.lang;
  return next;
}

module.exports = { list, byId, applyTo };
