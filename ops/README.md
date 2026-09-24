# Dónde vive la ingesta

> **Fuente única de "qué corre dónde".** Si otro documento contradice a éste, gana éste —
> y corregí el otro. Medido en vivo el **2026-09-11**.
>
> Antes de este día TODA la ingesta corría en una máquina de escritorio Windows (`.249`),
> con la agenda en el Programador de Windows: fuera del repo, invisible en un diff, y
> **17 de 21 tareas atadas a una sesión de usuario abierta**. La noche del 10-sep esa
> máquina se reinició por Windows Update y **la ingesta estuvo 9.5 h parada** porque Docker
> Desktop no arranca hasta que alguien inicia sesión. Eso es lo que la Fase VL vino a
> terminar (ADR-060).

---

## 1. Los dos lugares

| | `md` — **el servidor** | `.249` — **la máquina de escritorio** |
|---|---|---|
| Qué es | `192.168.0.222` · Ubuntu Server 26.04.1 · **Ryzen 5 3400G 4c/8t** · **28.8 GiB** · NVMe 1 TB ⚠️ *corregido 2026-09-22 con `lscpu`: este renglón decía «4600G 6c/12h · 14 GiB» desde el 10-sep — es el **mismo** modelo que `.249`, no uno mejor, y la RAM ya se había subido* | `SISTEMAS` · Windows 11 · Ryzen 5 3400G · 30 GB |
| Qué corre | **La ingesta completa**: la fuente + los 17 carriles | Sólo lo que **no puede** correr en Linux, y el respaldo |
| Cómo arranca | `systemd` → Docker → `restart: unless-stopped`. **Sin sesión, sin nadie.** | Docker Desktop y 5 de 6 tareas **exigen sesión iniciada** |
| Verificado | ⭐ **Reinicio real el 2026-09-11**: los 8 contenedores volvieron solos en **39 s**, Postgres sin recuperación de caída, las 8 suscripciones al instante | — |

Acceso: `ssh superoot@192.168.0.222`.

---

## 2. Qué corre en `md`

Todo se define en **[`ops/vl/docker-compose.yml`](vl/docker-compose.yml)** (en el servidor vive
en `~/ops/vl/`). Los secretos en `~/secrets/{feeds,ingest}.env`, permisos `600`, **fuera del repo**.

### 2.1 Contenedores

| Contenedor | Qué hace | Cadencia | Latido |
|---|---|---|---|
| `pgvector-md` | **La fuente**: Postgres 18 con las 8 réplicas lógicas de las sucursales + `kepler_consolidado`. Publica `:5433` | — | healthcheck `pg_isready` |
| `ods-live-hot` | Carril caliente réplica → `kepler_ods` de prod (venta, movimientos, catálogos) | @15 s | `ods_live_hot` |
| `ods-live-mirror` | Espejo completo de lo que el hot no cubre | @300 s | `ods_live_mirror` |
| `ods-reconcile` | **La única alarma de COMPLETITUD**: compara llaves y repone el delta | @900 s | `cdc_reconcile` |
| `feeds-cron` | Los **17 carriles agendados** (§2.2) | ver abajo | uno por carril |
| `feeds-livefast` | Venta del día + cajas abiertas. Sub-minuto, por eso **no** va en cron | @60 s | `feed_livefast` |
| `store-poller` | Tickets en vivo → `/tienda/live` | @25 s | `store_poller` |
| `ods-autoheal` | **El brazo**: reinicia lo que se declare `unhealthy` | @30 s | — |

### 2.2 Los carriles agendados

La agenda vive **versionada en el repo**: [`ops/vl/crontab.feeds`](vl/crontab.feeds). Un cambio se
revisa en un diff, que es justo lo que el Programador de Windows no permitía.

```
* * * * *          contpaqi
* * * * *          caja-mv               (refresh-caja-matview; latido `mv_caja_refresh`)
*/2 * * * *        refresh-consolidado   ⭐ [NORM.3] era el ÚNICO mudo — ya late (`consolidado_refresh`)
*/5 * * * *        watchdog
3-58/5 * * * *     contpaqi-cfdis        (incremental del ADD)
5,20,35,50 * * * * stock
*/30 * * * *       live                  ⭐ [NORM.3] de 4 pasos a 2: `sales-fact` y `cash-sessions` los hace `livefast` @60 s
2,32 * * * *       prices
15 * * * *         intraday
25 */2 * * *       contpaqi-slow
0 3 * * *          nightly               ⭐ [NORM.3] su fact COMPLETO (13 m) late aparte: `kepler_sales_fact_full`
30 4 * * *         receipts              (barrido histórico; era @1 min hasta DB-MEM.2)
45 5 * * *         contpaqi-cfdis-full   (reconciliador, ~167k CFDIs)
10 5 * * *         inventory-products    ⭐ [NORM.2] escaneo del conteo — NO estaba agendado
20 5 * * *         products-active       ⭐ [NORM.2] 9 lectores — NO estaba agendado
0 2 * * 6          catalog               (sábado 02:00)
22 6 * * *         replica-refresh       (kepler-replica-refresh; latido `kepler_replica_refresh`)
```

