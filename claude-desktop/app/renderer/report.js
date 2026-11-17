'use strict';
// 独立「环境检查报告」窗口的渲染层。
// 与主窗口完全解耦：这里不碰 webview / 不碰桌面，检测过程只是一次只读的
// check-env.sh 调用，所以报告开着的时候桌面照常可用。

const $ = (id) => document.getElementById(id);
const MARK = { pass: '✓', warn: '!', fail: '✕', info: 'i' };
const STATUS_LABEL = { pass: '通过', warn: '注意', fail: '失败', info: '信息' };

let lastData = null;
let lastRaw = '';
let lastError = '';
let showAll = false;
let lastTime = '';

function panelMessage(text, isError) {
  const d = document.createElement('div');
  d.className = 'cp-empty' + (isError ? ' msg' : '');
  d.textContent = text;
  $('cpBody').appendChild(d);
}

function renderVerdict(summary, cc) {
  const { pass, warn, fail } = summary;
  const v = $('cpVerdict');
  let kind = 'ok', text = '全部通过，各维度指向同一环境';
  if (fail > 0) { kind = 'err'; text = `发现 ${fail} 项必须修复，修好再登录 Claude`; }
  else if (warn > 0) { kind = 'warn'; text = `环境可用，但有 ${warn} 项需要留意`; }
  v.className = 'cp-verdict ' + kind;

  const label = document.createElement('span');
  label.textContent = text;
  const pills = document.createElement('div');
  pills.className = 'pills';
  [['pass', '通过', pass], ['warn', '注意', warn], ['fail', '失败', fail]].forEach(([k, name, n]) => {
    if (!n) return;
    const p = document.createElement('span');
    p.className = 'pill ' + k;
    p.textContent = `${name} ${n}`;
    pills.appendChild(p);
  });
  // 检测站那个百分比是「扣了多少分」，直接给同一口径的数字，
  // 免得出现「报告全绿、去网站一看 41 分」对不上。
  if (cc && cc.total > 0) {
    const p = document.createElement('span');
    p.className = 'pill cc';
    p.textContent = `检测站口径 ${cc.total} 分`;
    p.title = `服务端可观测 ${cc.serverSide} 分 + 浏览器侧探活 ${cc.browserSide} 分`;
    pills.appendChild(p);
  }
  v.append(label, pills);
}

function renderItem(it) {
  const row = document.createElement('div');
  row.className = 'ci ' + (it.status || 'info');
  const mark = document.createElement('div');
  mark.className = 'ci-mark';
  mark.textContent = MARK[it.status] || '·';
  const body = document.createElement('div');
  body.className = 'ci-body';
  const top = document.createElement('div');
  top.className = 'ci-top';
  const lb = document.createElement('span');
  lb.className = 'ci-label';
  lb.textContent = it.label || '';
  const val = document.createElement('span');
  val.className = 'ci-value';
  val.textContent = it.value || '';
  top.append(lb, val);
  body.appendChild(top);
  if (it.detail) {
    const det = document.createElement('div');
    det.className = 'ci-detail';
    det.textContent = it.detail;
    body.appendChild(det);
  }
  if (it.advice) {
    const adv = document.createElement('div');
    adv.className = 'ci-advice';
    adv.textContent = it.advice;
    body.appendChild(adv);
  }
  row.append(mark, body);
  return row;
}

const isIssue = (it) => it.status === 'fail' || it.status === 'warn';

