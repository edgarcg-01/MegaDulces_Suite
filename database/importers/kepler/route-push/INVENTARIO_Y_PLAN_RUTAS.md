# Dónde viven las rutas + plan de alta para el resto

> Documento de inventario y onboarding del **push de ventas de ruta** (camionetas Kepler → runner → `mart.ventas`).
> Complementa el [`README.md`](README.md) de esta carpeta (que explica el *cómo* del agente).
> Fecha de levantamiento: **2026-07-13**.

---

## 1. Mapa: dónde vive cada cosa

El flujo tiene **3 capas físicas**. Ninguna corre en la PC de analítica/dev (ahí solo está la plantilla del `.cmd`, no el ejecutable real).

```
[Camioneta de ruta]  Kepler local (md.*)  ──push cada 15 min──▶  [Runner .249]  ──feeds──▶  Plataforma / Command Center
   laptop en la calle                                          kepler_consolidado
```

### 1.1 Runner consolidado (destino del push)
| Campo | Valor |
|---|---|
| Host | `192.168.0.249:5433` |
| DB | `kepler_consolidado` |
| Credencial | `postgres` / `superoot` (alcanza para `\copy` + `merge_route_sales` SECURITY DEFINER) |
| Staging | `ingest.route_sales_stg` (se vacía tras cada merge) |
| Destino final | `mart.ventas` con `sucursal='ruta_NN'` |
| Función merge | `ingest.merge_route_sales('ruta_NN', <días>)` — idempotente |
| Setup (una vez) | [`runner-ingest-setup.sql`](runner-ingest-setup.sql) |

**Sucursales/rutas hoy en `mart.ventas` (runner):**

| sucursal | filas | rango de fechas | fuente |
|---|---:|---|---|
| `md_01` | 51,289 | 2026-06-27 → 2026-07-13 | branch (concentrador) |
| `md_02` | 310,724 | 2025-01-01 → 2026-07-13 | branch (concentrador) |
| `md_03` | 648,298 | 2025-01-01 → 2026-07-13 | branch (concentrador) |
| `md_04` | 58,811 | 2026-02-18 → 2026-07-13 | branch (concentrador) |
| `md_05` | 59,330 | 2026-03-17 → 2026-07-13 | branch (concentrador) |
| `ruta_23` | 732 | 2026-06-29 → **2026-07-01** ⚠️ | push de ruta |
| `ruta_27` | 567 | 2026-06-29 → **2026-07-02** ⚠️ | push de ruta |

> ⚠️ **ALERTA DE SALUD:** las dos rutas activas dejaron de subir venta hace ~11 días (última 2026-07-01/07-02) mientras las sucursales `md_*` están al día. Muy probablemente la **tarea programada de esas camionetas está caída, apagada, o la laptop sin red**. Verificar antes de dar de alta nuevas (ver §4).

### 1.2 Branches / sucursales (NO son camionetas — son las tiendas)
Cada sucursal tiene su propio Kepler (`md.*`). El catálogo de direcciones vive en la tabla **`md.pv_suc_ip`** de cualquier branch:

| c1 | Nombre (`c2`) | Dirección DDNS (`c3`) | Puerto (`c4`) | Host real | DB |
|---|---|---|---|---|---|
| `00` | Cedis Oficinas | `mddlacedis.ddns.net` | 1801 | `192.168.9.95:5432` | `md_00` |
| `01` | Sucursal Hidalgo | `mddlaph.ddns.net` | 1801 | `192.168.10.10:1977` | `md_01` |
| `02` | La Piedad Abastos | `mdabastos.ddns.net` | 1801 | `192.168.42.42:5432` | `md_02` |
| `03` | 8 Esquinas | `md8esquinas.ddns.net` | 1801 | `192.168.40.40:5432` | `md_03` |
| `04` | Yurecuaro | `mdyurecuaro.ddns.net` | 1801 | `192.168.44.44:5432` | `md_04` |
| `05` | Zamora Centro | `mdzamora.ddns.net` | 1801 | `192.168.54.54:5432` | `md_05` |
| `SC` | **Sistema Concentrador** | — | — | — | (proceso, no DB) |

Credencial branches: `postgres` / `kepler123`.

### 1.3 Camionetas de ruta (origen del push) — **inventario a completar**
Cada camioneta tiene un Kepler local **independiente** (esquema `md.*`, una o varias rutas). El nombre de base sigue el patrón **`md_01-0NN`** y su folio local (`c63`) es **`UD10NN`**, pero:

> 🔴 **GOTCHA CLAVE:** el `NN` local **NO es** el número de ruta de la empresa.
> Ejemplo real confirmado: base **`md_01-005` = ruta 27 de la empresa**, pero su serie local es **`UD1001`**.

Estado del inventario de camionetas (lo único confirmado hoy):