> **[LT.9.2, 2026-09-17]** `fleet-gps` salió de esta agenda: hacía el mismo trabajo que el
> `FleetPollerService` del API, que medido con `pg_stat_statements` ponía el **91.4 %** de las
> posiciones (25,498 filas contra 2,385 en 56.5 h). El latido `fleet_gps` lo escribe ahora el
> API. Detalle y el orden en que se hizo, en [`FASE_LT`](../docs/IMPLEMENTACION/FASES/FASE_LT_RASTREO_FLOTA.md).

⛔ **Esas fases no son decorativas y este README las tuvo MAL hasta el 2026-09-12** — decía
`*/15 stock`, `*/30 live · prices`, `0 * * * * intraday`, `0 */2 contpaqi-slow`, que es la versión
**colapsada** que provocó el incidente de VL.4: los cuatro carriles más pesados cayendo en el mismo
minuto contra un Postgres IO-limitado, con el ship del ODS muriendo por `statement timeout`. El
escalonamiento original era accidental (cada tarea de Windows repetía desde la hora en que alguien
la creó) pero el sistema dependía de él. Si vas a tocar una cadencia, la fuente es
[`ops/vl/crontab.feeds`](vl/crontab.feeds), **no esta tabla**.

Todos pasan por **[`ops/vl/run-feed.sh`](vl/run-feed.sh)**, que hace dos cosas que `crond` no:
carga el entorno desde el archivo (busybox `crond` **no hereda** el entorno del contenedor) y
serializa con `flock` (no existe el `IgnoreNew` del Programador, y los de 1 minuto se apilarían).

---

## 3. Qué sigue en `.249`, y por qué

| Tarea | Por qué no se mudó | Cuándo |
|---|---|---|
| ~~`WincajaLive` · `WincajaSyncActual` · `WincajaSyncConcentrada`~~ ✅ **DESHABILITADAS 2026-09-22** | ⛔ **El único bloqueo real de "todo en Linux"**: leen `.mdb` con **Jet 4.0 de 32 bits** sobre `Z:` (`\\192.168.0.245\D`). `Z:` es una unidad **mapeada por sesión**, así que la tarea **no puede** correr sin sesión iniciada — y un token `S4U` tampoco lleva credenciales de red | ⭐ **VL.5 se CANCELA**: Sistemas informó el 2026-09-12 que **Wincaja deja de existir en ~1 semana**. No se porta nada a Linux — sería infraestructura para un sistema con siete días de vida |
| `KeplerFeedGuardian` | ⛔ **Desde el 2026-09-22 NO VIGILA NADA**: su lista son 11 tareas y las 11 están `Disabled` (10 se mudaron en VL.4 y `WincajaLive` se retiró hoy), y su código hace `continue` con las deshabilitadas. Sigue latiendo en verde — el falso verde de siempre. **Se deja prendido a propósito**: su llave `feed_guardian` tiene umbral registrado (`warnH 0.5 / critH 2`), así que apagar la tarea sin retirar la llave del código pone esa alarma en rojo. Retirarlo = apagar la tarea **y** sacar la llave, en el mismo cambio | VL.7 |
| ~~`TradeMarketing-DailyBackup`~~ ✅ **DESHABILITADA 2026-09-22 — se mudó a `md`** | `pg_dump` de prod. Era `S4U` (sobrevivía al reinicio) pero **llevaba 12 días sin producir un archivo** (ParserError de PowerShell) y el `ok` de `backup_prod` lo había escrito una **prueba de instrumentación**, nunca un respaldo real. ⭐ **No se mudó por el enlace**: se midió el cable con el MISMO comando desde las dos máquinas y dan casi igual (218 MB/min desde `SISTEMAS`, 260 desde `md`). Se mudó porque `md` arranca sin sesión, su `pg_dump` es 18.6 —la misma minor que el servidor, contra 18.4 acá—, desaparece la clase de fallo del ParserError, y **el restore del corte ocurre en `md`: tomar ahí el volcado cada noche es ensayar ese camino todas las noches**. Ahora es el contenedor `prod-backup`, 22:00 MX, latido con `host = md-backup`. Deshabilitada y **no borrada**: un solo dueño de `backup_prod` | **VL.6.4** ✅ |
| ⛔ **`[VL.13]` El respaldo de `md` volcaba RAILWAY — corregido 2026-09-23** | El contenedor `prod-backup` monta `/secrets/ingest.env` **como archivo**, y el bind de Docker resuelve por **INODO**: al reescribir ese archivo en el host (23-sep 10:24, repuntando de Railway a `pg-prod`) cambió el inodo y el contenedor —23 h arriba— quedó clavado al anterior. El host decía `pg-prod:5432`, el contenedor leía `trolley.proxy.rlwy.net`. **Sin error y sin aviso.** Consecuencia: la producción real en `md` **no tenía ni un respaldo lógico**, y el `pg_dump` "fallido" de anoche era un crash de backend **de Railway**, no de `md`. ⇒ **Tras editar un secreto montado como ARCHIVO hay que RECREAR el contenedor; un `restart` no basta.** Compuerta nueva (`1-bis`): se compara el `system_identifier` del destino contra el del clúster local que respalda pgBackRest y se **aborta** si difieren — la compuerta vieja clasificaba por FORMA y no podía verlo, porque `md` es una restauración de Railway. Primer volcado real de `md`: **2,216 MB en 327 s** (contra Railway eran ~75 min: **13.5×**) | **VL.13** ✅ |
| `PM2 Resurrect ODS` | ⛔ **NO es residuo todavía**: es lo que revive los carriles de PM2 de abajo tras un reinicio. Apagarlo antes de que Wincaja se vaya los mata en el próximo boot | VL.7, **después** de Wincaja |