function paintBody() {
  const d = lastData;
  if (!d) return;
  const body = $('cpBody');
  body.innerHTML = '';

  if (!d.runtimeUp) {
    const banner = document.createElement('div');
    banner.className = 'cp-banner';
    banner.textContent = '虚拟环境当前没有运行，部分项目无法检测。先在主窗口启动环境，再回来重新检测。';
    body.appendChild(banner);
  }

  const groups = d.groups || [];
  const all = groups.flatMap((g) => g.items || []);
  const problems = all.filter(isIssue).length;
  const onlyIssues = !showAll && problems > 0;

  const visible = groups
    .map((g) => ({ title: g.title, items: (g.items || []).filter((it) => !onlyIssues || isIssue(it)) }))
    .filter((g) => g.items.length);

  if (!visible.length) {
    const d0 = document.createElement('div');
    d0.className = 'cp-empty';
    d0.textContent = problems ? '没有需要处理的项目' : '本次没有检测到结果';
    body.appendChild(d0);
  }
  visible.forEach((g) => {
    const box = document.createElement('div');
    box.className = 'cp-group';
    const t = document.createElement('div');
    t.className = 'cp-group-title';
    t.textContent = g.title;
    box.appendChild(t);
    g.items.forEach((it) => box.appendChild(renderItem(it)));
    body.appendChild(box);
  });

  const btn = $('cpFilter');
  const passes = all.length - problems;
  if (problems === 0 || passes === 0) btn.hidden = true;
  else {
    btn.hidden = false;
    btn.textContent = showAll ? `只看需要处理的 ${problems} 项` : `显示全部 ${all.length} 项`;
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 导出成一份可独立打开的静态 HTML（内联样式，不依赖应用里的 styles.css）。 */
function buildExportHtml() {
  const d = lastData;
  const rows = [];
  rows.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">');
  rows.push('<title>Claude VM 环境检查报告</title><style>');
  rows.push('body{font-family:-apple-system,"Segoe UI",sans-serif;background:#14161a;color:#e6e8ec;margin:0;padding:32px;line-height:1.6}');
  rows.push('h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:24px 0 8px;color:#9aa4b5;border-bottom:1px solid #2a2f38;padding-bottom:6px}');
  rows.push('.sub{color:#8b93a3;font-size:12px;margin-bottom:20px}.pill{display:inline-block;border:1px solid #2a2f38;border-radius:999px;padding:2px 10px;margin-right:6px;font-size:12px}');
  rows.push('.pill.pass{color:#7fd392}.pill.warn{color:#e5c07b}.pill.fail{color:#f08b84}.pill.cc{color:#8ab4f8}');
  rows.push('.item{border:1px solid #232833;border-radius:8px;padding:10px 12px;margin:6px 0}');
  rows.push('.item.fail{border-left:3px solid #f08b84}.item.warn{border-left:3px solid #e5c07b}.item.pass{border-left:3px solid #7fd392}');
  rows.push('.t{font-weight:600;font-size:13px}.v{float:right;color:#c7cedb;font-size:12px}.d,.a{font-size:11.5px;color:#8b93a3;margin-top:4px}.a{color:#b9c2d0}');
  rows.push('pre{background:#0f1115;border:1px solid #232833;border-radius:8px;padding:12px;overflow:auto;font-size:11px;color:#aab2c0}');
  rows.push('</style></head><body>');
  rows.push('<h1>Claude VM · 环境检查报告</h1>');
  rows.push(`<div class="sub">生成时间 ${esc(lastTime)} ｜ 画像 ${esc(d ? d.regionLabel : '')} ｜ 出口链路：容器内 mihomo + TUN</div>`);
  if (d) {
    const s = d.summary || {};
    rows.push('<div>');
    ['pass', 'warn', 'fail', 'info'].forEach((k) => {
      if (s[k]) rows.push(`<span class="pill ${k}">${STATUS_LABEL[k]} ${s[k]}</span>`);
    });
    if (d.checkcc && d.checkcc.total > 0) rows.push(`<span class="pill cc">检测站口径 ${d.checkcc.total} 分</span>`);
    rows.push('</div>');
    if (!d.runtimeUp) rows.push('<p class="a">注意：生成报告时虚拟环境未在运行，部分项目无法检测。</p>');
    for (const g of d.groups || []) {
      rows.push(`<h2>${esc(g.title)}</h2>`);
      for (const it of g.items || []) {
        rows.push(`<div class="item ${esc(it.status)}">`);
        rows.push(`<div class="t">${STATUS_LABEL[it.status] || ''} · ${esc(it.label)}<span class="v">${esc(it.value)}</span></div>`);
        if (it.detail) rows.push(`<div class="d">${esc(it.detail)}</div>`);
        if (it.advice) rows.push(`<div class="a">建议：${esc(it.advice)}</div>`);
        rows.push('</div>');
      }
    }
  } else {
    rows.push(`<p class="a">${esc(lastError || '本次没有拿到结构化结果')}</p>`);
  }
  if (lastRaw) rows.push(`<h2>原始输出</h2><pre>${esc(lastRaw)}</pre>`);
  rows.push('</body></html>');
  return rows.join('\n');
}

function render(res) {
  lastRaw = res ? (res.raw || res.out || '') : '';
  lastTime = new Date().toLocaleString();
  $('cpSub').textContent = `对照风控维度逐项核对镜像、出口与指纹 · ${lastTime}`;
  $('cpRaw').textContent = lastRaw;
  $('cpRawToggle').disabled = !lastRaw;
  $('cpRaw').hidden = true;
  $('cpRawToggle').textContent = '原始输出';
  $('cpBody').innerHTML = '';
  $('cpVerdict').className = 'cp-verdict';
  $('cpVerdict').innerHTML = '';
  lastData = null;
  showAll = false;

  if (!res || res.ok !== true || !res.data) {
    lastError = (res && (res.error || res.out)) || '检查失败，未获取到结果。';
    $('cpVerdict').className = 'cp-verdict err';
    const v = document.createElement('span');
    v.textContent = '无法完成检查';
    $('cpVerdict').appendChild(v);
    panelMessage(lastError, true);
    $('rpNote').textContent = '检查未完成';
    return;
  }
  const d = res.data;
  const s = d.summary || { pass: 0, warn: 0, fail: 0, info: 0 };
  renderVerdict(s, d.checkcc);
  lastData = d;
  paintBody();
  $('rpNote').textContent = `${s.pass || 0} 通过 · ${s.warn || 0} 注意 · ${s.fail || 0} 失败`;
}

async function doCheck() {
  const rerun = $('cpRerun');
  if (rerun.disabled) return;
  rerun.disabled = true;
  $('cpFilter').hidden = true;
  $('cpRaw').hidden = true;
  $('cpRawToggle').disabled = true;
  $('cpExport').disabled = true;
  $('cpVerdict').className = 'cp-verdict';
  $('cpVerdict').textContent = '检测中…';
  $('cpBody').innerHTML = '';
  $('rpNote').textContent = '正在检测';
  try {
    render(await window.api.check());
  } catch (error) {
    render({ ok: false, error: error?.message });
  } finally {
    rerun.disabled = false;
    $('cpExport').disabled = false;
  }
}

// ---------- 初始化 ----------
if (!window.api) {
  window.__noop = true;
} else {
  $('cpRerun').addEventListener('click', doCheck);
  $('cpFilter').addEventListener('click', () => { showAll = !showAll; paintBody(); });
  $('cpRawToggle').addEventListener('click', () => {
    const raw = $('cpRaw');
    raw.hidden = !raw.hidden;
    $('cpRawToggle').textContent = raw.hidden ? '原始输出' : '收起原始输出';
  });
  $('cpExport').addEventListener('click', async () => {
    const btn = $('cpExport');
    btn.disabled = true;
    $('cpRerun').disabled = true;
    const old = btn.textContent;
    btn.textContent = '正在导出…';
    try {
      const r = await window.api.exportReport(buildExportHtml());
      $('rpNote').textContent = r && r.ok ? '报告已保存' : (r && r.canceled ? '已取消导出' : '导出失败');
    } catch (e) {
      $('rpNote').textContent = '导出失败：' + (e && e.message);
    } finally {
      btn.disabled = false;
      $('cpRerun').disabled = false;
      btn.textContent = old;
    }
  });
  doCheck();
}
