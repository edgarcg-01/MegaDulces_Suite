# Push de ventas de RUTA (camionetas Kepler → runner → `mart.ventas`)

Cada camioneta de ruta tiene su **Kepler local** (esquema `md.*`). Este agente
empuja su venta al **runner** (`192.168.0.249:5433 / kepler_consolidado`), donde
entra a `mart.ventas` como `sucursal='ruta_NN'` y sigue el mismo pipeline
analítico que las sucursales (Command Center, sell-out, etc.).

## Arquitectura

```
Kepler local camioneta (md.kdm1⋈kdm2, venta c4=10)
        │  psql "\copy (SELECT...) to stdout"   ← DIRECTO, sin archivo
        ▼  |  (pipe)
Runner .249:5433  ingest.route_sales_stg   (psql "\copy ... from stdin")
        ▼  ingest.merge_route_sales('ruta_NN', 15)   ← idempotente (borra-por-fechas-del-lote)
   mart.ventas  (sucursal='ruta_NN')
```

- **Directo por pipe** (`to stdout | from stdin`): no escribe CSV en disco.
- **Credenciales por URI** (`postgresql://user:pass@host:port/db`): sin espacios →
  a prueba de las comillas de `cmd` (una conninfo con espacios hace que psql
  "ignore" el `-c`).
- **Idempotente**: `merge_route_sales` borra solo las fechas presentes en el lote
  y reinserta; correr de más no duplica ni pierde historia.

## Piezas

| Archivo | Dónde corre | Qué es |
|---|---|---|
| `runner-ingest-setup.sql` | runner (una vez) | schema `ingest`, tabla `route_sales_stg`, función `merge_route_sales`, rol `ingest`. |
| `push-ruta.template.cmd` | laptop de cada camioneta | agente de push (copiar a `C:\KeplerPush\push-ruta.cmd` y llenar). |
| `install-task.cmd` | laptop de cada camioneta (admin) | crea la tarea programada oculta. |

## Alta de una camioneta nueva (paso a paso)

> Los archivos van en `C:\KeplerPush\` (FUERA del repo: llevan credenciales).

### 1. Encontrar la SERIE local de la ruta
La base de la camioneta numera su folio `c63` como `UD10NN`, pero el **NN es
local** (casi siempre `UD1001`, porque esa base tiene una sola ruta) — **no** es
el número de ruta de la empresa. Verificá:
```
psql "postgresql://postgres:<CLAVE>@localhost:5432/<DB_LOCAL>" -c "select distinct rtrim(btrim(c63),'-') from md.kdm1 where c4=10 and c2='U' and c3='D'"
```
Ejemplo real: base `md_01-005` = **ruta 27 de la empresa**, pero su serie local es **`UD1001`**.

### 2. Llenar `C:\KeplerPush\push-ruta.cmd`
Desde `push-ruta.template.cmd`, ajustar:
- `TRUCK=ruta_27` → clave en `mart.ventas` (número de ruta de la **empresa**).
- `ROUTE_SERIE=UD1001` → la serie **local** del paso 1.
- `SRC=postgresql://postgres:<CLAVE_LOCAL>@localhost:5432/<DB_LOCAL>`
- `DST=postgresql://postgres:<CLAVE_RUNNER>@192.168.0.249:5433/kepler_consolidado`

### 3. Probar a mano (desde un `cmd` ya abierto, no doble-clic)
```
cd /d C:\KeplerPush
push-ruta.cmd
```
Debe terminar mostrando el número del merge (filas insertadas), sin "sintaxis incorrecta".

### 4. Instalar la tarea oculta (`cmd` como Administrador)
```
schtasks /Create /TN Ruta27 /TR "C:\KeplerPush\push-ruta.cmd" /SC MINUTE /MO 15 /RU SYSTEM /RL HIGHEST /F
```
`/RU SYSTEM` → corre en sesión 0: sin contraseña, logueado o no, **sin ninguna ventana**.
Cada 15 min todo el día (fuera de horario de ruta simplemente no hay venta nueva; el merge es idempotente).

### 5. Verificar
```
schtasks /Run /TN Ruta27
schtasks /Query /TN Ruta27 /V /FO LIST | findstr /I "resultado ejecución"
```
**`Último resultado: 0`** = corrió y terminó bien. ✅

## Gotchas / troubleshooting

- **Serie local ≠ número de ruta de la empresa** → si `ROUTE_SERIE` no matchea, el push sube **0 filas** (falla seguro, NO corrompe `mart.ventas`). Siempre verificar con el paso 1.
- **Base con varias rutas** (ej. los DB de sucursal, `md_01` = `UD1001..UD1005`): el filtro `ROUTE_SERIE` es **obligatorio** o hay doble conteo. Base de una sola ruta: el filtro igual es inofensivo (debe matchear).
- **`\copy` dice "No such file"** → corriste el paso de carga antes del de volcado, o el orden se rompió. Correr en secuencia.
- **`La sintaxis del comando no es correcta`** → el `.cmd` se tipeó a mano con `if (...)`, `&` o `goto` (frágiles). La plantilla nueva NO los usa; retranscribí sin esos.
- **La consola se abre y se cierra al instante** → doble-clic siempre cierra; correr desde un `cmd` ya abierto (paso 3) para leer el error.
- **VNC sin copy-paste** → tipear los comandos a mano; ojo que Notepad no guarde como `.txt` oculto.
- **Runner con `postgres/superoot`**: alcanza para `\copy` a staging + `merge_route_sales` (SECURITY DEFINER). El rol `ingest` least-privilege es opcional.

## Estado

- **ruta_27** (base `md_01-005`, serie local `UD1001`): ✅ validada — 567 filas en `mart.ventas`, tarea `Ruta27` corriendo cada 15 min.
- Pendiente: replicar para el resto de camionetas (mismo `.cmd` cambiando `TRUCK`, `ROUTE_SERIE`, `SRC` y el nombre de tarea).
