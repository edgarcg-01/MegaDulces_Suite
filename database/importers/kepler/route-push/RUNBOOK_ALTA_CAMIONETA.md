# Runbook — alta / rescate de una camioneta (para seguir EN VIVO)

> Se sigue **con la van físicamente en base** conectada a la red interna (PH o CEDIS).
> Tú corres los comandos en la laptop de la van y me pegas la salida; yo verifico el lado runner.
> Prerrequisito ya hecho: `runner-heartbeat.sql` aplicado en el runner ✅.

> ## ⛔ EL RUNNER ES `192.168.0.222`, NO `.249`
>
> La ingesta se mudó al servidor Linux `md` el **2026-09-11** ([`FASE_VL`](../../../../docs/IMPLEMENTACION/FASES/FASE_VL_VPS_LOCAL.md)).
> El `:5433` de `.249` quedó **jubilado**; hoy sobrevive sólo como un **reenvío TCP**
> (`netsh interface portproxy`, `0.0.0.0:5433 → 192.168.0.222:5433`) puesto para no tener que
> visitar las 11 camionetas el mismo día.
>
> ⚠️ **Por eso el error no se ve:** una van configurada contra `.249` **funciona** — el reenvío la
> lleva igual. Lo que no se ve es que su venta depende de una máquina de escritorio que ya no es
> servidor de nada y que **se reinicia sola con Windows Update** (medido: 9.5 h sin ingesta el
> 2026-09-10, porque Docker Desktop no arranca hasta que alguien inicia sesión).
>
> - **Alta nueva** → `.222` directo (las plantillas de este repo ya vienen así).
> - **Van ya dada de alta contra `.249`** → **CASO 4**, abajo.

---

## Datos a tener a la mano (por camioneta)

| Dato | De dónde sale | Valor |
|---|---|---|
| `TRUCK` (nº de ruta de la EMPRESA) | responsable de rutas (ej. `ruta_28`) | ______ |
| `DB_LOCAL` (nombre de la base local) | ver Paso A2 | ______ |
| Clave Postgres LOCAL de la van | admin/TI | ______ |
| Clave Postgres del RUNNER | `superoot` (o rol `ingest`) | ______ |
| `ROUTE_SERIE` (serie local `UD10NN`) | ver Paso A3 | ______ |

---

## CASO 1 — Rescate rápido de `ruta_23` / `ruta_27` (URGENTE)
Estas ya tienen el agente v1 instalado; solo hay que hacerlas correr para recuperar la venta atrasada (aún dentro de la ventana de 15 días).

En la laptop de la van (cmd/PowerShell):
```
schtasks /Run /TN Ruta27            REM (o Ruta23)
```
Si la tarea ya no existe o falla, correr el push directo:
```
cd /d C:\KeplerPush
push-ruta.cmd
```
Luego pegar la última parte del log:
```
type C:\KeplerPush\push_ruta_27.log
```
→ **Yo verifico** en el runner que subió y que el latido avanzó. Si recuperó, seguimos a migrar esta van a v2 (Caso 2, desde el Paso B).

---

## CASO 2 — Alta / migración a v2 de una camioneta

### Bloque A — Descubrimiento (en la laptop de la van)

**A1. ¿Está psql?**
```
where psql
```
Si no aparece, usar la ruta completa (ajustar versión):
`"C:\Program Files\PostgreSQL\18\bin\psql.exe"`  ← llamaré a esto `PSQL` abajo.

**A2. ¿Cómo se llama la base local?**
```
"C:\Program Files\PostgreSQL\18\bin\psql.exe" "postgresql://postgres:<CLAVE_LOCAL>@localhost:5432/postgres" -c "select datname from pg_database where datname like 'md%' order by 1"
```

