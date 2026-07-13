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

### Bloque D — Instalar la tarea reactiva (cmd como ADMINISTRADOR)

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

## Mi lado (lo corro yo tras cada push)
```sql
-- venta reciente de la ruta
SELECT sucursal, max(fecha), count(*) FROM mart.ventas WHERE sucursal='ruta_NN' GROUP BY 1;
-- latido
SELECT * FROM ingest.route_push_heartbeat WHERE truck='ruta_NN';
```

## Señales de éxito
- Log dice `ONLINE` + `OK`.
- `mart.ventas` tiene venta fresca de `ruta_NN`.
- `route_push_heartbeat.last_ok` = ahora.
- `schtasks ... Último resultado: 0` y dispara al reconectar la red.
