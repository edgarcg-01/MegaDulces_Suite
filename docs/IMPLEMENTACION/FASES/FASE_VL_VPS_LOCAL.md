# Fase VL — VPS local: sacar la capa de ingesta de la máquina de trabajo

> **Estado:** 🔨 DISEÑADO (planeación) 2026-09-10 · **ADR-060 propuesto** · sin código aún.
> **Pedido inmediato:** mover **los contenedores del ODS** de `.249` al servidor nuevo.
> **Pedido de fondo:** dejar todo listo para que la capa de ingesta viva en un **VPS local Linux**.

**Decisiones tomadas (Edgar, 2026-09-10):**

1. **El fierro existe, sin SO** → VL.0 instala **Ubuntu Server 26.04.1 LTS** (`resolute`, §6.0). **Ya instalado y medido en vivo el 2026-09-10** (§6.1): `md` · `192.168.0.222` · Ryzen 5 4600G **6c/12h** · **14 GiB** · **NVMe BIWIN NV3500 de 1 TB** (no el SN740 de 256) · NIC **1 Gb/s**. **Alcanza para todo, VL.9 incluido.**
2. **Alcance: ingesta ahora, prod después** → VL.9 (bajar Railway) pasa a ser fase real con su propio ADR, no un "condicional". **El disco de 1 TB tira abajo la compra de disco que este plan daba por necesaria**; queda sólo la RAM a 32 GB, y sólo para VL.9 (§6.1).
3. **Wincaja/Access se decide en VL.5** → mientras tanto **se queda en `.249`**, declarado como pendiente con dueño y fecha. `.249` no se apaga del todo hasta cerrarlo (afecta VL.7).
4. **Corte con ventana nocturna o de fin de semana** → copia física del volumen, camino sin hueco. Falta la fecha concreta y el chequeo previo de disco en los 8 publicadores.

---

## 1. Lo que se pidió, reformulado

Dos horizontes, y el corto **no es independiente** del largo:

- **Ahora:** los 4 contenedores de ingesta del ODS dejan de correr en `.249` (la máquina de trabajo de Sistemas) y pasan a un servidor.
- **Después:** ese servidor absorbe **toda** la capa de ingesta — hoy 21 tareas del Programador de Windows + 6 contenedores — y corre Linux.

El pedido corto, tomado literalmente, **no rinde el beneficio que busca**. Lo que sigue explica por qué y cuál es la unidad mínima que sí lo rinde.

---

## 2. Inventario MEDIDO de `.249` (2026-09-10, en vivo)

`.249` = `SISTEMAS`, Windows 11 Pro, **Ryzen 5 3400G (4c/8t), 29.9 GB RAM**, `C:` 431 GB (94 GB libres), `D:` 45 GB, `Z:` = `\\192.168.0.245\D` (1.9 TB, 815 libres).

### 2.1 Contenedores (Docker Desktop)

| Contenedor | Imagen | Qué hace | Portable a Linux |
|---|---|---|---|
| `ods-live-hot` | `trade-ingest:latest` | `replicate-ods-live --watch=15`, 19 tablas calientes, 8 ramas | ✅ ya es `node:20-alpine` |
| `ods-live-mirror` | `trade-ingest:latest` | espejo completo `md.*` menos el set caliente, `--watch=300` | ✅ |
| `ods-reconcile` | `trade-ingest:latest` | `reconcile-ods-window --days=3 --watch=900` — la única alarma de **completitud** | ✅ |
| `ods-autoheal` | `willfarrell/autoheal` | el **brazo** del healthcheck (sin él el rótulo `unhealthy` no reinicia nada) | ✅ |
| `pgvector-md` | `pgvector/pgvector:pg18` (**18.4**) | **la fuente**: `kepler_md_00..07` + `wincaja` + `kepler_consolidado` | ✅ imagen oficial |
| `redis-md` | `redis:7-alpine` | cache local | ✅ |

Volumen `pgvector-md-data` = **54.73 GB**. Desglose: `wincaja` 40 GB · `kepler_md_03` 2.95 GB · `md_02` 1.68 · `md_01` 1.40 · `md_00` 1.09 · `md_05` 1.01 · `md_04` 0.92 · `md_06` 0.90 · `md_07` 0.62 · `kepler_consolidado` 0.50.

### 2.2 Tareas programadas (21 activas)

| Tarea | Cadencia | Lanza | Portable |
|---|---|---|---|
| `Receipts` · `Contpaqi` | 1 min | `run-hidden.vbs receipts` / `contpaqi` | ✅ Node (ContPAQi = SQL Server en `.35`, driver `mssql`) |
| `RefreshConsolidado` | 2 min | `run-refresh-consolidado-hidden.vbs` | ✅ |
| `FeedGuardian` | 5 min | `run-feed-guardian.ps1` | ⚠️ PowerShell (reescribir) |
| `HealthWatchdog` | 10 min | `run-watchdog-hidden.vbs` | ⚠️ VBS/PS |
| `WincajaLive` | 10 min | `run-wincaja-live.ps1` | ⛔ **Jet 32-bit + `Z:`** |
| `Stock` | 15 min | `run-hidden.vbs stock` | ✅ |
| `Live` · `Prices` | 30 min | `run-hidden.vbs live` / `run-prices.cmd` | ✅ |
| `LivePoller` | loop 25 s | `C:\KeplerPush\store-poller.cmd` → `live-tickets-poller.js` | ✅ (corre como SYSTEM) |
| `LiveFastLoop` | loop 60 s | `run-livefast-loop.cmd` → `run-prod-feeds livefast` | ✅ (corre como SYSTEM) |
| `MegaDulces-FleetGPS` | 1 min | `fleet-gps-hidden.vbs` | ✅ (HTTP a magnitracking) |
| `Intraday` | 1 h | `run-hidden.vbs intraday` | ✅ |
| `ContpaqiSlow` | 2 h | `run-hidden.vbs contpaqi-slow` | ✅ |
| `Nightly` | diaria | `run-hidden.vbs nightly` | ✅ |
| `WincajaSyncActual` | diaria | `sync-wincaja-actual.ps1` | ⛔ **Jet 32-bit + `Z:`** |
| `TradeMarketing-DailyBackup` | diaria | `scripts/backup-db.ps1` | ⚠️ PowerShell |
| `Catalog` | semanal | `run-hidden.vbs catalog` | ✅ |
| `WincajaSyncConcentrada` | semanal | `sync-wincaja-concentrada.ps1` | ⛔ **Jet 32-bit + `Z:`** |
| `KP-Concentrate` | *deshabilitada* | `run-concentrate-hidden.vbs` | — |
| `PM2 Resurrect ODS` | al logon | `pm2 resurrect` | 🗑️ **residuo** (PM2 se retiró en OBS.4) |

