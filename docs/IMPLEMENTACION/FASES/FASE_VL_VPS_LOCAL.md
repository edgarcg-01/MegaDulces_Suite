# Fase VL — VPS local: sacar la capa de ingesta de la máquina de trabajo

> **Estado:** 🔨 DISEÑADO (planeación) 2026-09-10 · **ADR-060 propuesto** · sin código aún.
> **Pedido inmediato:** mover **los contenedores del ODS** de `.249` al servidor nuevo.
> **Pedido de fondo:** dejar todo listo para que la capa de ingesta viva en un **VPS local Linux**.

**Decisiones tomadas (Edgar, 2026-09-10):**

1. **El fierro existe, sin SO**, con **16 GB RAM** (ampliable a 32) y **NVMe 256 GB WD PC SN740** → VL.0 instala Ubuntu 24.04 LTS. **Alcanza con holgura para VL.0–VL.8; no alcanza para VL.9** (§6.1). Faltan núcleos y velocidad de NIC (§8.2 A1).
2. **Alcance: ingesta ahora, prod después** → VL.9 (bajar Railway) pasa a ser fase real con su propio ADR, no un "condicional". **Y con el fierro real medido, prod exige compra: segundo disco de 1–2 TB + los 32 GB de RAM** (§6.1).
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

Mover sólo los contenedores **sí** es válido como **paso intermedio de des-riesgo** (VL.2a): valida red, secretos, latido y healthchecks contra prod **antes** de tocar los 55 GB. Debe ser corto — días, no semanas.

---

## 4. Decisión — ADR-060 (propuesto)

> **La capa de ingesta se muda a un servidor Linux dedicado, y se muda como una unidad: fuente + carriles + agenda. El sustrato es Docker Compose declarado en el repo, no tareas del sistema operativo. Lo que no se pueda correr en Linux se DECLARA, con dueño y fecha; nunca se disfraza de "ya migrado".**

