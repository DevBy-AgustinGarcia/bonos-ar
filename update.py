"""Baja los datos que la página necesita y los deja como archivos estáticos en data/.

- data/quotes.json : cotizaciones de data912 (bonos + letras). La página las pide en vivo
                     directo a data912; este archivo es el respaldo si esa llamada falla.
- data/indices.json: CER, TAMAR, BADLAR, A3500, inflación, REM y tasas de referencia de la API
                     del BCRA, que no permite pedidos desde el navegador. Se renueva cada INDICES_TTL horas.
- data/ust.json    : curva del Tesoro de EE.UU. (riesgo país estimado).
- data/tasas.json  : plazo fijo por banco y rendimiento de fondos money market (ArgentinaDatos).

Lo corre la tarea programada de GitHub (cada 15 min en horario de mercado) y también server.py.
Uso:  python update.py  [--force]
"""
import json
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

DATA = Path(__file__).parent / "data"
BCRA = "https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/{id}?desde={desde}&hasta={hasta}&limit=3000"
# id de variable BCRA -> (clave, desde cuándo hace falta la serie)
SERIES = {30: ("cer", "2003-01-01"), 44: ("tamar", "2024-06-01"), 7: ("badlar", "2024-06-01"), 5: ("a3500", "2024-06-01"),
          27: ("inflacion", "2024-01-01"),  # inflación mensual (INDEC), %
          29: ("rem12", "2024-01-01"),      # REM: inflación esperada próximos 12 meses (mediana), %
          150: ("pases1d", "2025-01-01"),   # pases entre terceros a 1 día, TNA % (referencia de caución)
          12: ("pf30", "2025-01-01")}       # plazo fijo a 30 días, promedio del sistema, TNA %
INDICES_TTL = 6  # horas: el BCRA publica una vez por día


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "panel-bonos/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def bcra_series(var_id, desde):
    """Serie completa ascendente [[fecha, valor], ...]; pagina por tramos de ~3 años (límite 3000 filas)."""
    out, start, end = [], date.fromisoformat(desde), date.today() + timedelta(days=60)
    while start <= end:
        stop = min(start + timedelta(days=1000), end)
        for r in fetch_json(BCRA.format(id=var_id, desde=start, hasta=stop))["results"]:
            out += [[d["fecha"], d["valor"]] for d in r["detalle"]]
        start = stop + timedelta(days=1)
    return sorted(out)


def write(name, obj):
    """Escribe en un temporal y renombra, así la página nunca lee un archivo a medio escribir."""
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = DATA / (name + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    tmp.replace(DATA / name)


def update_quotes():
    data = []
    for ep in ("arg_bonds", "arg_notes"):
        data += fetch_json(f"https://data912.com/live/{ep}")
    write("quotes.json", data)
    return len(data)


def update_indices(force=False):
    try:  # si se agregó una serie nueva, se baja todo aunque el archivo sea reciente
        have = set(json.loads((DATA / "indices.json").read_text(encoding="utf-8")))
    except (OSError, ValueError):
        have = set()
    complete = {k for k, _ in SERIES.values()} <= have
    if not force and complete and age_of("indices.json") < INDICES_TTL * 3600:
        return False
    out = {key: bcra_series(var_id, desde) for var_id, (key, desde) in SERIES.items()}
    write("indices.json", {"updated": int(time.time()), **out})
    return True


UST = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/"
       "{y}/all?type=daily_treasury_yield_curve&field_tdr_date_value={y}&page&_format=csv")
# Columna del Tesoro de EE.UU. -> plazo en años
UST_COLS = {"1 Mo": 1 / 12, "1.5 Month": 1.5 / 12, "2 Mo": 2 / 12, "3 Mo": .25, "4 Mo": 1 / 3, "6 Mo": .5, "1 Yr": 1,
            "2 Yr": 2, "3 Yr": 3, "5 Yr": 5, "7 Yr": 7, "10 Yr": 10, "20 Yr": 20, "30 Yr": 30}


def age_of(name):
    """Segundos desde la última actualización guardada adentro del archivo (en GitHub el checkout pone la fecha de hoy)."""
    try:
        return time.time() - json.loads((DATA / name).read_text(encoding="utf-8")).get("updated", 0)
    except (OSError, ValueError):
        return float("inf")


