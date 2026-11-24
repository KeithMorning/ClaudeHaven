<p align="right">English · <a href="README.zh-CN.md">简体中文</a></p>

<div align="center">
  <img src="claude-tauri/ui/assets/claude-cage.png" alt="Claude Haven logo" width="132" />
  <h1>Claude Haven</h1>
  <p><strong>Fast to launch. Small to download.</strong></p>
  <p>Give Claude Code a focused Linux desktop workspace on Windows and Apple Silicon Mac.</p>
  <p>About 400 MB on Mac · About 600 MB on Windows</p>
  <p>
    <img src="https://img.shields.io/badge/Windows%20x64-supported-2ea44f?style=flat-square" alt="Windows x64 supported" />
    <img src="https://img.shields.io/badge/macOS%2013%2B-Apple%20Silicon%20supported-2ea44f?style=flat-square" alt="macOS 13 and Apple Silicon supported" />
  </p>
  <p>
    <a href="#get-started">Get started</a> ·
    <a href="#working-in-the-desktop">Working in the desktop</a> ·
    <a href="#troubleshooting">Troubleshooting</a> ·
    <a href="docs/development.md">Development guide</a>
  </p>
</div>

---

Claude Haven is a desktop workspace for Claude Code. It provides Claude Code, a browser, a terminal, and a file manager inside an isolated Linux desktop, with a folder on your computer as the project workspace.

macOS is supported on Apple Silicon (M-series) with macOS 13 or later. It uses Apple’s Virtualization.framework to run the Linux system bundled with the app. Windows x64 runs the desktop through WSL2. Linux hosts are not currently supported.

## Get started

### 1. Download and install

Download the Windows x64 installer from the [v0.1.2 release](https://github.com/KeithMorning/ClaudeVM/releases/tag/v0.1.2). This release updates Windows only. Apple Silicon Mac users can get the existing DMG from [v0.1.1](https://github.com/KeithMorning/ClaudeVM/releases/tag/v0.1.1). On Mac, open the DMG and drag Claude Haven to the `Applications` shortcut.

### 2. Configure your network

When you first open the app, go to **System Settings**:

1. Under **Network**, select a Clash / Mihomo YAML configuration file from your computer.
2. Choose an egress node from its proxy list and save the settings.

The configuration stays on your computer. At startup, Claude Haven checks the network guard and egress connection. The desktop will not be marked ready if these checks fail, so use a configuration with a working proxy node.

### 3. Choose a workspace

Open **Workspace**, select a folder on your computer, and save it. The Linux desktop can read and write files in this folder. Only share folders you want the desktop to access.

### 4. Start the desktop

Return to **Desktop** and click **Start virtual environment**. On Windows, the app checks WSL2 on first launch and guides you through setup if required components are missing. On Mac, the Linux system is included with the app; you do not need to install Lima or Docker or download a separate system image. The first launch can take a little while. Keep the app open until startup finishes.

## Working in the desktop

- Use Claude Code, Chrome, a terminal, and a file manager in one Linux desktop.
- Chinese input is provided by fcitx5 / Rime. Text can be copied between the host and the desktop.
- Access project files through the shared workspace. You can also use it to move images and other files between the host and desktop.
- On Windows, WSL interoperability lets you invoke Windows-native commands from Linux when needed. This can reuse tools already installed on the host instead of installing a duplicate in Linux. Windows commands run as host processes, use Windows paths and permissions, and are outside the Linux network guard; Linux tools included with Claude Haven remain the ready-to-use default.
- The app shows the network protection status. If a node or egress check fails, choose and save another node in **System Settings**, then retry from **Desktop**.

![Claude Haven Linux desktop](assets/screenshots/claude-haven-running.png)

![Browser running in the Claude Haven desktop](assets/screenshots/claude-haven-browser.png)

![Claude Code running in the Claude Haven terminal](assets/screenshots/claude-haven-claude-code.png)

## Troubleshooting

**Windows says WSL2 is not ready**

Follow the in-app steps to configure WSL2. If Windows asks you to restart, restart the computer and reopen Claude Haven to continue.

**The first launch is taking a while**

The app initializes the virtual desktop and network protection on first launch. Wait for the progress indicator to finish. If startup fails, check the displayed error and your settings, then try again.

**The network guard check failed**

Make sure the selected YAML has a working node that can reach the internet. Select and save a node again under **Network**. The environment will not be marked ready until the guard check passes.

**Want to check your Claude environment?**

Try the third-party [Claude environment checker](https://fuck-claude.vercel.app/) to inspect signals such as timezone, browser language, fonts, and WebRTC. It is not an Anthropic service, its results are informational only, and it cannot guarantee account access or prevent restrictions. The site says it sends your IP-derived region and a scan count, but not scan results.

**Where are my project files?**

They remain in the local folder you selected as your workspace, including when the virtual desktop is stopped.

**Why does the Mac data disk initially show 2 GiB?**

The persistent `state.img` starts as a sparse disk with a logical capacity of 2 GiB. It uses host disk space as the virtual desktop writes data. See **System Settings → Virtual Machine Storage** for the logical capacity, actual Mac disk usage, and free space inside the VM. When the VM has less than 1 GiB free, the app schedules the disk to double on the next start, up to 16 GiB, if the Mac has enough free space.

## Security and privacy

- The virtual desktop can read and write files in the workspace folder you selected.
- Clash / Mihomo configuration is stored locally. Remove node addresses, passwords, keys, local paths, and other personal information before sharing a report.

## Contributing

Forks and contributions are welcome, including work assisted by AI coding tools. Review changes before submitting, describe their purpose and how you verified them, and do not commit personal configuration, credentials, or other sensitive data. For issues, open a [GitHub Issue](https://github.com/KeithMorning/ClaudeVM/issues).

For development setup, app builds, and Linux image creation, see the [development guide](docs/development.md).

## License

See [LICENSE](LICENSE) for the source license. Bundled third-party components retain their respective licenses.