Hereda:
- **ADR-053 / Fase OBS** — el latido mide **entrega**, no que el proceso exista; y el veredicto necesita un brazo (`autoheal`). Una migración que rompa el latido reconstruye exactamente el congelamiento de 6 días.
- **ADR-056 / Fase VP** — lo que no se pueda medir se declara. Aplica a la migración misma: un carril se declara migrado sólo con su **latido verde en prod**, no con "el contenedor arrancó".
- **`project_vps_onprem_coolify`** — mini-PC dedicado, Ubuntu 24.04, Coolify para la capa PaaS, Cloudflare Tunnel para exposición, **DB nunca por el túnel**. Proxmox → VM completa, no LXC.

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
  |  VPS LOCAL (Ubuntu 24.04, Docker Compose)                    |
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
| **VL.0** | ⬜ | **Instalar y preparar el servidor.** El fierro existe sin SO: instalar **Ubuntu 24.04 LTS Server**, Docker + Compose, TZ `America/Mexico_City`, IP fija, `docker` sin sudo, **datos en partición aparte** (§6.1). **Verificar antes de seguir:** alcanzar los 8 publicadores (`pg_isready` host:puerto, uno por uno), `.245:5432`, el share de `.245` por CIFS, y salida a `feeds-ingest` + prod. **Prueba negativa obligatoria:** romper una rama a propósito y ver el rojo. | todo |
| **VL.1** | ⬜ | **Secretos en un solo lugar.** Hoy las credenciales de prod viven **en texto plano en al menos 4 lanzadores** (`run-feeds.cmd`, `store-poller.cmd`, `ingest.env`, `sync.local.env`). En el servidor nuevo: un `.env` por stack, fuera del repo, permisos `600`, un dueño. **La credencial de prod expuesta sigue pendiente de rotar** (`project_security_incident_db_creds`) — la mudanza es el momento natural. | VL.2 |
| **VL.2a** | ⬜ | **Des-riesgo: sólo los 4 contenedores del ODS**, leyendo la fuente por LAN (`ODS_SOURCE_BASE` → `192.168.0.249:5433`). Apagar los de `.249` **antes** de levantar los nuevos (nunca dos shippers a la vez: pelean `ods.ctl`/`ods.shadow`). Verde = los 3 latidos (`ods_live_hot`, `ods_live_mirror`, `cdc_reconcile`) frescos **en prod** y `db-health` sin sensor crítico. | VL.3 |
| **VL.2b** | ⬜ | **Mudar la fuente — en la ventana nocturna/fin de semana.** **Copia física del volumen**: `docker stop` → copiar `pgvector-md-data` (55 GB **en tránsito**) → levantar en el servidor nuevo con **la misma major (PG 18)** → **`DROP DATABASE wincaja` allá** (queda residente **~15 GB**; sus 40 GB los sigue usando el carril Wincaja **en `.249`** hasta VL.5 — §6.1). La copia física es lo que preserva `pg_replication_origin`, y por eso las 8 suscripciones **retoman desde su slot sin hueco**; `pg_dump` por base **no** lo preserva. ⚠️ `wincaja` **no** tiene orígenes que preservar (no la alimenta replicación lógica, la escribe el replicador Jet) → dropearla no pierde nada. ⚠️ Mientras la réplica está abajo **los publicadores retienen WAL** → **medir el disco libre de las 8 sucursales el día antes**, no suponerlo (si una está justa, se acorta la ventana o se hace esa rama por separado). Plan B (por rama, si alguna no retoma): `DROP`/`CREATE SUBSCRIPTION` con `copy_data=true` sólo de esa rama. | VL.2c |
| **VL.2c** | ⬜ | **Desactivar las suscripciones viejas en `.249`.** Tras la copia física **los dos clusters tienen las 8 suscripciones idénticas apuntando a los mismos slots**, y un slot admite **una sola** conexión activa → se pelean (`replication slot is already active`). En `.249`: **`ALTER SUBSCRIPTION <cada una> DISABLE`** — **no `DROP`**: se conservan como rollback y su Postgres sigue arriba sólo por `wincaja`. ⛔ **Si alguna vez se dropean en `.249`, primero `ALTER SUBSCRIPTION … SET (slot_name = NONE)`**, o el `DROP` intenta borrar el slot **del publicador** y le corta la fuente al servidor nuevo. ⚠️ **El rollback a `.249` es limpio SÓLO de inmediato**: en cuanto el servidor nuevo confirma LSNs, los slots avanzan y volver deja un **hueco** — por eso VL.3 se corre antes de soltar la ventana. | VL.3 |
| **VL.3** | ⬜ | **Reapuntar y cerrar.** `ODS_SOURCE_BASE` → la fuente local del servidor nuevo. **Candado de completitud:** correr `reconcile-ods-window` sobre la ventana que cubre el corte y exigir **0 filas ausentes** — es la única prueba de que la mudanza no dejó hueco (la primera corrida histórica de ese script encontró 7,587). | VL.4 |
| **VL.4** | ⬜ | **La agenda a Compose.** Los ~13 carriles portables del Programador (`live`, `livefast`, `stock`, `intraday`, `nightly`, `catalog`, `prices`, `receipts`, `contpaqi`, `contpaqi-slow`, `refresh-consolidado`, `store-poller`, `fleet-gps`) pasan a servicios con `healthcheck` de **entrega** (latido en `analytics.cron_runs`) y `autoheal`. **Regla:** ningún carril se declara migrado sin **umbral registrado en `CRON_JOBS`** — sin umbral, `db-health` da verde incondicional (medido en VP.0). Uno por uno, apagando el de `.249` primero. | VL.6 |
| **VL.5** | ⬜ | **Wincaja / Access — decisión diferida a este sprint (Edgar, 2026-09-10).** 3 tareas (`WincajaLive` @10 min, `WincajaSyncActual` diaria, `WincajaSyncConcentrada` semanal) y 16 archivos dependen de PS32 + Jet 4.0 sobre `Z:`. **Mientras no se resuelva, esas 3 se quedan corriendo en `.249`** — es el único pedazo de la capa de ingesta que sobrevive ahí, y queda **declarado con dueño y fecha**, no como "ya migrado". Opciones y recomendación en §8 D3. Precedentes medidos que ya existen: **mdbtools en contenedor** (5.7× más rápido, cifras idénticas al centavo) y **agente en el POS** (TDA, corriendo en MD-30 y MD-32). ⚠️ Si se elige mdbtools, el `Z:` se vuelve un mount CIFS y **hereda la misma trampa**: el mount desaparece y el proceso sigue vivo (costó 4 días de rezago silencioso en WR). | VL.7 |
| **VL.6** | ⬜ | **Guardián y respaldo, nativos.** `FeedGuardian` + `HealthWatchdog` + `backup-db.ps1` reescritos como servicios/cron del stack. El respaldo es **precondición del corte**, no un pendiente: hoy los 55 GB de la fuente viven en un volumen de Docker Desktop sin respaldo declarado. | VL.7 |
| **VL.7** | ⬜ | **Apagar `.249` como servidor** (menos lo de VL.5). Deshabilitar las tareas migradas — **no borrarlas**: quedan deshabilitadas 2 semanas como rollback —, retirar el residuo `PM2 Resurrect ODS`, y **declarar en el repo** qué corre en el servidor nuevo (un `ops/README` que sea la verdad; hoy no existe). Las 3 tareas Wincaja siguen habilitadas hasta que cierre VL.5. | VL.8 |
| **VL.8** | ⬜ | **Aguante.** UPS dimensionado + internet redundante (o degradación declarada) + respaldo fuera del sitio. La frescura del ODS es el cimiento de todo lo que publica la app; sin esto se cambia una dependencia frágil (una sesión de Windows) por otra (la luz). **Con la decisión de traer prod después, esto deja de ser opcional: pasa a ser precondición de VL.9.** | VL.9 |
| **VL.9** | ⬜ | **Prod on-prem (fase real, ADR aparte).** Coolify + Cloudflare Tunnel + Cloudflare Access; DB **nunca** por el túnel (apps↔Postgres por LAN privada). Prod mide hoy **30 GB en PG 18.6**. No arranca hasta que VL.0–VL.8 estén verdes. Se planeará con su propio doc; acá sólo condiciona el **dimensionamiento** (§6.1). | — |