### 3.1 PM2 en `.249` — que este README omitía

Medido el **2026-09-12**. Existe un segundo sustrato en `.249` además del Programador, y no estaba
documentado: si sólo mirás `Get-ScheduledTask` concluís que la máquina ya no hace nada, y es falso.

| App PM2 | Qué hace | Estado, medido el **2026-09-22** |
|---|---|---|
| `caja-general-replica` · `caja-general-ship` | `.mdb` de Caja General → espejo `:5433/caja_general` → `caja_general_ods` | 🟢 **ONLINE — y este README no los listaba.** ⛔ Son ahora **el único bloqueo real de «todo en Linux»**: Jet 32-bit sobre `Z:` (`\192.168.0.245\D`), igual que Wincaja. ⚠️ Su `CAJA_GENERAL_REPLICA_URL` dice `localhost:5433`, pero el `:5433` de `.249` está jubilado (§3.2) — llega a **`md`** por el reenvío `netsh` de §3.2.1. Funciona, y la configuración no lo dice. ⛔ **`[VL.14]` 2026-09-23: su `DATABASE_URL_NEW` apuntaba a RAILWAY** — o sea que el ship escribía la Caja General a la producción VIEJA. Repuntado a `192.168.0.222:5434` y **`pm2 save`**; el primer ciclo contra `md` escribió **+19 doctos / +10 arqueos** que a prod le faltaban (contra Railway venía escribiendo `0`). Dato, no hipótesis |
| ~~`wincaja-inc` · `wincaja-hash`~~ | Réplica cruda Access → `:5433/wincaja` | ⏹️ **DETENIDOS 2026-09-22** (`pm2 stop` + `pm2 save`, reversible). Medido antes de tocarlos: `inc` daba `read 0 · wrote 0` en cada ciclo, y `hash` leía **186,255 filas para escribir CERO** en **873 s por pasada**. ⭐ **`[VL.14]` 2026-09-23 — ahora se sabe POR QUÉ leían cero: Wincaja se apagó el 2026-09-19.** El corte, día por día: `09-18` Wincaja 30/32 = **4,334** líneas / Kepler 07/08 = 565 docs → `09-19` Wincaja = **0** / Kepler = **1,336**, y de ahí CERO todos los días. El CEDIS paró el 09-18. La decisión de detenerlos fue correcta; lo que faltaba era **retirar sus sondas** (se hizo) |
| ~~`wincaja-live-tickets`~~ | Tickets w30/w32/w00 → `/tienda/live` | ⏹️ **DETENIDO 2026-09-22.** Fallaba cada minuto (`timeout expired`, `ECONNRESET`) contra `.245/platform_test` —la base de **desarrollo**, no prod— y PM2 lo mostraba `online` |
| ~~`contpaqi-cfdis-inc` · `contpaqi-cfdis-full`~~ | CFDIs del ADD → `fiscal.cfdis` | ⏹️ **DETENIDOS 2026-09-22.** ⛔ Este README los daba por mudados el 12-sep y *en `pm2 stop`*, y estaban **ONLINE**: `PM2 Resurrect` los revivió tras un reinicio de Windows, porque el `pm2 save` los tenía como activos. El `inc` corría **duplicado** con el contenedor de `md` **y mudo** — su latido fallaba con `timeout expired`, así que el renglón lo escribía el otro y el duplicado era invisible |

⚠️ **`contpaqi_add_cfdis_full` va a seguir diciendo `host = SISTEMAS` hasta mañana 05:45**, que es
su primera pasada en `md`. Es lo mismo que pasó con `feed_nightly` tras VL.4: hasta la primera
corrida, el renglón conserva el host viejo. Si el **jueves** sigue diciendo `SISTEMAS`, **ahí sí**
es un problema.

### 3.2 ✅ El `:5433` de `.249` está JUBILADO (2026-09-12) → [runbook](vl/RUNBOOK-jubilar-5433-249.md)

**`.249` ya no tiene base de datos.** Quedó `Exited (0)` — apagado limpio — después de mover
`wincaja` (40 GB, 34 esquemas, 2,316 tablas) a `md` y cuadrarla contra el origen: **147,449,607
filas exactas a los dos lados, cero tablas con conteo distinto, y 264 sumas de control de dinero
sin una diferencia.**

