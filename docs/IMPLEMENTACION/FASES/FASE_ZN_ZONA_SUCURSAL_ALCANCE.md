# Fase ZN — Zona, sucursal y ruta: normalizar para que cada quien vea lo suyo

> **Estado:** 🔨 ZN.0 en código (2026-09-23) · **ZN.6 en código (2026-09-30)** · ZN.1–ZN.5 planeados
>
> ⚠️ **Las cifras de §2 son del 2026-09-23 y envejecieron.** La re-medición del 2026-09-30 está en
> §11, y una de ellas **corrige un diagnóstico de este mismo documento**. Leer §11 antes que §2.
> **Pedido del lead (2026-09-23):** *«hay que normalizar esto, para que se respete que el usuario
> solo vea lo de su zona o sus sucursales asignadas. Debemos eliminar todo lo que esté hardcodeado
> y separar por sucursal.»*
> **ADR:** propuesto — ver §9.

---

## 1. La tesis

**Zona, sucursal y ruta son tres niveles de un mismo árbol, y la actividad de la persona decide a
cuál se ancla.** Hoy los tres viven en la misma tabla (`trade.zones`, 9 filas) y toda persona apunta
ahí, sea de ruta, de sucursal o de oficina. De ese colapso salen el resto de los defectos: el
alcance no puede filtrar, los selectores ofrecen la red completa a todo el mundo, y el tablero de
dirección agrupa mal.

```
ZONA (3)   La Piedad · Zamora · Morelia          ← kepler_ods.kduk + warehouses.purchase_zone
  └── SUCURSAL (8 + CEDIS)  PH LPA 8ES YU │ DAMASO CAN │ MM MA
        └── RUTA (18)       21…28, 1V00x │ 501…505 │ 321, 322

PERSONA → su ACTIVIDAD (identity.departments) decide su ancla:
    tienda / cajas        → SUCURSAL      (la zona se deriva)
    ruta directa/vecinal  → RUTA          (sucursal y zona se derivan)
    oficina               → SEDE          (ninguna zona; no suma a la venta de ninguna plaza)
```

⭐ **Nada de esto se inventa.** Las 3 zonas ya están declaradas en dos fuentes vivas e
independientes, y coinciden:

| Fuente | Qué dice |
|---|---|
| `kepler_ods.kduk` (catálogo del ERP, replicado en las 9 sucursales) | `ZONA LA PIEDAD` · `ZONA MORELIA` · `ZONA ZAMORA` (dos numeraciones: `01/02/03` y `10000/20000/30000`), 13,836 clientes clasificados |
| `commercial.warehouses.purchase_zone` | La Piedad (01,02,03,04) · Zamora (05,06) · Morelia (07,08) · Corporativo (00) |

---

## 2. Lo que está roto, medido en prod (2026-09-23)

### 2.1 `trade.zones` mezcla cuatro niveles

| Nivel | Filas |
|---|---|
| zona real | `LA PIEDAD RD`, `ZAMORA` — y **falta MORELIA** |
| sucursal | `YURECUARO`, `CANINDO`, `MORELIA MADERO`, `MORELIA ABASTOS` |
| canal | `LA PIEDAD VECINAL`, `ZAMORA VECINAL` |
| actividad | `OFICINAS` |

### 2.2 La persona se ancla al catálogo equivocado

**26 personas de tres sucursales distintas comparten la misma etiqueta**, que además es la zona de
*ruta*:

| Zona declarada | Sucursal real | Personas |
|---|---|---|
| LA PIEDAD RD | 8ESQ | 10 |
| LA PIEDAD RD | Padre Hidalgo | 10 |
| LA PIEDAD RD | La Piedad Abastos | 6 |

Y el dato que **sí** le toca a cada actividad falta justo donde importa:

| Actividad | Personas | Con sucursal | Con ruta | Con zona |
|---|---|---|---|---|
| Tienda (tienda + cajas) | 42 | 38 | 1 | 41 |
| **Ruta** (RD + vecinal) | 34 | 2 | **17 (50 %)** | 34 |
| Oficina / otro | 46 | 5 | 0 | **31** ← una zona que no les aplica |

### 2.3 El tablero de dirección parte las zonas

`me-zona.ts` agrupa por `trade.zones`, así que muestra **6 agrupaciones donde el negocio tiene 3**:
Zamora partida en `ZAMORA` + `CANINDO`, Morelia en `MORELIA MADERO` + `MORELIA ABASTOS`. Venta de
ruta de 30 días, bien agrupada:

| Zona | Venta 30 d | Rutas |
|---|---|---|
| La Piedad | $4,737,256 | 21…28, 1V001-003, 1V004 |
| Zamora | $2,076,268 | 501…505 (cargan en CANINDO) |
| Morelia | $0 | 321, 322 sin venta en el período |

### 2.4 ⚠️ Corrección a un diagnóstico previo

Se reportó que las rutas `501…505` tenían «dos dueños en disputa». **No era una contradicción**: el
catálogo decía `ZAMORA` (la **zona**) y `v_route_zone` dice `CANINDO` (la **sucursal madre**), y
Canindo es sucursal *de* la zona Zamora. Las dos fuentes tenían razón; lo que no existía era el
nivel que las separa. El dinero no está mal asignado — está mal **agrupado**.

### 2.5 El hardcode que impide respetar el alcance

| Qué | Medido |
|---|---|
| Catálogo de sucursales **escrito a mano en el frontend** (`core/constants/store-branches.ts`) | importado por **14 componentes** → todos ofrecen las 9 sucursales a cualquiera |
| Controllers que reciben un parámetro de sucursal **sin que su módulo consulte el alcance** | **13** (contra 3 que sí) |
| Archivos que sí consultan `ScopeService` | **33** |
| Nombres de zona literales en código | 9 |
| Tiendas (`trade.stores`) sin zona | **717 de 1,603 (44.7 %)** |

