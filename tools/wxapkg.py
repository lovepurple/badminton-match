#!/usr/bin/env python3
"""解密并解包微信 PC 端（V1MMWX）小程序 / 插件包。

容器格式（实测微信 4.x，appid=wx5f3f808a2ea7f0a8）：

    magic "V1MMWX"                                      6 bytes
    AES-256-CBC(file[6:1030])[:1023]                    明文头部
    XOR(file[1030:], ord(appid[-2]))                    明文其余部分

    key = PBKDF2-HMAC-SHA1(appid, b"saltiest", 1000, 32)
    iv  = b"the iv: 16 bytes"

明文是标准 wxapkg：

    0xBE | uint32 info1 | uint32 index_len | uint32 body_len | 0xED | uint32 count
    count * (uint32 name_len | name | uint32 offset | uint32 size)
    body

注意：index_len 从偏移 14 开始计（包含 count 字段），body 起点为 14 + index_len；
文件偏移是相对整个明文的绝对偏移。

用法：
    python tools/wxapkg.py <appid> <input.wxapkg> <out_dir>
"""
import hashlib
import os
import struct
import sys
import zlib

from Crypto.Cipher import AES

SALT = b"saltiest"
IV = b"the iv: 16 bytes"


def decrypt(appid: str, data: bytes) -> bytes:
    if data[:6] != b"V1MMWX":
        return data
    key = hashlib.pbkdf2_hmac("sha1", appid.encode(), SALT, 1000, 32)
    head = AES.new(key, AES.MODE_CBC, IV).decrypt(data[6:1030])[:1023]
    xor_key = ord(appid[-2])
    return head + bytes(b ^ xor_key for b in data[1030:])


def unpack(data: bytes) -> dict:
    if data[0] != 0xBE:
        raise ValueError("bad wxapkg magic: 0x%02x" % data[0])
    index_len, body_len = struct.unpack(">II", data[5:13])
    if data[13] != 0xED:
        raise ValueError("bad index mark: 0x%02x" % data[13])
    count = struct.unpack(">I", data[14:18])[0]
    pos = 18
    files = {}
    for _ in range(count):
        name_len = struct.unpack(">I", data[pos:pos + 4])[0]
        pos += 4
        name = data[pos:pos + name_len].decode("utf-8", "replace")
        pos += name_len
        offset, size = struct.unpack(">II", data[pos:pos + 8])
        pos += 8
        blob = data[offset:offset + size]
        try:
            blob = zlib.decompress(blob)
        except zlib.error:
            pass
        files[name] = blob
    return files


def extract(appid: str, path: str, outdir: str) -> int:
    files = unpack(decrypt(appid, open(path, "rb").read()))
    root = os.path.abspath(outdir)
    for name, blob in files.items():
        dest = os.path.normpath(os.path.join(root, name.lstrip("/")))
        if not dest.startswith(root):
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(blob)
    return len(files)


def main() -> None:
    if len(sys.argv) != 4:
        print(__doc__)
        raise SystemExit(2)
    appid, path, outdir = sys.argv[1:4]
    count = extract(appid, path, outdir)
    print("%s -> %d files -> %s" % (path, count, outdir))


if __name__ == "__main__":
    main()
