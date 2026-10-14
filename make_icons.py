#!/usr/bin/env python3
"""Генерация иконок расширения (PNG, без зависимостей)."""
import os, struct, zlib

OUT = os.path.join(os.path.dirname(__file__), "icons")

BG = (15, 23, 42, 255)       # тёмно-синий фон
FG = (59, 130, 246, 255)     # синие «плитки»
FG2 = (96, 165, 250, 255)


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def make_icon(size):
    px = [[BG for _ in range(size)] for _ in range(size)]

    # Округление углов фона
    r = max(2, size // 5)
    for y in range(size):
        for x in range(size):
            for cx, cy in ((r, r), (size - 1 - r, r), (r, size - 1 - r), (size - 1 - r, size - 1 - r)):
                if (x < r and y < r and x < cx and y < cy) or \
                   (x > size - 1 - r and y < r and x > cx and y < cy) or \
                   (x < r and y > size - 1 - r and x < cx and y > cy) or \
                   (x > size - 1 - r and y > size - 1 - r and x > cx and y > cy):
                    dx, dy = x - cx, y - cy
                    if dx * dx + dy * dy > r * r:
                        px[y][x] = (0, 0, 0, 0)

    # Четыре плитки 2x2 (символ панели быстрого доступа)
    margin = max(2, size // 4)
    gap = max(1, size // 9)
    cell = (size - 2 * margin - gap) // 2
    colors = [[FG, FG2], [FG2, FG]]
    for gy in range(2):
        for gx in range(2):
            x0 = margin + gx * (cell + gap)
            y0 = margin + gy * (cell + gap)
            for y in range(y0, min(y0 + cell, size)):
                for x in range(x0, min(x0 + cell, size)):
                    px[y][x] = colors[gy][gx]

    raw = b"".join(b"\x00" + b"".join(struct.pack("4B", *p) for p in row) for row in px)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    return png


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(make_icon(size))
        print("wrote", path)


if __name__ == "__main__":
    main()