⭐ El mecanismo de alcance **ya existe y está poblado** (`identity.role_scopes` 288 filas,
`identity.user_scopes` 46, y `GET /users/me/scope` ya devuelve las opciones que la persona puede
elegir). El problema no es que falte: es que **casi nadie lo consulta** y el catálogo que alimenta
los selectores está en el bundle del navegador.

---

## 3. ZN.0 — El cimiento declarativo ✅ en código

Aditivo, **no mueve ninguna pantalla**. Migración `20260923150000_zn0_zona_sucursal_normalizadas.js`:

- `trade.zones.kind` (`zona` | `sucursal` | `canal` | `oficina`) + `kind_motivo` — cada una de las 9
  filas queda clasificada **con su porqué escrito en la fila**.
- `trade.zones.code` — llave **estable** (`LP`/`ZAM`/`MOR`). Hoy la llave es el nombre, y el JWT
  viaja con el **nombre**: renombrar rompe (ya pasó con `rename_zone_nacional_to_oficinas`).
- Crea la zona **MORELIA**, la única de las tres que no existía.
- `analytics.v_branch_zone` — resolvedor único **sucursal → zona**, derivado de `purchase_zone`
  (vista, no tabla: regla principal del proyecto).
- **Gate**: exactamente 3 zonas por tenant, ninguna sucursal de la red sin zona, y el CEDIS
  declarado corporativo en vez de colgado de una plaza.

**No hace** (a propósito, porque mueven números en pantalla y necesitan su propio antes/después):
re-apuntar `warehouses.zone_id`, mover personas, borrar o renombrar filas.

Smoke: `database/tests/test-newdb-zn-zonas.js` — read-only (abre la sesión con
`default_transaction_read_only = on`, así que puede correr contra prod). Hoy: **4 ok / 0 fallos /
4 declarados** no medidos a la espera de la migración.

---

## 4. ZN.1 — La sucursal cuelga de su zona (mueve el tablero)

`commercial.warehouses.zone_id` hoy apunta a filas que son sucursales. Re-apuntarlo a la zona
canónica hace que el tablero de dirección pase de 6 agrupaciones a 3.

**Requisito:** medir el antes/después y avisar a Dirección. Es un cambio correcto y **visible**.
Orden obligatorio: ZN.0 aplicado → medición → ZN.1.

---

## 5. ZN.2 — El selector de sucursales sale del servidor, con el alcance aplicado

🔨 **En código (2026-09-23): el apartado Tienda.** El resto, pendiente.

### 5.1 Se midió antes de encender, y el riesgo que se temía no existe

Simulando la resolución real del alcance sobre las 122 personas activas:

| Qué vería si el selector respetara el alcance | Personas |
|---|---|
| 1 sucursal | 58 |
| 3 sucursales | 11 |
| 2 sucursales | 2 |
| Toda la red | 47 |
| **Nada** | **4** — 3 `externo` (portal B2B) + 1 `sistemas` con `none` explícito, o sea correctamente |

Ninguna persona de tienda, cajas, ruta o almacén se queda sin sucursal. **Se puede encender.**

### 5.2 ⛔ Pero apareció un dato roto que el fail-open venía tapando

`options` se intersecta con el universo vigente, y ahí saltaron **4 personas de ruta de Morelia
Madero** (`humberto_placencia`, `rdmad322`, `rvmad01`, `rvmad02`) con alcance `'32'` — la llave
**Wincaja** de Madero, que dejó de existir cuando migró su POS a Kepler como `'07'` y su almacén
`MD-32` quedó soft-deleted. Para ellas `me/scope` devuelve `options: []`.

⚠️ **Corrección del 2026-09-24:** la primera versión de esa migración llevaba el mapa
`'32'→'07'` **escrito a mano**. Está mal y el repo ya lo había pagado: `[SB.1]`
(mig `20260923120000`, del mismo día y con timestamp anterior) creó
`analytics.v_branch_erp_cutover` justamente porque ese corte vivía **copiado en tres
lugares y divergió**, dejando **$1,636,170.10** de Morelia Abastos invisibles. Ahora se
**deriva** de esa vista. ⭐ Y derivarlo trajo más: medido en `wincaja.branches`, **las 8
sucursales cambiaron de código al migrar de POS** (10→01 · 30→08 · 32→07 · 40→03 · 42→02 ·
44→04 · 50→06 · 54→05) — el mapa a mano cubría **2 de 8**.

Hoy no se nota **porque el front ignora el alcance**. El día que obedezca, se quedan sin su
sucursal. `store-branches.ts` ya había declarado el caso y lo dejó pendiente; la migración
`20260923160000` lo cierra por el lado del dato: **agrega `'07'` sin quitar `'32'`** (las dos llaves
son la misma sucursal en dos eras, y los feeds viejos siguen emitiendo la vieja), derivando la
reparación de las equivalencias de cutover en vez de una lista de nombres.

### 5.3 Lo hecho

- `tienda-state.service.ts`: `branchList` deja de ser el array del bundle y pasa a ser
  **alcance ∩ monitor** — el alcance dice *qué le toca*, `LIVE_MONITOR_BRANCHES` dice *qué puede
  mostrar esta pantalla* (el CEDIS no vende al público). Mientras `me/scope` no contesta la lista va
  **vacía**, no completa: rellenar «por las dudas» es el fail-open que esto cierra.
- Los 3 selectores del apartado (`live`, `branches`, `pace`) pasan a `computed`.
- Candado en el smoke: **ninguna persona activa con alcance que no resuelva**.

⚠️ **Orden de despliegue: la migración `20260923160000` va ANTES que este front.** Al revés, esas 4
personas ven el selector vacío.