**Ruta crítica del pedido inmediato:** VL.0 → VL.1 → VL.2a → VL.2b → VL.2c → VL.3.

### 6.1 Dimensionamiento — contra el fierro REAL (16 GB RAM · NVMe 256 GB WD PC SN740)

Todo lo de abajo está **medido**, no estimado.

**RAM: los 16 GB alcanzan de sobra para VL.0–VL.8.** El stack completo de ingesta consume hoy **718 MB** (`pgvector-md` 560 MB · `ods-live-hot` 95 · `ods-live-mirror` 31 · `ods-reconcile` 19 · `autoheal` 7 · `redis` 5). Sumar los ~13 carriles del Programador agrega pasadas de Node de 100–200 MB cada una: pico realista **3–4 GB**. **Los 32 GB se necesitan recién para VL.9** (prod: un segundo Postgres con `shared_buffers` de verdad + builds de Angular con heap de 4–6 GB). O sea: la ampliación de RAM **no bloquea nada de lo que se quiere hacer ahora**.

**Disco: es el que manda, y el hallazgo lo desahoga.** `wincaja` (40 GB, **73 % del sustrato**) la consumen **sólo** el carril Wincaja y sus pruebas — el replicador, los importers bronze, el poller de tickets y los tests (`database/importers/wincaja/*`, `test-wincaja-replica-fidelidad.js`, `validate-sales-sources.js`). **La API no la toca:** `WincajaService` va por `TenantKnexService` = prod. Y como el carril Wincaja **se queda en `.249` hasta VL.5** (decisión D3), sus 40 GB **no tienen por qué quedarse residentes en el servidor nuevo**.

| Rubro | En el servidor nuevo | Nota |
|---|---|---|
| Ubuntu 24.04 Server | ~15 GB | sin escritorio |
| Sustrato de ingesta **útil** | **~15 GB** | `kepler_md_00..07` 10.6 + `kepler_consolidado` 0.5 + overhead |
| Imágenes Docker (con caché podado) | ~9 GB | hoy 8.6 GB imágenes + 8.3 GB de caché de build, reclamable |
| WAL + temp + margen de autovacuum | ~15 GB | ver la nota de WAL abajo |
| Respaldos locales comprimidos | ~5–8 GB | de 15 GB de datos |
| **Total en régimen** | **≈ 60 GB de 238 GiB (25 %)** | cómodo |
| Pico transitorio durante VL.2b | ~70 GB | la copia física trae los 55 GB antes del `DROP` |
| Si Wincaja también migra en VL.5 | ≈ 105 GB (44 %) | sigue holgado |