**A3. Sacar la SERIE local** (crítico — evita el gotcha serie≠ruta):
```
"C:\Program Files\PostgreSQL\18\bin\psql.exe" "postgresql://postgres:<CLAVE_LOCAL>@localhost:5432/<DB_LOCAL>" -c "select distinct rtrim(btrim(c63),'-') from md.kdm1 where c4=10 and c2='U' and c3='D'"
```
- 1 serie → esa es `ROUTE_SERIE`.
- Varias → la base tiene varias rutas; hay que confirmar cuál es la de esta van (te ayudo a decidir con la venta por serie).

📋 **Pégame la salida de A1, A2 y A3.**

### Bloque B — Configurar el agente (en la laptop de la van)

**B1.** Crear carpeta y copiar los 2 archivos del repo a la van:
```
mkdir C:\KeplerPush
```
Copiar a `C:\KeplerPush\`:
- `push-ruta.v2.template.cmd`  → renombrar a `push-ruta.cmd`
- `ruta.task.xml`

**B2.** Editar `C:\KeplerPush\push-ruta.cmd` (Notepad) y llenar:
- `set TRUCK=ruta_NN`
- `set ROUTE_SERIE=<serie del Paso A3>`
- `set SRC=postgresql://postgres:<CLAVE_LOCAL>@localhost:5432/<DB_LOCAL>?connect_timeout=5`
- `set DST=postgresql://postgres:<CLAVE_RUNNER>@192.168.0.222:5433/kepler_consolidado?connect_timeout=5`

### Bloque C — Probar a mano (en la laptop de la van)

**C1.** Desde un cmd YA abierto (no doble-clic):
```
cd /d C:\KeplerPush
push-ruta.cmd
```
**C2.** Ver el log:
```
type C:\KeplerPush\push_ruta_NN.log
```
Debe verse `ONLINE` + `merge -> filas: <N>` + `OK`. Si dice `OFFLINE` → el runner no se alcanza desde este segmento (avísame, revisamos ruteo/firewall).

📋 **Pégame el log de C2.** → **Yo verifico** venta en `mart.ventas` + latido en `route_push_heartbeat`.

### Bloque D — Instalar la tarea reactiva (terminal ELEVADA obligatoria)

> ⚠️ **GOTCHA (visto en ruta_28):** aunque la cuenta sea "Administrador", la ventana debe estar **elevada** o `schtasks /Create` da **"Acceso denegado"** (la tarea corre como SYSTEM → requiere elevación). Abrir *PowerShell → clic derecho → Ejecutar como administrador*. Tip: hacer TODO el Bloque B–D desde una sola ventana elevada. El `.cmd` y el `ruta.task.xml` se escriben igual; solo el `schtasks /Create` exige elevación.