### 5.4 Los 4 que faltaban ✅ (2026-09-23)

`NETWORK_BRANCHES` ya no alimenta ningún selector. De paso salió el primitivo que faltaba:

**`DataScopeService.misSucursales()`** — las sucursales del alcance como **signal**, con el tercer
estado. Existe porque cada pantalla se estaba escribiendo su propio `subscribe` + `signal` (el
apartado Tienda tenía el suyo, compras rellenaba con el bundle), y un primitivo copiado a mano en
cuatro lugares se desincroniza (ADR-056). `null` = todavía no contestó · `[]` = no te toca ninguna.

| Archivo | Qué cambió |
|---|---|
| `compras-entradas` · `-pendientes` · `-revision` | con alcance acotado manda el reporte; con `all` —o mientras carga— sale de `me/scope`, no del bundle. Antes `null` significaba **dos cosas** («ves todo» y «no cargó») con el mismo resultado en pantalla |
| `admin-users.component.ts` | **se retira el fallback**: en un ALTA no se filtra lo que uno ve, se decide dónde queda asignada otra persona, y una lista vieja no deja el diálogo «usable» — deja asignar una sucursal equivocada. Vacío es la respuesta honesta |
| `tienda-state.service.ts` | pasa a usar el primitivo compartido en vez de su `subscribe` propio |

`nx build view` OK (1.28 MB) · `vitest` de view **756 pasan**.

### 5.5 Deuda declarada: `branchName`

Los **13 archivos restantes** que importan `store-branches` usan sólo `branchName` (código →
nombre). No es un agujero de alcance —una etiqueta equivocada es cosmética— pero **ese mapa también
se desincroniza**: ya pasó con los cutovers de POS y con la forma de escribir «8 Esquinas» / `8ESQ`.
Queda con nombre: **ZN.2.5**, servir la etiqueta desde el mismo `me/scope` que ya trae `label`.

---

## 6. ZN.3 — Los endpoints que aceptan una sucursal por parámetro

### ⚠️ Corrección de una cifra publicada en este mismo documento

Este plan decía **«88 fail-open»**. Era **ruido de grep**: ese conteo agarraba
`(x.sucursal || '')`, concatenaciones SQL (`m.source_branch || '|' || ...`) y fallbacks de
etiqueta (`warehouse_name || warehouse_code`). El patrón real
(`user?.warehouse_code || query.warehouse_code`) aparece **7 veces y las 7 son comentarios que
documentan que ya se retiró** — `store.controller`, `store-arqueo.controller` y
`store-analytics.controller` ya lo migraron. El `41 módulos` que cita `scope.service.ts` es de
`[ID.2]` y también envejeció.

### Lo que SÍ falta, medido

**13 controllers** aceptan `sucursal`/`warehouse_code` por parámetro y ni ellos ni su carpeta
consultan el alcance; **3** sí. Que no lo consulten **no los hace fail-open por sí solo** — hay
casos legítimos (el verificador de precios es público por diseño; la contabilidad ContPAQi es
consolidada y no segmenta por sucursal, ADR-040). Se revisan **uno por uno**, priorizando
dinero y operación de sucursal:

| Prioridad | Controller |
|---|---|
| dinero | `finance/caja/cash-ledger` · `finance/expense-proofs` · `finance/customer-ledger` · `finance/budget/budget-expense` |
| operación | `commercial-receiving/receiving-session` · `commercial-replenishment` (×2) · `commercial-home-delivery` · `commercial-stockouts` |
| revisar si aplica | `commercial-labels` (kiosco) · `kp` (público por diseño) · `polizas` · `contabilidad-contpaqi` (consolidada) |

Cada uno migra con un smoke que ejerza el **caso negativo**: una persona con alcance acotado
pide la sucursal ajena por parámetro y **no la recibe**, con control positivo de que la propia
sí llega.

⚠️ Sin ZN.3, ZN.2 es **cosmético**: el desplegable muestra 2 sucursales pero la API sigue
contestando las 9 si alguien las pide a mano.

### ZN.3.1 — Faltantes de piso ✅ (2026-09-23)

`GET /faltantes/sucursal/:code` y `…/codigos-que-fallan` aceptaban **cualquier** código en la ruta.
Quien trabaja en Padre Hidalgo podía pedir `/sucursal/05` y leer lo reportado en Zamora.

`assertAlcanza()` corta con `ScopeService.canRead` **antes de la consulta**, y devuelve **403, no un
recorte silencioso**: la persona pidió una sucursal concreta, y contestarle con otra se leería como
« en Zamora no falta nada ».

Medido antes de encenderlo: las 17 personas con alcance acotado en esta familia son **todas `own` y
todas tienen `warehouse_code`** en su ficha — el alcance resuelve y nadie pierde su propia sucursal.

`floor-stockouts.scope.spec.ts` **6/6, con el rojo ejercido** (se anuló el `canRead` a propósito →
cayeron exactamente las 3 del corte y los 3 controles positivos siguieron verdes). El candado
central no es el 403: es que **`tk.run` no se llame**, o sea que el corte ocurra antes de tocar la
base.

⚠️ **La ESCRITURA (`POST /faltantes`) queda declarada, no cerrada.** El kiosco de mostrador
reporta en cinco segundos y con cuenta de dispositivo; poner un `canWrite` sin medir antes qué
alcance tienen esas cuentas puede matar el flujo de captura, que es la única fuente de este dato.
Va con su propia medición.

### ZN.3.2 — Reparto y Compras 360 ✅ (2026-09-23)

Salió el primitivo que faltaba: **`ScopeService.assertCanRead`**, el hermano de lectura de
`assertCanWrite`. Resolver el alcance, preguntar y lanzar el 403 con un mensaje útil eran tres
líneas a punto de copiarse en cuatro servicios — y el mensaje es lo primero que se degrada.

