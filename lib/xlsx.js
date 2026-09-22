// ============================================================================
// lib/xlsx.js —— 零依赖 .xlsx 读写（供订单导入/导出使用）
//
// 定位：只支持商家日常会用到的"干净表格"：第一个工作表、单列文本/数字、
// 公式取缓存值。不支持合并单元格、样式化日期（日期列请用文本格式）。
// 读取基于 zip 中央目录 + zlib.inflateRaw；写出使用 STORE（不压缩），
// Excel / WPS 均可直接打开。
// ============================================================================
'use strict';

const zlib = require('zlib');

// ---------- 公共工具 ----------
function decodeXml(s) {
  return String(s).replace(/&(amp|lt|gt|quot|apos|#x?[0-9A-Fa-f]+);/g, (m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const hex = e[1] === 'x' || e[1] === 'X';
    return String.fromCodePoint(parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

function encodeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function attrOf(tag, name) {
  const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag);
  return m ? decodeXml(m[1]) : '';
}

function colIndex(ref) {
  const m = /^([A-Za-z]+)/.exec(ref || '');
  let c = 0;
  for (const ch of m ? m[1].toUpperCase() : 'A') c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}

function colRef(i) {
  let s = '';
  i += 1;
  while (i > 0) { s = String.fromCharCode(65 + (i - 1) % 26) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- ZIP 读取（支持 STORE 与 DEFLATE） ----------
function readZip(buf) {
  let e = -1;
  const limit = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= limit; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error('不是有效的 xlsx 文件（zip 结构缺失）');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx 内部结构损坏（中央目录）');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    files[name] = { method, csize, lho };
    p += 46 + nameLen + extraLen + commentLen;
  }
  const out = {};
  for (const [name, info] of Object.entries(files)) {
    const lh = info.lho;
    if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('xlsx 内部结构损坏（本地头）');
    const nameLen = buf.readUInt16LE(lh + 26);
    const extraLen = buf.readUInt16LE(lh + 28);
    const data = buf.slice(lh + 30 + nameLen + extraLen, lh + 30 + nameLen + extraLen + info.csize);
    if (info.method === 0) out[name] = data;
    else if (info.method === 8) out[name] = zlib.inflateRawSync(data);
    else throw new Error('不支持的 zip 压缩方式：' + info.method);
  }
  return out;
}

// ---------- ZIP 写出（STORE，无需压缩器） ----------
function zipStore(entries) {
  const chunks = [], central = [];
  let offset = 0;
  const dosDate = (2024 - 1980) << 9 | 1 << 5 | 1; // 2024-01-01
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(data);
    const size = data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    lh.writeUInt16LE(0, 8);      // STORE
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    chunks.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += 30 + nameBuf.length + size;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

// ---------- 表格解析 ----------
function parseSharedStrings(xml) {
  const sst = [];
  for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) || []) {
    const ts = si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || [];
    sst.push(decodeXml(ts.map(t => t.replace(/^<t[^>]*>/, '').replace(/<\/t>$/, '')).join('')));
  }
  return sst;
}

function parseSheet(xml, sst) {
  const rows = [];
  for (const rm of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const cm of rm.match(/<c[^>]*\/>|<c[^>]*>[\s\S]*?<\/c>/g) || []) {
      const ref = attrOf(cm, 'r');
      const type = attrOf(cm, 't') || 'n';
      let v = '';
      if (type === 'inlineStr') {
        const tm = cm.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        v = tm ? decodeXml(tm[1]) : '';
      } else {
        const vm = cm.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        if (vm) {
          const raw = decodeXml(vm[1]);
          v = type === 's' ? (sst[Number(raw)] ?? '') : type === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE') : raw;
        }
      }
      cells[colIndex(ref)] = v;
    }
    rows.push(cells);
  }
  return rows;
}

// 读取 .xlsx：返回 { sheetName, rows: string[][] }（第一个工作表）
function readXlsx(buf) {
  const files = readZip(buf);
  const sstXml = files['xl/sharedStrings.xml'];
  const sst = sstXml ? parseSharedStrings(sstXml.toString('utf8')) : [];
  const wbXml = (files['xl/workbook.xml'] || '').toString();
  const sheets = [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map(tag => ({
    name: attrOf(tag[0], 'name'),
    rid: attrOf(tag[0], 'r:id') || attrOf(tag[0], 'id'),
  }));
  const relsXml = (files['xl/_rels/workbook.xml.rels'] || '').toString();
  const relMap = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    relMap[attrOf(m[0], 'Id')] = attrOf(m[0], 'Target');
  }
  let sheetXml = '';
  let sheetName = '';
  if (sheets.length) {
    sheetName = sheets[0].name;
    let target = relMap[sheets[0].rid] || '';
    if (target.startsWith('/')) target = target.slice(1);
    else if (target) target = 'xl/' + target.replace(/^\.\//, '');
    if (files[target]) sheetXml = files[target].toString('utf8');
  }
  if (!sheetXml) {
    const fallback = Object.keys(files).find(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
    if (!fallback) throw new Error('xlsx 中没有工作表');
    sheetXml = files[fallback].toString('utf8');
  }
  return { sheetName, rows: parseSheet(sheetXml, sst) };
}

// ---------- 表格生成 ----------
function buildSheetXml(rows) {
  const body = rows.map((cells, r) => {
    const cs = (cells || []).map((v, c) => {
      if (v === '' || v == null) return '';
      return `<c r="${colRef(c)}${r + 1}" t="inlineStr"><is><t>${encodeXml(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cs}</row>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + body + '</sheetData></worksheet>';
}

// 生成 .xlsx：sheets = [{ name, rows: string[][] }]
function writeXlsx(sheets) {
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${encodeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  const entries = [
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: buildSheetXml(s.rows) })),
  ];
  return zipStore(entries);
}

module.exports = { readXlsx, writeXlsx };