⚠️ **17 de 21 corren como `Desarrollo MD`, no como `SYSTEM`** → dependen de una sesión de usuario. Es el mismo defecto de sustrato que documentó OBS.1: el proceso puede reportarse vivo y no entregar nada.

### 2.3 Lo que NO está en `.249` y no se mueve

- Los **8 servidores Kepler de sucursal** (publicadores de la replicación lógica): `192.168.9.95` (md_00) · `.10.10:1977` (md_01) · `.42.42` (md_02) · `.40.40` (md_03, `sub_pilot`) · `.44.44` (md_04) · `.54.54` (md_05) · `.50.50:1977` (md_06) · `.32.32:1977` (md_07). **Ocho subredes distintas** → el servidor nuevo necesita la misma alcanzabilidad (riesgo R3).
- **`.245`** = caja de consolidación Kepler + `platform_test` + **el share `D:` con los `.mdb` de Wincaja** (= `Z:` en `.249`). Decisión previa (memoria `project_vps_onprem_coolify`): **no co-locar**; `.245` se queda sólo con Postgres.
- **Los agentes de tienda** (`C:\WincajaAgent` en los POS de MD-30 y MD-32) — ya empujan solos desde la tienda, no pasan por `.249`.
- **Railway** = prod. Sigue sirviendo la app durante toda la mudanza; prod es VL.9 (§8.1 D2).

---

## 3. El hallazgo que cambia el pedido

**Los contenedores del ODS no se pueden mover solos con provecho.**

Su fuente es `ODS_SOURCE_BASE = host.docker.internal:5433` → **el contenedor `pgvector-md` de esta misma máquina**. Si los 4 contenedores se van y la fuente se queda:

- `.249` sigue siendo **dependencia dura** de la venta publicada: apagarla, cerrar sesión, o que se le llene `C:` (94 GB libres para un volumen de 55 GB que crece) sigue congelando el ODS. El objetivo de "sacarlo de esta compu" no se cumple.
- Se **agrega** un salto de red a la ruta caliente (`--watch=15` sobre 8 ramas) sin ganar nada.

**La unidad mínima que sí rinde es el par:** `pgvector-md` (la fuente + sus 8 suscripciones) **+** los 4 contenedores de ingesta. Eso es VL.2–VL.3, y es lo que hay que hacer "ahora". Y rinde barato: de los 55 GB del volumen, **sólo ~15 GB tienen que quedarse residentes** en el servidor nuevo (§6.1).

⚠️ **Se intentó mover sólo los contenedores como paso intermedio de des-riesgo (VL.2a) y resultó al revés.** Esa configuración deja cada lectura del CDC cruzando la LAN **y el proxy de puertos de Docker Desktop**; es la peor de las tres posibles. Se eliminó tras el incidente del 2026-09-10 (§VL.2a). Lo que ese intento **sí** dejó validado —y no hay que repetir— es red, secretos, imagen, latido y autenticación a la fuente y a prod desde `md`.

---

## 4. Decisión — ADR-060 (propuesto)

> **La capa de ingesta se muda a un servidor Linux dedicado, y se muda como una unidad: fuente + carriles + agenda. El sustrato es Docker Compose declarado en el repo, no tareas del sistema operativo. Lo que no se pueda correr en Linux se DECLARA, con dueño y fecha; nunca se disfraza de "ya migrado".**

Hereda:
- **ADR-053 / Fase OBS** — el latido mide **entrega**, no que el proceso exista; y el veredicto necesita un brazo (`autoheal`). Una migración que rompa el latido reconstruye exactamente el congelamiento de 6 días.
- **ADR-056 / Fase VP** — lo que no se pueda medir se declara. Aplica a la migración misma: un carril se declara migrado sólo con su **latido verde en prod**, no con "el contenedor arrancó".
- **`project_vps_onprem_coolify`** — mini-PC dedicado, Coolify para la capa PaaS, Cloudflare Tunnel para exposición, **DB nunca por el túnel**. Proxmox → VM completa, no LXC.

Se **rechaza** explícitamente:
- **Mover primero prod (Railway) y después la ingesta.** La ingesta es la que hoy vive en una máquina de trabajo sin UPS; prod está en un hosting con respaldo. El riesgo está de este lado.
- **Recrear las suscripciones con `copy_data=true` como plan A.** Re-sincroniza ~55 GB desde 8 sucursales en horario hábil, por enlaces que ya son el cuello de botella del negocio.
- **Traducir los `.vbs`/`.cmd` uno a uno a `.sh`.** El defecto no es el lenguaje del lanzador: es que la agenda vive fuera del repo y no declara entrega. Van a Compose (un servicio por carril, con `healthcheck`), que es el patrón que ya funcionó en OBS.4.

---

## 5. Arquitectura destino

```
  8 Kepler sucursal (publicadores)          .245 (intacta)
  .9.95 .10.10 .32.32 .40.40                Postgres + share D: (.mdb Wincaja)
  .42.42 .44.44 .50.50 .54.54                        |
        |  replicación lógica                        | CIFS (solo lectura)
        v                                            v
  +--------------------------------------------------------------+
  |  VPS LOCAL (Ubuntu Server 26.04.1 LTS, Docker Compose)        |
  |                                                              |
  |   pg-ods (pgvector pg18)  <- kepler_md_00..07, wincaja,      |
  |      volumen 55 GB+          kepler_consolidado              |
  |        |                                                     |
  |        +-- ods-live-hot / -mirror / ods-reconcile / autoheal  |
  |        +-- feeds-* (un servicio por cadencia, ex-Task Sched.) |
  |        +-- wincaja-mdb (mdbtools) --> ver §8 Q3               |
  |        +-- redis                                             |
  +--------------------------------------------------------------+
        |  latido + filas (HTTP feeds-ingest / pg)
        v
   PROD (hoy Railway; mañana quizá acá — §8 Q2)
```

`.249` queda como **estación de trabajo**: repo, dev servers, builds. Sin nada en su Programador de tareas.

---

## 6. Sprints