**Dos defectos distintos, dos primitivos distintos:**

| Caso | Primitivo | Por qué |
|---|---|---|
| pidió una sucursal concreta y no le toca | `assertCanRead` → **403** | contestarle con otra sería responder algo que no preguntó |
| **no pidió ninguna** | `intersect` → **lo suyo** | era el agujero de reparto: sin parámetro no se filtraba **nada** |

- **Reparto** (`listRiders`, `listDispatched`): filtraban sólo si venía el parámetro, así que la
  encargada de La Piedad Abastos veía los repartidores y despachos de **las nueve**.
- **Compras 360 / ajustes** (5 entradas): lo que se lee ahí es el **costo de compra** por sucursal
  — lo pagado al proveedor, los ajustes y las pólizas — y `COMPRAS_360_VER` lo tienen las **6
  encargadas de tienda** con alcance `own`.
- ⭐ En el constructor de consultas compartido, el alcance se aplica **incluso con
  `skipDim = 'sucursal'`**: ese parámetro existe para que un dropdown cuente las opciones de su
  propia dimensión sin filtrarse a sí mismo — omite el filtro del **usuario**, no el del alcance.
  Si se saltara, el desplegable listaría sucursales ajenas y al elegir una daría 403: ofrecer lo
  que no se puede abrir es el mismo defecto que ZN.2 cerró en el frontend.

`[]` **no es** `null`: `null` = alcance global (no se filtra) · `[]` = no le toca ninguna, y ese
vacío tiene que llegar al WHERE. Un `if (lista.length)` mal escrito ahí es fail-open, y el spec lo
vigila.

Specs **11/11** (`floor-stockouts` 6 + `home-dispatch` 5), los dos con el **rojo ejercido**.
`libs/commercial` completo: **143 pasan**. `api:typecheck` OK.

### ZN.3.3 — Compras / reabastecimiento ✅ (2026-09-24)

`commit d000103a` · 6 encargadas de tienda con alcance acotado tienen `COMPRAS_PEDIDO_VER`.

**El defecto.** Los 8 reportes de `/compras/pedido` —existencia crítica, sugerido, traspasos,
sobrestock, workbook, worklist, stock muerto y los KPIs— recortaban por almacén así:

```ts
const whIds = this.whIds(q);              // SÓLO parseaba el query param
if (whIds.length) b.whereIn('rp.warehouse_id', whIds);
```

O sea: **quien no mandaba el parámetro veía la red completa.** El permiso decía «puede abrir la
pantalla»; faltaba el otro eje, sobre qué filas (ADR-050).

**El puente que faltaba, y que ya estaba escrito.** El alcance de `warehouse` es un código de dos
dígitos, pero estas tablas guardan el **uuid** del almacén. Esa traducción ya existía **a mano** en
`commercial-bi-almacen.resolveWarehouseIds()` — correcta, bien comentada y sin dueño. Por ADR-056
(un primitivo copiado diverge), al aparecer el segundo consumidor sube a `libs/`:
`ScopeService.warehouseIds()`. `bi-almacen` ahora delega, así que no queda una segunda copia que
pueda desincronizarse. Escribirla de nuevo habría sido repetir exactamente el error de
`[ZN.2.0]` con el mapa de cutover.

**Los tres estados, y el del medio es el que siempre se pierde.**

| valor | significa | en SQL |
|---|---|---|
| `null` | no filtrar (alcance `all` y nadie pidió nada) | sin `WHERE` de almacén |
| `[...]` | esas sucursales | `IN (…)` |
| `[]` | **ninguna** | `whereIn(col, [])` · en crudo, `AND false` |

El patrón viejo colapsaba `[]` contra `null`: un alcance resuelto a cero almacenes se leía como
«todas». Por eso las llamadas quedaron `if (whIds)` y **no** `if (whIds.length)`, y en SQL crudo el
equivalente es un `false` explícito — un `IN ()` vacío no compila.

**El selector también recorta.** `/compras/filters` ofrecía las nueve sucursales. Al elegir una
ajena, el reporte —ya filtrado— devolvía vacío: una pantalla que ofrece una sucursal y después la
muestra en cero se lee como *«ahí no falta nada»*, que es peor que no ofrecerla.

**Se retira el último mapa escrito a mano de la pantalla.** Los atajos por zona de Existencia
Crítica estaban clavados en el bundle (`Bajío 01-04` · `Morelia MD-30,MD-32` · `Zamora 05,06` ·
`CEDIS 00`) y tenían los dos defectos de esta fase a la vez: **contradecían el modelo** (el negocio
tiene TRES zonas y el CEDIS no es una de ellas, `[ZN.0]`; «Bajío» no existe en ninguna fuente) y
**no respetaban el alcance** — un botón «Zamora» para quien sólo alcanza La Piedad. Ahora se
derivan de `w.purchase_zone`, que viaja en la misma respuesta que el backend ya recortó. Sin zona
declarada no se agrupa: la lista queda vacía a propósito en vez de inventar una agrupación.

**Prueba.** `replenishment.scope.spec.ts` 5/5 con el **rojo ejercido**: al restaurar
`if (whIds.length)` falla exactamente la aserción del alcance vacío y ninguna otra. Incluye el
**control negativo del control** (con `null` no debe filtrar), sin el cual «filtrar siempre»
pasaría las otras dos pruebas y dejaría ciego al comprador de red, que es quien más usa la
pantalla.

**⚠️ Lo que NO se midió, y por qué.**

* **El smoke HTTP contra API viva.** El spec corre con dobles y por lo tanto **no valida SQL**
  (`GOTCHAS §67`). Es la misma clase de hueco que en `[ID.37]` resultó ser justo donde estaba el
  defecto, así que se declara en vez de darlo por cubierto.
