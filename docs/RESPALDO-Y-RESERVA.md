# Copias de seguridad y reserva en Genesis

Esta guía explica cómo están armadas las copias de seguridad de Faster y qué hacer en una emergencia.

## Cómo está armado

| Qué | Dónde | Cada cuánto | Se guarda |
|---|---|---|---|
| Todas las VM y contenedores del Proxmox de Faster (10.255.0.2): open-isp, MikroTik CHR, cloudflared, Uptime Kuma, AdGuard, homelable y MikroDash | Proxmox Backup Server en **Genesis** (10.10.1.94:8007), almacén `faster` | 02:00, 08:00, 14:00 y 20:00 | las últimas 8 copias, 14 diarias, 8 semanales y 6 mensuales |
| Datos del sistema: base de datos (copia en caliente), documentos, fotos, comprobantes, ajustes y sesión de WhatsApp | mismo almacén, grupo `host/openisp-datos` | cada hora, en el minuto 17 | igual que la fila anterior |
| **VM de reserva 908 `open-isp-reserva`** | Genesis, con IP fija **192.168.218.208** (reserva DHCP en `/etc/dnsmasq.d/genesis.conf`) | se actualiza a las 02:40, 08:40, 14:40 y 20:40 con la última copia | apagada y con la red desconectada; simulacro completo OK el 18/10/2026 |

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
   - Deja puesta la marca "reserva en uso" (`/var/lib/faster-reserva.activa` en Genesis). Si la VM de Faster vuelve a encenderse sola, por ejemplo cuando vuelve la luz, **no arranca el sistema** mientras exista esa marca.
   - Conecta la red, enciende la VM 908 y quita las rutas fijas que trae copiadas de Faster (iban por 10.255.0.4, que en Genesis no existe).
   - Le carga los datos de la última copia horaria (como mucho se pierde una hora), WhatsApp incluido.
2. **Entrar por IP**, desde casa o la WireGuard: **`http://10.10.1.94:3001`**. Genesis redirige ese puerto a la reserva (192.168.218.208); la redirección se quita al volver.
3. **Solo si hace falta que entren clientes y técnicos** por la dirección de siempre: en **Cloudflare Zero Trust → Networks → Tunnels**, pasá el nombre del sistema al **túnel de Genesis** (contenedor 100 `cloudflared`, IP 192.168.218.215), con destino `http://192.168.218.208:3001`.
4. WhatsApp se conecta con la sesión copiada. Si pide vincular de nuevo, escaneá el QR desde Sistema → WhatsApp.
5. Alcance de la reserva, si el sitio de Faster sigue en pie (probado el 18/10/2026):
   - llega al MikroTik: la API acepta 10.10.1.94;
   - llega a la OLT, por la ruta /32 del router de casa hacia el NOC.
   Si el sitio de Faster está caído, no llega a ninguno de los dos, pero igual funcionan:
   - cobros;
   - portal de clientes;
   - conversaciones;
   - reclamos.

## Cuando vuelve Faster

1. En **Genesis**:
   ```bash
   faster-volver-a-faster.sh
   ```
   Frena el sistema en la reserva, hace una copia final con todo lo que se trabajó ahí, la apaga, le desconecta la red y quita el acceso por IP.
2. En la **VM de Faster** (10.255.0.12):
   ```bash
   faster-cargar-desde-reserva.sh
   ```
   - Guarda los datos que tenía en `/root/antes-de-volver-<fecha>/`.
   - Carga la copia final de la reserva, con la base de datos y la sesión de WhatsApp para no tener que escanear el QR.
   - Quita la marca de "reserva en uso" y arranca el sistema.
3. Si habías cambiado Cloudflare, volvé a apuntarlo a `http://10.255.0.12:3001`.
4. La reserva se actualiza sola en la próxima copia y queda apagada y desconectada.

## Restaurar una copia puntual

- **Una VM o un contenedor:** Proxmox de Faster → elegí la máquina → Respaldo → almacenamiento `pbs-genesis` → Restaurar. Para restaurarla en Genesis, usá el almacenamiento `pbs-faster`.
- **Un archivo de los datos** (por ejemplo la base de datos de ayer): Genesis → almacenamiento `pbs-faster` → contenido → `host/openisp-datos` → *File restore*.