| Item | Estado | Descripción | Bloquea a |
|---|---|---|---|
| **VL.0** | ✅ **2026-09-10** | **Instalar y preparar el servidor.** Ejecutable: [`ops/vl/vl0-bootstrap.sh`](../../../ops/vl/vl0-bootstrap.sh) (la pila de §6.0) + [`ops/vl/vl0-verify.sh`](../../../ops/vl/vl0-verify.sh) (**la compuerta**, con `--negative`). El fierro existe sin SO: instalar **Ubuntu Server 26.04.1 LTS amd64** (`resolute`; pila de versiones completa y sus trampas en **§6.0**), Docker + Compose, TZ `America/Mexico_City`, IP fija, `docker` sin sudo, **datos en partición aparte** (§6.1). **Verificar antes de seguir:** alcanzar los 8 publicadores (`pg_isready` host:puerto, uno por uno), `.245:5432`, el share de `.245` por CIFS, y salida a `feeds-ingest` + prod. **Prueba negativa obligatoria:** romper una rama a propósito y ver el rojo. | todo |
| **VL.1** | ⬜ | **Secretos en un solo lugar.** Hoy las credenciales de prod viven **en texto plano en al menos 4 lanzadores** (`run-feeds.cmd`, `store-poller.cmd`, `ingest.env`, `sync.local.env`). En el servidor nuevo: un `.env` por stack, fuera del repo, permisos `600`, un dueño. **La credencial de prod expuesta sigue pendiente de rotar** (`project_security_incident_db_creds`) — la mudanza es el momento natural. | VL.2 |
| ~~VL.2a~~ | ❌ **ELIMINADO 2026-09-10** | **Se ejecutó, y el intento mostró que el paso era contraproducente.** Movía los carriles a `md` dejando la fuente en `.249` → cada lectura del CDC cruzaba la LAN **y el proxy de puertos de Docker Desktop en Windows**, el componente más débil de la cadena; las otras dos configuraciones (todo en `.249`, todo en `md`) no tienen ese salto. **El paso diseñado para bajar el riesgo era el de mayor riesgo de los tres.** Seis minutos después del cambio **el motor de Docker de `.249` se cayó entero** (todos los contenedores por señal: `pgvector-md` 137, `autoheal` 139, `redis` 0) → 17 min sin ingesta, **sin pérdida de datos** (las 8 suscripciones retomaron de su slot, reconciliador en `huecos 0`). **Causa no establecida** — la coincidencia temporal es evidente pero nada en el log de Windows la prueba. Se va **directo a VL.2b**, que mueve fuente y carriles juntos = la unidad de §3. Detalle en [`INCIDENTE-2026-09-10-vl2a.md`](../../../ops/vl/INCIDENTE-2026-09-10-vl2a.md) |
| **VL.2b** | ⬜ | ⭐ **Runbook completo y medido: [`RUNBOOK-VL2b-corte.md`](../../../ops/vl/RUNBOOK-VL2b-corte.md).** Ventana **35–45 min**, de los cuales **~9 son la transferencia** (no 44): **`wincaja` no viaja** — OID 561593, **39.7 de los 50.8 GB** — se queda en `.249` con su carril hasta VL.5, se excluye del `tar` y se dropea en el destino arrancando el cluster aislado. ⚠️ **Sacar datos de `.249` está estrangulado, y no es culpa del plan** (medido, 4 GB por camino): API de Docker **5 MB/s** · volumen por 9P **5** · `tar`+`ssh` en contenedor **16** · **`tar`+`zstd -1`+`ssh` todo DENTRO del contenedor 21** ⭐ (ratio **4.6×**) · lectura sola **69** · Windows→LAN **68**. **Los bytes nunca deben cruzar la frontera Windows↔WSL.** **Mudar la fuente — en la ventana nocturna/fin de semana.** **Copia física del volumen**: `docker stop` → copiar `pgvector-md-data` (55 GB **en tránsito**) → levantar en el servidor nuevo con **la misma major (PG 18)** → **`DROP DATABASE wincaja` allá** (queda residente **~15 GB**; sus 40 GB los sigue usando el carril Wincaja **en `.249`** hasta VL.5 — §6.1). La copia física es lo que preserva `pg_replication_origin`, y por eso las 8 suscripciones **retoman desde su slot sin hueco**; `pg_dump` por base **no** lo preserva. ⚠️ `wincaja` **no** tiene orígenes que preservar (no la alimenta replicación lógica, la escribe el replicador Jet) → dropearla no pierde nada. ⚠️ Mientras la réplica está abajo **los publicadores retienen WAL** → **medir el disco libre de las 8 sucursales el día antes**, no suponerlo (si una está justa, se acorta la ventana o se hace esa rama por separado). Plan B (por rama, si alguna no retoma): `DROP`/`CREATE SUBSCRIPTION` con `copy_data=true` sólo de esa rama. | VL.2c |
| **VL.2c** | ⬜ | **Desactivar las suscripciones viejas en `.249`.** Tras la copia física **los dos clusters tienen las 8 suscripciones idénticas apuntando a los mismos slots**, y un slot admite **una sola** conexión activa → se pelean (`replication slot is already active`). En `.249`: **`ALTER SUBSCRIPTION <cada una> DISABLE`** — **no `DROP`**: se conservan como rollback y su Postgres sigue arriba sólo por `wincaja`. ⛔ **Si alguna vez se dropean en `.249`, primero `ALTER SUBSCRIPTION … SET (slot_name = NONE)`**, o el `DROP` intenta borrar el slot **del publicador** y le corta la fuente al servidor nuevo. ⚠️ **El rollback a `.249` es limpio SÓLO de inmediato**: en cuanto el servidor nuevo confirma LSNs, los slots avanzan y volver deja un **hueco** — por eso VL.3 se corre antes de soltar la ventana. | VL.3 |
| **VL.3** | ⬜ | **Reapuntar y cerrar.** `ODS_SOURCE_BASE` → la fuente local del servidor nuevo. **Candado de completitud:** `reconcile-ods-window` sobre la ventana que cubre el corte. ⚠️ **El criterio NO es "0 filas ausentes"** — eso era un error de este plan, corregido el 2026-09-10 al medir el régimen real: el reconciliador encuentra **48–167 huecos por ventana de 3 días y los repone todos**, de forma continua. Exigir cero es pedir un verde que no existe. **El criterio correcto es comparar contra el baseline medido ANTES del corte**: (a) `huecos` en el mismo rango, (b) `repuestas == huecos` (repone todo lo que encuentra), (c) `errores = 0`, y (d) ninguna clase de hueco nueva. Registrar el baseline es parte de VL.2b, no de VL.3. **Observado el 2026-09-10 en régimen normal, sin tocar nada: `huecos` 167 (disparó el umbral de alerta de 50) · 49 · 48 · 42, y en las cuatro `repuestas == huecos` con `errores 0`.** Ése es el rango contra el que se compara. | VL.4 |
| **VL.4** | ⬜ | **La agenda a Compose.** Los ~13 carriles portables del Programador (`live`, `livefast`, `stock`, `intraday`, `nightly`, `catalog`, `prices`, `receipts`, `contpaqi`, `contpaqi-slow`, `refresh-consolidado`, `store-poller`, `fleet-gps`) pasan a servicios con `healthcheck` de **entrega** (latido en `analytics.cron_runs`) y `autoheal`. **Regla:** ningún carril se declara migrado sin **umbral registrado en `CRON_JOBS`** — sin umbral, `db-health` da verde incondicional (medido en VP.0). Uno por uno, apagando el de `.249` primero. | VL.6 |
| **VL.5** | ⬜ | **Wincaja / Access — decisión diferida a este sprint (Edgar, 2026-09-10).** 3 tareas (`WincajaLive` @10 min, `WincajaSyncActual` diaria, `WincajaSyncConcentrada` semanal) y 16 archivos dependen de PS32 + Jet 4.0 sobre `Z:`. **Mientras no se resuelva, esas 3 se quedan corriendo en `.249`** — es el único pedazo de la capa de ingesta que sobrevive ahí, y queda **declarado con dueño y fecha**, no como "ya migrado". Opciones y recomendación en §8 D3. Precedentes medidos que ya existen: **mdbtools en contenedor** (5.7× más rápido, cifras idénticas al centavo) y **agente en el POS** (TDA, corriendo en MD-30 y MD-32). ⚠️ Si se elige mdbtools, el `Z:` se vuelve un mount CIFS y **hereda la misma trampa**: el mount desaparece y el proceso sigue vivo (costó 4 días de rezago silencioso en WR). | VL.7 |
| **VL.6** | ⬜ | **Guardián y respaldo, nativos.** `FeedGuardian` + `HealthWatchdog` + `backup-db.ps1` reescritos como servicios/cron del stack. El respaldo es **precondición del corte**, no un pendiente: hoy los 55 GB de la fuente viven en un volumen de Docker Desktop sin respaldo declarado. | VL.7 |
| **VL.7** | ⬜ | **Apagar `.249` como servidor** (menos lo de VL.5). Deshabilitar las tareas migradas — **no borrarlas**: quedan deshabilitadas 2 semanas como rollback —, retirar el residuo `PM2 Resurrect ODS`, y **declarar en el repo** qué corre en el servidor nuevo (un `ops/README` que sea la verdad; hoy no existe). Las 3 tareas Wincaja siguen habilitadas hasta que cierre VL.5. | VL.8 |
| **VL.8** | ⬜ | **Aguante.** UPS dimensionado + internet redundante (o degradación declarada) + respaldo fuera del sitio. La frescura del ODS es el cimiento de todo lo que publica la app; sin esto se cambia una dependencia frágil (una sesión de Windows) por otra (la luz). **Con la decisión de traer prod después, esto deja de ser opcional: pasa a ser precondición de VL.9.** | VL.9 |
| **VL.9** | ⬜ | **Prod on-prem (fase real, ADR aparte).** Coolify + Cloudflare Tunnel + Cloudflare Access; DB **nunca** por el túnel (apps↔Postgres por LAN privada). Prod mide hoy **30 GB en PG 18.6**. No arranca hasta que VL.0–VL.8 estén verdes. Se planeará con su propio doc; acá sólo condiciona el **dimensionamiento** (§6.1). | — |