* **La re-medición de cuánta gente con alcance acotado tiene el permiso.** El `pg_hba.conf` de
  `.245` no admite a esta máquina (`no hay una línea … para «192.168.0.243»`). La cifra de 6 viene
  de la medición del 2026-09-23, no de hoy.

---

### ZN.3.3+ — Lo que sigue, priorizado por medición

| Controller | Personas con alcance acotado | Nota |
|---|---|---|
| `commercial-labels` | 17 | ⛔ **trabajo en vuelo de otra sesión** (`ETQ-CAMBIOS`, 3 commits) — no se toca hasta que baje. El daño ahí es real: la sucursal elige el **precio**, así que se puede imprimir la etiqueta de otra plaza |
| `commercial-home-delivery` | 9 | reparto |
| ~~`commercial-replenishment` · `purchase-adjustments`~~ | 6 | ✅ `[ZN.3.2]` + `[ZN.3.3]` |
| `receiving-session` | 0 con `COMMERCIAL_INVENTORY_RECIBIR` | el conteo alto venía de `COMMERCIAL_WAREHOUSES_GESTIONAR`: revisar cuál puerta importa |
| `expense-proofs` | 46 **con `CAPTURAR`**, 0 con `VER` | la bandeja con montos es corporativa; lo único expuesto es `proof-by-folio`, que devuelve estado, no dinero |
| `cash-ledger` · `customer-ledger` · `budget-expense` · `polizas` · `contabilidad-contpaqi` | **0** | su público es 100 % corporativo (`all`): encender el filtro no cambia nada hoy. Se hará por higiene, sin prisa |

⛔ Sin ZN.2 esto es invisible para el usuario; sin ZN.3, ZN.2 es cosmético. Van juntos, módulo por
módulo.

---

## 7. ZN.4 — El alta se adapta a la actividad

Hoy el formulario pide **Sucursal, Ruta y Zona a todo el mundo**
(`persona-detalle.component.ts`). Pasa a pedir lo que corresponde:

| Actividad | Pide | Deriva |
|---|---|---|
| tienda / cajas | sucursal | zona |
| ruta | ruta | sucursal y zona |
| oficina | sede | — |

Y la zona **deja de capturarse**: se deriva. Es lo que impide que vuelvan a aparecer 26 personas de
tres sucursales con la misma etiqueta.

---

## 8. ZN.5 — Cobertura

- Las **717 tiendas sin zona** se derivan de su ruta (resoluble una vez que existe ZN.0/ZN.1).
- Crosswalk cliente → zona para los dos catálogos del ERP (`01/02/03` y `10000/20000/30000`), con
  los **1,098 clientes sin zona** y las 13,197 filas de cartera en NULL **declarados**, no
  inventados.

---

## 9. Decisiones abiertas (bloquean ZN.4, no ZN.0–ZN.3)

1. **Las vecinales** — `LA PIEDAD VECINAL` / `ZAMORA VECINAL`: ¿son **canal** dentro de la zona (la
   vecinal de La Piedad es zona La Piedad, canal vecinal) o una unidad aparte con jefe y números
   propios? `[JZ.6]` ya observó que **no tienen ni un almacén** y que las rutas vecinales cuelgan
   de la sucursal madre, lo que apunta a *canal*. Falta confirmarlo con el negocio.
2. **Las sedes de oficina** — decidido que la gente de oficina registra **la sede donde se sienta**
   (lead, 2026-09-23), y que **no suma a la venta de ninguna zona**. Falta el catálogo: ¿cuántas
   sedes hay y cómo se llaman? Hoy 19 personas están en `OFICINAS` y 27 más repartidas.

---

## 10. Riesgos y orden

| Riesgo | Mitigación |
|---|---|
| ZN.1 cambia lo que ve Dirección (6 → 3 agrupaciones) | medir antes/después y avisar; es el objetivo, no un efecto colateral |
| ZN.3 puede **quitarle** datos a alguien que hoy ve de más | migrar por módulo, con prueba negativa y control positivo; el fail-open actual es el defecto, pero apagarlo de golpe en 88 lugares es un apagón |
| El JWT viaja con el **nombre** de la zona | `code` (ZN.0) es la condición para dejar de depender del nombre |
| `trade.zones` tiene filas que dejan de usarse | **no se borran**: se marcan con `kind` y se retiran de los selectores. Borrar exige autorización explícita |

**Orden:** ZN.0 → (medición) → ZN.1 → ZN.2 + ZN.3 por módulo → ZN.4 → ZN.5.

---

## 11. ZN.6 — El motor que lo fabricaba, y el editor que sólo podía quitar ✅ en código (2026-09-30)

Disparado por un reporte sobre una ficha concreta: *«¿por qué en zonas sólo aparece eso? es una
aberración nuestro funcionamiento de usuarios»*. Re-medido contra **prod real** (`pg-prod` en `md`,
`system_identifier 7688376744939610156`, lectura sola).

### 11.1 ⛔ Corrección a §2.2 y al ADR: la causa raíz no estaba nombrada

`[ZN.0]` clasificó el catálogo y declaró que **no movía a nadie**. Lo que no se vio es que había
algo **fabricando el defecto todos los días**: `derivarZona()` derivaba la zona de una persona
leyendo `commercial.warehouses.zone_id`, y **4 de sus 8 filas pobladas apuntan a una fila-sucursal**
(`04`→YURECUARO VECINAL, `06`→CANINDO, `07`→MORELIA MADERO, `08`→MORELIA ABASTOS).

O sea que **cada alta en esas cuatro plazas volvía a anclar a alguien a su propia sucursal
disfrazada de zona**. Limpiar sin cerrar esto era barrer con la canilla abierta — y explica por qué
la cifra de §2.2 no bajaba sola. El resolvedor correcto (`analytics.v_branch_zone`, creado por el
propio ZN.0) acierta **9 de 9** y **no lo consumía nadie**.