def update_ust(force=False):
    """Curva de rendimientos del Tesoro de EE.UU. del último día publicado, para estimar el riesgo país."""
    if not force and age_of("ust.json") < INDICES_TTL * 3600:
        return False
    import csv, io
    rows = []
    for y in (date.today().year, date.today().year - 1):  # en enero puede no haber datos del año nuevo
        req = urllib.request.Request(UST.format(y=y), headers={"User-Agent": "panel-bonos/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            rows = list(csv.DictReader(io.StringIO(r.read().decode("utf-8"))))
        if rows:
            break
    last = rows[0]  # el CSV viene del más nuevo al más viejo
    m, d, y = last["Date"].split("/")
    curve = [[t, float(last[c])] for c, t in UST_COLS.items() if last.get(c)]
    write("ust.json", {"updated": int(time.time()), "date": f"{y}-{m}-{d}", "curve": curve})
    return f"{y}-{m}-{d}"


AD = "https://api.argentinadatos.com/v1/finanzas"
MM_FONDOS = 15     # fondos money market en pesos más grandes que se muestran
MM_DIAS = 7        # rendimiento sobre los últimos ~7 días (con 1 día el dato es muy ruidoso)


def update_rates(force=False):
    """Plazo fijo por banco y fondos money market. Guarda el valor cuotaparte de cada día en el
    propio archivo, porque la API sólo da los dos últimos días y hace falta una semana para medir."""
    if not force and age_of("tasas.json") < INDICES_TTL * 3600:
        return False
    try:
        prev = json.loads((DATA / "tasas.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prev = {}
    pf = [{"entidad": b["entidad"].title().replace(" S.A.", "").replace(" Sociedad Anonima", ""),
           "tna30": b.get("tnaClientes") or 0,
           "tasas": [[t["plazoMinDias"], t["tna"]] for t in (b.get("tasas") or []) if t.get("plazoMinDias") and t.get("tna")]}
          for b in fetch_json(f"{AD}/tasas/plazoFijo") if b.get("tnaClientes")]
    ult, pen = fetch_json(f"{AD}/fci/mercadoDinero/ultimo"), fetch_json(f"{AD}/fci/mercadoDinero/penultimo")
    pesos = [f for f in ult if f.get("patrimonio") and f.get("vcp") and not any(k in f["fondo"] for k in ("lar", "USD", "U$S", "US$"))]
    top = sorted(pesos, key=lambda f: -f["patrimonio"])[:MM_FONDOS]
    hist = prev.get("mmHist", {})
    pen_by = {f["fondo"]: f for f in pen if f.get("vcp")}
    mm, new_hist = [], {}
    for f in top:
        h = {d: v for d, v in hist.get(f["fondo"], [])}
        if f["fondo"] in pen_by:
            h[pen_by[f["fondo"]]["fecha"]] = pen_by[f["fondo"]]["vcp"]
        h[f["fecha"]] = f["vcp"]
        pts = sorted(h.items())[-12:]
        new_hist[f["fondo"]] = pts
        last_d, last_v = pts[-1]
        target = (date.fromisoformat(last_d) - timedelta(days=MM_DIAS)).isoformat()
        base = [p for p in pts[:-1] if p[0] <= target] or pts[:-1]  # la más cercana a 7 días atrás, si no la primera
        if not base:
            continue
        d0, v0 = base[-1] if base[-1][0] <= target else base[0]
        days = (date.fromisoformat(last_d) - date.fromisoformat(d0)).days
        if days <= 0 or v0 <= 0:
            continue
        r = last_v / v0 - 1
        mm.append({"fondo": f["fondo"], "patrimonio": f["patrimonio"], "desde": d0, "hasta": last_d, "dias": days,
                   "tna": r * 365 / days, "tea": (1 + r) ** (365 / days) - 1})
    write("tasas.json", {"updated": int(time.time()), "plazoFijo": pf, "mm": mm, "mmHist": new_hist})
    return f"{len(pf)} bancos, {len(mm)} fondos"


def main(force=False):
    ok = True
    for name, fn in (("cotizaciones", update_quotes), ("indices", lambda: update_indices(force)),
                     ("tesoro EE.UU.", lambda: update_ust(force)), ("tasas", lambda: update_rates(force))):
        try:
            print(f"{name}: {fn()}")
        except Exception as e:  # una fuente caída no frena a la otra; queda el archivo anterior
            print(f"{name}: ERROR {e}", file=sys.stderr)
            ok = False
    return ok


if __name__ == "__main__":
    sys.exit(0 if main("--force" in sys.argv) else 1)