**Ruta crítica del pedido inmediato:** VL.0 → VL.1 → ~~VL.2a~~ → **VL.2b** → VL.2c → VL.3.

### VL.0 — cerrado 2026-09-10, con la evidencia

`md` · `192.168.0.222` · Ubuntu Server 26.04.1 LTS · kernel 7.0.0-31 · usuario `superoot`.

**Bootstrap aplicado:** Docker **29.8.0** + Compose **v5.5.1** (repo oficial, `resolute`) · `psql` **18.6** de PGDG (`pgdg26.04+2` — **misma minor que prod**) · Docker en la lista negra de `unattended-upgrades` · `vm.swappiness=1` · `transparent_hugepage=never`.

**Post-reinicio, verificado:** `THP: always madvise [never]` · `swappiness: 1` · `TZ: America/Mexico_City` · `docker 29.8.0` con `superoot` en el grupo `docker`. **La caja volvió sola en ~25 s** — que es, de paso, la primera prueba de que arranca desatendida (importa para VL.8).

**La compuerta, corrida contra el server real:**

| | Resultado |
|---|---|
| Los 8 publicadores Kepler | **OK los 8** — 64–195 ms (`md_02` 64 · `md_03` 74 · `md_01` 143 · el resto 176–195) |
| `.245` · `.249:5433` (fuente actual) | OK — 64 ms · 37 ms |
| prod (`trolley:39023`) · `feeds-ingest` | OK — 917 ms · HTTP 404 (responde) |
| Reloj | OK — `America/Mexico_City`, NTP sincronizado |
| Share CIFS de `.245` | **NO MEDIDO** — no montado, y es lo correcto hasta VL.5 |
| **Veredicto** | **13 OK · 0 FALLA · 1 NO MEDIDO** → `exit 2`, *abierta con reservas* |

**⭐ R3 queda resuelto: el servidor nuevo alcanza las 8 subredes.** Era el riesgo que bloqueaba la fase entera y no se podía suponer.

**Prueba negativa hecha** (el plan la exige): con una rama inexistente agregada, la compuerta reporta `FALLA: 1` y `exit 1`. O sea sabe ponerse en rojo — no es una intención.

⚠️ **Bug encontrado y corregido en el propio instrumento** (commit `cac348c0`): la primera corrida publicó `170562626 ms` de latencia — son 47 horas. `date +%s%3N` no truncó a 3 dígitos en ese sistema y la resta salía en **nanosegundos rotulada como ms**. Los valores **ordenaban bien** (prod el más alto, `.249` el más bajo), que es exactamente lo que hace que una unidad equivocada pase desapercibida. Misma clase de error que ADR-055/057 documentan para las columnas de la DB, esta vez en la herramienta de medición.


### 6.0 La pila de versiones de VL.0 (lo que se instala, exacto)

**SO: Ubuntu Server 26.04.1 LTS, amd64** (codename **`resolute`**) — imagen **"Server install image"** (no Desktop, no Cloud image), instalación **minimized**. Soporte estándar hasta **abril 2031**.