### 11.2 ⛔ Corrección a una afirmación del código: ruta → zona NO es una función

El docstring de `derivarZona` afirmaba: *«de las 15 rutas con tiendas cargadas, **ninguna cruza de
zona**. Es una función»*, y por eso tomaba la primera fila con un `.first()` **sin `ORDER BY`**.
Hoy es falso: **`Ruta Vecinal #1` tiene 742 tiendas en dos zonas** (58 en LA PIEDAD RD, 684 en
MORELIA MADERO), así que la zona salía **al azar** según el plan de ejecución.

⭐ `database/tests/test-newdb-scope-axis.js` **ya lo venía reportando en rojo**. La afirmación vivía
en un comentario, que no se pone rojo cuando deja de ser cierta.

### 11.3 El síntoma reportado: `optionsFor()` es un read-model usado como edit-model

`GET /users/:id/scope` → `describe()` → `optionsFor()`, que **recorta el universo por el modo del
propio sujeto**. Su docstring dice que es para el picker de `GET /users/me/scope` («¿por qué puedo
filtrar YO?»), y `/admin/personas` lo usaba como la lista de lo que un admin puede **otorgar**:

| modo del sujeto | opciones que veía el admin | efecto |
|---|---|---|
| `own` | **1**: la que ya tiene | sólo podía «otorgar» lo que ya tenía |
| `none` / sin regla | **`[]`** | *«el catálogo llegó vacío»* y Guardar apagado |
| `listed` | sólo las que ya tiene | **nunca podía AGREGAR** |
| `all` | el universo | el único caso que funcionaba |

⇒ **La pantalla de alcance sólo podía quitar, nunca dar.**

### 11.4 Cifras al 2026-09-30 (reemplazan las de §2)

| | |
|---|---|
| `trade.zones` vivas | **11** — 3 zonas · 4 sucursales · 2 canales · 1 oficina · **1 sin clasificar** (`LA PIEDAD MAYOREO`, nacida **después** de ZN.0) |
| Personas vivas | 136, de las que 113 tienen zona |
| …ancladas a una fila que **no** es zona | **54** (29 a una sucursal · 20 a OFICINAS · 5 a un canal) |
| Personas cuyo filtro **depende** de la zona | 90 |
| …cuyo filtro es **inválido** | **37** (34 por una fila que no es zona · 3 por zona vacía) |
| Tiendas | 1,603 — **717 sin zona (44.7 %)** y 228 colgadas de una fila-sucursal |
| Nadie apunta a la zona **MORELIA** | las 21 personas de Morelia apuntan a las dos filas-sucursal |

⚠️ **Las vecinales siguen sin decidirse** (§9.1) y eso ya cuesta: 5 personas y 1 ruta ancladas a un
`canal`.

### 11.5 Qué se entregó

**Capa A — cerrar la canilla** (sin efecto visible):

- `derivarZona()` deriva de `analytics.v_branch_zone` y exige **una sola zona real** por ruta; lo
  ambiguo **se declara**, no se adivina.
- `setScope` valida `values` contra el universo de la dimensión. ⛔ Antes aceptaba cualquier uuid:
  por ahí entró el alcance `zone: listed = OFICINAS` que motivó el reporte.
- `resolveZoneRef` pregunta por **presencia** (`!== undefined`), no por valor: elegir «Ninguna» ya
  desasigna. El comentario afirmaba que eso funcionaba y `null` es *falsy*.
- El alta adopta la precedencia de la edición (manda lo explícito). Eran **reglas opuestas** para el
  mismo campo, y en el alta la derivada pisaba la elección del admin sin aviso.

**Capa B — que el editor pueda dar**:

- `ScopeService.universeFor()` — el primitivo que faltaba. `describe()` ahora viaja con **tres**
  cosas distintas: `universe` (lo otorgable), `values` (lo guardado) y `options` (lo alcanzable).
- El universo de `zone` se acota a `kind='zona'`: **primer consumidor de `kind` desde que ZN.0 lo
  escribió**.
- Lo guardado que queda fuera del universo **se declara** (`valuesFueraDelUniverso`, y en «Dónde
  opera» la fila se conserva marcada con su `kind_motivo`). Recortar a secas habría dejado el
  selector en blanco para 54 personas, y un blanco se lee como «no tiene».
- `GET /users/zones` filtra `deleted_at` y devuelve `kind`.
- Los catálogos que no cargan se declaran en pantalla (eran 5 `error: () => set([])` mudos).

**⛔ Lo que el plan decía y la medición desaconsejó:** exigir `USUARIOS_VER` en `GET /users/zones`
para alinearlo con `/branches` y `/routes`. **115 de 136 personas no tienen ese permiso** (6 de 52
roles), y el endpoint lo consumen Seguimiento y Reportes: les habría apagado el filtro de zona a
casi toda la empresa para proteger una lista de tres nombres. Queda autenticado sin permiso, con el
motivo medido escrito en el controller.

**Candados:** `apps/view/.../zona-opciones.spec.ts` (11 casos, **rojo ejercido**: con el filtro
desactivado caen 10) y `database/tests/test-newdb-zn6-universo-alcance.js` (read-only contra prod,
**7 ok / 0 fallos / 1 declarado**, con control negativo — sin el filtro el universo pasa de 3 a 11).

### 11.6 Lo que ZN.6 **no** hace, a propósito

No mueve a nadie de zona ni toca `warehouses.zone_id`: eso es **ZN.1 + ZN.5**, mueve el tablero de
Dirección de 6 agrupaciones a 3 y necesita su propio antes/después. Las 37 personas quedan **medidas
y con nombre** en el bloque [6] del candado, que las reporta sin fallar.

