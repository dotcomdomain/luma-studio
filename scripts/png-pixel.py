# Prints RGBA values of pixels in a PNG screenshot: png-pixel.py FILE X Y [X Y ...]
import sys, zlib, struct
data = open(sys.argv[1], 'rb').read()
pos, idat = 8, b''
while pos < len(data):
    n, kind = struct.unpack('>I4s', data[pos:pos + 8])
    chunk = data[pos + 8:pos + 8 + n]
    if kind == b'IHDR': w, h, depth, ctype = struct.unpack('>IIBB', chunk[:10])
    if kind == b'IDAT': idat += chunk
    pos += 12 + n
bpp = {6: 4, 2: 3}[ctype]
raw, stride, rows, prev = zlib.decompress(idat), w * bpp, [], bytearray(w * bpp)
for y in range(h):
    f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
    for i in range(stride):
        a = line[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
        if f == 1: line[i] = (line[i] + a) & 255
        elif f == 2: line[i] = (line[i] + b) & 255
        elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
        elif f == 4:
            p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    rows.append(line); prev = line
args = list(map(int, sys.argv[2:]))
for x, y in zip(args[::2], args[1::2]):
    print(x, y, tuple(rows[y][x * bpp:(x + 1) * bpp]))
