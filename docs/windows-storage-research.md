# Windows 上直接挂载压缩 RootFS

日期 2026-11-19。先核对微软和 Linux 上游的文档与源码，再用本机 Windows x64 和隔离的 WSL 2 测试发行版验证原型。

## 原型实测

环境为 WSL 2.6.1.0，内核 `6.6.87.2-microsoft-standard-WSL2`。系统镜像取自仓库现有的 675,493,802 字节 Windows RootFS。转换前清理 npm 下载缓存与日志，并修正旧镜像中指向不存在的 `claude.exe` 的启动链接。普通 XZ 样品为 459,223,040 字节，加入 x86 BCJ 过滤后为 448,368,640 字节。

| 文件 | 字节 |
| --- | ---: |
| 只读系统镜像，XZ + x86 BCJ | 448,368,640 |
| 只读配套资源镜像 | 43,659,264 |
| 最小引导归档 | 3,635,671 |
| 导入并运行挂载验证后的 `ext4.vhdx` | 79,691,776 |
| 当前 Windows 程序 | 15,657,472 |
| 配套脚本 | 165,725 |
| 原型合计 | **591,178,548** |

合计是实际文件长度之和，未计安装器、预先安装的共享 WSL 平台及完整桌面首次启动写入。Windows `GetCompressedFileSizeW` 实测原型 VHDX 的占用与表中长度一致。当前已有约 8.8 MB 余量，**完整首次运行尚未通过 600 MB 验收**。

[系统镜像构建脚本](../claude-vm/probe-compressed-rootfs.sh)、[最小引导构建脚本](../claude-vm/probe-wsl-bootstrap.sh)和[挂载验证脚本](../claude-vm/probe-compressed-mount.sh)记录了可复现的步骤。隔离发行版从 Windows E 盘通过 DrvFs、loop 设备和 SquashFS 直接读取系统镜像。验证运行了 Chrome 156.0.8078.79、Node 20.18.1 和 Claude Code 2.1.197 的版本命令。脚本验证了系统写入只进入 ext4 可写层，单独绑定的资料目录和系统写入在重挂载后仍可读取。Chrome 图形启动、沙箱、输入法和网络守卫尚未进行端到端验证。

当前 Windows 归档缺少 fcitx5 和 LXTerminal，启动脚本会按需安装。两套字体原文件合计 29,714,268 字节，启动会再复制到系统字体目录。万象词库 ZIP 内的文件共 79,889,433 字节，脚本还会展开并编译词库。如果沿用现有启动逻辑，很容易超出原型剩余空间。下一版应在构建时安装输入法依赖、预编译静态词库、把字体和词库只放在压缩镜像里。用户词库与配置单独持久化。还可验证预制的动态 VHDX 能否降低最小引导盘的固定开销。发布前以完整桌面第一次启动并停止后的主机占用为准。

## 第二轮构建

`claude-vm/build-windows-squashfs.sh` 将输入法、字体和预编译词库直接放进只读镜像。构建时安装依赖，并在打包前删除词库 ZIP、编译产物对应的静态词库源文件、下载缓存和桌面用不到的硬件 Vulkan 驱动。保留软件渲染所需的 Mesa 组件。构建目录需要位于 Linux ext4 文件系统，以保留权限和属性。

```bash
sudo bash claude-vm/build-windows-squashfs.sh \
  claude-tauri/runtime/rootfs.tar.gz dist/haven-windows-slim.squashfs
sudo bash claude-vm/probe-compressed-mount.sh \
  "$(realpath dist/haven-windows-slim.squashfs)" --offline-input
```

现行 Windows 启动流程仍使用归档和 WSL 导入。新的 NSIS 安装包启用 LZMA。新建环境从已校验的资源目录链接中文字体，避免在 WSL 中再写入两份字体文件，约节省 29.7 MB。已有字体副本仍可使用。

预装输入法的镜像初版为 506,585,088 字节。移除硬件 Vulkan 驱动后为 499,023,872 字节。后者在隔离 WSL 中通过了只读挂载、TigerVNC 显示启动、Chrome 和 Claude Code 版本命令、字体识别、输入法文件存在检查以及可写数据重挂载检查。

按文件长度计算，精简后的镜像、引导归档、测试 VHDX、Windows 程序和去重后的少量配套资源共 600,049,030 字节。以 700,000,000 字节为预算，约有 100 MB 供完整首次启动的写入使用。该口径按 Windows 已安装共享 WSL 平台计算。完整 Tauri 启动链路、网络守卫和输入法实际输入仍需验收，不能将文件长度合计视为完整桌面的磁盘实测。

## 挂载路径

