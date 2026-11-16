# 文档变更日志

> append-only，只追加不改写。格式参考 llm-wiki：`## [日期] 动作 | 标题`。
> 记录文档结构变更与重要知识更新；代码提交历史看 `git log`。

## [2026-11-16] restructure | 拆分 开发交接.md 到 doc/ 技术文档 wiki

- 来源：`开发交接.md`（730 行，1.0.37）。原始全文复制到 `doc/raw/开发交接-原始全文-20261116.md`，只读保留。
- 建立分类：`overview/` `network/` `desktop/` `platform/` `engineering/` `security/` `pitfalls/` `decisions/` `references/`。
- 建立 `doc/index.md`（内容目录 + 维护约定）与本日志。
- 分流原则：机制与「当前做法」写主题文档；22 个踩坑实录原文按类归入 `pitfalls/` 五个文件，主题文档只引用坑编号，不复制全文。
- 新增决策记录 4 篇、外部参考 2 篇：把此前只在会话里的调研结论（Claude Cage、OrbStack、防封 PDF、arm64、TUN 架构纠正）固化下来。
- 待办：更新 `README.md` / `claude-vm/README.md` / `build/pack-dev-src.py` 的引用与源码包白名单。

## [2026-11-16] knowledge | 内置 Mihomo + TUN 架构纠正（坑 22）

- 结论：容器内自带内核 + YAML + TUN，宿主 Clash 只是编辑 YAML 的辅助工具，不进运行时链路。
- 产品脚本端到端实测通过（DNS 归属 198.19.0.4、三源出口一致、杀内核立刻断）；详见 `build/TUN-SPIKE-结果.md` 第四轮。
- 归档到 `network/02-TUN与Mihomo.md` 与 `decisions/03-网络架构演进.md`。

## [2026-11-16] knowledge | 一键环境重置落地（坑 21）

- 顺序硬约束：先 `stopRuntime()` 再 `destroyAll()`；两后端销毁语义不同；界面两段式确认。
- 归档到 `security/02-一键环境重置.md`。

## [2026-11-09] knowledge | 输入法定案 fcitx5 + 零候选修复（坑 18/19/20）

- IBus 面板到天花板 → 换 fcitx5（换壳不换引擎）；CJK 扩展 B 区补 HanaMin；零候选时关 client preedit 保住候选窗。
- 归档到 `desktop/01-输入法.md` 与 `pitfalls/03-输入法.md`。

---
*最后更新: 2026-11-16*