**⛔ Lo que NO entra: prod (VL.9).** OS 15 + ingesta 55 (con Wincaja) + prod 30 + Docker y builds 25 + WAL/temp 25 + respaldos de prod (2 completos + WAL) 60–90 = **210–240 GB de 238**, y eso es **estático, antes de crecer**. Dos Postgres al 90 % de disco es el escenario donde un `REFRESH MATERIALIZED VIEW` o un autovacuum que no cierra llena el volumen. **VL.9 exige un segundo disco** — no reemplazar el SN740: dejarlo para SO + Docker y poner los datos en un NVMe de 1–2 TB aparte, que además es la partición separada que VL.0 ya pide. Pregunta abierta A6: **¿tiene segundo slot M.2 o puertos SATA?**

**Desgaste del SSD: medido, y no es alarma.** El cluster genera **20 GB de WAL por día** (`pg_stat_wal`: 42 GB en 2.09 días). Sumando la escritura de páginas en los `checkpoint` y la amplificación propia de un SSD sin DRAM, el orden real es **~30–50 GB/día**. Contra el TBW declarado para esa capacidad (**confirmar en la etiqueta**: la familia SN740 ronda 100 TBW en 256 GB) da **del orden de 4–7 años**. Es un horizonte de reemplazo normal, no un problema. ⚠️ Lo que sí conviene saber del SN740: **es sin DRAM (usa HMB)** y en 256 GB la caché SLC es chica → la escritura sostenida cae después de los primeros ~10–20 GB. Eso **no afecta el goteo de 20 GB/día**, sí puede alargar la restauración inicial de VL.2b. Es una vez.

**Veredicto:** el fierro que ya existe **sirve para todo el pedido inmediato y para VL.0–VL.8 con holgura**. Lo que hay que planificar como compra es el **segundo disco** antes de VL.9, y la RAM a 32 GB junto con él.

---

## 7. Riesgos y trampas que ya cobraron en este proyecto

| # | Riesgo | Por qué lo sabemos | Mitigación |
|---|---|---|---|
| R1 | **Hueco de filas en el corte** | La primera corrida de `reconcile-ods-window` encontró 7,587 filas ausentes en 3 días | VL.3 exige reconciliación en 0 sobre la ventana del corte |
| R2 | **El latido se muda mal y nadie se entera** | El ODS estuvo **6 días congelado** publicando precio, costo y margen con toda confianza; lo encontró un humano | `ODS_HB_URL` es var propia **a propósito** (GOTCHAS §17). Verificar los 3 latidos en prod antes de apagar el origen |
| R3 | **El servidor nuevo no alcanza las 8 subredes** | Los publicadores están en `.9.x .10.x .32.x .40.x .42.x .44.x .50.x .54.x` — hay ruteo/VPN detrás de `.249` | VL.0 lo verifica **antes** de mover un byte, con prueba negativa |
| R4 | **WAL retenido en las sucursales durante el corte** | Los slots de replicación retienen mientras el suscriptor no confirma | Medir disco libre en los 8 publicadores y acotar la ventana; plan B por rama |
| R5 | **El mount de red se cae y el proceso sigue vivo** | `Z:` mapeada = 4 días de rezago silencioso con todos los chequeos en verde (WR) | El chequeo mide **entrega**, no proceso; el mount CIFS se verifica **leyendo un archivo**, no con `mountpoint` |
| R6 | **Dos shippers a la vez** | `ods.ctl`/`ods.shadow` son estado compartido; `hot` y `mirror` ya se separan por conjunto de tablas justamente para no pelear | Apagar siempre el viejo antes de levantar el nuevo. Nunca solapar |
| R7 | **`healthcheck` sin brazo** | 15 h colgado el 2026-09-04: proceso vivo, CPU 0.00 %, cero entrega, y el motor no movió un dedo | `autoheal` acotado por etiqueta viaja con el stack (nunca en modo `all`: reiniciaría la base) |
| R8 | **El disco del servidor se llena** | Hoy: volumen de 55 GB en un disco con 94 GB libres, y `wincaja` (40 GB) crece | Disco de datos separado y dimensionado en VL.0; alerta de espacio en VL.6 |
| R9 | **Credenciales en texto plano se multiplican** | 4+ lanzadores hoy; la de prod sigue **sin rotar** | VL.1 antes de VL.2 |

---

## 8. Decisiones

### 8.1 Resueltas (2026-09-10)