*Cómo se decidió, y la corrección:* el plan arrancó recomendando **24.04 LTS** por madurez (~2.4 años de rodaje contra ~5 meses). El argumento técnico concreto era que Docker CE y PGDG podían no publicar todavía para el codename nuevo. **Se verificó contra los repos, no de memoria** (2026-09-10):

- `download.docker.com/linux/ubuntu/dists/` → `… noble oracular plucky questing `**`resolute`** ✅
- `apt.postgresql.org/pub/repos/apt/dists/` → `jammy-pgdg noble-pgdg `**`resolute-pgdg`** ✅

Con los dos repos presentes el argumento se cae, y la 26.04.1 gana: es el **point release** (no el ISO del día uno) y estira el soporte **dos años más**. **Decidido: 26.04.1.**

⚠️ **El ISO se verifica por SHA256 antes de flashear**, contra `releases.ubuntu.com/26.04.1/SHA256SUMS`. Un ISO corrupto **no falla al escribir**: falla en medio de la instalación y parece un problema de hardware. *Hecho el 2026-09-10:* `ubuntu-26.04.1-live-server-amd64.iso`, 2,927,861,760 bytes, `cc8a95cd…f1d927` — **coincide**.

| Pieza | Versión / origen | Por qué así |
|---|---|---|
| **Kernel** | GA (`linux-generic`) | Sólo pasar a **HWE** si el instalador **no ve la NIC o el NVMe** — depende del hardware, que es la pregunta abierta A1 |
| **Postgres en el host** | **ninguno** — sólo `postgresql-client-18` de **PGDG** (`apt.postgresql.org`, `resolute-pgdg` — verificado presente) | El replica corre en el contenedor `pgvector/pgvector:pg18`. ⛔ **Los repos de Ubuntu no traen PG 18**, y `pg_dump` 16 **se niega** a volcar un servidor 18 — te enterás justo cuando necesitás el respaldo |
| **Major de Postgres** | **18**, obligatorio | El volumen es **18.4** y prod **18.6**. La copia física de VL.2b **exige la misma major** |
| **Docker** | **Docker CE del repo oficial** (`download.docker.com`, canal `stable`, `resolute` — verificado presente) + `docker-compose-plugin` | ⛔ **No `docker.io` de Ubuntu**: es más viejo y trae `docker-compose` **v1**; los compose de este repo son **v2** (`docker compose`) |
| **Node en el host** | **ninguno** | Todo va en contenedores `node:20`. Y de paso se corrige una deriva real: el repo declara `engines: node >=20 <21` y `.node-version 20.18.0`, pero hoy los carriles corren con el **Node 24 del host** (`C:\Program Files\nodejs\node.exe`) |
| **Zona horaria** | `America/Mexico_City` en el host **y** en las imágenes | ⚠️ **No es cosmético**: los `@Cron` del proyecto están escritos asumiendo que el proceso corre en hora MX (`ENV TZ` en los Dockerfile de prod). Un host en UTC corre los nocturnos 6 h desfasados |
| **Reloj** | `systemd-timesyncd` (o `chrony`) encendido | La frescura se juzga **comparando timestamps contra prod**. Un reloj corrido hace que `db-health` mienta en verde o en rojo, y este proyecto ya pagó por alarmas que decían lo que no era |
| **Filesystem de datos** | **ext4**, `noatime`, partición aparte | Sin btrfs/ZFS con CoW debajo de Postgres en un solo disco |
| **Kernel tuning** | `transparent_hugepage=never` · `vm.swappiness=1` | Lo estándar para Postgres; nada exótico |
| **`unattended-upgrades`** | Sí, **con Docker en la lista negra** (`docker-ce`, `docker-ce-cli`, `containerd.io`) | Un upgrade desatendido del daemon **reinicia todos los contenedores en medio de una pasada de shipment**. Los parches de seguridad del SO sí se quieren; el reinicio del motor no |

### 6.0bis Postgres: en Docker, no nativo — y la razón es medible

Pregunta legítima al llegar a un servidor Linux limpio: ¿el sustrato de réplicas sigue en contenedor, o se instala Postgres nativo del sistema? Para **esta** migración no es cuestión de gusto.

**El hecho.** El datadir de las réplicas **nació bajo Debian 12 / glibc 2.36** (`18.4 (Debian 18.4-1.pgdg12+1)`), y Postgres lo tiene **grabado en el catálogo**: las 11 bases declaran `datcollate = en_US.utf8`, `datlocprovider = c` (libc) y **`datcollversion = 2.36`**. El servidor nuevo corre **Ubuntu 26.04 con glibc 2.43**.

**Qué pasa exactamente si se copia ese datadir a un Postgres nativo de Ubuntu 26.04.** No falla al arrancar — eso es lo peligroso. Postgres levanta, avisa una vez del *collation version mismatch*, y a partir de ahí los índices sobre texto quedan ordenados según una regla de comparación que ya no es la que el sistema aplica. **El modo de falla no es un error: es una consulta que devuelve de menos.** Justo la clase de error silencioso que la Fase VP existe para erradicar, y en el sustrato del que sale la venta publicada.

**El tamaño del problema, contado:**

| Base | Índices sobre texto | Tamaño |
|---|---|---|
| `kepler_md_00..07` | **2,695** | 10.6 GB |
| `kepler_consolidado` | 6 | 496 MB |
| **Subtotal — lo que se muda en VL.2b** | **2,701** | **11.1 GB** |
| `wincaja` (se queda en `.249` hasta VL.5) | **2,250** | 40 GB |
| **Total si algún día migra todo** | **4,951** | 51 GB |

Hacerlo nativo **bien** obliga a `REINDEX` de esos índices más `ALTER DATABASE … REFRESH COLLATION VERSION`. Eso convierte una ventana de 60–90 min en varias horas, necesita disco libre para reconstruir, y agrega un paso que **si se salta o se hace a medias no avisa**.

**Con Docker el problema no existe: la glibc viaja adentro de la imagen.** El datadir aterriza en el mismo entorno donde nació — mismo Debian 12, misma 2.36. Cero mismatch, cero reindex, la ventana se mantiene.

**Las tres puertas, para que quede explícito:**

| Camino | Costo |
|---|---|
| **Docker, copia física** | Copiar y arrancar. Nada más |
| Nativo, copia física | + `REINDEX` de 2,701 índices y `REFRESH COLLATION VERSION`. Horas, y falla en silencio si se omite |
| Nativo, suscripciones nuevas con `copy_data` | Sin mismatch (datadir nuevo), pero resincroniza 55 GB desde 8 sucursales por los enlaces que ya son el cuello de botella — es el plan B que §4 rechaza |