⛔ **Los 3 carriles de Wincaja NO se mudaron de máquina** — leen los `.mdb` con Jet de 32 bits sobre
`Z:`. Siguen en `.249`; lo que cambió es su **destino** (`WINCAJA_REPLICA_URL` → `192.168.0.222:5433`).
`.249` pasa a ser un lector de Access sin base propia.

⚠️ **El volumen `pgvector-md-data` sigue intacto**: `docker start pgvector-md` revierte en segundos.
`docker volume rm` es otra cosa y se pide aparte.

Lo demás que sigue vivo en `.249`: los 3 carriles Wincaja, `redis-md` (pub/sub de un dev server, no
es ingesta), `ods-autoheal` (**ya no vigila nada**: sus objetivos se fueron a `md` — residuo de
VL.7), `FeedGuardian` y `PM2 Resurrect ODS`. ⚠️ `TradeMarketing-DailyBackup` **salió de esta
lista el 2026-09-22**: el respaldo de prod vive ahora en el contenedor `prod-backup` de `md`
(VL.6.4). La tarea quedó **deshabilitada, no borrada**.

#### 3.2.1 ⛔ El REENVÍO TCP de `.249:5433` — 11 camionetas cuelgan de él, y no estaba escrito acá

Medido el **2026-09-15**. `.249` ya no tiene base, pero **sigue escuchando en el 5433**:

```
netsh interface portproxy show all     →     0.0.0.0:5433  →  192.168.0.222:5433
```

Lo puso VL.7.5 para no tener que visitar las camionetas el mismo día del corte. **Las 11 vans de
ruta escriben su venta ahí** (`push-ruta.cmd` con `DST=…@192.168.0.249:5433/kepler_consolidado`) y
llegan a `md` por este salto. Funciona — y **por eso el riesgo es invisible**: la venta de ruta
depende de una máquina de escritorio que ya no es servidor de nada y **que se reinicia sola con
Windows Update**.

⭐ El reenvío vive en el servicio `iphlpsvc` (automático, **arranca con la máquina, sin sesión**), o
sea que es *más* disponible que el Postgres en Docker Desktop al que reemplazó. Pero sigue siendo
una dependencia de más en el camino del dinero.

**Quién empuja, medido del dato** (no de `netstat`: las vans suben al cerrar el día, así que en
cualquier instante puede no haber ninguna conectada):

```sql
SELECT sucursal, max(fecha), (CURRENT_DATE - max(fecha)) AS dias, count(*)
  FROM mart.ventas WHERE sucursal LIKE 'ruta_%' GROUP BY 1 ORDER BY 2 DESC;
```

**11 rutas** (PH `21,22,23,26,27,28` + Canindo `501–505`) — ⚠️ *no* las ~35 que decía el plan de VL.
Al 15-sep, 10 empujaron el día anterior y **`ruta_505` llevaba 5 días muda** (falla anterior, ajena
a esto).

**Cómo se desengancha:** [CASO 4 del runbook de camionetas](../database/importers/kepler/route-push/RUNBOOK_ALTA_CAMIONETA.md)
— una línea por van (`DST` → `.222`), de a una y verificando. ⛔ **El reenvío no se quita hasta que
las 11 estén verificadas**, y antes de quitarlo hay que medir **qué más lo usa**: se vieron
conexiones locales desde `127.0.0.1:5433` en la propia `.249`. Quitarlo sin mirar eso es repetir el
apagón de 49 h (se inventarió *qué corre en* la máquina y nunca *quién le escribe desde afuera*).

Del lado servidor **no hay nada que abrir**: `md` no tiene `ufw` activo, publica `0.0.0.0:5433` y su
`pg_hba` es `host all all all scram-sha-256`. En `.249` sí había regla de firewall, y dejaba entrar
a exactamente tres subredes: `192.168.0.0/24`, `192.168.10.0/24`, `192.168.50.0/24`.

⛔ **El contenedor se llama `pgvector-md` en las DOS máquinas**, y el de `md` es la fuente viva.
Antes de correr nada: `docker exec pgvector-md psql -U postgres -tAc "SELECT count(*) FILTER
(WHERE subenabled) FROM pg_subscription"` → **`0` = `.249`** (la que se jubila) · **`8` = `md`,
pará**.

✅ **Paso 0 hecho el 2026-09-12**: las 8 suscripciones apagadas de `.249` **seguían agarradas al
`slot_name` del publicador** — el mismo slot que `md` usa. Con eso puesto, un `DROP SUBSCRIPTION`
allá no es local: le borra el slot **al publicador** y le corta la fuente al servidor vivo. Se
soltaron con `SET (slot_name = NONE)` (reversible); verificado después: `.249` sin slots, `md` con
las 8 activas recibiendo a 0.0–0.3 min.

⚠️ **Y el "rollback" ya no existe: está medido.** `.249` quedó **1.83 GB de WAL atrás** de lo que
`md` consumió, y el hueco crece. Re-apuntarlo hoy lo haría retomar desde la posición actual del
slot, dejando un hueco permanente. Los `kepler_md_*` de `.249` son una **foto fría del 11-sep**,
no un standby — dejá de llamarlos rollback antes de que alguien decida apoyándose en la palabra.

