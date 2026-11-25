import Darwin
import Foundation
import Virtualization

/// The guest can request a tool by name. The host owns the executable
/// and workspace grant, and reads the grant again for every request.
final class HostNpm: NSObject, VZVirtioSocketListenerDelegate {
    private let workspace: URL
    private let dataDirectory: URL
    private let worker = DispatchQueue(label: "haven.host-npm")
    // The VM delegate and stop() both run on the VM's main queue.
    private var active: VZVirtioSocketConnection?
    private var stopping = false

    private struct Grant: Decodable {
        let workspace: String
        let node: String?
        let allowBuild: Bool?
        let tools: [String: String]?
    }

    private struct Request: Decodable {
        let operation: String
        let directory: String?
        let tool: String?
        let arguments: [String]?
    }

    init(workspace: String, disk: String) {
        self.workspace = URL(fileURLWithPath: workspace).resolvingSymlinksInPath()
        self.dataDirectory = URL(fileURLWithPath: disk).deletingLastPathComponent().resolvingSymlinksInPath()
    }

    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection, from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard !stopping, active == nil else { return false }
        active = connection
        _ = fcntl(connection.fileDescriptor, F_SETFD, FD_CLOEXEC)
        worker.async {
            self.handle(connection.fileDescriptor)
            DispatchQueue.main.async { self.active = nil }
        }
        return true
    }

    func stop() {
        stopping = true
        if let active { shutdown(active.fileDescriptor, SHUT_RDWR) }
    }

    private func isInWorkspace(_ url: URL) -> Bool {
        url.path == workspace.path || url.path.hasPrefix(workspace.path + "/")
    }

    private func grant() throws -> Grant {
        let path = dataDirectory.appendingPathComponent("host-npm.json").path
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw LaunchError("Mac 宿主 npm 未开启。请在 Mac 上配置 host-npm.json。") }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(), (info.st_mode & 0o077) == 0,
              info.st_size > 0, info.st_size <= 16_384,
              !isInWorkspace(dataDirectory),
              let data = try file.read(upToCount: 16_385) else {
            throw LaunchError("host-npm.json 必须是 Mac 当前用户拥有的私有配置文件（权限 600）。")
        }
        let grant = try JSONDecoder().decode(Grant.self, from: data)
        guard grant.workspace.hasPrefix("/"),
              URL(fileURLWithPath: grant.workspace).resolvingSymlinksInPath().path == workspace.path else {
            throw LaunchError("当前工作区未获准使用 Mac 宿主 npm。")
        }
        return grant
    }

    private func workDirectory(_ path: String) throws -> URL {
        guard !path.hasPrefix("/"), !path.contains("\0"),
              !path.split(separator: "/").contains("..") else {
            throw LaunchError("工作目录必须在共享工作区内。")
        }
        let url = (path.isEmpty ? workspace : workspace.appendingPathComponent(path)).resolvingSymlinksInPath()
        guard isInWorkspace(url),
              (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
            throw LaunchError("请从 /workspace 内的目录调用 Mac 宿主工具。")
        }
        return url
    }

    private struct Invocation {
        let executable: URL
        let bins: [URL]
        let directory: URL
        let arguments: [String]
    }

    private func toolPath(_ path: String) throws -> (URL, URL) {
        guard path.hasPrefix("/"), !path.contains("\0") else {
            throw LaunchError("请为宿主工具配置绝对路径。")
        }
        let alias = URL(fileURLWithPath: path)
        let bin = alias.deletingLastPathComponent().resolvingSymlinksInPath()
        let executable = alias.resolvingSymlinksInPath()
        guard !bin.path.contains(":"), !isInWorkspace(bin), !isInWorkspace(executable),
              (try? executable.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
              FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw LaunchError("宿主工具必须是工作区外可执行的文件。")
        }
        return (executable, bin)
    }

    private func invocation(_ request: Request, grant: Grant) throws -> Invocation {
        guard request.operation == "run", let tool = request.tool, let arguments = request.arguments,
              !arguments.contains(where: { $0.contains("\0") }) else {
            throw LaunchError("无效的宿主工具请求。")
        }
        if let tools = grant.tools {
            guard let path = tools[tool], let directory = request.directory else {
                throw LaunchError("请在共享工作区内调用已授权的 Mac 工具。")
            }
            let (executable, bin) = try toolPath(path)
            var bins = [bin]
            if tool == "npm", let node = tools["node"] {
                let (_, nodeBin) = try toolPath(node)
                bins.insert(nodeBin, at: 0)
            }
            return Invocation(executable: executable, bins: bins,
                              directory: try workDirectory(directory), arguments: arguments)
        }

        guard let nodePath = grant.node else { throw LaunchError("请配置宿主 Node 路径或 tools。") }
        let (node, bin) = try toolPath(nodePath)
        if tool == "node" && (arguments == ["--version"] || arguments == ["-v"]) {
            return Invocation(executable: node, bins: [bin], directory: dataDirectory, arguments: ["--version"])
        }
        if tool == "npm" {
            let npm = URL(fileURLWithPath: nodePath).deletingLastPathComponent()
                .appendingPathComponent("npm").resolvingSymlinksInPath()
            guard !isInWorkspace(npm), FileManager.default.isReadableFile(atPath: npm.path) else {
                throw LaunchError("找不到 Node 同目录下的 npm。")
            }
            if arguments == ["--version"] || arguments == ["-v"] {
                return Invocation(executable: node, bins: [bin], directory: dataDirectory,
                                  arguments: [npm.path, "--version"])
            }
            if arguments == ["run", "build"], grant.allowBuild == true, let path = request.directory {
                let directory = try workDirectory(path)
                let package = directory.appendingPathComponent("package.json").resolvingSymlinksInPath()
                guard isInWorkspace(package),
                      (try? package.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
                    throw LaunchError("请在工作区内含有 package.json 的目录运行构建。")
                }
                return Invocation(executable: node, bins: [bin], directory: directory,
                                  arguments: [npm.path, "--prefix", directory.path, "run", "build"])
            }
        }
        throw LaunchError("此命令尚未获得 Mac 宿主授权，请检查 host-npm.json。")
    }

    private func handle(_ fd: Int32) {
        defer { shutdown(fd, SHUT_RDWR) }
        var timeout = timeval(tv_sec: 3, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        do {
            let request = try readRequest(fd)
            let grant = try grant()
            if request.operation == "list" {
                let listing: [String: Any] = ["tools": grant.tools?.keys.sorted() ?? ["node", "npm"],
                                              "legacy": grant.tools == nil]
                try sendFrame(fd, kind: 1, data: JSONSerialization.data(withJSONObject: listing))
                try sendFrame(fd, kind: 3, data: Data("0".utf8))
                return
            }
            let status = try execute(fd, invocation: invocation(request, grant: grant))
            try sendFrame(fd, kind: 3, data: Data(String(status).utf8))
        } catch {
            try? sendFrame(fd, kind: 2, data: Data(("mac: " + error.localizedDescription + "\n").utf8))
            try? sendFrame(fd, kind: 3, data: Data("1".utf8))
        }
    }

    private func readRequest(_ fd: Int32) throws -> Request {
        let deadline = DispatchTime.now() + .seconds(3)
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while DispatchTime.now() < deadline, data.count < 8192 {
            var input = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&input, 1, 250) >= 0 else { break }
            if input.revents == 0 { continue }
            let count = read(fd, &buffer, buffer.count)
            guard count > 0 else { break }
            data.append(contentsOf: buffer.prefix(count))
            if data.count <= 8192, data.last == 10 {
                return try JSONDecoder().decode(Request.self, from: data)
            }
        }
        throw LaunchError("无效的宿主 npm 请求。")
    }

    private func sendFrame(_ fd: Int32, kind: UInt8, data: Data) throws {
        var size = UInt32(data.count).bigEndian
        var frame = Data([kind])
        withUnsafeBytes(of: &size) { frame.append(contentsOf: $0) }
        frame.append(data)
        try frame.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw LaunchError("宿主 npm 连接已断开。") }
                offset += count
            }
        }
    }

    private func execute(_ fd: Int32, invocation: Invocation) throws -> Int32 {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["--host-npm-child", invocation.executable.path] + invocation.arguments
        child.currentDirectoryURL = invocation.directory
        child.environment = [
            "HOME": NSHomeDirectory(),
            "PATH": (invocation.bins.map(\.path) + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]).joined(separator: ":"),
            "CI": "1",
            "NPM_CONFIG_UPDATE_NOTIFIER": "false",
        ]
        let stdout = Pipe()
        let stderr = Pipe()
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = stdout
        child.standardError = stderr
        try child.run()
        var completed = false
        defer {
            if !completed {
                let pid = child.processIdentifier
                if kill(-pid, SIGKILL) != 0, child.isRunning { child.terminate() }
                child.waitUntilExit()
            }
        }

        var sources = [
            pollfd(fd: fd, events: Int16(POLLIN), revents: 0),
            pollfd(fd: stdout.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0),
            pollfd(fd: stderr.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0),
        ]
        let deadline = DispatchTime.now() + .seconds(30 * 60)
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while sources[1].fd >= 0 || sources[2].fd >= 0 || child.isRunning {
            guard DispatchTime.now() < deadline else { throw LaunchError("Mac 宿主 npm 执行超时。") }
            let ready = sources.withUnsafeMutableBufferPointer { poll($0.baseAddress, nfds_t($0.count), 250) }
            if ready < 0 && errno == EINTR { continue }
            guard ready >= 0, sources[0].revents == 0 else { throw LaunchError("宿主 npm 连接已断开。") }
            for index in 1...2 where sources[index].revents != 0 {
                let count = read(sources[index].fd, &buffer, buffer.count)
                if count > 0 {
                    try sendFrame(fd, kind: UInt8(index), data: Data(buffer.prefix(count)))
                } else if count == 0 {
                    sources[index].fd = -1
                } else if errno != EINTR {
                    throw LaunchError("无法读取 Mac 宿主 npm 输出。")
                }
            }
        }
        child.waitUntilExit()
        completed = true
        return child.terminationReason == .uncaughtSignal ? 128 + child.terminationStatus : child.terminationStatus
    }
}

// Give npm and its subprocesses their own process group for cancellation.
func runHostNpmChild() -> Never {
    let arguments = Array(CommandLine.arguments.dropFirst(2))
    guard !arguments.isEmpty, getpgrp() == getpid() || setpgid(0, 0) == 0 else { exit(126) }
    var argv = arguments.map { strdup($0) } + [nil]
    _ = execv(arguments[0], &argv)
    exit(126)
}