**Lo que gana nativo, honestamente**, para no vender una sola cara: `pg_basebackup`/PITR y las herramientas de respaldo son más convencionales; `systemd` maneja el arranque sin un demonio de por medio; editar `postgresql.conf` no pide reiniciar un contenedor. Son ventajas reales pero **operativas y menores**, y ninguna compensa reconstruir 2,701 índices durante un corte.

**El precio de Docker, dicho de frente:** quedás pegado a la glibc 2.36 de la imagen hasta que decidas cambiarla, y el día que quieras una base más nueva vas a enfrentar el mismo reindex. La diferencia es que lo vas a enfrentar **en tu calendario, con la ventana que elijas**, y no metido dentro de una migración que ya tiene ocho suscripciones y una ventana contada.

**Lo que NO pesa, aunque suele alegarse:** el rendimiento es un empate — un volumen nombrado de Docker **no pasa por overlayfs**, escribe directo al filesystem del host, y la carga acá es lectura secuencial de CDC, no OLTP de alta concurrencia. Y el fijado de versión es parejo: la etiqueta pinea la imagen, y PGDG instala las majors lado a lado (no te sube de 18 a 19 solo).

**Decisión: sigue en Docker.** Se reconsidera nativo cuando (a) haya que cambiar de base de imagen igual, y (b) exista ventana para el reindex — o sea, nunca durante un corte.

#### Dos hallazgos de esta medición

- **`pgvector` no se usa.** Ninguna de las réplicas tiene la extensión (`kepler_consolidado` sólo trae `postgres_fdw` y `dblink`). La imagen `pgvector/pgvector:pg18` está funcionando como un Postgres 18 común — el vector es incidental, herencia de cuando la copia local de Fase K vivía ahí. **No se cambia la imagen ahora** (cambiar de imagen durante la migración es cambiar dos variables a la vez), pero queda anotado como limpieza opcional posterior.
- ⚠️ **Toda la memoria de Postgres está en default de fábrica.** `shared_buffers` **128 MB** · `effective_cache_size` 4 GB · `work_mem` **4 MB** · `maintenance_work_mem` **64 MB** · `max_wal_size` 1 GB · `checkpoint_timeout` 5 min. Lo único configurado —y que **viaja con la copia física**— es lo de replicación: `wal_level=logical`, `max_replication_slots=20`, `max_logical_replication_workers=16`. Tunearlo va en VL.2b (§6.0ter).

#### 6.0ter Rendimiento de RAM: lo que la mudanza gana, y la trampa de Docker que sí es real

**1. Docker en Linux no cuesta RAM. En Windows sí, y hoy se está pagando.** Docker Desktop corre un **VM de WSL2** y `docker info` lo declara: ve **15,665,954,816 bytes = 14.59 GiB** de los **29.9 GB físicos** de `.249`. O sea que **menos de la mitad de la RAM de esa máquina llega a los contenedores**, y lo que la VM reserva queda amurallado del lado de Windows. En Linux no hay VM: los contenedores son procesos con namespaces sobre el mismo kernel, el *page cache* es el del host y se comparte. El costo real es `dockerd` + `containerd` + un shim por contenedor ≈ **200 MB con 8 contenedores**.

> Coincidencia útil: el servidor nuevo tiene **~14 GiB** utilizables y la VM de Docker en `.249` tiene **14.59 GiB**. En RAM **efectivamente disponible para los contenedores, el server nuevo empata con lo que tienen hoy** — con la mitad de RAM física.

**2. ⚠️ La trampa que sí es de Docker: `/dev/shm` = 64 MB.** Medido en el contenedor actual (`ShmSize: 67108864`). Postgres usa memoria compartida POSIX para los *parallel workers* (`dynamic_shared_memory_type = posix`, `max_parallel_workers = 8`), y cuando 64 MB no alcanzan tira `could not resize shared memory segment … No space left on device`. Hoy casi no pica porque la carga del CDC es lectura simple y UPSERT, pero un `VACUUM`/`REINDEX` paralelo sobre `wincaja` (40 GB) o cualquier consulta analítica lo despierta. **Nativo no tiene el problema** (el `/dev/shm` del sistema es la mitad de la RAM). **Fix de una línea en el compose: `shm_size: 1gb`.** Va en VL.2b.

**3. ⛔ No poner `mem_limit` al contenedor de Postgres.** Con límite, el cgroup **cuenta el page cache contra el tope** y el kernel lo recupera bajo presión — la base termina releyendo del disco lo que creía cacheado. Hoy está en `Memory: 0` (sin límite): **dejarlo así**. Es la única forma en que Docker sí puede perjudicar a una base, y se evita no haciéndolo.

**4. El presupuesto del servidor nuevo (14 GiB), para la etapa de ingesta:**

| Rubro | GB | Nota |
|---|---|---|
| `shared_buffers` | **4.0** | ~28 % de la RAM, la guía clásica |
| Backends (≈25 × 10 MB + picos de `work_mem`) | ~0.8 | `work_mem` 32 MB, `max_connections` puede bajar de 100 |
| Carriles de ingesta | ~1.0 | 4 contenedores hoy, ~17 con VL.4; medidos en 100–200 MB cada uno |
| SO + Docker + shims | ~1.0 | |
| **Page cache libre** | **~7.2** | |

**Y acá está el número que importa:** lo que se muda son **11.1 GB** (`kepler_md_00..07` 10.6 + `kepler_consolidado` 0.5). Contra `shared_buffers` 4 GB **+** ~7 GB de page cache = **~11 GB de caché para un conjunto de trabajo de 11.1 GB**. Después del calentamiento, las lecturas del CDC salen prácticamente de RAM. **Por eso 14 GiB alcanzan de sobra para VL.0–VL.8.**

**Y por eso los 32 GB sí hacen falta en VL.9:** al sumar prod (30 GB) aparece un segundo conjunto de trabajo que ya no entra junto al primero, más un segundo `shared_buffers`. El argumento no es "más RAM es mejor" — es que **el conjunto de trabajo deja de caber en caché**.

**Ajustes concretos para VL.2b:** `shared_buffers=4GB` · `effective_cache_size=9GB` (sólo pista al planificador, no reserva nada) · `maintenance_work_mem=1GB` (pesa en `VACUUM` y en reconstruir índices) · `work_mem=32MB` · `max_wal_size=4GB` (con 20 GB de WAL por día, menos *checkpoints*) · `shm_size: 1gb` en el compose. `huge_pages` queda en `try`: el beneficio con 4 GB de buffers es de pocos puntos y no compensa la complejidad operativa ahora.