**D1.** Editar `install-task.v2.cmd` → `set TASKNAME=RutaNN` y copiarlo a `C:\KeplerPush\`.
**D2.** Correr como Administrador:
```
cd /d C:\KeplerPush
install-task.v2.cmd
```
(Si tenías la tarea v1, esto la reemplaza con `/F`.)

**D3.** Probar el disparo por red: desconectar el wifi, reconectar, esperar ~1 min, y:
```
schtasks /Query /TN RutaNN /V /FO LIST | findstr /I "resultado ejecución"
```
→ **Último resultado: 0** = ✅. Confirmar también que el log tiene una corrida nueva tras reconectar.

### Bloque E — Cierre
- Registrar la fila de esta van en `INVENTARIO_Y_PLAN_RUTAS.md` §1.3.
- Repetir para la siguiente camioneta.

---

## CASO 3 — Camioneta en OTRA subred (ej. CANINDO `192.168.50.x`)

Las vans de PH están en la misma LAN que el runner (`.10.x` → `.0.249`). Las de **Canindo** están en `192.168.50.x` (Wi-Fi) → el push da `OFFLINE` hasta abrir la red por **dos lados**. Además el Postgres de la van no acepta a `.249` por `pg_hba`, y el psql local tiene el gotcha del `-c`.

**R1 — abrir la VAN** (PowerShell **elevado** en la laptop; idempotente):
```powershell
netsh advfirewall firewall add rule name="ICMP-In" protocol=icmpv4:8,any dir=in action=allow | Out-Null
netsh advfirewall firewall add rule name="PG-In-LAN" dir=in action=allow protocol=TCP localport=5432 remoteip=192.168.0.0/16 | Out-Null
$env:PGPASSWORD='kepler123'
$psql = "C:\Program Files\PostgreSQL\16\bin\psql.exe"
$hba = & $psql -U postgres -tAc "show hba_file"
if (-not (Select-String -Path $hba -Pattern '192.168.0.0/16' -Quiet)) { Add-Content -Path $hba -Value "host    all    all    192.168.0.0/16    scram-sha-256" }
& $psql -U postgres -c "select pg_reload_conf()"   # → t
```
(Su Postgres ya escucha en la LAN — NO hace falta `listen_addresses` ni reiniciar. Clave local Canindo = `kepler123`.)

**R2 — abrir el RUNNER** para esa subred. ⭐ **Con `md` (`.222`) este paso YA NO EXISTE**: medido el
2026-09-15, `md` no tiene `ufw` activo y el contenedor publica `0.0.0.0:5433`, y su `pg_hba` es
`host all all all scram-sha-256` → **entra cualquier subred con contraseña**. No hay nada que abrir
del lado servidor.

> Para referencia histórica, en `.249` sí había que hacerlo, y la regla dejaba entrar a **exactamente
> tres** subredes — `192.168.0.0/24`, `192.168.10.0/24`, `192.168.50.0/24`:
> ```powershell
> Set-NetFirewallRule -DisplayName "Kepler ingest 5433" -RemoteAddress @('192.168.0.0/24','192.168.10.0/24','192.168.50.0/24')
> ```
> ⚠️ Que el servidor acepte **no** significa que la van llegue: el ruteo entre segmentos es otra
> cosa, y se comprueba desde la van (el log dice `OFFLINE` si no alcanza). No se da por hecho.

**R3 — descubrir DESDE el runner** (más rápido que en la van; ya alcanzable tras R1). El contenedor
`pgvector-md` vive ahora en `md`, así que se entra por `ssh superoot@192.168.0.222`:
```
docker exec -e PGPASSWORD=kepler123 pgvector-md psql -h <IP_VAN> -p 5432 -U postgres -d postgres -tAc "select datname from pg_database where datname like 'md%'"
docker exec -e PGPASSWORD=kepler123 pgvector-md psql -h <IP_VAN> -p 5432 -U postgres -d <DB> -tAc "select rtrim(btrim(c63),'-') serie, btrim(c67) ruta, count(*) from md.kdm1 where c2='U' and c3='D' and c4=10 group by 1,2"
```

**R4 — agente + tarea** = igual que CASO 2 (Bloques B–D), con **dos diferencias obligatorias**:
- ⚠️ **`-d` en TODAS las llamadas psql** del `.cmd`: en este psql `psql "<uri>" -c "SQL"` ignora el `-c` y **se cuelga** en interactivo. Usar `psql -d "<uri>" -c "SQL"` + `<nul` en las que no tienen pipe. (Ver plantilla ya corregida usada en `ruta_503`/`ruta_504`.)
- ⚠️ **crear `C:\KeplerPush` primero** (`New-Item -ItemType Directory -Force C:\KeplerPush`) — cada van es una máquina distinta.

**R5 — ⚠️ retirar la ruta del `c67` del branch** (server-side, para no doble-contar): las vans de Canindo también sincronizan al POS, así que su venta ya entra por `import-canindo-routes-monthly` (`WIN-50N`). Al ponerla en push, retirar esa `50N` del path `c67` (patrón Wincaja '50'). Mientras `ruta_50N` no tenga mapeo a warehouse, no llega a sell-out → seguro. Ver [`INVENTARIO_Y_PLAN_RUTAS.md`](INVENTARIO_Y_PLAN_RUTAS.md) §1.5.

---

## CASO 4 — repuntar una camioneta YA dada de alta: `.249` → `.222`

> Para las 11 vans que se dieron de alta antes del 2026-09-11 y quedaron con el runner viejo en su
> `push-ruta.cmd`. Hoy funcionan por el reenvío TCP de `.249`; esto las desengancha de esa máquina.

**Lo que cambia es UNA IP**, y nada más: mismo puerto, misma base, mismo usuario, misma tarea
programada, mismo `TRUCK` y `ROUTE_SERIE`. El origen (Postgres local de la van) **no se toca**.

> ⛔ **NO busques el cambio por el nombre de la variable.** Medido en `ruta_21` el 2026-09-15: el
> agente **desplegado** no usa la línea de estas plantillas. En campo es
>
> ```
> set RUNNER_CONN=host=192.168.0.222 port=5433 dbname=kepler_consolidado user=ingest password=… connect_timeout=6
> ```
>
> —formato de **palabras clave** (no URI) y usuario **`ingest`** (no `postgres`)—, mientras el repo
> trae `set DST=postgresql://postgres:…`. **Hay una versión en campo que nunca volvió al repo.**
> Por eso el procedimiento de abajo reemplaza **la IP** y no la línea: es lo único que vale en las
> dos variantes. Buscar `set DST=` no encuentra nada y parece que el archivo está mal.

