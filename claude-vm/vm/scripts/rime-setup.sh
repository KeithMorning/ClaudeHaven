#!/usr/bin/env bash
# ============================================================
# rime-setup.sh — 按需安装 fcitx5 + Rime（万象拼音 Pure 词库）
#
# 为什么是 fcitx5 而不是 IBus（1.0.34 起）：
#   WSLg 不转发 Windows IME 的 preedit 组合串，但**按键本身是转发的**。
#   所以把输入法放在虚拟机内部跑，组合与提交都在 Linux 侧完成，不碰 Windows IME。
#   1.0.31~1.0.33 用 IBus + ibus-gtk3，输入能进了，但 IBus 的候选面板在 VNC
#   串流里有天花板：候选窗不跟光标（钉在屏幕左下角）、竖排老式 1-9 样式、
#   面板字体回退失败出豆腐块 —— 都是 IBus 面板自身的问题，调参无解。
#   fcitx5 的面板（classicui）跟手、横排候选、字体正常，是国内 Linux 桌面
#   事实标准；Rime 引擎与万象词库原样复用，只是换壳。
#   注意 fcitx5 5.0 起没有 XIM 前端 —— 主链路本来就是 GTK3 im module
#   （lxterminal / Chrome 走 GTK_IM_MODULE=fcitx），不需要 XIM。
#
# 为什么按需联网装、而不是塞进 rootfs：
#   WSL 发行版的文件系统是持久的，装一次就一直在；不必重打 720MB 的 rootfs。
#   1.0.35 起 apt 部分：fcitx5 系（约 20MB）+ fonts-hanazono（22MB，约 52MB 落盘）。
#   **这个字体包是特意加的**：万象词库含 CJK 扩展 B 区生僻字（U+20000+），
#   镜像自带 Noto Sans SC/TC 是子集、覆盖不到 → 候选窗画方框。HanaMinA/B
#   家族名「花園明朝」不在 checkcc 名单，且不改变默认 sans / 中文匹配。
#   --no-install-recommends 保证不带进任何**名单内**中文字体包
#   （fonts-noto-cjk-extra 214MB 且家族名直接命中名单，禁止使用）。
#   词库 zip 已随安装包放在 /opt/assets/rime，离线解压，不依赖 GitHub 可达性。
#
# 关于「换成万象词库有没有影响」：
#   词库是 Rime 的 .dict.yaml/.schema.yaml 数据文件，检测站看不到输入法，
#   也看不到打进 Claude Code 的字；它不影响时区/语言/字体/出口任何一项，评分不变。
#   唯一代价是体积（zip 26MB / 解压约 75MB / 编译产物约 59MB）与首次编译耗时。
# ============================================================
set -u