Windows 固定盘上的 `rootfs.squashfs` 可由 WSL 2 通过 DrvFs 读取。默认自动挂载路径为 `/mnt/<盘符>`，配置可修改路径或关闭自动挂载。微软的实现支持 9P、virtio-9p 和 virtiofs，并区分普通 Windows 进程与已提权进程的挂载命名空间。验证时应使用与应用相同的普通 Windows 用户，由发行版内的 root 执行 Linux 挂载。 [WSL 自动挂载配置](https://learn.microsoft.com/windows/wsl/wsl-config#automount-settings) · [微软 DrvFs 实现说明](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/drvfs.md)

Windows 文件 → DrvFs → 只读 loop 块设备 → 只读 SquashFS → OverlayFS。在 WSL 内核 6.18.58.1 中，loop 接受实现了 `read_iter` 的常规文件，9P 文件实现了该接口，因此此路径从源码看具备直接读取压缩镜像的条件。SquashFS 按需读取和解压文件块，整棵 RootFS 无需预先解包成 ext4 文件。loop 保持默认缓冲 I/O。跨主机边界的读取仍经过 DrvFs，实际 I/O 和冷启动耗时需要在应用使用的目标盘与 WSL 版本上测量。 [loop 内核实现](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.58.1/drivers/block/loop.c#L454-L495) · [9P 文件实现](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.58.1/fs/9p/vfs_file.c#L486-L511) · [SquashFS 内核文档](https://docs.kernel.org/filesystems/squashfs.html) · [losetup 手册](https://man7.org/linux/man-pages/man8/losetup.8.html) · [WSL 跨文件系统性能说明](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop#performance-considerations)

## x64 内核与压缩算法

| 微软 WSL 内核配置 | zlib / LZ4 / LZO / XZ | Zstd |
| --- | --- | --- |
| [5.15.y](https://raw.githubusercontent.com/microsoft/WSL2-Linux-Kernel/linux-msft-wsl-5.15.y/arch/x86/configs/config-wsl) | 启用 | 启用 |
| [6.6.y](https://raw.githubusercontent.com/microsoft/WSL2-Linux-Kernel/linux-msft-wsl-6.6.y/arch/x86/configs/config-wsl) | 启用 | 未启用 |
| [6.18.58.1](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.58.1/arch/x86/configs/config-wsl#L6241-L6258) | 启用 | 未启用 |

仓库固定的 WSL 3.0.5 对应微软内核包 6.18.58.1-1，该 x64 配置内置 loop、OverlayFS、SquashFS 和 SquashFS xattr。选用 XZ 可以覆盖表中的配置。可用 1 MiB 数据块作为打包实验的起点，用同一个 RootFS 比较不同块大小的镜像字节数和冷启动耗时。复用已有 WSL 时，应记录 `uname -r` 并实际挂载同一份镜像，以覆盖不同发行版环境或用户配置的自定义内核。 [WSL 3.0.5 发布说明](https://github.com/microsoft/WSL/releases/tag/3.0.5) · [loop 配置](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.58.1/arch/x86/configs/config-wsl#L2138) · [OverlayFS 配置](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.58.1/arch/x86/configs/config-wsl#L6163) · [mksquashfs 手册](https://github.com/plougher/squashfs-tools/blob/master/Documentation/manpages/mksquashfs.1) · [WSL 自定义内核配置](https://learn.microsoft.com/windows/wsl/wsl-config#main-wsl-settings)

## 可写层与实机验证

将 `upperdir` 和 `workdir` 放在项目专用 WSL 发行版的同一 ext4 文件系统，初次验证使用独立目录和空的 `workdir`。OverlayFS 的可写层需要扩展属性和有效的目录项类型。对 lower 中文件的首次写入或某些元数据变更可触发整文件复制，进而增加 ext4.vhdx 的宿主占用。挂载期间保持镜像不变。更换镜像时先卸载合并层、卸载 SquashFS，再释放 loop，按镜像版本选择相应的 upper/work。 [Linux OverlayFS 文档](https://docs.kernel.org/filesystems/overlayfs.html) · [WSL 磁盘空间管理](https://learn.microsoft.com/windows/wsl/disk-space)

在专用测试发行版内，以 root 逐条验证。镜像路径指向 Windows 固定盘，`upper` 和 `work` 预先建在发行版 ext4 上，`lower` 和 `merged` 使用预先创建的专用挂载目录。

```sh
loop=$(losetup --find --show --read-only /mnt/c/path/to/rootfs.squashfs)
mount -t squashfs -o ro "$loop" /run/haven/lower
mount -t overlay overlay -o lowerdir=/run/haven/lower,upperdir=/var/lib/haven/upper,workdir=/var/lib/haven/work /run/haven/merged
findmnt /run/haven/lower
findmnt /run/haven/merged
losetup "$loop"
```

验收记录应包含实际 DrvFs 路径与文件系统类型、loop 背后的 Windows 文件、只读下层、真实运行时入口的首次启动时间，以及写入合并层后重挂载的持久性。用只读下层的文件做一次修改和删除测试，分别检查 copy-up 与删除标记。重复冷启动并检查下层、合并层与 loop 的清理。 [losetup 生命周期](https://man7.org/linux/man-pages/man8/losetup.8.html) · [OverlayFS copy-up 与删除](https://docs.kernel.org/filesystems/overlayfs.html)

## 600 MB 冷态验收

阈值为 **600,000,000 字节**。测试从干净状态完成首次可用启动，再停止项目实例并清理已经不用的暂存文件，统计 Windows 盘上仍归项目所有的文件。运行时口径至少包含 SquashFS、项目发行版 ext4.vhdx、保留的 RootFS 下载、缓存与其他运行时数据。整套安装口径再计入应用文件及新安装 WSL 带来的独占增量。复用已有 WSL 时用安装前快照记录基线，新装时单列 WSL 的磁盘增量。仓库固定 MSI 的下载长度为 367,788,032 字节，保留的安装包与安装后系统增量各自记录。 [仓库 WSL 发布清单](../claude-tauri/src-tauri/src/bootstrap/wsl-release.json) · [WSL 磁盘空间管理](https://learn.microsoft.com/windows/wsl/disk-space)

逐项报告主机文件的逻辑长度与实际占用。Windows 的 `GetCompressedFileSizeW` 可反映压缩或稀疏文件的主机占用。另记各目标卷的安装前后空闲空间差，用于核查逐文件统计遗漏的占用。VHD 的虚拟容量以及发行版内 `df` 的值属于来宾文件系统口径。另记安装或更新的峰值，尤其是下载、临时打包及新旧镜像并存期。镜像是否达标由主机实测的冷态总量决定。 [GetCompressedFileSizeW](https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getcompressedfilesizew) · [GetDiskFreeSpaceExW](https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getdiskfreespaceexw) · [WSL VHD 容量说明](https://learn.microsoft.com/windows/wsl/disk-space)
