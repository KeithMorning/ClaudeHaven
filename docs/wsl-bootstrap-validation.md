# WSL 2 首次引导验证记录

日期：2026-11-19  
代码基线：实施前本地 `main`，起始提交 `ed93519`；工作树起始时干净。  
验证范围：官方 WSL x64 MSI 下载、大小、SHA-256、Authenticode；源码级探测/状态逻辑与 mock-safe 单元测试。

## 当前实现

- 普通应用进程不提权。用户点击「配置 WSL 2」后才会下载或进入系统组件安装流程。
- 复用已有 WSL 2。已注册的发行版只是探测线索，初始化还会检查系统组件状态或正在运行的 WSL 2 发行版。探测不会启动、关闭或注销其他发行版。后台只对正在运行的 `claude-vm` 执行 `/bin/true`，停止状态下的最终探针由用户启动运行时触发。
- `wsl --version`（WSL 软件引擎版本）与 `wsl --list --verbose`（各发行版 WSL 1/2 架构）分别读取；另检查 WSL Appx/MSI 注册信息，避免把已安装的较新 WSL 当成缺失而降级。没有默认发行版不会被当作 WSL 未安装。
- WSL 运行时缺失时只使用固定清单里的微软官方 `3.0.5` x64 MSI；离线选择也必须通过相同文件大小、SHA-256 与 Microsoft Authenticode 校验。未经验证的文件不会进入提权安装流程。
- 受限 PowerShell 助手在提权后创建独立暂存目录，复核所有者和权限，再复制并验证 MSI。安装诊断保留原始 Windows 退出码，3010/1641 会进入待重启状态。
- 安装状态原子保存。应用重开后确认旧任务已不再运行时，会允许重试。待重启状态只有在读到可靠的新系统启动时间并重新探测后才会更新。
- `claude-vm` 已注册但为 WSL 1 时停止并提示，不自动转换、覆盖或注销。
- 初始化前会查询运行时数据目录所在卷的剩余空间；当前以 3 GB 作为保守拦截阈值。该阈值不是实机测得的精确导入占用，需在 Phase A 记录不同 RootFS 的峰值空间后校准。

## 官方 MSI 实测

资产：`wsl.3.0.5.0.x64.msi`，来自微软 WSL GitHub Release 3.0.5。  
固定清单大小：367,788,032 字节。  
SHA-256：`2313efc5873e3f8552f42e77f950fabd913c0289078fa89d2100f3421a525eaa`。  
本次下载实测大小：367,788,032 字节。  
本次哈希：与固定清单匹配。  
Authenticode：`Valid`；签名者 `Microsoft Corporation`。  
复现脚本：[verify-wsl-release.ps1](../claude-tauri/scripts/verify-wsl-release.ps1)。脚本只下载并验证，不安装、不启用 Windows 功能、不重启。

## 当前开发机只读观察

- `wsl.exe --version` 成功，输出 WSL 软件版本 `2.6.1.0`。这不是发行版的 WSL 1/2 架构版本。
- `wsl.exe --list --verbose` 在 Codex 执行环境返回 `Wsl/E_ACCESSDENIED`，无法用本次环境核对发行版列表或做 `claude-vm` 实机探针。
- `Get-CimInstance` 在当前命令执行环境也返回 CIM 访问拒绝。因此实现改为从本机运行时 API / 注册表读取 OS 版本与 build；Hypervisor、固件虚拟化及 Windows 可选功能探测失败时保留为“未知”，不据此断言硬件不支持。
- 本次没有运行 MSI，没有调用 DISM 启用组件，没有触发 UAC，也没有重启或修改 Windows 功能。

## Phase A 未完成项

当前没有可用的干净 Windows x64 测试机或已授权的可回滚测试 VM。所以下列内容**尚未实测**，不能视作通过：

1. Windows 10 build 19041 与 Windows 11 的最低支持基线（19041 目前来自微软公开安装文档，未在本项目 MSI 路径上实测）。
2. MSI 安装、VirtualMachinePlatform 启用次序、普通用户导入自定义 RootFS、重启续接、实际每次 UAC 数量。
3. 下载中断续传、代理环境、企业策略、磁盘空间临界值和其他 WSL 发行版并发运行。
4. Win10 家庭版/专业版、中文/英文系统，以及错误 0x80370102 等虚拟化故障提示。

实机验证需要使用干净快照/专用 VM，确认可回滚后再由操作者明确授权启用系统组件、安装 MSI 和重启。不得用本机现有发行版代替干净系统测试，也不要在验证时执行 `wsl --shutdown` 或注销其他发行版。

参考：[微软 WSL 安装文档](https://learn.microsoft.com/windows/wsl/install)、[WSL 命令参考](https://learn.microsoft.com/windows/wsl/basic-commands)、[WSL 3.0.5 官方资产](https://github.com/microsoft/WSL/releases/expanded_assets/3.0.5)。

## 自动化结果

在 Windows 开发环境执行：

```powershell
cd claude-tauri\src-tauri
cargo test
```

最近一次运行通过 32 项，跳过 6 项需要真实 WSL 环境的集成测试。新增回归覆盖首次配置的空闲状态、HEAD 文件大小判断、重启标识与 WSL 就绪判定。前端 JavaScript 和探测、安装、校验用 PowerShell 脚本也通过语法检查。
