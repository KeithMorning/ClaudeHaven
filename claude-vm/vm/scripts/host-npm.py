#!/usr/bin/python3
"""Run workspace-authorized tools on the Mac host."""

import io
import json
import os
import re
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile


def request_host(message, stdout=None, stderr=None, timeout=None):
    if stdout is None:
        stdout = sys.stdout.buffer
    if stderr is None:
        stderr = sys.stderr.buffer
    with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as connection:
        connection.settimeout(5 if timeout is None else timeout)
        connection.connect((socket.VMADDR_CID_HOST, 6082))
        connection.sendall(json.dumps(message).encode() + b"\n")
        connection.settimeout(timeout)
        with connection.makefile("rb") as reply:
            while True:
                header = reply.read(5)
                if len(header) != 5:
                    raise ValueError("连接已关闭，或 Mac 上有另一项宿主任务正在执行。")
                kind, size = struct.unpack("!BI", header)
                if size > 65536:
                    raise ValueError("无效的宿主响应。")
                payload = reply.read(size)
                if len(payload) != size:
                    raise ValueError("读取宿主响应时连接断开。")
                if kind == 3:
                    return int(payload)
                output = {1: stdout, 2: stderr}.get(kind)
                if output is None:
                    raise ValueError("无效的宿主响应类型。")
                output.write(payload)
                output.flush()


def run_tool(tool, arguments):
    try:
        directory = str(Path.cwd().relative_to("/workspace"))
    except ValueError:
        directory = None
    return request_host({
        "operation": "run", "directory": directory,
        "tool": tool, "arguments": arguments,
    })


def claude_host_grant():
    reply = io.BytesIO()
    try:
        status = request_host({"operation": "list"}, reply, io.BytesIO(), timeout=2)
        if status == 0:
            return json.loads(reply.getvalue())
    except (OSError, ValueError):
        pass
    return None


def launch_claude(arguments):
    grant = claude_host_grant()
    command = ["claude", *arguments]
    if not grant or not grant["tools"]:
        os.execvp(command[0], command)

    client = Path(__file__).resolve()
    with tempfile.TemporaryDirectory(prefix="haven-host-tools-") as directory:
        for tool in grant["tools"]:
            if tool not in {"mac", "claude"} and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.+-]*", tool):
                (Path(directory) / tool).symlink_to(client)
        environment = dict(os.environ)
        environment["PATH"] = directory + ":" + environment.get("PATH", os.defpath)
        environment["HAVEN_HOST_TOOLS_LEGACY"] = "1" if grant["legacy"] else "0"
        return subprocess.call(command, env=environment)


def main():
    arguments = sys.argv[1:]
    command = Path(sys.argv[0])
    if command.name not in {"mac", "host-npm.py"}:
        if (command.name == "node" and os.environ.get("HAVEN_HOST_TOOLS_LEGACY") == "1"
                and arguments not in (["--version"], ["-v"])):
            environment = dict(os.environ)
            shim = command.absolute().parent
            environment["PATH"] = ":".join(
                entry for entry in environment.get("PATH", os.defpath).split(":")
                if Path(entry).resolve() != shim
            )
            os.execvpe("node", ["node", *arguments], environment)
        return run_tool(command.name, arguments)
    if arguments[:1] == ["claude"]:
        return launch_claude(arguments[1:])
    if arguments:
        return run_tool(arguments[0], arguments[1:])
    print("用法: mac <宿主工具> [参数…] | mac claude [参数…]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, ValueError) as error:
        print(f"mac: {error}", file=sys.stderr)
        sys.exit(1)
