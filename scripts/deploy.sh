#!/usr/bin/env bash
# Publica la última versión en el servidor: trae los cambios, genera la información de versión
# (build-info.json: número, fecha y lista de cambios) y reconstruye el contenedor.
# Uso (en el servidor):  /opt/open-isp/scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull -q
python3 - <<'PY'
import json, subprocess, datetime
sh = lambda *a: subprocess.check_output(['git', *a], text=True).strip()
changes = []
for line in sh('log', '-40', '--format=%h%x09%cI%x09%s').splitlines():
    h, date, subject = (line.split('\t', 2) + ['', ''])[:3]
    changes.append({'h': h, 'date': date, 'subject': subject})
info = {
    'build': int(sh('rev-list', '--count', 'HEAD')),
    'commit': sh('rev-parse', '--short', 'HEAD'),
    'date': sh('log', '-1', '--format=%cI'),
    'deployedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'branch': sh('rev-parse', '--abbrev-ref', 'HEAD'),
    'changes': changes,
}
open('build-info.json', 'w').write(json.dumps(info, ensure_ascii=False, indent=1))
print(f"Versión v{info['build']} ({info['commit']})")
PY
docker compose up -d --build open-isp
