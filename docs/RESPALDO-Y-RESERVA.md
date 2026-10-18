# Copias de seguridad y reserva en Genesis

Esta guía explica cómo están armadas las copias de seguridad de Faster y qué hacer en una emergencia.

## Cómo está armado

| Qué | Dónde | Cada cuánto | Se guarda |
|---|---|---|---|
| Todas las VM y contenedores del Proxmox de Faster (10.255.0.2): open-isp, MikroTik CHR, cloudflared, Uptime Kuma, AdGuard, homelable y MikroDash | Proxmox Backup Server en **Genesis** (10.10.1.94:8007), almacén `faster` | 02:00, 08:00, 14:00 y 20:00 | las últimas 8 copias, 14 diarias, 8 semanales y 6 mensuales |
| Datos del sistema: base de datos (copia en caliente), documentos, fotos, comprobantes, ajustes y sesión de WhatsApp | mismo almacén, grupo `host/openisp-datos` | cada hora, en el minuto 17 | igual que la fila anterior |
| **VM de reserva 908 `open-isp-reserva`** | Genesis, con IP fija **192.168.218.208** (reserva DHCP en `/etc/dnsmasq.d/genesis.conf`) | se actualiza a las 02:40, 08:40, 14:40 y 20:40 con la última copia | apagada y con la red desconectada |

- Todas las copias van **cifradas**. Las claves están en el Proxmox de Faster (`/etc/pve/priv/storage/pbs-genesis.enc`), en la VM (`/root/.pbs/db.key`) y en Genesis, fuera del almacén de copias (`/root/claves-backup-faster/`).
  - **Guardá también una copia de esos dos archivos en un lugar seguro tuyo**, por ejemplo un gestor de contraseñas o un pendrive guardado. Sin ellos no se puede restaurar.
- El sistema revisa las copias cada 30 minutos y avisa por WhatsApp si alguna se atrasa:
  - más de 13 h en las máquinas;
  - más de 3 h en los datos.
- Los registros se pueden revisar en tres lugares:
  - Proxmox de Faster → Centro de datos → Respaldo (tarea `faster-a-genesis`);
  - `/var/log/faster-datos-backup.log` en la VM;
  - `/var/log/faster-reserva.log` en Genesis.

## Emergencia: el Proxmox de Faster no está (robo, falla o corte largo)

1. Entrá a Genesis (web de Proxmox o SSH) y en la consola ejecutá:
   ```bash
   faster-levantar-reserva.sh
   ```
   - Primero controla que el sistema de Faster **no** responda. Si responde, no hace nada, para no duplicar mensajes, cortes ni la sesión de WhatsApp.
   - Después conecta la red, enciende la VM 908 y le carga los datos de la última copia horaria. Como mucho se pierde una hora.
   - Al final muestra la IP de la reserva: siempre **`http://192.168.218.208:3001`**.
2. Para que clientes y técnicos entren por la dirección de siempre, entrá a **Cloudflare Zero Trust → Networks → Tunnels**:
   - pasá el nombre del sistema al **túnel de Genesis** (contenedor 100 `cloudflared`, IP 192.168.218.215), porque el de Faster no está;
   - el servicio de destino es `http://192.168.218.208:3001`;
   - el sistema ya confía en ese túnel (`trusted_proxies` incluye 192.168.218.215), así que ve bien la IP real de cada visitante.
3. WhatsApp vuelve a conectarse con la sesión copiada. Si pide vincular de nuevo, escaneá el QR desde Sistema → WhatsApp.
4. Alcance de la reserva desde Genesis:
   - **llega** al MikroTik (10.255.0.1) y al Proxmox de Faster por la WireGuard, si el sitio de Faster sigue en pie;
   - **llega a la OLT** (192.168.8.100) por el router de casa, que tiene una ruta /32 hacia el NOC (la red 192.168.8.x de casa es de otra OLT, la 192.168.8.200);
   - si el sitio de Faster está caído, no llega a ninguno de los dos. Igual funcionan:
   - cobros;
   - portal de clientes;
   - conversaciones;
   - reclamos.

## Cuando vuelve Faster

1. **Primero apagá la reserva** en Genesis:
   ```bash
   qm shutdown 908
   ```
2. Si mientras tanto se trabajó en la reserva (cobros, chats), llevá esos datos al sistema original **antes** de encenderlo. Pedí ayuda para hacer esa copia y no pisar nada.
3. Encendé la VM 108 de Faster y volvé a apuntar el túnel de Cloudflare a 10.255.0.12:3001.
4. Desconectá de nuevo la red de la reserva (en el script `faster-reserva-actualizar.sh`) y dejala apagada: se actualiza sola en la próxima copia.

## Restaurar una copia puntual

- **Una VM o un contenedor:** Proxmox de Faster → elegí la máquina → Respaldo → almacenamiento `pbs-genesis` → Restaurar. Para restaurarla en Genesis, usá el almacenamiento `pbs-faster`.
- **Un archivo de los datos** (por ejemplo la base de datos de ayer): Genesis → almacenamiento `pbs-faster` → contenido → `host/openisp-datos` → *File restore*.