---

### 6.1 Dimensionamiento — el fierro REAL, medido en vivo (2026-09-10, por SSH)

`md` · `192.168.0.222` · Ubuntu Server 26.04.1 LTS · usuario `superoot`.

| | Medido |
|---|---|
| CPU | **AMD Ryzen 5 4600G** — 6 núcleos / **12 hilos** (mejor que el 3400G de `.249`, que es 4c/8t) |
| RAM | **14 GiB utilizables** de 16 físicos (el resto lo reserva la Radeon integrada). En reposo usa **748 MiB** |
| Disco | ⭐ **NVMe `BIWIN NV3500 1TB` — 953,9 GiB**, NO el WD SN740 de 256 GB |
| Partición | `p1` 1 G EFI · `p2` 2 G `/boot` · `p3` **950,8 G como PV de LVM**, con sólo **100 G asignados a `/`** → **~850 GB libres en el grupo `ubuntu-vg`** |
| Red | `enp6s0` a **1000 Mb/s** |
| Reloj | ⚠️ `Etc/UTC`, NTP activo y sincronizado → **la TZ hay que corregirla** (lo hace el bootstrap) |

**⭐ El disco de 1 TB tira abajo la restricción que dominaba esta sección.** El plan estaba dimensionado contra un NVMe de 256 GB y concluía que **prod (VL.9) no entraba** y exigía comprar un segundo disco. Con 953,9 GiB y **850 GB sin asignar en el VG**, eso deja de ser cierto:

| Rubro | GB | Nota |
|---|---|---|
| `/` (ya asignado) | 100 | SO + Docker + builds, con 86 GB libres hoy |
| Sustrato de ingesta **útil** | ~15 | `kepler_md_00..07` 10.6 + `kepler_consolidado` 0.5 (§3: `wincaja` se queda en `.249`) |
| Si Wincaja migra en VL.5 | +40 | |
| Prod, cuando llegue VL.9 | ~30 | hoy 30 GB en PG 18.6 |
| WAL + temp + margen de autovacuum | ~25 | |
| Respaldos locales | ~90 | 2 completos de prod + WAL |
| **Total con TODO adentro** | **≈ 300 de 953** | **31 %** — y quedan ~650 GB de crecimiento |

**Consecuencias:**

- **VL.9 ya no exige comprar disco.** Cae la pregunta A6 (segundo slot M.2 / SATA): deja de ser bloqueante y pasa a ser opcional.
- **La RAM sigue siendo la única compra pendiente**, y sólo para VL.9: el stack de ingesta consume **718 MB** hoy en `.249` (`pgvector-md` 560 · `ods-live-hot` 95 · `-mirror` 31 · `reconcile` 19 · `autoheal` 7 · `redis` 5), y con los ~13 carriles sumados el pico realista es **3–4 GB**. Los 14 GiB alcanzan de sobra para VL.0–VL.8. Los 32 se necesitan cuando entre el segundo Postgres y los builds de Angular.
- **La partición de datos aparte sigue en pie**, pero ahora como **LV dentro del VG** en vez de disco separado: crear `lv_pgdata` en el espacio libre y montarlo en `/srv/pgdata`, ext4 `noatime`. Ventaja de haber instalado con LVM: se dimensiona ahora y se extiende después sin reinstalar.
- **La NIC a 1 Gb/s confirma la ventana de VL.2b:** ~15–25 min de transferencia para los 55 GB, más apagado/arranque y verificación → **60–90 min con el ODS detenido**, como estaba planificado.

⚠️ **Queda una pregunta menor:** dónde está el **WD SN740 de 256 GB**. No es el disco instalado. Si sigue disponible, no hace falta para nada — con 1 TB sobra; a lo sumo sirve de repuesto.

**El SSD de 512 GB del adaptador** (hoy el medio de instalación) queda libre después de VL.0. Su mejor destino es **respaldo desconectado fuera del sitio**, que es justo lo que pide VL.8 y hoy no existe.

**Desgaste: medido, y con este disco importa menos.** El cluster genera **20 GB de WAL por día** (`pg_stat_wal`: 42 GB en 2.09 días); con checkpoints y amplificación, **~30–50 GB/día** reales. Un NVMe de 1 TB tiene varias veces el TBW de uno de 256 y una caché SLC mucho más grande — el horizonte pasa de "4–7 años" a "más que la vida útil del equipo", y desaparece la advertencia sobre la restauración inicial lenta.

---

## 7. Riesgos y trampas que ya cobraron en este proyecto

| # | Riesgo | Por qué lo sabemos | Mitigación |
|---|---|---|---|
| R1 | **Hueco de filas en el corte** | La primera corrida de `reconcile-ods-window` encontró 7,587 filas ausentes en 3 días | VL.3 exige reconciliación en 0 sobre la ventana del corte |
| R2 | **El latido se muda mal y nadie se entera** | El ODS estuvo **6 días congelado** publicando precio, costo y margen con toda confianza; lo encontró un humano | `ODS_HB_URL` es var propia **a propósito** (GOTCHAS §17). Verificar los 3 latidos en prod antes de apagar el origen |
| R3 | **El servidor nuevo no alcanza las 8 subredes** | Los publicadores están en `.9.x .10.x .32.x .40.x .42.x .44.x .50.x .54.x` — hay ruteo/VPN detrás de `.249` | ✅ **Descartado 2026-09-10**: la compuerta de VL.0 dio 8/8, 64–195 ms |
| **R3b** | ✅ **RESUELTO 2026-09-10** — era real y bloqueaba VL.2b | **Medido 2026-09-10.** `pg_isready` de VL.0 dijo 8/8 OK, pero **no autentica ni consulta `pg_hba`**. El probe con el handshake real (`IDENTIFY_SYSTEM`) dio **3 OK / 5 FALLA**: `FATAL: no hay una línea en pg_hba.conf para «192.168.0.222», usuario «ods_repl», base de datos «md_00»`. **Patrón: las 3 que aceptan son las del puerto 1977; las 5 que rechazan, las del 5432.** Habría explotado **dentro de la ventana**, con las réplicas ya movidas | **Hecho el 2026-09-10, una sucursal por vez, en horario hábil y sin reiniciar nada.** Dos renglones por sucursal (`ods_repl` + `platform_ro`) + `pg_reload_conf()`, dejando los de `.249` puestos como rollback. **Verificado: `ods_repl` 8/8 · `platform_ro` 6/6.** Cero daño colateral: las 8 suscripciones vivas siguieron recibiendo (1–23 s) y los 3 carriles entregando a prod, 8/8 ramas, 0 errores. [Runbook](../../../ops/vl/RUNBOOK-VL2b-pg_hba-sucursales.md) |
| R4 | **WAL retenido en las sucursales durante el corte** | Los slots de replicación retienen mientras el suscriptor no confirma | Medir disco libre en los 8 publicadores y acotar la ventana; plan B por rama |
| R5 | **El mount de red se cae y el proceso sigue vivo** | `Z:` mapeada = 4 días de rezago silencioso con todos los chequeos en verde (WR) | El chequeo mide **entrega**, no proceso; el mount CIFS se verifica **leyendo un archivo**, no con `mountpoint` |
| R6 | **Dos shippers a la vez** | `ods.ctl`/`ods.shadow` son estado compartido; `hot` y `mirror` ya se separan por conjunto de tablas justamente para no pelear. **Pasó el 2026-09-10** (abajo) | Apagar siempre el viejo antes de levantar el nuevo. Nunca solapar. Y ⛔ **`--watch` implica `--apply`** |
| R7 | **`healthcheck` sin brazo** | 15 h colgado el 2026-09-04: proceso vivo, CPU 0.00 %, cero entrega, y el motor no movió un dedo | `autoheal` acotado por etiqueta viaja con el stack (nunca en modo `all`: reiniciaría la base) |
| R8 | **El disco del servidor se llena** | Hoy: volumen de 55 GB en un disco con 94 GB libres, y `wincaja` (40 GB) crece | Disco de datos separado y dimensionado en VL.0; alerta de espacio en VL.6 |
| R9 | **Credenciales en texto plano se multiplican** | 4+ lanzadores hoy; la de prod sigue **sin rotar** | VL.1 antes de VL.2 |

