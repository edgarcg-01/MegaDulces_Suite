# Runbook — alta / rescate de una camioneta (para seguir EN VIVO)

> Se sigue **con la van físicamente en base** conectada a la red interna (PH o CEDIS).
> Tú corres los comandos en la laptop de la van y me pegas la salida; yo verifico el lado runner.
> Prerrequisito ya hecho: `runner-heartbeat.sql` aplicado en `.249` ✅.

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
- `set DST=postgresql://postgres:<CLAVE_RUNNER>@192.168.0.249:5433/kepler_consolidado?connect_timeout=5`

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

**R2 — abrir el RUNNER `.249`** para esa subred (**una sola vez por plaza**, en `.249`):
```powershell
Set-NetFirewallRule -DisplayName "Kepler ingest 5433" -RemoteAddress @('192.168.0.0/24','192.168.10.0/24','192.168.50.0/24')
```
> ✅ **Canindo `.50.0/24` YA está agregada** → las próximas vans de Canindo saltan R2.

**R3 — descubrir DESDE `.249`** (más rápido que en la van; ya alcanzable tras R1):
```
docker exec -e PGPASSWORD=kepler123 pgvector-md psql -h <IP_VAN> -p 5432 -U postgres -d postgres -tAc "select datname from pg_database where datname like 'md%'"
docker exec -e PGPASSWORD=kepler123 pgvector-md psql -h <IP_VAN> -p 5432 -U postgres -d <DB> -tAc "select rtrim(btrim(c63),'-') serie, btrim(c67) ruta, count(*) from md.kdm1 where c2='U' and c3='D' and c4=10 group by 1,2"
```

**R4 — agente + tarea** = igual que CASO 2 (Bloques B–D), con **dos diferencias obligatorias**:
- ⚠️ **`-d` en TODAS las llamadas psql** del `.cmd`: en este psql `psql "<uri>" -c "SQL"` ignora el `-c` y **se cuelga** en interactivo. Usar `psql -d "<uri>" -c "SQL"` + `<nul` en las que no tienen pipe. (Ver plantilla ya corregida usada en `ruta_503`/`ruta_504`.)
- ⚠️ **crear `C:\KeplerPush` primero** (`New-Item -ItemType Directory -Force C:\KeplerPush`) — cada van es una máquina distinta.

**R5 — ⚠️ retirar la ruta del `c67` del branch** (server-side, para no doble-contar): las vans de Canindo también sincronizan al POS, así que su venta ya entra por `import-canindo-routes-monthly` (`WIN-50N`). Al ponerla en push, retirar esa `50N` del path `c67` (patrón Wincaja '50'). Mientras `ruta_50N` no tenga mapeo a warehouse, no llega a sell-out → seguro. Ver [`INVENTARIO_Y_PLAN_RUTAS.md`](INVENTARIO_Y_PLAN_RUTAS.md) §1.5.

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
```bash
# quedan deltas de 1-5 líneas con importe $0 = líneas de SKU vacío que el loader descarta a propósito
```

## Señales de éxito
- Log dice `ONLINE` + `OK`.
- `mart.ventas` tiene venta fresca de `ruta_NN`.
- `route_push_heartbeat.last_ok` = ahora.
- `schtasks ... Último resultado: 0` y dispara al reconectar la red.
- **`analytics.route_push_lines` tiene la MISMA venta que el runner** para esa ruta, mes por mes.
- **`analytics.sales_by_route_monthly` trae `WIN-NN`** con el warehouse correcto (se deriva del
  prefijo del almacén: `06-003` → `06`; si el almacén viene vacío el importer lo manda a `01` por
  default — revisarlo en una plaza nueva).