[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env

need=0
command -v fcitx5 >/dev/null 2>&1 || need=1
# X11 模块属于推荐依赖，--no-install-recommends 不会自动安装；缺少它时
# classicui 无法连接 X server 并在 tint2 托盘显示输入法状态。
[ -f /usr/share/fcitx5/addon/xcb.conf ] || need=1
[ -f /usr/share/rime-data/stroke.schema.yaml ] || need=1
# GTK3 原生输入模块 + GTK 终端。缺了 im-fcitx5.so，GTK 应用会整体
# 降级到 XIM（fcitx5 没有 XIM 前端 = 输入直接哑掉）；缺了 lxterminal 就没终端。
ls /usr/lib/*/gtk-3.0/*/immodules/im-fcitx5.so >/dev/null 2>&1 || need=1
command -v lxterminal >/dev/null 2>&1 || need=1
# 1.0.35：万象词库含大量 CJK 扩展 B 区生僻字（地名/古字），Noto Sans SC/TC
# 是子集字体覆盖不到 → 候选窗画成方框。必须有一个覆盖 U+20000+ 的字体。
# 用「该码位是否有字体覆盖」判定，而不是查包/文件，和具体字体包解耦。
fc-list ':charset=20000' family 2>/dev/null | grep -qi . || need=1

if [ "$need" = "1" ]; then
  echo "[rime] 首次启用：安装 fcitx5 / Rime / 扩展区字形 / GTK 前端 / lxterminal…"
  export DEBIAN_FRONTEND=noninteractive
  # Reuse packages unpacked before an interrupted guest startup.
  if [ -n "$(dpkg --audit 2>/dev/null)" ]; then
    if ! dpkg --configure -a >/tmp/rime-setup.log 2>&1; then
      echo "[rime] 无法继续上次中断的包配置，详见 /tmp/rime-setup.log"
      exit 1
    fi
  fi
  apt-get update -qq >/dev/null 2>&1
  # 字体策略（1.0.35）：中文主体仍靠镜像自带的 Noto Sans SC/TC（不在 checkcc
  # 指纹名单）。但它们是子集，缺 CJK 扩展 B 区（U+20000+）字形，而万象词库
  # 把 𤻌/𦯏/𦰖/𦷵 这类生僻字排进高频候选 → 候选窗全是方框。
  # 选 fonts-hanazono（22MB，HanaMinA/B，家族名「花園明朝」不在 22 个名单家族里），
  # 不装 fonts-noto-cjk-extra（214MB 且 "Noto Sans CJK SC/TC" 直接命中名单扣分）。
  # 字体回退是按需的：Noto 已有的字仍走 Noto，只有缺字形的才落到 HanaMin。
  # --no-install-recommends 依旧保证不带进任何名单内中文字体包。
  if ! apt-get install -y --no-install-recommends \
        fcitx5 fcitx5-rime fcitx5-frontend-gtk3 fcitx5-module-xorg rime-data-stroke lxterminal \
        fonts-hanazono \
        >/tmp/rime-setup.log 2>&1; then
    echo "[rime] 安装失败，详见 /tmp/rime-setup.log"
    exit 1
  fi
  fc-cache -f >/dev/null 2>&1 || true
  echo "[rime] 安装完成（扩展区字形已覆盖，名单内字体零引入）"
fi

# ---- 万象拼音 Pure 词库（离线解压）----
# 来源：amzxyz/rime_wanxiang v18.1.8 Pure，CC BY 4.0（包内自带 README/许可说明）。
# 为什么选 Pure：Base / Pro / Lite 都依赖 librime 的 Lua 插件，而 Ubuntu 22.04
# 只有 librime 1.7.3；Pure 官方定位就是「老系统 / 旧 Rime / 无 Lua 环境」。
# 实测在 1.7.3 上成功编译出 wanxiang_pure.table.bin（约 59MB）。
# 使用系统 OpenCC 的繁转简规则统一候选文字。
# fcitx5-rime 的用户数据目录是 ~/.local/share/fcitx5/rime（ibus-rime 是
# ~/.config/ibus/rime）。1.0.34 起换到 fcitx5 目录；老环境（1.0.31~1.0.33 用
# ibus 部署过万象词库）一次性把数据迁过来，避免 146MB 词库重新解压编译。
RIME_DIR=/root/.local/share/fcitx5/rime
OLD_RIME_DIR=/root/.config/ibus/rime
WANT=/opt/assets/rime/wanxiang-pure.zip
STAMP="$RIME_DIR/.wanxiang-v18.1.8"
mkdir -p "$RIME_DIR"
if [ ! -f "$STAMP" ] && [ -f "$OLD_RIME_DIR/.wanxiang-v18.1.8" ]; then
  echo "[rime] 迁移 ibus 时代的万象词库到 fcitx5 数据目录…"
  # build/ 是编译产物，跨引擎版本不保证兼容，不迁 —— fcitx5-rime 首次使用会重编
  (cd "$OLD_RIME_DIR" && tar cf - --exclude=build .) | (cd "$RIME_DIR" && tar xf -)
  touch "$STAMP"
fi
if [ -f "$WANT" ] && [ ! -f "$STAMP" ]; then
  echo "[rime] 首次部署万象词库（解压约 75MB，首次编译约 1 分钟）…"
  if python3 - "$WANT" "$RIME_DIR" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
z.extractall(sys.argv[2])
print("[rime] 解压完成：%d 个文件" % len(z.namelist()))
PY
  then
    touch "$STAMP"
  else
    echo "[rime] 词库解压失败，将退回 luna_pinyin"
  fi
elif [ ! -f "$WANT" ]; then
  echo "[rime] 警告：未找到 $WANT，将退回系统自带 luna_pinyin"
fi

if [ -f "$RIME_DIR/wanxiang_pure.schema.yaml" ]; then
  SCHEMA=wanxiang_pure
  _schema_custom="$RIME_DIR/wanxiang_pure.custom.yaml"
  # 只迁移 Haven 生成的补丁。精简镜像已删除词典源码，
  # 要在构建新镜像时写入补丁，再编译词典和拼写索引。
  _previous_patch=$(cat <<'YAML'
patch:
  "speller/algebra/+":
    - abbrev/^([zcs]h).+$/$1/
    - abbrev/^([bpmfdtnlgkhjqxzcsryw]).+$/$1/
YAML
  )
  _learning_patch=$(cat <<'YAML'
patch:
  "translator/enable_correction": true
  "translator/contextual_suggestions": true
  "speller/algebra/+":
    # 兼容快速输入时 ng 写反，例如 shagn → shang。
    - derive/^(zh|ch|sh)ang$/$1agn/
    - abbrev/^([zcs]h).+$/$1/
    - abbrev/^([bpmfdtnlgkhjqxzcsryw]).+$/$1/
YAML
  )
  if [ -f "$RIME_DIR/wanxiang_pure.dict.yaml" ]; then
    _existing_patch=
    [ ! -f "$_schema_custom" ] || _existing_patch=$(cat "$_schema_custom")
    if [ ! -e "$_schema_custom" ] || [ "$_existing_patch" = "$_previous_patch" ] ||
      [ "$_existing_patch" = "$_learning_patch" ]; then
      {
        printf '%s\n' "$_learning_patch"
        cat <<'YAML'
  # 替换词库原有的简繁切换项。没有 states 的选项只负责初始化，
  # 不出现在方案菜单里。
  "switches/@4":
    name: haven_simplified
    reset: 1
  "engine/filters":
    - simplifier@haven_simplified
    - simplifier@emoji
    - uniquifier
  haven_simplified:
    option_name: haven_simplified
    opencc_config: /usr/share/opencc/t2s.json
    tips: none
  # 万象 Pure v18.1.8 的最后两个绑定是简繁切换快捷键。
  "key_binder/bindings/@10": null
  "key_binder/bindings/@9": null
YAML
      } > "$_schema_custom"
    fi
  fi

  # 万象的自定义短语只匹配完整编码。优先尊重用户已有的同码设置，
  # 不修改 Rime 记录输入习惯的 userdb。
  _phrases="$RIME_DIR/custom_phrase.txt"
  touch "$_phrases"
  if ! awk -F '\t' '$2 == "l" { found = 1 } END { exit !found }' "$_phrases"; then
    printf '\n了\tl\t1\n' >> "$_phrases"
  fi
  if ! awk -F '\t' '$2 == "xiang" { found = 1 } END { exit !found }' "$_phrases"; then
    printf '\n想\txiang\t3\n向\txiang\t2\n像\txiang\t1\n' >> "$_phrases"
  fi
else
  SCHEMA=luna_pinyin
fi
# fcitx5-rime 的用户数据目录见上（~/.local/share/fcitx5/rime）。
# page_size 必须停在 6：万象 default.yaml 明确写了「候选词个数不得超过 6 个，
# 7890 代表声调」—— 数字键 7/8/9/0 是声调筛选键，不是选字键。
# 之前改成 9 会让第 7~9 个候选看起来在列表里、按数字却选不中。
cat > "$RIME_DIR/default.custom.yaml" <<YAML
patch:
  schema_list:
    - schema: $SCHEMA
  menu:
    page_size: 6
YAML

# fcitx5 的输入法组配置：默认引擎设为 rime（写 profile，无图形界面也能配）。
# 中英文都由 Fcitx 切换，英文键盘下单按 Shift 也能回到 Rime。
mkdir -p /root/.config/fcitx5
# Fcitx 的键盘布局默认标签为小写 en。托盘直接绘制输入法条目的 Label，
# 用用户级静态条目覆盖键盘布局标签；切换与输入逻辑仍由 Fcitx 管理。
mkdir -p /root/.local/share/fcitx5/inputmethod
_keyboard=/opt/assets/config/fcitx5/keyboard-us.conf
[ -f "$_keyboard" ] || _keyboard=/opt/config/fcitx5/keyboard-us.conf
[ ! -f "$_keyboard" ] || cp -f "$_keyboard" /root/.local/share/fcitx5/inputmethod/keyboard-us.conf
# Rime 的中文与内部英文模式使用不同图标名称。把轻量 SVG 放到用户图标
# 目录中，避免依赖发行版默认图标的造型，也避免改变输入法的快捷键。
_icons=/opt/assets/config/fcitx5/icons
[ -f "$_icons/fcitx-rime.png" ] || _icons=/opt/config/fcitx5/icons
if [ -f "$_icons/fcitx-rime.png" ]; then
  _icon_dest=/root/.local/share/icons/hicolor/48x48/apps
  mkdir -p "$_icon_dest"
  # 用户级 hicolor 目录需要主题索引，否则新图标可能无法被 Fcitx 找到。
  [ -f /root/.local/share/icons/hicolor/index.theme ] || cp -f /usr/share/icons/hicolor/index.theme /root/.local/share/icons/hicolor/index.theme
  cp -f "$_icons"/*.png "$_icon_dest"/
  cp -f "$_icons/fcitx-rime-latin.png" "$_icon_dest/fcitx_rime_latin.png"
  cp -f "$_icons/fcitx-rime-latin.png" "$_icon_dest/fcitx_rime_latin_upper.png"
fi
# 安装随应用同步的候选框主题；老安装包没有资源时沿用原主题。
_theme=/opt/assets/config/fcitx5/claude
[ -f "$_theme/theme.conf" ] || _theme=/opt/config/fcitx5/claude
if [ -f "$_theme/theme.conf" ]; then
  mkdir -p /root/.local/share/fcitx5/themes/claude /root/.config/fcitx5/conf
  cp -f "$_theme"/* /root/.local/share/fcitx5/themes/claude/
  _classic=/root/.config/fcitx5/conf/classicui.conf
  touch "$_classic"
  { printf 'Theme=claude\nFont=Sans 12\n'; sed '/^Theme=/d; /^Font=/d' "$_classic"; } > "$_classic.tmp"
  mv -f "$_classic.tmp" "$_classic"
fi
cat > /root/.config/fcitx5/profile <<'PROFILE'
[Groups/0]
Name=Default
Default Layout=us
DefaultIM=rime

[Groups/0/Items/0]
Name=keyboard-us
Layout=

[Groups/0/Items/1]
Name=rime
Layout=

[GroupOrder]
0=Default
PROFILE

# 零候选时 classicui 会把整个候选窗 unmap；而默认的 client preedit 把编码交给
# 应用绘制，候选窗里不显示输入码。两者叠加：输入 ffff 这种非法编码时既没候选、
# 也看不到编码，退格删除全程盲（串流/wslg 两模式一致，与 X server 无关）。
# 关掉「在应用中显示预编辑」，让 classicui 自己画编码：零候选时窗口仍保持
# IsViewable 并显示输入码。配置项来自 fcitx5 核心库的 PreeditEnabledByDefault。
cat > /root/.config/fcitx5/config <<'CONF'
[Hotkey]
AltTriggerKeys=

[Hotkey/TriggerKeys]
0=Super+space
1=Control+space
2=Shift_L
3=Shift_R

[Behavior]
PreeditEnabledByDefault=False
CONF

echo "[rime] 配置完成：$SCHEMA（候选窗在零候选时保持可见，page_size=6）"
exit 0
