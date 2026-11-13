"""Servidor local para desarrollo: sirve la carpeta y renueva los datos cada 15 minutos con update.py.

Los datos locales van a .local/data/ (ignorado por git) y se sirven en lugar de data/, así no chocan
con los que sube la tarea programada de GitHub.

Publicado (GitHub Pages / Vercel) no hace falta: la página es estática y la tarea programada
de GitHub mantiene data/ al día.

Uso:  python server.py   y abrir http://localhost:8020
"""
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import update

PORT = 8020
ROOT = Path(__file__).parent
LOCAL = ROOT / ".local" / "data"
update.DATA = LOCAL


def refresher():
    while True:
        update.main()
        time.sleep(15 * 60)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def translate_path(self, path):
        # /data/x se sirve desde .local/data/x si existe; si no, del data/ del repo.
        rel = path.split("?")[0].lstrip("/")
        if rel.startswith("data/") and (LOCAL / rel[5:]).is_file():
            return str(LOCAL / rel[5:])
        return super().translate_path(path)

    def end_headers(self):
        # Evita que el navegador use una versión vieja del catálogo, el motor o los datos después de editarlos.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    threading.Thread(target=refresher, daemon=True).start()
    print(f"Panel de bonos en http://localhost:{PORT}  (Ctrl+C para cortar)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