| TRUCK (empresa) | Base local | Serie local (`c63`) | Host laptop | Tarea | Estado |
|---|---|---|---|---|---|
| `ruta_22` | `md_01-002` | `UD1001` | *(por documentar)* | `Ruta22` | ✅ v2 reactiva (alta 2026-07-13) |
| `ruta_23` | `md_01-003` | `UD1001` | *(por documentar)* | `Ruta23` | ✅ v2 reactiva (alta 2026-07-13) |
| `ruta_27` | `md_01-005` | `UD1001` | `192.168.10.241` | `Ruta27` | ✅ v2 reactiva (alta 2026-07-16) |
| `ruta_28` | `md_01-006` | `UD1001` | *(por documentar)* | `Ruta28` | ✅ v2 reactiva (alta 2026-07-16) |
| resto (~31) | — | — | — | — | ⬜ pendiente |

**Notas de campo:** todas las bases de camioneta siguen `md_01-0NN` con serie local **`UD1001`** (una ruta por base). El agente correcto es la variante CSV (con filtros `d.c8 NOT IN ('00001','00002')` + no-vacíos). La tarea se instala **desde PowerShell ELEVADA** (`schtasks /Create` da "Acceso denegado" si no). El firewall de las laptops solo permite Postgres en `localhost` → el descubrimiento y el push corren en la propia laptop.

### 1.4 Catálogo de rutas de la empresa (referencia)
De `md.kdm_rutas` (branch `md_00`). **La ruta 28 = `R0028` ANGAMACUTIRO.** Este es el universo de rutas candidatas a onboarding:

| Código | Nombre | | Código | Nombre |
|---|---|---|---|---|
| R0001 | HUANIMARO | | R0019 | ROMITA |
| R0002 | PASTOR ORTIZ | | R0021 | LA YERBABUENA |
| R0003 | ABASOLO | | R0022 | ZAMORA |
| R0004 | PENJAMO | | R0023 | MORELIA |
| R0005 | PENJAMILLO | | R0024 | SANTA ANA PACUECO |
| R0006 | ZINAPARO | | R0025 | VALLE DE SANTIAGO |
| R0007 | AYOTLAN | | R0026 | IRAPUATO |
| R0008 | DEGOLLADO | | R0027 | ALDAMA |
| R0009 | LA PIEDAD | | **R0028** | **ANGAMACUTIRO** |
| R0010 | TANUHATO | | R0029 | ARANDAS |
| R0011 | YURECUARO | | R0030 | GUANAJUATO |
| R0012 | LA RIVERA | | R0031 | NUMARAN |
| R0013 | MANUEL DOBLADO | | R0032 | PURISIMA DEL RINCON |
| R0014 | GUAYABO DE SANTA RITA | | R0033 | QUERETARO |
| R0015 | LEON | | R0034 | TANGANCICUARO |
| R0016 | EL MAGUEY | | R0035 | ZAPOPAN |
| R0017 | SAN FRANCISCO DEL RINCON | | R0036 | CHURINTZIO |
| R0018 | SILAO | | | |

> ⚠️ El `TRUCK=ruta_NN` es el **número de ruta de negocio**, que puede NO coincidir con el código `R00NN` del catálogo (cada branch además tiene su propia numeración `R1..R25`). El número de negocio se confirma con el responsable de rutas, no se deduce del catálogo.

---

## 2. Cómo funciona el push (resumen operativo)

Detalle completo en [`README.md`](README.md). En una línea: `push-ruta.cmd` corre cada 15 min por Task Scheduler (como `SYSTEM`, oculto) en la laptop de la camioneta y hace:

1. `DELETE` del staging de esa camioneta en el runner.
2. `\copy (SELECT venta local de md.kdm1⋈kdm2, c4=10, filtrado por ROUTE_SERIE, últimos N días) to stdout` **| pipe |** `\copy ingest.route_sales_stg from stdin` (directo, sin CSV).
3. `SELECT ingest.merge_route_sales('ruta_NN', N)` → aterriza en `mart.ventas` (idempotente).

Piezas:
- [`push-ruta.template.cmd`](push-ruta.template.cmd) → se copia a `C:\KeplerPush\push-ruta.cmd` (fuera del repo, lleva credenciales) y se llenan los `<...>`.
- [`install-task.cmd`](install-task.cmd) → registra la tarea oculta cada 15 min.

---

## 3. Plan: agregar el push al resto de las camionetas

Objetivo: llevar de **2 rutas** (`ruta_23`, `ruta_27`) a **todas las camionetas activas**, con un método repetible y verificable. Estimado: ~15–20 min por camioneta una vez que hay acceso a su laptop.

### Fase 0 — Levantar el inventario real (bloqueante)
No se puede automatizar el push sin saber qué camionetas hay y cómo llegar a ellas. Salida: completar la tabla §1.3.

- [ ] Obtener del responsable de rutas la **lista de camionetas activas** y su **número de ruta de negocio** (`ruta_NN`).
- [ ] Para cada una, conseguir **acceso a su laptop** (VNC/AnyDesk/RDP/DDNS o presencial) y confirmar: hostname/IP, versión de PostgreSQL local, nombre de la DB local (`md_01-0NN`).
- [ ] Decidir la convención de acceso (¿todas por DDNS tipo `mdrutaNN.ddns.net`? ¿IP fija?). Documentarla aquí.

