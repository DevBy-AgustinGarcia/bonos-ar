/* Guarda una foto de precio, TIR, duration y paridad de cada bono en data/history/AAAA-MM.csv.
   Lo corre la tarea programada después de update.py; alimenta los gráficos de evolución y las rotaciones.
   Uso:  node snapshot.js */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const dir = __dirname;
const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const catalog = read('catalog.json'), indices = read('data/indices.json');
const quotes = Object.fromEntries(read('data/quotes.json').map(q => [q.symbol, q]));

const now = new Date(Date.now() - 3 * 3600e3); // hora AR
const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
const settle = E.settlementDate(), ctx = E.makeContext(indices, settle);
const r = (v, d) => v == null || !isFinite(v) ? '' : +v.toFixed(d);

const lines = [];
for (const b of catalog) {
  const { q, price } = E.priceFor(b, quotes, 'usd');
  if (!(price > 0)) continue;
  let v; try { v = E.value(b, price, ctx); } catch { continue; }
  if (v.matured) continue;
  lines.push([stamp, b.tk, r(price, 4), r(v.tir, 6), r(v.md, 4), r(v.vt && price / v.vt, 6), q ? q.v : 0].join(','));
}

const histDir = path.join(dir, 'data', 'history');
fs.mkdirSync(histDir, { recursive: true });
const file = path.join(histDir, stamp.slice(0, 7) + '.csv');
if (!fs.existsSync(file)) fs.writeFileSync(file, 'fecha,tk,precio,tir,md,paridad,vol\n');
fs.appendFileSync(file, lines.join('\n') + '\n');
console.log(`${lines.length} bonos -> ${path.relative(dir, file)}`);
