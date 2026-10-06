// Small readers for Adobe swatch files. Colour values come straight from the file;
// nothing is guessed or converted between colour models (HEX only for RGB swatches).

function utf16be(buf, start, chars) {
  let out = '';
  for (let i = 0; i < chars; i += 1) {
    const code = buf.readUInt16BE(start + i * 2);
    if (code !== 0) out += String.fromCharCode(code);
  }
  return out;
}

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();

function rgbColor(name, r, g, b) {
  return { name, model: 'RGB', values: [Math.round(r), Math.round(g), Math.round(b)], hex: `#${hex2(r)}${hex2(g)}${hex2(b)}` };
}

// Photoshop .aco: a v1 section (no names) optionally followed by a v2 section (with names).
export function parseAco(buf) {
  if (!buf || buf.length < 4) throw new Error('ACO file too short');
  const readColors = (start, hasNames) => {
    const version = buf.readUInt16BE(start);
    const count = buf.readUInt16BE(start + 2);
    let off = start + 4;
    const colors = [];
    for (let i = 0; i < count; i += 1) {
      if (off + 10 > buf.length) break;
      const space = buf.readUInt16BE(off);
      const [w, x, y, z] = [2, 4, 6, 8].map((d) => buf.readUInt16BE(off + d));
      off += 10;
      let name = '';
      if (hasNames) {
        const chars = buf.readUInt32BE(off);
        name = utf16be(buf, off + 4, chars);
        off += 4 + chars * 2;
      }
      const label = name || `Swatch ${i + 1}`;
      if (space === 0) colors.push(rgbColor(label, w / 257, x / 257, y / 257));
      else if (space === 2) colors.push({ name: label, model: 'CMYK', values: [w, x, y, z].map((v) => Math.round(100 - v / 655.35)) });
      else if (space === 8) colors.push({ name: label, model: 'Gray', values: [Math.round(w / 100)] });
      else colors.push({ name: label, model: `space-${space}`, values: [w, x, y, z] });
    }
    return { version, colors, end: off };
  };

  const v1 = readColors(0, false);
  if (v1.end + 4 <= buf.length && buf.readUInt16BE(v1.end) === 2) {
    return readColors(v1.end, true).colors;
  }
  return v1.colors;
}

// Adobe Swatch Exchange (.ase): named RGB/CMYK/LAB/Gray swatches, optionally in groups.
export function parseAse(buf) {
  if (!buf || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'ASEF') throw new Error('Not an ASE file');
  const blocks = buf.readUInt32BE(8);
  let off = 12;
  const colors = [];
  for (let i = 0; i < blocks && off + 6 <= buf.length; i += 1) {
    const type = buf.readUInt16BE(off);
    const length = buf.readUInt32BE(off + 2);
    const body = off + 6;
    if (type === 0x0001) {
      const chars = buf.readUInt16BE(body);
      const name = utf16be(buf, body + 2, chars);
      let p = body + 2 + chars * 2;
      const model = buf.toString('ascii', p, p + 4).trim();
      p += 4;
      const floats = { RGB: 3, CMYK: 4, LAB: 3, Gray: 1 }[model] || 0;
      const v = Array.from({ length: floats }, (_, k) => buf.readFloatBE(p + k * 4));
      if (model === 'RGB') colors.push(rgbColor(name, v[0] * 255, v[1] * 255, v[2] * 255));
      else if (model === 'CMYK') colors.push({ name, model, values: v.map((n) => Math.round(n * 100)) });
      else if (model === 'Gray') colors.push({ name, model, values: [Math.round(v[0] * 100)] });
      else colors.push({ name, model, values: v.map((n) => Number(n.toFixed(2))) });
    }
    off = body + length;
  }
  return colors;
}

export function describeColor(color) {
  if (color.model === 'RGB') return `${color.name}: RGB ${color.values.join(', ')} (hex ${color.hex})`;
  if (color.model === 'CMYK') return `${color.name}: CMYK ${color.values.join('/')} %`;
  return `${color.name}: ${color.model} ${color.values.join(', ')}`;
}

export function parseSwatchFile(fileName, buf) {
  return /\.ase$/i.test(fileName) ? parseAse(buf) : parseAco(buf);
}