### P0 — PREFLIGHT, obligatorio en un segmento NO probado (ej. Canindo `192.168.50.x`)

> En un segmento que ya se probó (PH `.10.x`), esto se puede saltar: se cambia y se prueba. En uno
> **sin probar, se prueba ANTES de cambiar** — si no hay camino, la van queda muda hasta que alguien
> lo note, y el agente sale rápido y en silencio cuando el runner no responde.

**No modifica nada** y no imprime la contraseña:

```powershell
# 1) ¿hay camino TCP hasta el runner nuevo?
Test-NetConnection -ComputerName 192.168.0.222 -Port 5433 -InformationLevel Quiet

# 2) ¿autentica de verdad? — usa la cadena del PROPIO archivo, cambiando sólo el host
$f = 'C:\KeplerPush\push-ruta.cmd'
$c = ((Select-String -Path $f -Pattern '192\.168\.0\.\d+').Line -split '=', 2)[1] -replace '192\.168\.0\.249','192.168.0.222'
$psql = (Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -EA SilentlyContinue | Select-Object -Last 1).FullName
& $psql -d "$c" -c "select 'OK 222' as prueba"
```

⭐ El `-split '=', 2` lo hace **agnóstico al nombre de la variable** (`RUNNER_CONN`, `DST`, lo que
sea) y sirve igual para formato URI que de palabras clave. Y `-d` es obligatorio: este psql se
**cuelga** en interactivo si se le pasa la cadena como argumento posicional con `-c`.

| resultado | qué hacer |
|---|---|
| `True` + `OK 222` | seguir con P1 |
| `False` | ⛔ **no tocar la van.** Sigue entregando por el reenvío de `.249` y no se pierde nada. Es problema de red: hay que permitir `.0.222` desde ese segmento |
| `True` pero psql falla | raro — `md` tiene `pg_hba` `host all all all`. Investigar antes de seguir |

**Lo que YA está medido del lado servidor (2026-09-15), para no repetirlo:** `.249` y `md` tienen
**la misma tabla de rutas** (sólo default vía `192.168.0.254`, sin rutas estáticas ni VPN), y desde
`md` el gateway de Canindo (`192.168.50.1`) **responde**. O sea que el camino de vuelta existe; lo
único sin verificar es si el segmento de la van permite salir hacia `.0.222`.

### P1 — en la laptop de la van (no hace falta elevar: es editar un archivo)