| # | Pregunta | Respuesta | Consecuencia en el plan |
|---|---|---|---|
| D1 | Estado del servidor | **Existe el fierro, sin SO**: **16 GB RAM** (ampliable a 32) + **NVMe 256 GB WD PC SN740** | VL.0 instala Ubuntu 24.04 Server. **Alcanza con holgura para VL.0–VL.8** (§6.1: el stack usa 718 MB y el sustrato útil son ~15 GB). ⛔ **No alcanza para VL.9** → segundo disco + los 32 GB, juntos, antes de traer prod |
| D2 | Alcance | **Ingesta ahora, prod después** | Dimensionar para los dos desde el día 1 (§6.1: 32 GB / 1 TB). VL.9 pasa a fase real; **VL.8 (UPS/respaldo) deja de ser opcional** |
| D3 | Wincaja / Access | **Se decide en VL.5** | Las 3 tareas Wincaja **siguen en `.249`** hasta entonces, declaradas con dueño y fecha. VL.7 no las apaga |
| D4 | Corte de la fuente | **Ventana nocturna / fin de semana** | Copia física (camino sin hueco). **Falta la fecha** → A2. Chequeo de disco en los 8 publicadores el día antes |

**Recomendación registrada para D3, para cuando llegue VL.5:** agente en el POS para el carril **vivo** (patrón TDA, ya probado en MD-30/MD-32 — elimina el `Z:` y el Jet del servidor, y la memoria dice que el agente **le gana** en frescura a la réplica por `Z:`) + mdbtools en contenedor para el **masivo** (5.7× más rápido, cifras idénticas al centavo). Dejar una caja Windows chica sólo como red de seguridad temporal.

### 8.2 Abiertas — bloquean VL.0 o la ventana

**A1 — Núcleos y red del fierro.** RAM y disco ya están (D1). Falta: **cuántos núcleos reales** y si la NIC es **gigabit**. *La NIC define la ventana de VL.2b: 55 GB a 1 Gb/s son ~15–25 min; a 100 Mb/s serían ~2.5 h y el plan de corte cambia.*

**A6 — ¿Hay dónde poner un segundo disco?** ¿Segundo slot **M.2** libre, o puertos **SATA**? Y de paso: el SN740 de 256 GB, ¿es **2280** o **2230**? *No bloquea el arranque — bloquea VL.9. Si no hay slot libre, la única salida para prod es reemplazar el SN740 por uno de 1–2 TB, y entonces conviene comprarlo de una vez y dejar el de 256 para el SO.* **Confirmar el TBW en la etiqueta** (§6.1 asume el orden de 100 TBW para esa capacidad).

**A2 — La ventana concreta.** Fecha y hora del corte de VL.2b. *La copia de 55 GB por gigabit son ~15–25 min de transferencia; con apagado, arranque y verificación: **60–90 min con el ODS detenido**. Mientras tanto los 8 publicadores retienen WAL, así que la ventana define cuánto disco necesitan aguantar.*

**A3 — Ubicación y red.** ¿El servidor va en el mismo sitio y VLAN que `.249`? ¿Hay UPS ahí, o hay que comprarlo? *Sin esto R3 y R8 no se cierran en VL.0. Y con D2 (prod después), el UPS pasa a ser compra planificada, no un "después vemos".*

### 8.3 Abiertas — no bloquean el arranque

**A4 — Sustrato.** Ubuntu 24.04 **bare-metal + Docker Compose** (mi recomendación: menos capas, y el stack ya es Compose) o **Proxmox + VM** (más flexible para hospedar otros proyectos, al costo de una capa). *Nota vigente de la memoria: si Proxmox, **VM completa, no LXC**.* Se puede decidir al momento de instalar.

**A5 — Quién lo opera.** Hoy la capa de ingesta se diagnostica leyendo `C:\KeplerRunner\logs\*` desde la sesión de Sistemas. En Linux pasa a `docker compose logs`. ¿Runbook para los 4 devs, o dueño único? *Se resuelve en VL.7, con el `ops/README`.*

---

## 9. Lo que esta fase NO hace

- **No mueve prod en VL.0–VL.8.** Railway sigue sirviendo la app durante toda la mudanza de la ingesta. Prod es VL.9, con ADR propio y sólo después de que VL.8 (UPS, respaldo, red) esté verde.
- No toca `.245` ni los 8 Kepler de sucursal.
- No apaga los 3 carriles Wincaja de `.249` (VL.5 los decide; hasta entonces siguen ahí, declarados).
- No reescribe ningún importer. Los importers ya son Node multiplataforma; lo que cambia es **quién los agenda y dónde corren**.
- No cambia el contrato de latido y frescura. Lo **respeta**: es la única forma de saber si la mudanza salió bien.
