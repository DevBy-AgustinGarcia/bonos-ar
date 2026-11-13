/* Análisis entre curvas: compara la curva a tasa fija en pesos contra CER, dollar linked y TAMAR,
   y la curva hard dólar contra el Tesoro de EE.UU.
   Recibe las filas ya valuadas por la página (r.b = entrada del catálogo, r.tir, r.md, r.price, r.days).
   Funciona en el navegador (window.BondAnalysis) y en Node. */
(function (root) {
  'use strict';

  // Interpolación lineal en una curva [[x, y], ...] ordenada. Fuera del rango:
  // corto plazo = primer punto (plano); largo plazo hasta un 10% más allá del último, si no null.
  function interp(curve, x) {
    if (!curve.length || x == null) return null;
    if (x <= curve[0][0]) return curve[0][1];
    const last = curve[curve.length - 1];
    if (x >= last[0]) return x <= last[0] * 1.1 ? last[1] : null;
    const i = curve.findIndex(p => p[0] >= x), [x0, y0] = curve[i - 1], [x1, y1] = curve[i];
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }

  // Curva tasa fija en pesos (Lecaps, Boncaps y bonos a tasa fija): TEA contra duration modificada.
  // Se descartan TIR absurdas (bonos sin precio real) para que no tuerzan la interpolación.
  function fixedCurve(rows) {
    return rows.filter(r => r.b.group === 'LETRAS' && r.b.curr === 'ARS' && r.tir != null && r.md > 0 && r.tir > 0 && r.tir < 3)
      .map(r => [r.md, r.tir, r.tk]).sort((a, b) => a[0] - b[0]);
  }

  // Inflación implícita: (1 + tasa fija) / (1 + tasa real) − 1, al mismo plazo.
  function inflation(rows, fixed) {
    return rows.filter(r => r.b.group === 'CER' && r.b.issuer === 'Nación' && r.tir != null && r.md > 0).map(r => {
      const iFix = interp(fixed, r.md);
      const be = iFix == null ? null : (1 + iFix) / (1 + r.tir) - 1;
      return { tk: r.tk, mat: r.mat, md: r.md, tir: r.tir, iFix, be, monthly: be == null ? null : Math.pow(1 + be, 1 / 12) - 1 };
    }).sort((a, b) => a.md - b.md);
  }

  // Devaluación implícita: (1 + tasa fija) / (1 + TIR en dólares) − 1; dólar de equilibrio al vencimiento.
  function devaluation(rows, fixed, a3500) {
    return rows.filter(r => r.b.group === 'DL' && r.tir != null && r.md > 0).map(r => {
      const iFix = interp(fixed, r.md);
      const dev = iFix == null ? null : (1 + iFix) / (1 + r.tir) - 1;
      return { tk: r.tk, mat: r.mat, md: r.md, tir: r.tir, iFix, dev,
               fx: dev == null ? null : a3500 * Math.pow(1 + dev, r.days / 365) };
    }).sort((a, b) => a.md - b.md);
  }

  // TAMAR implícita: la TNA constante que hace rendir al bono lo mismo que la tasa fija al mismo plazo.
  // Se busca por bisección revaluando el bono con distintas TAMAR (la TIR sube con la TAMAR).
  function tamarBreakeven(rows, fixed, ctx, E) {
    return rows.filter(r => r.b.group === 'TAMAR' && ['float', 'cap_tamar'].includes(r.b.kind) && r.tir != null && r.md > 0).map(r => {
      const key = r.b.index === 'BADLAR' ? 'badlarNow' : 'tamarNow';
      const iFix = interp(fixed, r.md);
      let be = null;
      if (iFix != null) {
        const tirAt = x => E.value(r.b, r.price, { ...ctx, [key]: x }).tir;
        let lo = 0, hi = 150;
        const a = tirAt(lo), z = tirAt(hi);
        if (a != null && z != null && a <= iFix && z >= iFix) {
          for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2, t = tirAt(m); if (t == null) break; t < iFix ? lo = m : hi = m; }
          be = (lo + hi) / 2;
        }
      }
      return { tk: r.tk, issuer: r.b.issuer, index: r.b.index || 'TAMAR', mat: r.mat, md: r.md, tir: r.tir, iFix, now: ctx[key], be };
    }).sort((a, b) => a.md - b.md);
  }

  // Ley argentina (Bonares) contra ley Nueva York (Globales) del mismo año.
  const PAIRS = [['AL29', 'GD29'], ['AL30', 'GD30'], ['AL35', 'GD35'], ['AE38', 'GD38'], ['AL41', 'GD41']];
  function lawSpread(rows) {
    const by = Object.fromEntries(rows.map(r => [r.tk, r]));
    return PAIRS.filter(([a, g]) => by[a]?.tir != null && by[g]?.tir != null).map(([a, g]) => ({
      ar: a, ny: g, md: by[g].md, tirAr: by[a].tir, tirNy: by[g].tir, bps: (by[a].tir - by[g].tir) * 1e4,
      pxAr: by[a].price, pxNy: by[g].price,
    }));
  }

  // Spread contra el Tesoro de EE.UU. al mismo plazo (duration). El Tesoro publica tasas semestrales:
  // se pasan a efectiva anual para comparar con la TIR. El riesgo país estimado es el promedio de los Globales.
  function countryRisk(rows, ust) {
    if (!ust?.curve?.length) return { rows: [], embi: null };
    const curve = ust.curve.map(([t, y]) => [t, Math.pow(1 + y / 200, 2) - 1]);
    const out = rows.filter(r => r.b.group === 'HD' && r.b.issuer === 'Nación' && r.b.curr === 'USD' && r.tir != null && r.md > 0)
      .map(r => { const u = interp(curve, r.md) ?? curve[curve.length - 1][1];
                  return { tk: r.tk, mat: r.mat, md: r.md, tir: r.tir, ust: u, bps: (r.tir - u) * 1e4, ny: /^GD/.test(r.tk) }; })
      .sort((a, b) => a.md - b.md);
    const gd = out.filter(r => r.ny);
    return { rows: out, embi: gd.length ? gd.reduce((s, r) => s + r.bps, 0) / gd.length : null, date: ust.date };
  }

  const api = { interp, fixedCurve, inflation, devaluation, tamarBreakeven, lawSpread, countryRisk };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BondAnalysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