```powershell
$f = 'C:\KeplerPush\push-ruta.cmd'
Copy-Item $f "$f.bak-$(Get-Date -Format yyyyMMdd-HHmm)" -Force     # respaldo con fecha
(Get-Content $f -Raw) -replace '192\.168\.0\.249', '192.168.0.222' |
  Set-Content $f -Encoding ASCII -NoNewline                        # el .cmd NO puede quedar UTF-8 con BOM
Get-Item $f | Select-Object Length, LastWriteTime                  # que no haya quedado vacío
Select-String -Path $f -Pattern '192\.168\.0\.'                    # debe decir 192.168.0.222
```

Es **idempotente**: correrlo dos veces no hace daño (la segunda no encuentra qué reemplazar).

⚠️ **Se verifica por la IP y por el tamaño del archivo**, no por el nombre de la variable (ver el
recuadro de arriba) — y el tamaño porque el mismo comando que reemplaza **reescribe el archivo**:
si el origen viniera vacío, lo dejaría vacío sin dar error.

⚠️ **La contraseña del runner está EN CLARO en ese archivo, en las 11 vans y es la misma.** No la
pegues en un chat ni en un ticket al verificar: filtrá la salida a la IP, como arriba. Si se
expuso, rotarla **después** de terminar el repunte (rotarla antes deja mudas a las que faltan).

### P2 — probar a mano, desde un `cmd` YA abierto (no doble clic)

```
cd /d C:\KeplerPush
push-ruta.cmd
type C:\KeplerPush\push_ruta_NN.log
```

Tiene que decir **`ONLINE`** + `merge -> filas: <N>` + **`OK`**.

⛔ Si dice **`OFFLINE`**, la van **no alcanza `.222`** desde su segmento y hay un problema de ruteo o
firewall — **revertí con el `.bak` y avisá**. No lo dejes así: el agente sale rápido y en silencio
cuando el runner no responde, o sea que la van se queda muda sin ruido.

### P3 — lo verifico yo del lado runner (con el dato, no con "debería andar")

```sql
SELECT sucursal, max(fecha), count(*) FROM mart.ventas WHERE sucursal='ruta_NN' GROUP BY 1;
SELECT * FROM ingest.route_push_heartbeat WHERE truck='ruta_NN';
```

### Orden, y por qué importa

1. **Una sola van primero** (conviene la que empujó hoy: se ve el resultado enseguida).
2. Verificación P3 **antes** de seguir.
3. Las otras diez.
4. ⛔ **El reenvío de `.249` se queda puesto** hasta que las 11 estén verificadas. No cuesta nada y
   **es el rollback**: si una falla, vuelve a `.249` y sigue entregando.
5. Recién ahí se evalúa quitar el reenvío — y **antes de quitarlo hay que medir qué MÁS lo usa**:
   el 2026-09-15 se vieron conexiones locales desde `127.0.0.1:5433` en la propia `.249`. Quitarlo
   sin mirar eso es repetir el apagón de 49 h de `ruta_*` (se inventarió *qué corre en* la máquina
   y nunca *quién le escribe desde afuera*).

### ⚠️ Antes de empezar: dos cosas que NO son consecuencia del cambio

- **`ruta_505` lleva sin empujar desde el 2026-09-10** (medido el 15-sep). Si la repuntás y sigue
  callada, **eso no significa que el repunte falló** — ya estaba rota.
- Las vans empujan **al cerrar el día**, no continuo. Que `netstat` no muestre conexiones no dice
  nada; el inventario de quién empuja se saca del **dato**:

```sql
SELECT sucursal, max(fecha) AS ultima, (CURRENT_DATE - max(fecha)) AS dias, count(*) AS lineas
  FROM mart.ventas WHERE sucursal LIKE 'ruta_%' GROUP BY 1 ORDER BY 2 DESC;
```

---

## Mi lado (lo corro yo tras cada push) — **son DOS lados, no uno**

### Lado 1 — llegó al runner
```sql
-- venta reciente de la ruta
SELECT sucursal, max(fecha), count(*) FROM mart.ventas WHERE sucursal='ruta_NN' GROUP BY 1;
-- latido
SELECT * FROM ingest.route_push_heartbeat WHERE truck='ruta_NN';
```

