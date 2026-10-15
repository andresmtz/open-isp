#!/bin/bash
# Instala en el host las unidades systemd del actualizador de GoWA (una sola vez, como root).
set -e
cat > /etc/systemd/system/gowa-updater.service <<'U'
[Unit]
Description=Actualizador de GoWA (pedido desde Open-ISP)
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/open-isp/scripts/gowa-updater.sh
U
cat > /etc/systemd/system/gowa-updater.path <<'U'
[Unit]
Description=Pedidos de actualización de GoWA desde Open-ISP
[Path]
PathExists=/opt/open-isp/docker-data/updater/request.json
Unit=gowa-updater.service
[Install]
WantedBy=multi-user.target
U
cat > /etc/systemd/system/gowa-status.service <<'U'
[Unit]
Description=Versión de GoWA en uso (para Open-ISP)
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/open-isp/scripts/gowa-updater.sh status
U
cat > /etc/systemd/system/gowa-status.timer <<'U'
[Unit]
Description=Actualiza la versión de GoWA en uso cada hora
[Timer]
OnBootSec=2min
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
U
mkdir -p /opt/open-isp/docker-data/updater
systemctl daemon-reload
systemctl enable --now gowa-updater.path gowa-status.timer
/bin/bash /opt/open-isp/scripts/gowa-updater.sh status
cat /opt/open-isp/docker-data/updater/status.json