### Fase 1 — Salud de lo existente (antes de crecer)
- [ ] Verificar por qué `ruta_23` y `ruta_27` no suben desde el 1–2 de julio:
  - En cada laptop: `schtasks /Query /TN RutaNN /V /FO LIST` → ver **"Último resultado"** y última ejecución.
  - Revisar `C:\KeplerPush\push_ruta_NN.log` (últimas líneas: merge / error / 0 filas).
  - Causas típicas: laptop apagada/sin red, tarea borrada, cambió la clave del runner, o la serie local cambió.
- [ ] Dejar ambas en verde (Último resultado `0` + venta fresca en `mart.ventas`) **antes** de replicar.

### Fase 2 — Onboarding por camioneta (receta repetible)
Para cada camioneta nueva, en su laptop:

1. **Sacar la serie local** (paso obligatorio — evita el gotcha del §1.3):
   ```
   psql "postgresql://postgres:<CLAVE_LOCAL>@localhost:5432/<DB_LOCAL>" -c "select distinct rtrim(btrim(c63),'-') from md.kdm1 where c4=10 and c2='U' and c3='D'"
   ```
   - Si devuelve **una** serie → esa es `ROUTE_SERIE`.
   - Si devuelve **varias** → la base tiene varias rutas; el filtro `ROUTE_SERIE` es **obligatorio** (o hay doble conteo). Confirmar cuál corresponde al `ruta_NN` de negocio.
2. **Llenar** `C:\KeplerPush\push-ruta.cmd` desde la plantilla: `TRUCK=ruta_NN`, `ROUTE_SERIE=<serie local>`, `SRC=<DB local>`, `DST=…@192.168.0.249:5433/kepler_consolidado`, `DAYS=15`.
3. **Probar a mano** desde un `cmd` ya abierto (no doble-clic): `cd /d C:\KeplerPush && push-ruta.cmd` → debe cerrar mostrando el conteo del merge, sin "sintaxis incorrecta".
4. **Instalar la tarea** (cmd como Administrador), nombre único por ruta:
   ```
   schtasks /Create /TN RutaNN /TR "C:\KeplerPush\push-ruta.cmd" /SC MINUTE /MO 15 /RU SYSTEM /RL HIGHEST /F
   ```
5. **Verificar en el runner** (desde cualquier lado con red a `.249`):
   ```
   psql "postgresql://postgres:superoot@192.168.0.249:5433/kepler_consolidado" -c "select sucursal,count(*),max(fecha) from mart.ventas where sucursal='ruta_NN' group by 1"
   ```
6. **Registrar** la fila en la tabla §1.3 de este documento.

### Fase 3 — Endurecer / escalar (mejoras, no bloqueantes)
- [ ] **Parametrizar la plantilla** para no editar a mano: leer `TRUCK`/`ROUTE_SERIE`/`SRC` de un `config.cmd` o variables de entorno por máquina → un solo `.cmd` idéntico en todas.
- [ ] **Rol least-privilege** en el runner (`ingest`) en vez de `postgres/superoot` en cada laptop (menos superficie si se filtra un `.cmd`).
- [ ] **Monitoreo de frescura**: query/cron en la plataforma que alerte si una `ruta_*` no sube venta en >X horas de horario hábil (hubiera cachado la caída de `ruta_23/27`). Encaja con el patrón de scanners/alertas ya existente.
- [ ] **Runbook de baja/cambio**: qué hacer si una camioneta se reasigna de ruta (cambia `TRUCK`/serie) o se retira.

### Riesgos y gotchas (heredados del README)
- **Serie local ≠ ruta de empresa** → si `ROUTE_SERIE` no matchea, sube **0 filas** (falla segura, no corrompe `mart.ventas`).
- **Base con varias rutas** → filtro obligatorio o doble conteo.
- **Comillas de `cmd`** → credenciales en URI sin espacios; nada de `if(...)`, `&`, `goto` en el `.cmd` (frágiles).
- **Doble-clic** cierra la consola al instante → probar siempre desde un `cmd` abierto.
- **VNC sin copy-paste** → tipear a mano; que Notepad no guarde `.cmd` como `.txt`.

---

## 4. Comandos rápidos de verificación

```bash
# Estado global de rutas en el runner
psql "postgresql://postgres:superoot@192.168.0.249:5433/kepler_consolidado" \
  -c "select sucursal, count(*), min(fecha), max(fecha) from mart.ventas where sucursal ilike 'ruta%' group by 1 order by 1"

# En una laptop de camioneta: ¿la tarea corre bien?
schtasks /Query /TN RutaNN /V /FO LIST | findstr /I "resultado ejecución"
type C:\KeplerPush\push_ruta_NN.log
```