**Decisión registrada (2026-09-30):** a la gente de oficina **la zona no le aplica** — su eje ya es
`red`, así que van a `zona_id = NULL` + regla explícita (`all`/`none`). Medido: **13 de esos 20 ya
están en `all`**, o sea que quitarles el valor engañoso no les cambia lo que ven.

---

## 12. ZN.7 — El selector de sucursal, una sola vez 🔨 en código (2026-10-01)

Pedido: *«todo lo que involucre ver una o más sucursales: hay que dar las opciones en el frontend,
para que hagamos dinámicos esos permisos»*.

### 12.1 ⛔ La regla que apareció midiendo, y que reordena el trabajo

**El selector y el endpoint tienen que ir juntos.** Un selector que respeta el alcance sobre un
endpoint que no lo respeta **no es medio arreglo: es una mentira nueva** — le recorta a la persona
lo que puede *pedir* mientras le sigue mostrando *todo*, y a quien no tiene regla le dice «Sin
sucursal asignada» encima de una tabla con las nueve.

Se descubrió al migrar `logistica/erp-trips-panel` y **se revirtió esa migración**: su controlador
(`erp-shipments.controller.ts`) toma `sucursal` crudo, sin `ScopeService`.

⇒ Sólo se migra una pantalla cuando **su endpoint ya aplica alcance**. El resto no es trabajo de
frontend: es ZN.3.

### 12.2 El censo (16 pantallas, 6 fuentes distintas)

| de dónde salen las opciones | pantallas | ¿respeta alcance? |
|---|---|---|
| `DataScopeService.misSucursales()` | `comercial-tickets` · `tienda-arqueo` · `compras-entradas{,-pendientes,-revision}` · `comercial-documentos` | ✅ |
| **`/api/sucursales` (PÚBLICO, del verificador)** | `tienda-verificador` · `tienda-etiquetas` · **`tienda-faltantes`** · **`tienda-retiros`** | ❌ |
| endpoint GX `analytics/expenses/sucursales` | `comercial-egresos` · `comercial-egreso-detalle` · `finanzas-solicitudes` | ❌ (su controller tiene **0** usos de scope) |
| **arreglo escrito a mano en el componente** | `logistica/erp-trips-panel` | ❌ y **viejo** |
| `STORE_BRANCHES` del bundle | `televenta-quote-new` | ❌ |
| endpoint propio | `anden` · `tienda-caducidades-expediente` · `compras-catalogo-reporte` | sin medir |

⚠️ **Corrección a §2.5 de este documento:** decía *«`store-branches.ts` importado por 14
componentes → todos ofrecen las 9 sucursales a cualquiera»*. Hoy es falso: **14 de los 16 sólo
importan `branchName()`**, que es una etiqueta, no una fuente de opciones. ZN.2 ya los había
migrado; lo que queda de ese archivo en ellos es la deuda `branchName` de §5.5.

⛔ El arreglo a mano de Logística lista **00–06**: desde esa pantalla **Morelia (07 y 08) no se
puede filtrar**, y dos opciones se llaman `"04"` y `"05"` a secas.

### 12.3 Antes de cerrar nada, a quién le cambia

| situación | personas |
|---|---|
| `own` **con** sucursal en su ficha → ve 1 | 47 |
| `all` → ve las 9 | 46 |
| `listed` → su lista | 32 |
| **sin regla → el selector queda vacío** | **6** |
| `none` a propósito → vacío | 4 |
| **`own` sin sucursal → vacío** | **1** |

Los **7** que quedarían con el selector vacío **ya no ven filas**: sin regla, `build()` resuelve
`none` y el `WHERE` sale en `false`. El picker no les quita nada — **deja de mentirles**.

Y en las dos pantallas migradas, **cero bloqueados**: los 31 de mostrador (`cajero` 18,
`encargado_tienda` 7, `auxiliar_tienda` 4, `verificador_precios` 2) tienen todos `warehouse_code`,
y `superadmin` resuelve por god-mode antes de consultar reglas.

### 12.4 Lo entregado

- **`shared/components/sucursal-picker`** — el primitivo. El idiom no se inventó: estaba bien
  resuelto en `comercial-tickets` y se subió tal cual, con sus **cuatro** estados (`null` ≠ `[]`,
  y *una sola sucursal es un hecho de la sesión, no un desplegable de una opción*). Más `unCodigo()`,
  que estrecha el valor a un código **en un solo lugar** en vez de un ternario por pantalla.
- **`tienda-faltantes`** y **`tienda-retiros`** migradas: sus endpoints **sí** aplican alcance
  (`floor-stockouts`, y `pos-line-voids` que directamente **responde 403** a una sucursal ajena).
  Antes ofrecían las nueve desde el catálogo **público**, así que una cajera de La Piedad podía
  reportar un faltante a nombre de Morelia, o pedir un retiro y comerse el 403 después del clic.
  La **preselección** (`?sucursal=NN` → la sucursal de la ficha) también se valida ahora contra el
  alcance: que la sucursal exista no alcanza.
- Candado `sucursal-picker.component.spec.ts` (8 casos, **rojo ejercido**: colapsando `null` en
  `[]` cae el primero, que es justo el contra-ejemplo).

### 12.5 Declarado, NO construido

| pantalla | qué falta primero |
|---|---|
| `logistica/erp-trips-panel` | alcance en `erp-shipments.controller` (hoy 0 usos). **Su lista a mano queda viva y vieja** |
| `comercial-egresos` · `egreso-detalle` · `finanzas-solicitudes` | alcance en `commercial-analytics.controller` — el dominio VG+GX entero lo ignora |
| `televenta-quote-new` | ningún `ScopeService` en televenta; su rol es `own` con 3 personas |
| `tienda-verificador` · `tienda-etiquetas` | **a propósito**: son kiosco de mostrador y el catálogo público es su fuente correcta — la sucursal ahí es la de la máquina, no la de la persona |
| `anden` · `caducidades-expediente` · `catalogo-reporte` | sin medir si su endpoint acota |

