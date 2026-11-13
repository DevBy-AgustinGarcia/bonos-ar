# Panel de bonos argentinos

Precio, valor técnico, paridad, TIR y duration de los bonos y letras que cotizan en BYMA, separados por tipo: CER, TAMAR, duales, dollar linked, hard dólar, letras/tasa fija y otros. Se actualiza solo cada 15 minutos.

## Cómo usarlo

```bash
python server.py
```

Abrir http://localhost:8020. No necesita instalar nada (sólo Python 3).

## Archivos

- `update.py`: baja cotizaciones (data912) e índices del BCRA (CER, TAMAR, BADLAR, A3500) y la curva del Tesoro de EE.UU. a `data/`. El BCRA no permite pedidos desde el navegador, por eso se guardan como archivo.
- `analysis.js`: pestaña Análisis: inflación, devaluación y TAMAR implícitas, spread ley AR/NY y riesgo país estimado.
- `snapshot.js`: guarda una foto de precio y TIR de cada bono en `data/history/AAAA-MM.csv`.
- `server.py`: servidor local que corre `update.py` cada 15 minutos.
- `.github/workflows/actualizar.yml`: en GitHub corre lo mismo cada 15 min en horario de mercado y publica en Pages.
- `engine.js`: cálculo de flujos, valor técnico y TIR por tipo de instrumento.
- `catalog.json`: condiciones de emisión de cada instrumento, armadas a partir de las fichas técnicas de BYMA. Los que tienen `"ok": false` tienen algún dato supuesto (ver `notes`).
- `index.html`: la página.

## Supuestos

- Liquidación T+1 hábil, sin feriados.
- CER con rezago de 10 días hábiles.
- TAMAR/BADLAR futuras = la última publicada (TIR proyectada).
- Duales CER/TAMAR: CER futuro = último publicado, así que la TIR es un piso.
- Instrumentos nuevos que aparezcan en data912 no se muestran hasta agregarlos al catálogo.

## Trabajar en local

`server.py` reescribe `data/`, que también actualiza la tarea programada de GitHub. Antes de `git pull`, descartá los datos locales con `git checkout -- data` (y borrá archivos nuevos de `data/` que no estén en el repo).