⚠️ **Las 11 tareas que sí se mudaron quedaron DESHABILITADAS, no borradas** — son el rollback.
No las vuelvas a habilitar sin apagar antes su contenedor: **un carril = UN dueño**, y dos
procesos con el mismo `job_key` se pisan el renglón del latido (pasó hoy con el watchdog).

---

## 4. Cómo se despliega un cambio

`md` **no tiene el repo**, y la imagen es **autocontenida** (el código se copia adentro). O sea
que un cambio de código exige **reconstruir**, no reiniciar:

```sh
ops/vl/deploy.sh                 # reconstruye y recrea los feeds
ops/vl/deploy.sh feeds-cron      # sólo esos servicios
ops/vl/deploy.sh --estado        # qué corre allá y con qué imagen
```

⛔ Archiva **`HEAD`**, no la copia de trabajo: el índice de git lo comparten ~10 sesiones y el
working tree traería WIP ajeno a producción. Te avisa qué archivos no viajan.

### 4.1 `api`/`worker` se despliegan SOLOS desde `origin/main` (`[VL.17]`, 2026-09-24)

Ya no hay que correr nada: `ops/prod/auto-deploy.sh` mira `origin/main` cada 5 minutos y, si lo
que está horneado en la imagen no coincide, construye, recrea y **verifica**. La agenda está
versionada en [`ops/prod/crontab.auto-deploy`](prod/crontab.auto-deploy).

```sh
ssh superoot@192.168.0.222 'sh ~/ops/prod/auto-deploy.sh --estado'   # qué sirve vs qué hay en main
ssh superoot@192.168.0.222 'tail -n 40 ~/ops/prod/auto-deploy.log'
# y el veredicto que vale: Salud BD → job_key = 'auto_deploy'
```

⭐ **Despliega `origin/main`, y eso lo hace MÁS seguro que el despliegue a mano**, no menos:
`deploy.sh` archiva el HEAD de quien lo corre, así que puede subir código que nadie revisó y que
no está en el remoto — medido el 2026-09-23, prod corrió horas un commit ausente de `origin/main`.

⛔ **Se FRENA solo si `origin/main` trae migraciones que prod no tiene aplicadas**, y lo dice en
el latido. Eso no es una falla del carril: es el carril funcionando. Para destrabarlo hay que
aplicarlas **una por una** con
[`database/scripts/apply-one-migration-prod.js`](../database/scripts/apply-one-migration-prod.js)
— que **verifica la identidad del clúster antes de escribir**, porque el `FLEET_DB_URL` del `.env`
todavía apunta a Railway y el camino documentado llevaba, callado, a la base equivocada
(`[VL.18]`). Nunca `migrate:latest`: hay **dos** `knex_migrations` y el `search_path` lleva a la
vacía.

⚠️ La lección que dejó instalarlo: **el script no es el carril**. Estuvo instalado, con la llave
de GitHub funcionando y una corrida a mano perfecta, mientras `crontab -l` decía
`no crontab for superoot`. El carril es *script + agenda + latido*, y un carril que nadie dispara
se ve idéntico a uno que corre y no encuentra nada que hacer.

---

## 4.2 Control de acceso — quién puede tocar producción (`[SEG.1]`, 2026-09-24)

**Medido antes de cambiar nada**, porque la sospecha inicial apuntaba al lugar equivocado.

| Superficie | Estado medido | Veredicto |
|---|---|---|
| Servidor `md` | **1 sola llave SSH**, 1 usuario con shell (`superoot`) | cerrado… **sin atribución** |
| Llave de despliegue de GitHub | `read_only = true` | ✅ correcto |
| `main` en GitHub | exige PR + 1 review de CODEOWNERS, sin force-push | ✅ |
| Colaboradores | 4 con `write` — **no** pueden saltarse esa protección | ✅ sus commits entran por PR |
| Repositorio | era **PÚBLICO**, con 157 archivos con IPs internas | ⛔ **corregido: privado** |

⭐ **El hallazgo que dio vuelta la premisa:** de los últimos 25 commits en `main`, **21 entraron
por push directo del lead** (cuenta admin, y `enforce_admins` está en `false`, que es lo que la
deja saltarse el PR) y **4 por PR de los devs**. Quitarles el push a los devs no habría cerrado
nada y habría frenado justo a quienes sí siguen el proceso.

### Quién entró a `md`

`sshd` ya registra la **huella de la llave** en cada acceso con su nivel de log por defecto, y
`superoot` está en el grupo `adm`, así que puede leer `/var/log/auth.log` **sin sudo**. La
atribución ya existía en el sistema: lo único que faltaba era que cada huella fuera de UNA persona.

```sh
ssh superoot@192.168.0.222 'sh ~/ops/prod/ssh-llaves.sh listar'      # llaves, dueño y último uso
ssh superoot@192.168.0.222 'sh ~/ops/prod/ssh-llaves.sh quien 20'    # últimos accesos, con NOMBRE
ssh superoot@192.168.0.222 'sh ~/ops/prod/ssh-llaves.sh agregar /tmp/fulano.pub fulano@megadulces'
```

