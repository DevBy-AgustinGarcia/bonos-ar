"""Baja los datos que la página necesita y los deja como archivos estáticos en data/.

- data/quotes.json : cotizaciones de data912 (bonos + letras). La página las pide en vivo
                     directo a data912; este archivo es el respaldo si esa llamada falla.
- data/indices.json: CER, TAMAR, BADLAR y A3500 de la API del BCRA, que no permite pedidos
                     desde el navegador. Se renueva si tiene más de INDICES_TTL horas.

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
          29: ("rem12", "2024-01-01")}      # REM: inflación esperada próximos 12 meses (mediana), %
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


def main(force=False):
    ok = True
    for name, fn in (("cotizaciones", update_quotes), ("indices", lambda: update_indices(force)),
                     ("tesoro EE.UU.", lambda: update_ust(force))):
        try:
            print(f"{name}: {fn()}")
        except Exception as e:  # una fuente caída no frena a la otra; queda el archivo anterior
            print(f"{name}: ERROR {e}", file=sys.stderr)
            ok = False
    return ok


if __name__ == "__main__":
    sys.exit(0 if main("--force" in sys.argv) else 1)
