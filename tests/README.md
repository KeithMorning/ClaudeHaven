# 测试

在仓库根目录运行 JavaScript 和静态检查：

```powershell
node --test tests/unit/*.test.js tests/static/*.test.js
```

在 `claude-tauri/src-tauri/` 运行 Rust 测试：

```powershell
cargo test
```

普通测试不启动或停止虚拟机。Rust 中标记为 `ignored` 的真实 WSL 测试会使用本机发行版，其中部分会启动、停止会话或修改测试目录；只能在确认没有用户会话时显式运行。`tests/integration/wsl.test.js` 也会操作真实 WSL 路由，不属于默认测试。
