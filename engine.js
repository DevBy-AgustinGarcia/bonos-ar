/* Motor de valuación de bonos argentinos.
   Toma una entrada del catálogo (condiciones de emisión), un precio y los índices del BCRA,
   y devuelve valor técnico, paridad, TIR, duration y próximo pago.
   Funciona en el navegador (window.BondEngine) y en Node (module.exports) para poder testearlo. */
(function (root) {
  'use strict';

  /* ---------- Fechas ---------- */
  const D = s => new Date(s + 'T00:00:00Z');
  const iso = d => d.toISOString().slice(0, 10);
  const DAY = 864e5;
  const days = (a, b) => Math.round((b - a) / DAY);
  const days360 = (a, b) => { // 30/360 US
    let d1 = Math.min(a.getUTCDate(), 30), d2 = b.getUTCDate(); if (d1 === 30 && d2 === 31) d2 = 30;
    return 360 * (b.getUTCFullYear() - a.getUTCFullYear()) + 30 * (b.getUTCMonth() - a.getUTCMonth()) + d2 - d1;
  };
  const yf = (a, b, dc) => dc === 'ACT/365' ? days(a, b) / 365 : dc === 'ACT/360' ? days(a, b) / 360 : days360(a, b) / 360;
  // Días hábiles: sólo descuenta fines de semana (los feriados no están modelados).
  const addBD = (d, n) => {
    const x = new Date(d), step = n < 0 ? -1 : 1;
    for (let k = Math.abs(n); k > 0;) { x.setUTCDate(x.getUTCDate() + step); if (![0, 6].includes(x.getUTCDay())) k--; }
    return x;
  };

  /* ---------- Series del BCRA: [[fecha, valor], ...] ascendente ---------- */
  function seriesLookup(arr) {
    const fn = d => { // último valor con fecha <= d
      const k = typeof d === 'string' ? d : iso(d);
      let lo = 0, hi = arr.length - 1, ans = null;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m][0] <= k) { ans = arr[m][1]; lo = m + 1; } else hi = m - 1; }
      return ans ?? (arr.length ? arr[0][1] : null);
    };
    fn.last = arr.length ? arr[arr.length - 1] : null;
    fn.lastOnOrBefore = d => fn(d);
    return fn;
  }

  /* ---------- Contexto de cálculo ---------- */
  function makeContext(indices, settle) {
    const cer = seriesLookup(indices.cer), tamar = seriesLookup(indices.tamar),
          badlar = seriesLookup(indices.badlar), a3500 = seriesLookup(indices.a3500);
    const today = iso(new Date(Date.now() - 3 * 3600e3));
    return {
      settle,
      cerLag: d => cer(addBD(d, -10)),            // CER con rezago de 10 días hábiles
      tamar, badlar, a3500,
      tamarNow: tamar(today), badlarNow: badlar(today), a3500Now: a3500(today),
    };
  }

  /* ---------- TIR por bisección (robusta para cualquier flujo positivo) ---------- */
  function irr(flows, price, settle) {
    if (!(price > 0) || !flows.length) return null;
    const ts = flows.map(f => days(settle, f.date) / 365);
    const pv = r => flows.reduce((s, f, i) => s + f.amt / Math.pow(1 + r, ts[i]), 0);
    let lo = -0.95, hi = 10;
    if (pv(hi) > price || pv(lo) < price) return null;
    for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; pv(m) > price ? lo = m : hi = m; }
    const r = (lo + hi) / 2;
    const mac = flows.reduce((s, f, i) => s + ts[i] * f.amt / Math.pow(1 + r, ts[i]), 0) / price;
    return { tir: r, md: mac / (1 + r) };
  }

  /* ---------- Bonos con cupón (fijo, step-up, flotante, CER) ---------- */
  function couponFlows(b, ctx) {
    const amort = new Map((b.amort || [[b.mat, 100]]).map(([d, p]) => [d, p]));
    const pays = [...new Set([...(b.pay || []), ...amort.keys()])].sort();
    const start0 = D(b.accrualStart || b.issue);
    const isPay = new Set(b.pay || []);
    const rateAt = start => {
      if (b.kind === 'float') {
        const idx = b.index === 'BADLAR' ? ctx.badlarNow : ctx.tamarNow;
        return idx + (b.spread || 0);
      }
      const st = (b.steps || []).filter(([s]) => D(s) <= start);
      return st.length ? st[st.length - 1][1] : (b.steps?.[0]?.[1] ?? 0);
    };
    const out = []; let resid = 100, prev = start0;
    for (const p of pays) {
      const d = D(p);
      let interest = 0, rate = 0;
      if (isPay.has(p)) { rate = rateAt(prev); interest = resid * rate / 100 * yf(prev, d, b.dc || '30/360'); }
      const am = amort.get(p) || 0;
      out.push({ date: d, start: prev, resid, rate, interest, amort: am, amt: interest + am });
      resid -= am;
      if (isPay.has(p)) prev = d;
    }
    return out;
  }

  /* ---------- Factor de capitalización TAMAR (TEM = (1+TNA·32/365)^(30/32) − 1) ---------- */
  function tamarFactor(ctx, from, to, spread, projectAfter) {
    let f = 1;
    for (let d = new Date(from); d < to; d.setUTCDate(d.getUTCDate() + 1)) {
      const r = (d >= projectAfter ? ctx.tamarNow : ctx.tamar(addBD(d, -10))) + (spread || 0);
      f *= Math.pow(1 + r / 100 * 32 / 365, (30 / 32) * (12 / 365));
    }
    return f;
  }

  /* ---------- Valuación ---------- */
  function value(b, price, ctx) {
    if (!b.mat) return { price };
    const settle = ctx.settle, mat = D(b.mat);
    const res = { price, unit: b.group === 'HD' ? b.curr : 'ARS', days: days(settle, mat) };
    if (mat <= settle) return { ...res, matured: true };
    // Sin precio, sin condiciones completas o en euros (no hay cotización en EUR): sólo se muestra el precio.
    if (b.kind === 'none' || !(price > 0) || b.curr === 'EUR' || (b.kind === 'cap_fixed' && b.tem == null)) return res;

    // Bono a descuento: un pago VF al vencimiento. scale pasa el flujo a la moneda del precio (coef. CER o dólar);
    // principal es la parte del pago que se informa como amortización.
    const zero = (VF, px, scale = 1, principal = 100) => {
      const k = irr([{ date: mat, amt: VF }], px, settle);
      return { ...k, tna: (VF / px - 1) * 365 / res.days, tem: Math.pow(VF / px, 30 / res.days) - 1, vf: VF,
               next: { date: mat, amt: VF * scale },
               flows: [{ date: mat, interest: (VF - principal) * scale, amort: principal * scale, amt: VF * scale }] };
    };

    switch (b.kind) {
      case 'fixed': case 'float': {
        const flows = couponFlows(b, ctx);
        const cur = flows.find(f => f.date > settle);
        const fut = flows.filter(f => f.date > settle && f.amt > 0);
        const curPay = flows.find(f => f.date > settle && f.rate > 0) || cur;
        const accrued = curPay.resid * curPay.rate / 100 * yf(curPay.start, settle, b.dc || '30/360');
        // La base del CER es la fecha de emisión original, aunque el devengamiento arranque después (ej. Par canje 2010).
        const coef = b.cer ? ctx.cerLag(settle) / ctx.cerLag(D(b.issue)) : 1;
        const pxReal = price / coef;
        const k = irr(fut, pxReal, settle);
        // Flujo en la moneda del precio: los CER se muestran ajustados por el coeficiente de hoy (sin inflación futura).
        const flowsN = fut.map(f => ({ date: f.date, interest: f.interest * coef, amort: f.amort * coef, amt: f.amt * coef, resid: f.resid, rate: f.rate }));
        return { ...res, ...k, coef, flows: flowsN, resid: cur.resid, vt: (cur.resid + accrued) * coef, rate: curPay.rate,
                 next: { date: fut[0].date, amt: fut[0].amt * coef }, tirKind: b.cer ? 'real' : (b.curr === 'ARS' ? 'TEA' : b.curr) };
      }
      case 'cap_fixed': {
        const tem = b.tem / 100, start = D(b.issue);
        const VF = 100 * Math.pow(1 + tem, days360(start, mat) / 30);
        return { ...res, ...zero(VF, price), vt: 100 * Math.pow(1 + tem, days360(start, settle) / 30), rate: b.tem, tirKind: 'TEA' };
      }
      case 'zero_cer': {
        const coef = ctx.cerLag(settle) / ctx.cerLag(D(b.issue));
        const z = zero(100, price / coef, coef);
        return { ...res, ...z, tna: null, tem: null, coef, vt: 100 * coef, next: { date: mat, amt: 100 * ctx.cerLag(mat) / ctx.cerLag(D(b.issue)) }, tirKind: 'real' };
      }
      case 'zero_dl': {
        const fx = ctx.a3500Now, z = zero(100, price / fx, fx);
        return { ...res, ...z, tna: null, tem: null, vt: 100 * fx, fx, next: { date: mat, amt: 100 * fx }, tirKind: 'USD' };
      }
      case 'cap_tamar': case 'dual_fixed_tamar': {
        const start = D(b.issue), today = settle;
        const tamarAcc = 100 * tamarFactor(ctx, start, today, b.spread, today);
        const tamarVF = tamarAcc * tamarFactor(ctx, today, mat, b.spread, today);
        let VF = tamarVF, vt = tamarAcc, leg = 'TAMAR';
        if (b.kind === 'dual_fixed_tamar') {
          const fixVF = 100 * Math.pow(1 + b.tem / 100, days360(start, mat) / 30);
          const fixAcc = 100 * Math.pow(1 + b.tem / 100, days360(start, settle) / 30);
          if (fixVF > tamarVF) { VF = fixVF; leg = 'Fija'; }
          vt = Math.max(fixAcc, tamarAcc);
        }
        return { ...res, ...zero(VF, price), vt, leg, rate: ctx.tamarNow + (b.spread || 0), tirKind: 'TEA', projected: true };
      }
      case 'dual_cer_tamar': {
        // Máximo entre capital ajustado por CER (+ tasa real) y capitalización TAMAR (+ margen). Ambas patas proyectadas:
        // CER al último valor publicado (sin inflación futura) y TAMAR constante: la TIR es un piso orientativo.
        const start = D(b.issue);
        const coef = ctx.cerLag(settle) / ctx.cerLag(start);
        const realF = Math.pow(1 + (b.realRate || 0) / 100, days360(start, mat) / 360);
        const cerVF = 100 * coef * realF;
        const tamarAcc = 100 * tamarFactor(ctx, start, settle, b.spread, settle);
        const tamarVF = tamarAcc * tamarFactor(ctx, settle, mat, b.spread, settle);
        const VF = Math.max(cerVF, tamarVF);
        const vt = Math.max(100 * coef * Math.pow(1 + (b.realRate || 0) / 100, days360(start, settle) / 360), tamarAcc);
        return { ...res, ...zero(VF, price), vt, leg: cerVF > tamarVF ? 'CER' : 'TAMAR', tirKind: 'TEA', projected: true };
      }
      case 'dual_tamar_dl': {
        const start = D(b.issue), fx0 = ctx.a3500(addBD(start, -3)), fx = ctx.a3500Now;
        const tamarAcc = 100 * fx0 * tamarFactor(ctx, start, settle, b.spread, settle);
        const tamarVF = tamarAcc * tamarFactor(ctx, settle, mat, b.spread, settle);
        const dlVF = 100 * fx;
        const VF = Math.max(tamarVF, dlVF);
        return { ...res, ...zero(VF, price, 1, 100 * fx0), vt: Math.max(tamarAcc, dlVF), leg: dlVF > tamarVF ? 'Dólar' : 'TAMAR', tirKind: 'TEA', projected: true };
      }
    }
    return res;
  }

  /* ---------- Precio a usar por bono (compartido por la página y el histórico) ---------- */
  const px = q => q ? (q.c > 0 ? q.c : (q.px_bid > 0 && q.px_ask > 0 ? (q.px_bid + q.px_ask) / 2 : 0)) : 0;
  const settlementDate = () => addBD(D(iso(new Date(Date.now() - 3 * 3600e3))), 1); // T+1 hábil, hora AR
  // quotes: { símbolo: cotización }. esp: 'usd' (MEP) o 'ccl' (cable), sólo para hard dólar.
  function priceFor(b, quotes, esp = 'usd') {
    const sym = b.group === 'HD' ? (b[esp] || b.usd || b.ars) : (b.ars || b.usd);
    const q = quotes[sym];
    // Hard dólar que sólo cotiza en pesos: se pasa a dólares al MEP implícito del AL30.
    const mep = px(quotes.AL30) / px(quotes.AL30D);
    const price = b.group === 'HD' && sym === b.ars && b.curr === 'USD' ? px(q) / mep : px(q);
    return { sym, q, price };
  }

  // Precio (por 100 VN, en la moneda del precio) que corresponde a una TIR efectiva anual y, sobre el flujo de value().
  const priceAtYield = (flows, y, settle) => flows.reduce((s, f) => s + f.amt / Math.pow(1 + y, days(settle, f.date) / 365), 0);

  const api = { value, priceAtYield, makeContext, couponFlows, addBD, days360, D, iso, px, settlementDate, priceFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BondEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