Para dar de alta a alguien, que mande la salida de `cat ~/.ssh/id_ed25519.pub` desde SU máquina
(la pública; **la privada no se comparte nunca**). Si no tiene, `ssh-keygen -t ed25519`.

⛔ **`quitar` se niega a dejar `authorized_keys` vacío**: `md` no tiene IPMI y recuperarla sería
caminar hasta el equipo, con producción adentro.

⚠️ **Lo que esto NO resuelve, declarado:** todos siguen entrando como `superoot`, que está en
`docker` y en `sudo` — o sea **root de facto**. Esto atribuye el ACCESO, no la acción.

⚠️ **Y lo que quedó abierto por decisión:** `enforce_admins` sigue en `false` (la cuenta admin
puede empujar a `main` sin PR — la vía por la que entró el commit que no arrancaba), y **las 2
credenciales por defecto que estuvieron en código público desde abril no se rotaron**. Pasar el
repo a privado reduce la exposición futura; no deshace la pasada.

---

## 5. Cómo se sabe si está sano

**El rótulo no es el veredicto.** Un contenedor `healthy` con el latido viejo ya pasó — por eso
los healthchecks miden **entrega** (`analytics.cron_runs` **en prod**), no que el proceso exista:

```sh
ssh superoot@192.168.0.222 'set -a; . ~/secrets/ingest.env; set +a;
  psql "$ODS_HB_URL" -c "SELECT job_key, status, host,
    round(extract(epoch from (now()-last_finish))/60.0,1) AS hace_min, note
    FROM analytics.cron_runs ORDER BY last_finish DESC NULLS LAST;"'
```

### Cómo leer esa tabla sin sacar la conclusión equivocada

Medido el **2026-09-11 17:14** (`vie`). Tres cosas se ven raras y ninguna es un problema:

- **`host` es el ID del contenedor, no un nombre.** Todos los carriles de `md` aparecen como
  hashes (`d34b0ab4a6df` = `feeds-cron`, etc.); `SISTEMAS` es `.249`. Un `host` que cambia tras
  un redeploy es normal: la imagen se recrea.
- ⚠️ **`feed_nightly` y `feed_catalog` reportan desde `SISTEMAS`, y NO es que falten por mudar.**
  Sus tareas en `.249` ya están **`Disabled`** (verificado con `Get-ScheduledTask`), pero sus
  cadencias son lentas y **todavía no les tocó la primera pasada en `md`**: `nightly` corre a las
  03:00 y `catalog` los sábados 02:00, o sea después del corte de hoy. Hasta esa primera pasada
  el renglón conserva el host viejo. Si mañana siguen diciendo `SISTEMAS`, **ahí sí** es un
  problema.
- **Hay llaves ZOMBI de carriles retirados, y están en `ok` para siempre:**
  `kepler_prices_bitacora` (18 d), `wincaja_replica` (24 d — lo reemplazaron `wincaja_replica_inc`
  y `_hash` en WR.5.1), `kepler_catalog_bulk` (26 d). Nadie las escribe ya y nadie las borró. Un
  `ok` de 26 días se lee igual que salud: cuando barras la tabla, **ordená por antigüedad**, no
  por status.

Reglas que ya costaron caro:

- **Un latido sin umbral registrado en `CRON_JOBS`** (`apps/api/src/modules/db-health/db-health.service.ts`)
  **no es una alarma: es decoración** — `db-health` lo pinta verde por viejo que esté.
- **`status='error'` no siempre significa "reiniciá"**: en varios carriles es alarma de **dato**
  (ContPAQi caído, sesión del GPS vencida). Por eso llevan `ODS_HB_IGNORE_ERROR=1`: lo que
  dispara el brazo es que el ciclo **deje de completarse**.
- **`cdc_reconcile` NO se juzga contra cero.** El régimen normal medido son **42–167 huecos por
  ventana de 3 días, todos repuestos**.

  ⚠️ **Y ojo con el criterio, porque este documento decía uno que el código no usa.** Medido el
  2026-09-11 en `reconcile-ods-window.js`:

  ```js
  malo = huecos > ALERTA || errores > 0 || (ALERTA_SOBRANTES > 0 && sobrantes > ALERTA_SOBRANTES)
  ```

  **`repuestas == huecos` no participa.** Sirve para leer el renglón —dice que repuso todo lo
  que encontró— pero **no es lo que pinta el status**. Lo que lo pinta son tres umbrales:

  | | Variable | Default | Qué significa pasarse |
  |---|---|---|---|
  | Huecos | `ODS_RECONCILE_ALERT` | **50** | el carril está perdiendo filas |
  | Errores | — | `> 0` | una tabla no se pudo comparar |
  | Sobrantes | `ODS_SOBRANTES_ALERT` | **0 = APAGADO** | `DELETE` sin propagar, revisar a mano |

  ⛔ **Los dos primeros están mal calibrados contra su propio baseline.** Con el régimen normal
  en 42–167 y el umbral en **50**, la única alarma de completitud está roja la mayor parte del
  tiempo: el 2026-09-11 a las 17:14 decía `error · huecos 191 · repuestas 191 · errores 0`, o
  sea **cumpliendo el criterio que este README enunciaba**. Una alarma que grita en régimen
  normal es exactamente la que se aprende a ignorar — el mismo defecto contra el que avisan las
  dos reglas de arriba. **Decisión abierta:** subir `ODS_RECONCILE_ALERT` por encima del
  baseline medido, o aceptar que el tablero viva en rojo. No se toca sin decidirlo.

  ⛔ **Y `sobrantes` no lo vigila nadie**: su umbral nace en `0`, que el código lee como
  APAGADO. El 2026-09-11 había **16,157 filas de más en el ODS** — que es el síntoma del
  `DELETE` que no se propaga, ya declarado como riesgo vivo. El número está a la vista en la
  nota del latido y **ningún sensor lo mira**.