### Lado 2 — llegó a la PLATAFORMA (⛔ no se puede omitir)
El runner verde **no** significa que la venta esté en la app. El 2026-09-09 las 3 vans de Canindo
latían verde y tenían **$1,266,037** parados en el runner porque el puente
(`import-route-push-lines.js`) usaba un watermark **global**: el máximo de las rutas viejas tapaba a
la van nueva y sus primeros días quedaban inalcanzables **sin ningún error** (ver
[`INVENTARIO_Y_PLAN_RUTAS.md`](INVENTARIO_Y_PLAN_RUTAS.md) §1.6).

```bash
node -e "require('dotenv').config();process.env.DST_URL=process.env.FLEET_DB_URL;require('./database/importers/kepler/import-route-push-lines.js')"
```
Leer la línea **`ventana por ruta`**: la ruta nueva debe aparecer con `*` y su motivo (`ruta nueva`
o `hueco frontal`). Correr con `--apply` para cargarla; el nightly también lo hace solo.

Después, el hueco tiene que dar **cero** (runner vs plataforma, ruta×mes):
⛔ **El delta de LÍNEAS no es cero, y la explicación que decía acá era FALSA.** Este runbook afirmaba
que eran *"líneas de SKU vacío que el loader descarta a propósito"*. Medido el 2026-09-15 contra
septiembre: **no hay ni una línea con SKU vacío** en las 11 rutas. La causa real es otra —
`import-route-push-lines.js` agrupa por `(route_no, business_date, folio, sku)` y **suma** el
importe, así que **el mismo producto repetido dos veces en el mismo ticket entra como un renglón**.

Medido, y cuadra exacto:

| | runner | plataforma | Δ líneas | Δ importe |
|---|---|---|---|---|
| 8 rutas | — | — | **0** | **0** |
| `ruta_27` | 1,852 | 1,845 | −7 | **0** |
| `ruta_502` | 2,223 | 2,222 | −1 | **0** |
| `ruta_503` | 2,959 | 2,957 | −2 | **0** |

…y los renglones duplicados por `folio+sku` en el runner son **exactamente 7 / 1 / 2** en esas tres
rutas. **El dinero cuadra al peso en las 11.**

```sql
-- Lo que explica el delta de líneas (debe dar los MISMOS números que el hueco):
SELECT substring(sucursal from 'ruta_(.*)') AS ruta, sum(cnt-1)::int AS lineas_consolidadas
  FROM (SELECT sucursal, fecha, folio, sku, count(*) AS cnt
          FROM mart.ventas_enriched
         WHERE sucursal LIKE 'ruta_%' AND fecha >= date_trunc('month', CURRENT_DATE)
           AND btrim(coalesce(sku,'')) <> ''
         GROUP BY 1,2,3,4 HAVING count(*) > 1) d
 GROUP BY 1 ORDER BY 1;
```

⚠️ **La lección, que vale más que el número:** un hueco *explicado por una cita* es un hueco sin
explicar. Si el delta no se reproduce con una consulta, no está entendido — y el día que aparezca
un hueco de verdad se va a archivar con el mismo motivo equivocado.

⚠️ El comparativo se hace contra **`mart.ventas_enriched`**, que es lo que lee el importer, no contra
`mart.ventas`. Son tablas distintas y compararlas contra la equivocada mueve el delta.

## Señales de éxito
- Log dice `ONLINE` + `OK`.
- `mart.ventas` tiene venta fresca de `ruta_NN`.
- `route_push_heartbeat.last_ok` = ahora.
- `schtasks ... Último resultado: 0` y dispara al reconectar la red.
- **`analytics.route_push_lines` tiene la MISMA venta que el runner** para esa ruta, mes por mes.
- **`analytics.sales_by_route_monthly` trae `WIN-NN`** con el warehouse correcto (se deriva del
  prefijo del almacén: `06-003` → `06`; si el almacén viene vacío el importer lo manda a `01` por
  default — revisarlo en una plaza nueva).
