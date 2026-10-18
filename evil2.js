const fs = require('fs'), zlib = require('zlib');
function hdr(name, size) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100); b.write('0000644\0', 100); b.write('0000000\0', 108);
  b.write('0000000\0', 116); b.write(size.toString(8).padStart(11, '0') + '\0', 124);
  b.write('00000000000\0', 136);
  b.write('        ', 148); b.write('0', 156); b.write('ustar\0', 257); b.write('00', 263);
  b.write('root', 265); b.write('root', 297);
  let s = 0; for (const x of b) s += x;
  b.write(s.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}
const data = Buffer.from('x'), pad = Buffer.alloc(512 - data.length);
fs.writeFileSync('evil-dotdot.tar.gz', zlib.gzipSync(Buffer.concat([hdr('../evil.txt', data.length), data, pad, Buffer.alloc(1024)])));
