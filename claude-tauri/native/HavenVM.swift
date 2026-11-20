import Darwin
import Foundation
import Virtualization

struct LaunchError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

func fail(_ error: Error) -> Never {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}

func listenSocket<T>(_ address: inout T, family: Int32) throws -> Int32 {
    let fd = socket(family, SOCK_STREAM, 0)
    guard fd >= 0 else { throw LaunchError("无法创建本地套接字") }
    var enabled: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &enabled, socklen_t(MemoryLayout<Int32>.size))
    let size = socklen_t(MemoryLayout<T>.size)
    let bound = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
    }
    guard bound == 0 && listen(fd, 16) == 0 else {
        let failure = String(cString: strerror(errno))
        close(fd)
        throw LaunchError("无法打开本地监听：\(failure)")
    }
    return fd
}

func localControl(_ path: String) throws -> Int32 {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    try withUnsafeMutableBytes(of: &addr.sun_path) { buffer in
        guard bytes.count <= buffer.count else { throw LaunchError("本地控制路径过长") }
        for (index, byte) in bytes.enumerated() { buffer[index] = UInt8(bitPattern: byte) }
    }
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    return try listenSocket(&addr, family: AF_UNIX)
}

func localDesktop() throws -> Int32 {
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = UInt16(6080).bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    return try listenSocket(&addr, family: AF_INET)
}

func growStateDiskIfRequested(_ path: String) throws {
    guard let requested = ProcessInfo.processInfo.environment["HAVEN_STATE_GROW_TO"] else { return }
    guard let target = Int64(requested), target > 0 else {
        throw LaunchError("无效的虚拟数据盘扩容目标")
    }
    let fd = open(path, O_WRONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw LaunchError("无法打开虚拟数据盘：\(String(cString: strerror(errno)))") }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
        throw LaunchError("无法确认虚拟数据盘格式")
    }
    guard info.st_size < target else { return }
    guard ftruncate(fd, target) == 0, fsync(fd) == 0 else {
        throw LaunchError("无法扩展虚拟数据盘：\(String(cString: strerror(errno)))")
    }
}

func copyBytes(_ source: Int32, _ destination: Int32) {
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
        let count = buffer.withUnsafeMutableBytes { read(source, $0.baseAddress, $0.count) }
        if count <= 0 { break }
        let written = buffer.withUnsafeBytes { bytes -> Bool in
            var offset = 0
            while offset < count {
                let sent = write(destination, bytes.baseAddress!.advanced(by: offset), count - offset)
                if sent <= 0 { return false }
                offset += sent
            }
            return true
        }
        if !written { break }
    }
    shutdown(destination, SHUT_WR)
}

func bridge(_ listener: Int32, to port: UInt32, vm: VZVirtualMachine) {
    DispatchQueue.global().async {
        while true {
            let client = accept(listener, nil, nil)
            if client < 0 { return }
            DispatchQueue.main.async {
                guard vm.state == .running,
                      let device = vm.socketDevices.first as? VZVirtioSocketDevice else {
                    close(client)
                    return
                }
                device.connect(toPort: port) { result in
                    guard case let .success(connection) = result else {
                        close(client)
                        return
                    }
                    let transfers = DispatchGroup()
                    for (source, destination) in [(client, connection.fileDescriptor), (connection.fileDescriptor, client)] {
                        DispatchQueue.global().async(group: transfers) { copyBytes(source, destination) }
                    }
                    transfers.notify(queue: .global()) {
                        withExtendedLifetime(connection) { _ = close(client) }
                    }
                }
            }
        }
    }
}

func share(_ directory: String, tag: String, readOnly: Bool) -> VZVirtioFileSystemDeviceConfiguration {
    let device = VZVirtioFileSystemDeviceConfiguration(tag: tag)
    device.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: directory), readOnly: readOnly))
    return device
}

func requestGuestShutdown(_ vm: VZVirtualMachine) {
    guard let device = vm.socketDevices.first as? VZVirtioSocketDevice else { return }
    device.connect(toPort: 6081) { result in
        guard case let .success(connection) = result else { return }
        let command = Data("[[\"/bin/kill\",\"-TERM\",\"1\"],\"\"]\n".utf8)
        command.withUnsafeBytes { bytes in
            _ = write(connection.fileDescriptor, bytes.baseAddress, bytes.count)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            withExtendedLifetime(connection) {}
        }
    }
}

func run() throws {
    let args = CommandLine.arguments
    if args == [args[0], "--supported"] {
        exit(VZVirtualMachine.isSupported ? 0 : 1)
    }
    guard args.count == 8 else { throw LaunchError("无效的虚拟机启动参数") }
    signal(SIGPIPE, SIG_IGN)
    umask(0o077)
    let config = VZVirtualMachineConfiguration()
    config.cpuCount = 4
    config.memorySize = 4 * 1024 * 1024 * 1024
    let loader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: args[1]))
    loader.initialRamdiskURL = URL(fileURLWithPath: args[2])
    loader.commandLine = "console=hvc0 net.ifnames=0"
    config.bootLoader = loader
    let control = try localControl(args[7])
    let desktop = try localDesktop()
    // Claim the app's desktop endpoint before changing an unattached disk image.
    try growStateDiskIfRequested(args[4])
    config.storageDevices = try zip([args[3], args[4]], [true, false]).map { path, readOnly in
        let attachment = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: path), readOnly: readOnly)
        return VZVirtioBlockDeviceConfiguration(attachment: attachment)
    }
    config.directorySharingDevices = [
        share(args[5], tag: "workspace", readOnly: false),
        share(args[6], tag: "haven-runtime", readOnly: true)
    ]
    let network = VZVirtioNetworkDeviceConfiguration()
    network.attachment = VZNATNetworkDeviceAttachment()
    config.networkDevices = [network]
    config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
    config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    let console = VZVirtioConsoleDeviceSerialPortConfiguration()
    console.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: .standardOutput)
    config.serialPorts = [console]
    try config.validate()
    let vm = VZVirtualMachine(configuration: config)
    bridge(control, to: 6081, vm: vm)
    bridge(desktop, to: 6080, vm: vm)
    // EOF means the app requested shutdown or its process has exited.
    DispatchQueue.global().async {
        _ = FileHandle.standardInput.readDataToEndOfFile()
        DispatchQueue.main.async {
            if vm.state == .stopped { exit(0) }
            requestGuestShutdown(vm)
            let timer = DispatchSource.makeTimerSource(queue: .main)
            var ticks = 0
            timer.schedule(deadline: .now(), repeating: .seconds(1))
            timer.setEventHandler {
                ticks += 1
                if vm.state == .stopped { exit(0) }
                if ticks >= 15 && vm.canStop {
                    timer.cancel()
                    vm.stop { error in
                        if let error { fail(error) }
                        exit(0)
                    }
                } else if ticks >= 20 {
                    exit(1)
                }
            }
            timer.resume()
        }
    }
    vm.start { result in
        if case let .failure(error) = result { fail(error) }
    }
    dispatchMain()
}

do { try run() } catch { fail(error) }