### Cuando el carril tiene 53 pasos, el latido no alcanza — `v_feed_step_health`

`feed_nightly` corre **53 scripts** y reporta **un** estado, que por diseño sólo se pone en
`error` si fallan **los 53** (`run-prod-feeds.js`: `failed === total`). Medido en la bitácora de
prod:

```
feed_nightly  ok  47/53 pasos OK
feed_nightly  ok  52/53 pasos OK
feed_nightly  ok  36/52 pasos OK      <-- 16 pasos fallaron. El tablero, verde.
```

⚠️ **Eso NO se arregla invirtiendo el criterio.** Con 6 pasos fallando en una noche normal, el
carril quedaría rojo casi siempre — y una alarma que grita todos los días es la que se aprende a
ignorar, el mismo defecto de las tres reglas de arriba. El autor ya lo había previsto y lo dejó
escrito en el código (*"sin disparar alarma crítica por ruido"*). Lo que faltaba no era un
umbral: era **grano**.

Desde VL.6.4 cada paso deja su propia fila en `analytics.cron_run_log` con la llave
`carril/paso`, y `analytics.v_feed_step_health` la lee (ventana 30 d):

```sh
ssh superoot@192.168.0.222 'set -a; . ~/secrets/ingest.env; set +a;
  psql "$ODS_HB_URL" -c "SELECT paso, corridas, fallas, horas_sin_ok, seg_p50,
    resumenes_distintos, left(ultimo_resumen,60) AS ultimo_resumen, veredicto
    FROM analytics.v_feed_step_health WHERE carril = \$\$feed_nightly\$\$
    ORDER BY veredicto DESC, resumenes_distintos, seg_p50;"'
```

Cómo se lee **sin sacar la conclusión equivocada**:

- **`resumenes_distintos = 1`** sobre muchas corridas = el propio resumen del importer **nunca
  cambió**. Es la señal de poda más filosa que existe sin tocar los 53 scripts — pero **no es
  prueba**: un paso legítimamente idempotente también imprime siempre lo mismo. Es por dónde
  empezar a mirar, no un veredicto.
- **No hay columna de filas escritas, a propósito.** El orquestador corre a los importers como
  subprocesos: conoce duración y código de salida, **no** filas. `ultimo_resumen` es la última
  línea que imprimió el importer, **textual** — una cita, no una medición. Contesta a ojo:
  `COMMIT — 0 filas` no se parece a `COMMIT — 2,187 filas`.
- **`horas_sin_ok` en NULL significa "nunca salió bien en la ventana"**, no "recién funcionó".
- ⛔ **Una fila ausente NO es un paso sano.** El padrón de pasos vive en `run-prod-feeds.js`, no
  en la BD: la vista sólo muestra lo que corrió al menos una vez. Un paso retirado de la lista no
  desaparece de golpe — se queda con `ultima_corrida` envejeciendo, que es como se nota.
- Los carriles **sub-minuto** (`livefast`, `receipts`, `contpaqi`) **no llevan bitácora por
  paso**: tienen 1-2 pasos cada uno —su latido ya es por paso— y costarían ~7,200 filas/día
  contra las ~940 de todos los demás carriles juntos.

---

## 6. Las variables, que significan cosas distintas según el carril

⚠️ Ver [`docs/GOTCHAS.md`](../docs/GOTCHAS.md) §17. En resumen, dentro de `md`:

| Variable | Apunta a |
|---|---|
| `ODS_SOURCE_BASE` | **la fuente** — el Postgres de réplicas del propio `md` |
| `DATABASE_URL_NEW` | **prod** en los feeds… pero **la fuente** en los shippers del ODS |
| `ODS_HB_URL` / `FLEET_DB_URL` | **prod, siempre** — por eso el latido usa éstas y no `DATABASE_URL_NEW` |

Un latido escrito en el lugar equivocado es invisible para el tablero, que vive en prod: ése es
exactamente el modo de falla que la Fase OBS existe para eliminar.

---

## 7. De dónde salen las réplicas

