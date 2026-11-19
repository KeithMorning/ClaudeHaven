#!/usr/bin/python3
"""Bridge the private VM sockets to the local desktop and management service."""
import json
import os
import selectors
import socket
import subprocess
import threading


def serve(port, handler):
    with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as listener:
        listener.bind((socket.VMADDR_CID_ANY, port))
        listener.listen(16)
        while True:
            conn, peer = listener.accept()
            if peer[0] != socket.VMADDR_CID_HOST:
                conn.close()
                continue
            threading.Thread(target=handle, args=(conn, handler), daemon=True).start()


def handle(conn, handler):
    with conn:
        try:
            handler(conn)
        except (OSError, ValueError):
            pass


def desktop(conn):
    with socket.create_connection(("127.0.0.1", 6080), timeout=4) as target:
        target.settimeout(None)
        with selectors.DefaultSelector() as sel:
            sel.register(conn, selectors.EVENT_READ, target)
            sel.register(target, selectors.EVENT_READ, conn)
            while sel.get_map():
                for event, _ in sel.select():
                    data = event.fileobj.recv(65536)
                    if not data:
                        sel.unregister(event.fileobj)
                        event.data.shutdown(socket.SHUT_WR)
                    else:
                        event.data.sendall(data)


def control(conn):
    request = conn.makefile("rb").readline(16 * 1024 * 1024)
    try:
        args, stdin = json.loads(request)
        if not isinstance(args, list) or not args or not all(isinstance(v, str) for v in args):
            raise ValueError("invalid command")
        result = subprocess.run(args, input=stdin.encode(), capture_output=True, timeout=45, cwd="/", env=os.environ)
        reply = [result.returncode, result.stdout.decode(errors="replace"), result.stderr.decode(errors="replace")]
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        reply = [1, "", str(exc)]
    conn.sendall(json.dumps(reply).encode() + b"\n")


threading.Thread(target=serve, args=(6080, desktop), daemon=True).start()
serve(6081, control)