---

## 13. ZN.8 — El alcance puede variar por ÁREA 🚀 en prod (2026-10-01)

Pedido: *«Aide hace el pedido de TODAS las sucursales, ve reportes de ALGUNAS, y en otras sólo
quiere ver la zona Morelia. Es por eso que quiero darle ese dinamismo»*.

### 13.1 El modelo no lo expresaba — y la bitácora lo prueba

`identity.user_scopes` tenía PK `(tenant, user, dimension)`: **un valor por persona y dimensión,
igual en toda la app**. La única forma de ver más en un lado y menos en otro era mover esa
palanca. Su bitácora, medida:

| fecha | de | a |
|---|---|---|
| 09-15 | `all` | `listed ['30','07']` |
| 09-21 | `listed ['07','08']` | `all` |
| 09-30 17:27 | `all` | `own` |
| 09-30 18:49 | `own` | `listed ['07','08']` (`[ZN.6.1]`) |

**Cuatro cambios en quince días, cada uno arreglando una pantalla y rompiendo otra.** No era
descuido: faltaba un eje.

### 13.2 La decisión que se consultó: techo o vista

Son dos capas que se parecen y no son lo mismo —el **techo** (qué filas *puede* ver: seguridad,
fail-closed) y la **vista** (qué *mira* por default: comodidad)—. Se ofreció resolverlo con la
vista, que es mucho más barato. **El usuario eligió el techo: «no debe poder».** Esto es el techo.

### 13.3 Lo entregado

- `area varchar(40) NOT NULL DEFAULT '*'` en `user_scopes` y `role_scopes`, **dentro de la PK**.
  ⭐ **Aditiva:** las 46 reglas de usuario y 294 de rol quedaron en `'*'` — cero cambio de
  comportamiento hasta que alguien cree una excepción a propósito.
- Precedencia de cuatro escalones: `usuario+área` → `usuario+'*'` → `rol+área` → `rol+'*'` →
  fail-closed. ⚠️ **El usuario gana siempre al rol**, incluso su `'*'` contra un rol con área.
- `elegirRegla()` en `libs/contracts`, **pura y con candado** (12 casos): es la pieza que falla
  **en silencio** — si elige mal no hay excepción ni log, sólo alguien viendo de más o de menos.
- **El área la declara el SERVICIO** (una constante por archivo), no la URL. Deducirla del
  request en el CLS se rompe mudo en los crons y al renombrar un prefijo de ruta.
- Las áreas se **derivan** de `AUTHZ_TREE` (13 proyectos). Por módulo **no**: son 60+ y nadie
  mantiene una matriz de 129 personas × 6 dimensiones × 60 módulos.
- **La pantalla** (`persona-datos`): por dimensión, la regla general y debajo, subordinadas, las
  **excepciones por área** — agregar, ver con su motivo, y quitar. Es lo que convierte esto en
  algo que se configura desde `/admin/personas` en vez de por migración.

### 13.4 Lo que midió y corrigió el candado

⭐ **Me corrigió a mí:** escribí `'tienda'` como ejemplo de área dando por hecho que el id del
proyecto era su prefijo de ruta. Es **`pdv`** («Punto de Venta»); `/tienda` es la **ruta**. Ese
typo se habría guardado feliz y habría creado una excepción que **no aplica a ninguna pantalla**
— invisible, porque el resolvedor nunca la encuentra y cae al `'*'`. Por eso `setScope` valida
contra el árbol.

⚠️ **Dos trampas medidas:**

1. **El DDL no acepta parámetros ligados.** `ADD COLUMN … DEFAULT ?` revienta con *«bind message
   supplies 1 parameters, but prepared statement requires 0»* — misma familia que el `SET` que
   necesita `set_config` (GOTCHAS §67). El primer intento falló y rollbackeó limpio.
2. **El área va en la CLAVE del caché.** Sin eso, la primera pantalla que resuelva le sirve su
   alcance a las demás durante 30 s — síntoma intermitente, el peor de depurar. Y
   `invalidateUser` ahora barre **todas** las áreas: borrar sólo `tenant:user` dejaba vivas las
   demás, o sea que cambiar el alcance en Compras no se notaba **en Compras**.

### 13.5 En prod

Migraciones **650** y **651**. `[ZN.8.1]` es la primera excepción real y es la del pedido:

| Aide, dimensión `warehouse` | |
|---|---|
| en `compras` | `all` |
| en el resto (`'*'`) | `listed ['07','08']` |

⚠️ **Ensancha** lo que ve en Compras, así que no se infirió: sale de lo que el usuario describió
como su trabajo. Reversible con `down()`.

Candado `test-newdb-zn8-alcance-por-area.js` contra prod: **7 ok · 0 fallos · 1 declarado** (el
bloque que compara contra el árbol no corre dentro de `prod-api`, que no lleva el fuente TS).

### 13.6 Declarado, NO construido

- **El subconjunto de sucursales para los REPORTES** — el usuario lo iba a confirmar. Inventarlo
  sería dibujar una regla que nadie pidió, y una regla de alcance equivocada **no se ve**.
- **Las otras 22 clases** que consumen `warehouse` no declaran área, o sea resuelven `'*'`:
  idéntico a antes. Se migran cuando haga falta, no antes.
- **La capa de vista** (preferencia por pantalla, que sigue a la persona entre dispositivos). Hoy
  13 pantallas guardan filtros en `localStorage`, que es por navegador.