`pgvector-md` **no copia** de las sucursales con un importer: son **8 suscripciones de
replicación lógica** que tiran (`pull`) desde 8 subredes distintas. La copia de VL.2b fue
**física** justamente para preservar `pg_replication_origin` y que las 8 retomaran desde su slot
**sin hueco**.

⚠️ Las suscripciones viejas quedaron en `.249` en **`DISABLE`, no `DROP`** (rollback). ⛔ Si
alguna vez se dropean allá, **primero `ALTER SUBSCRIPTION … SET (slot_name = NONE)`**, o el
`DROP` le borra el slot **al publicador** y le corta la fuente al servidor nuevo.

---

## 8bis. La red — una subred por plaza, y una flota de MikroTik

> Medido el 2026-09-23 desde `md`. Lo pidió el usuario porque **una decisión de VL.11 se
> apoyaba en un supuesto falso sobre esto**.

**El tercer octeto ES la plaza.** No es convención suelta: `kepler-branches.js` ya lo dice
(*"tercer octeto de IP = plaza"*), pero faltaba escrito qué hay en cada una.

| Subred | Plaza | Código | Gateway |
|---|---|---|---|
| `192.168.0.x` | **Oficinas** — acá viven `md` (.222) y el MikroTik (.254) | — | `192.168.0.254` |
| `192.168.9.x` | CEDIS | `00` | ⬜ no está en `.1` ni `.254` |
| `192.168.10.x` | Padre Hidalgo | `01` | ⬜ no está en `.1` ni `.254` |
| `192.168.42.x` | La Piedad Abastos | `02` | `192.168.42.1` |
| `192.168.40.x` | 8 Esquinas | `03` | `192.168.40.1` |
| `192.168.44.x` | Yurécuaro | `04` | `192.168.44.1` |
| `192.168.54.x` | Zamora Centro | `05` | `192.168.54.1` |
| `192.168.50.x` | Canindo | `06` | `192.168.50.1` |
| `192.168.32.x` | Morelia Madero | `07` | `192.168.32.1` |
| `192.168.30.x` | Morelia Abastos | `08` | `192.168.30.1` |

**Los 8 gateways identificados son MikroTik RouterOS** (verificado por su página de
administración). Es una flota, no equipos sueltos: lo que se hace en uno se hace igual en
todos.

### ⛔ La consecuencia que casi se nos pasa

`md` sólo conoce `192.168.0.0/24` directo; a todo lo demás llega **por el gateway de
oficinas**. Y **cada plaza tiene su propio resolvedor de DNS** — los 7 gateways contestan en
el puerto 53.

⇒ **Una entrada estática en el MikroTik de oficinas NO alcanza a las sucursales.** Sirve sólo
a quien use `192.168.0.254` como resolvedor. Una caja en `192.168.30.x` seguiría resolviendo
`megadulcessuite.com` a Cloudflare y **saliendo a internet para hablar con un servidor de la
misma red**, que es exactamente lo que `[VL.11.B]` viene a evitar.

⇒ El DNS partido se aplica **por plaza**: las mismas tres líneas en cada MikroTik. Buena
noticia: son idénticas, y siendo la misma flota se pueden aplicar de una.

### El sentido inverso: declarado por quien administra la red, no medido desde acá

Está **medido** que `md` alcanza a las sucursales (5 de 8 respondieron en 5432; las otras usan
el 1977). El sentido inverso —que una sucursal alcance `192.168.0.222`— lo **confirmó quien
administra la red el 2026-09-23**, y se registra como tal: es un dato de quien la configuró,
no una medición de este repo.

⚠️ Se distingue a propósito, porque **desde `md` no se puede comprobar**: hoy no existe ni un
solo flujo sucursal → `md` del que sacar evidencia. Todo lo que hay —las 8 suscripciones
lógicas, `store-poller`, los importers— sale **desde** `md`. Que `md` abra una conexión a una
sucursal y reciba respuesta NO prueba que una sucursal pueda abrir una hacia `md`: un firewall
puede ser asimétrico sin que nada lo delate.

⇒ La comprobación llega **gratis** con la primera caja que se repunte: si el POST entra, el
camino existe. Por eso se toca **una** caja antes que el resto.

⬜ **Abierto:** el gateway de CEDIS (`.9`) y el de Padre Hidalgo (`.10`) no están en `.1` ni
`.254`. Su direccionamiento es distinto y hay que averiguarlo antes de incluirlas.

---

## 8. Lectura de desarrollo

Los devs leen las réplicas de `md` (**no prod**) con un rol por persona, sólo lectura:
`ops/vl/dev-ro-setup.sh` · credenciales en `md:~/secrets/dev-ro/<usuario>.txt`.
Detalle y trampas en el encabezado de [`ops/vl/sql/dev-ro-grants.sql`](vl/sql/dev-ro-grants.sql).

---

**Plan completo, sprint por sprint:**
[`docs/IMPLEMENTACION/FASES/FASE_VL_VPS_LOCAL.md`](../docs/IMPLEMENTACION/FASES/FASE_VL_VPS_LOCAL.md)
· decisión en **ADR-060**.