---

## 8. Decisiones

### 8.1 Resueltas (2026-09-10)

| # | Pregunta | Respuesta | Consecuencia en el plan |
|---|---|---|---|
| D1 | Estado del servidor | **Instalado y medido 2026-09-10**: `md` · `192.168.0.222` · Ryzen 5 4600G 6c/12h · 14 GiB · **NVMe 1 TB** · NIC 1 Gb/s · Ubuntu 26.04.1 | Alcanza para **VL.0–VL.9**. Los 850 GB sin asignar del VG cubren ingesta + prod + respaldos con ~650 GB de sobra. Sólo la RAM a 32 GB queda como compra, y sólo para VL.9 |
| D2 | Alcance | **Ingesta ahora, prod después** | Dimensionar para los dos desde el día 1 (§6.1: 32 GB / 1 TB). VL.9 pasa a fase real; **VL.8 (UPS/respaldo) deja de ser opcional** |
| D3 | Wincaja / Access | **Se decide en VL.5** | Las 3 tareas Wincaja **siguen en `.249`** hasta entonces, declaradas con dueño y fecha. VL.7 no las apaga |
| D4 | Corte de la fuente | **Ventana nocturna / fin de semana** | Copia física (camino sin hueco). **Falta la fecha** → A2. Chequeo de disco en los 8 publicadores el día antes |
| D5 | ¿Postgres en Docker o nativo? | **Docker** (2026-09-10) | Medido: el datadir nació bajo **glibc 2.36** y el server nuevo trae **2.43** → nativo obliga a `REINDEX` de **2,701** índices de texto (4,951 con Wincaja) durante el corte, con falla silenciosa si se omite. En contenedor la glibc viaja con la imagen. Detalle y contras en §6.0bis |

**Recomendación registrada para D3, para cuando llegue VL.5:** agente en el POS para el carril **vivo** (patrón TDA, ya probado en MD-30/MD-32 — elimina el `Z:` y el Jet del servidor, y la memoria dice que el agente **le gana** en frescura a la réplica por `Z:`) + mdbtools en contenedor para el **masivo** (5.7× más rápido, cifras idénticas al centavo). Dejar una caja Windows chica sólo como red de seguridad temporal.

### 8.2 Abiertas — bloquean VL.0 o la ventana

**A1 — ✅ CERRADA 2026-09-10.** 6 núcleos / 12 hilos (Ryzen 5 4600G) y NIC a **1000 Mb/s** → la ventana de VL.2b queda confirmada en **60–90 min**.

**A6 — ✅ YA NO APLICA.** El disco instalado es de **1 TB**, no de 256: no hace falta un segundo disco para VL.9. *(Queda la curiosidad menor de dónde quedó el WD SN740 de 256 GB — no se necesita.)*

**A2 — La ventana concreta.** Fecha y hora del corte de VL.2b. *La copia de 55 GB por gigabit son ~15–25 min de transferencia; con apagado, arranque y verificación: **60–90 min con el ODS detenido**. Mientras tanto los 8 publicadores retienen WAL, así que la ventana define cuánto disco necesitan aguantar.*

**A3 — Ubicación y red.** ¿El servidor va en el mismo sitio y VLAN que `.249`? ¿Hay UPS ahí, o hay que comprarlo? *Sin esto R3 y R8 no se cierran en VL.0. Y con D2 (prod después), el UPS pasa a ser compra planificada, no un "después vemos".*

### 8.3 Abiertas — no bloquean el arranque

**A4 — Sustrato.** **Bare-metal + Docker Compose** (mi recomendación: menos capas, y el stack ya es Compose) o **Proxmox + VM** (más flexible para hospedar otros proyectos, al costo de una capa). *Nota vigente de la memoria: si Proxmox, **VM completa, no LXC**.* Se puede decidir al momento de instalar.

**A5 — Quién lo opera.** Hoy la capa de ingesta se diagnostica leyendo `C:\KeplerRunner\logs\*` desde la sesión de Sistemas. En Linux pasa a `docker compose logs`. ¿Runbook para los 4 devs, o dueño único? *Se resuelve en VL.7, con el `ops/README`.*

---

## 9. Lo que esta fase NO hace

- **No mueve prod en VL.0–VL.8.** Railway sigue sirviendo la app durante toda la mudanza de la ingesta. Prod es VL.9, con ADR propio y sólo después de que VL.8 (UPS, respaldo, red) esté verde.
- No toca `.245` ni los 8 Kepler de sucursal.
- No apaga los 3 carriles Wincaja de `.249` (VL.5 los decide; hasta entonces siguen ahí, declarados).
- No reescribe ningún importer. Los importers ya son Node multiplataforma; lo que cambia es **quién los agenda y dónde corren**.
- No cambia el contrato de latido y frescura. Lo **respeta**: es la única forma de saber si la mudanza salió bien.
