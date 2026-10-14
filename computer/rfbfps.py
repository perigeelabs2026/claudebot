# Minimal RFB client: counts framebuffer updates per second on one VNC port (no auth), raw+copyrect encodings.
import socket, struct, sys, time, threading
def recvn(s, n):
    b = b''
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c: raise EOFError
        b += c
    return b
def run(port, secs, out):
    s = socket.create_connection(('127.0.0.1', port)); s.settimeout(10)
    ver = recvn(s, 12); s.sendall(b'RFB 003.008\n')
    n = recvn(s, 1)[0]; types = list(recvn(s, n))
    if 1 not in types: out[port] = f'no None auth: {types}'; return
    s.sendall(bytes([1])); res = struct.unpack('>I', recvn(s, 4))[0]
    if res: out[port] = 'auth failed'; return
    s.sendall(b'\x01'); w, h = struct.unpack('>HH', recvn(s, 4)); pf = recvn(s, 16); nl = struct.unpack('>I', recvn(s, 4))[0]; name = recvn(s, nl)
    bpp = pf[0] // 8
    s.sendall(struct.pack('>BBHi', 2, 0, 1, 0))  # SetEncodings: raw only
    s.sendall(struct.pack('>BBHHHH', 3, 0, 0, 0, w, h))
    t0 = time.time(); frames = 0; px = 0
    while time.time() - t0 < secs:
        typ = recvn(s, 1)[0]
        if typ != 0:
            if typ == 2: continue
            if typ == 3: recvn(s, 3); l = struct.unpack('>I', recvn(s, 4))[0]; recvn(s, l); continue
            raise RuntimeError(f'msg {typ}')
        recvn(s, 1); nr = struct.unpack('>H', recvn(s, 2))[0]
        for _ in range(nr):
            x, y, rw, rh, enc = struct.unpack('>HHHHi', recvn(s, 12))
            recvn(s, rw * rh * bpp); px += rw * rh
        frames += 1
        s.sendall(struct.pack('>BBHHHH', 3, 1, 0, 0, w, h))
    out[port] = f'{w}x{h} {frames / secs:.1f} updates/s'
out = {}; ts = [threading.Thread(target=run, args=(p, 10, out)) for p in (5900, 5901)]
[t.start() for t in ts]; [t.join() for t in ts]; print(out)
