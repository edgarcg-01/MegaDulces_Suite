# Almacén › Inventario físico (conteo cíclico y total)

Pantallas: `/almacen/inventory/sessions` (folios), `/almacen/inventory/sessions/:id` (detalle del
supervisor), `/almacen/inventory/sessions/:id/teams` (equipo), `/almacen/inventory/count` (el contador),
`/almacen/inventory/abc` (clasificación), `/almacen/inventory/diferencias` (descuadre del físico de Kepler),
`/almacen/inventory/ira` (exactitud). El código vive en `apps/view/src/app/modules/comercial/pages/`, que es la carpeta, no la URL.

API: `/api/commercial/inventory/counts/*` · Backend: [`libs/commercial/src/lib/commercial-inventory/`](../../libs/commercial/src/lib/commercial-inventory/)

> **Medido en producción el 2026-11-25** (sólo lectura, `system_identifier` 7688376744939610156). Las cifras de
> este documento son de ese día; si lo que ves no coincide, **gana la base**, y se corrige acá.

---

## 1. Qué es, y qué NO es

Modela «hacer inventario» como una **sesión digital con conteo ciego**: el almacén se cuenta contra un teórico
fotografiado al abrir el folio, dos personas distintas cuentan lo mismo sin verse, las diferencias se resuelven con
un motivo, y el cierre produce un **archivo para capturar en Kepler**.

⛔ **No escribe en el ERP.** Kepler es el sistema de registro de la existencia (ADR-040). La Suite cuenta, arbitra y
emite; alguien captura allá. Lo que hoy escribe la reconciliación es `commercial.stock`, **que desde el 2026-11-25
está congelada** (`[CANON.7.5]`): ver §9, es el defecto abierto más importante del módulo.

⛔ **No es el inventario físico de la empresa.** Ése lo sigue haciendo Kepler por trimestre, a mano. La Suite lo
**muestra** (pantalla «Diferencias», sobre `analytics.mv_erp_physical_count_variance`), no lo ejecuta.

---

## 2. Estado real: el módulo está construido y el proceso no ocurre

| Qué | Medido el 2026-11-25 |
|---|---|
| Folios creados en toda la historia | **6**, todos entre el 15 y el 19 de junio de 2026 |
| Estado de esos folios | **los 6 `cancelled`** |
| Renglones sembrados para contar | 18,845 |
| Renglones efectivamente contados | **7** (0.04 %), por 2 superadmins |
| Folios reconciliados | **0** |
| Archivos emitidos a Kepler | **0** (`inventory_kepler_exports` vacía) |
| Sesiones de conteo / interrupciones / escaneos | 7 · 13 · 8 |
| Asignaciones de equipo | 18 |
| Generador automático de folios cíclicos | **apagado** (`ENABLE_CYCLE_COUNT_CRON` no está en `true`) |
| Último inventario físico real de la empresa | **septiembre de 2026**, hecho en Kepler: 12,747 renglones, 8 sucursales, $27.7 M contados |

**La causa está diagnosticada** (`[CNT.1]`): un folio completo exige contar **todos** sus SKUs para poder cerrarse
—el *coverage guard*, que es correcto: un no-contado jamás se trata como cero—, pero **sólo se enteraba de que no
podía cerrar quien apretaba el botón al final**, con 3,664 SKUs ya contados o abandonados. Por eso existe el folio
cíclico acotado y por eso `getProgress()` ahora avisa antes. Lo que faltaba no era el mecanismo: era decirlo a tiempo.

---

## 3. Las piezas

Todas en `commercial.*`, todas con **RLS forzada** (`relforcerowsecurity = true`).

| Tabla | Filas hoy | Para qué |
|---|---:|---|
| `inventory_counts` | 6 | El folio: almacén, tipo, ritmo, estado, pase actual, banderas, valor de la varianza |
| `inventory_count_items` | 18,845 | Un renglón por producto: teórico, hasta 3 conteos con su autor y hora, final, varianza, motivo, unidad |
| `inventory_count_assignments` | 18 | Quién cuenta y quién supervisa, opcionalmente por pasillo |
| `inventory_count_sessions` | 7 | Cada turno de cada contador en cada pase (entrada y salida) |
| `inventory_count_interruptions` | 13 | Cuándo alguien dejó el conteo y cuándo volvió |
| `inventory_count_scan_log` | 8 | Idempotencia del escaneo: repetir un scan no vuelve a contar |
| `inventory_count_sequences` | 1 | El folio correlativo por año (`INV-2026-00007`) |
| `inventory_kepler_exports` | 0 | El acuse: qué se exportó, quién lo capturó en Kepler y con qué folio |
| `inventory_investigations` | 1 | Expediente de una diferencia confirmada, con causa raíz |
| `inventory_monitoring` / `_counts` | 1 / 1 | Vigilancia intensiva de un SKU: varios conteos rápidos al día |
| `inventory_risk_index` | 0 | Índice de riesgo por producto (sin escritor vivo) |
| `abc_classification` | 33,732 | La clase A/B/C por almacén × producto, recalculada cada madrugada |

**Reglas que vive la base, no el código** (índices únicos y CHECK):

- `commercial_inv_counts_one_open_per_wh_ritmo` — **un folio vivo por (almacén, ritmo)**. Dos ritmos pueden coexistir;
  dos folios del mismo ritmo, no. La lista de estados «vivos» del servicio (`VIVOS`) **tiene que ser la misma** que la
  del índice: si se separan, el servicio deja pasar lo que la base rechaza y el error sale como violación de índice.
- `commercial_inv_items_count_product_unique` — un producto no se siembra dos veces en el mismo folio.
- `commercial_inv_session_unique` — una sesión por (folio, persona, pase).
- Estados del folio: `open · counting · review · ready_to_reconcile · reconciled · cancelled`.
- Estados del renglón: `pending · counted · discrepancy · resolved`.
- Roles de asignación: `counter · supervisor`.

---

## 4. El flujo, paso a paso

### 4.1 Abrir (`POST /counts/open`, permiso SUPERVISAR)

1. Valida que el almacén no tenga ya un folio vivo **de ese ritmo**, y que ningún SKU esté en otro folio vivo
   (si estuviera en dos, el segundo ajuste pisaría al primero).
2. **Elige la fuente del teórico**, en este orden: **ERP (ODS)** → `inventory.warehouse_stock` → `commercial.stock`.
   Con el ODS cubriendo las 9 sucursales, en la práctica siempre gana el ERP; las otras dos ramas son legado
   (ver §9).
3. Toma el folio correlativo y **fotografía el teórico** en `inventory_count_items`, estampando de la misma fila
   la cantidad y su unidad (`unit_factor`, `unit_source`) — la unidad se resuelve una vez, con testigo (ADR-057).
   ⚠️ `unit_source` puede quedar `NULL` y **se guarda NULL**: un factor inventado es peor que uno ausente.
4. El folio nace en `counting`.

Opciones: `freeze_movements` (congelar el almacén), `blind_double_count` (doble conteo ciego),
`recount_threshold_pct` (umbral de varianza que fuerza un tercer conteo), `product_ids` (folio cíclico acotado).

### 4.2 Armar el equipo (`POST /counts/:id/assignments`, permiso ASIGNAR)

Desde `[IC.27]` (Edgar, 2026-11-24) **la lista de contadores es universal**: cualquiera de las personas activas
internas, de otras sucursales y de oficinas, **promotoras incluidas**, elegidas una por una. El selector muestra
`Nombre — puesto · sucursal`, pone arriba a los del almacén que se cuenta y avisa quién ya está comprometido en otro
folio abierto.

⭐ **Y la asignación ES la llave**: asignar a alguien como contador le da el derecho a contar ESE folio mientras
viva, sin repartirle el permiso `CONTAR`. Sin eso, la lista universal era una trampa: de las 263 personas activas,
**90 son promotoras y ninguna tiene esa clave** — asignarlas las mandaba a un 403 (pasó en junio con dos
`promotor_ruta`). Ver §6.

### 4.3 Contar (`POST /counts/:id/count`, guard por clave **o** asignación)

- El contador abre su turno (`session/start`), que fija en qué **pase** trabaja.
- Escanea o busca el producto (`GET /counts/resolve`, por código de barras o id) y manda la cantidad.
- El servidor decide el casillero: `count_1` en el primer pase, `count_2` en el segundo.
  **Nadie pisa el conteo de otra persona** — sólo puede corregir el propio; si otro ya contó ese SKU en ese pase, el
  servidor responde 409 y pide un reconteo de desempate.
- Si el folio **no** está congelado, al primer conteo se fotografía el saldo en libros (`book_at_count`): así las
  ventas ocurridas durante el conteo no se borran al reconciliar.
- `scan_uuid` hace el envío idempotente: repetir el mismo escaneo (reintento del teléfono, pérdida de red) no cuenta
  dos veces.
- Las ausencias se registran (`POST /counts/:id/interruption`): cuándo se fue y cuándo volvió.

⛔ **El contador nunca ve el teórico ni la varianza.** `GET /counts/:id/catalog` y `count-progress` devuelven sólo lo
que necesita para contar; el teórico vive en `GET /counts/:id/items`, que exige SUPERVISAR.

### 4.4 Segundo pase y discrepancias

- `POST /counts/:id/advance-pass` (SUPERVISAR) mueve al pase 2 si el folio es de doble conteo ciego; si no, pasa a
  `review`.
- `POST /counts/:id/compute` (SUPERVISAR) compara: donde los dos conteos coinciden, el renglón queda `resolved` con
  su `final_qty`; donde difieren, queda `discrepancy`. El folio pasa a `review`.
- `POST /counts/:id/items/:itemId/resolve` (SUPERVISAR) fija el valor final de una discrepancia **con su motivo**
  (`reason_code`).

### 4.5 Cerrar (`POST /counts/:id/reconcile`, permiso RECONCILIAR)

Antes de tocar nada, cuatro bloqueos —los mismos que `getProgress()` muestra al supervisor, **una sola definición**
(`bloqueosParaReconciliar`), para que la pantalla no diga «listo» y el botón conteste 409:

1. **Sin contar**: cualquier SKU sin un solo conteo. *Un no-contado NO se trata como cero.*
2. **Discrepancias** sin resolver.
3. **Sin valor final**.
4. **Varianza material sin motivo** (sólo si el folio definió umbral).

Más dos guardas de validez y autoridad:

- **Integridad del congelado**: si el folio se abrió congelado y hubo movimientos de esos productos desde entonces,
  se bloquea — un set absoluto borraría esas ventas y atribuiría mal la varianza.
- **Segregación de funciones**: quien contó o resolvió un renglón **no puede autorizar el cierre**.

Si todo pasa: congela el costo unitario de cada renglón (del resolvedor único, al grano almacén × producto; `null`
si no se pudo valuar, nunca cero), escribe el ajuste y los movimientos, y marca el folio `reconciled` con su
varianza neta y absoluta.

### 4.6 Exportar a Kepler (`GET /counts/:id/kepler-export`, permiso RECONCILIAR)

Devuelve, por cada renglón con varianza distinta de cero: SKU, nombre, unidad, contado, teórico, diferencia, el tipo
de documento que le toca en Kepler (`InvIn` si sobra, `InvOut` si falta), la cantidad a ajustar y su valor; más un
resumen de merma, sobrante y neto. Quien lo captura en el ERP confirma con
`POST /counts/:id/kepler-export/ack`, que guarda el folio de Kepler y cierra el circuito.

**Hoy ese acuse no tiene una sola fila**: el circuito nunca se cerró.

---

## 5. Los seis controles que lo hacen auditable

1. **Conteo ciego** — el que cuenta nunca recibe el teórico.
2. **Doble conteo por personas distintas** — `count_2` lo hace alguien que no hizo `count_1`.
3. **Segregación de funciones** — el que cuenta no cierra.
4. **Coverage guard** — no se cierra con SKUs sin contar.
5. **Idempotencia del escaneo** — el mismo scan no cuenta dos veces.
6. **Trazabilidad del turno** — sesiones e interrupciones dicen quién contó qué y cuándo se ausentó.

---

## 6. Quién puede qué

| Permiso | Para qué | Roles | Personas |
|---|---|---:|---:|
| `COMMERCIAL_INVENTORY_VER` | ver folios | 11 | 51 |
| `COMMERCIAL_INVENTORY_SUPERVISAR` | abrir, ver el teórico, resolver | 5 | 21 |
| `COMMERCIAL_INVENTORY_ASIGNAR` | armar el equipo | 6 | 38 |
| `COMMERCIAL_INVENTORY_CONTAR` | contar sin estar asignado | 6 | 31 |
| `COMMERCIAL_INVENTORY_RECONCILIAR` | cerrar y exportar | 4 | 17 |
| `COMMERCIAL_INVENTORY_CANCELAR_CONTEO` | abandonar un folio | 6 | 31 |

⭐ **`[IC.27]` — la asignación es la llave.** Las 8 rutas del contador (`mine`, `resolve`, `:id/count`,
`count-progress`, `catalog`, `session/start`, `session/finish`, `interruption`) no piden la clave con
`@RequirePermissions`: llevan `@UseGuards(ContarOAsignadoGuard)`, que deja pasar a quien **trae la clave** o a quien
**está asignado como contador a ese folio vivo**. El permiso se apaga solo cuando el folio cierra: no quedan
permisos residuales.

⛔ Lo que **no** cambió: `:id/items` (el teórico) sigue exigiendo SUPERVISAR, con candado que lo verifica. El conteo
ciego es el control central del módulo.

---

## 7. El conteo cíclico (ABC)

La clasificación ABC por **valor de consumo anualizado** (demanda diaria × 365 × costo unitario), con Pareto por
almacén: A hasta el 80 % del valor acumulado, B hasta 95 %, C el resto. Hoy en prod: **4,928 A · 7,005 B · 21,799 C**,
recalculada automáticamente cada madrugada a las 3:30.

La cadencia por clase (A cada 30 días, B cada 90, C cada 365) alimenta `GET /inventory/abc/cycle-due`: qué toca
contar hoy. El scheduler diario de las 2:00 abriría un folio cíclico acotado por almacén con lo vencido, **pero está
gateado por `ENABLE_CYCLE_COUNT_CRON` y hoy no corre**: auto-crear folios es opt-in deliberado.

⚠️ La historia de esta clase importa: hasta septiembre la demanda salía de `commercial.orders` —la tabla de pedidos
de la plataforma, con **2 órdenes en toda su historia**— y producía *2 filas clase A, 56,002 clase C con valor cero y
ninguna B*. Un Pareto siempre produce B: ése era el delator. Hoy sale de la **misma** demanda que usa el punto de
reorden, y el recompute **se aborta si la fuente viene vacía** en vez de publicar «todo es C».

---

## 8. Alrededor: lo que no es conteo pero vive en el mismo módulo

- **Descuadre del físico de Kepler** (`/almacen/inventory/diferencias`): el trimestral del ERP, con su cobertura y el peldaño
  del costo declarado fila por fila. Es la única medición de exactitud que hoy existe de verdad.
- **IRA** (`/almacen/inventory/ira`): exactitud del registro **sobre folios reconciliados**. ⚠️ Con cero folios cerrados,
  esta pantalla mide el vacío — y lo declara en vez de dibujar un 100 %.
- **Investigación de diferencias**: expediente con línea de tiempo del SKU y causa raíz (9 códigos).
- **Monitoreo intensivo**: varios conteos rápidos al día sobre un SKU sospechoso, acotando la pérdida a una ventana
  de horas. Desde `[CANON.7.4d]` su teórico sale del ODS.

---

## 9. Deuda y defectos conocidos

**⛔ El ajuste cae en una tabla congelada (abierto desde el 2026-11-25).** `reconcile()` escribe en
`commercial.stock` y en `inventory.warehouse_stock`. La primera quedó congelada al retirar su importer
(`[CANON.7.5]`); la segunda lleva congelada desde el 15 de junio. **Si hoy alguien cerrara un folio, el ajuste no se
vería en ninguna pantalla.** La decisión ya está firmada (**D-EX8**, Edgar 2026-11-25): el conteo se repunta al ODS
—teórico y ajuste— y el ajuste sale como archivo para Kepler. Hasta que eso se construya, **el módulo no debe
encenderse**.

**El avance del listado miente en el segundo pase.** La lista de folios calcula el progreso con `count_1`, mientras
el detalle usa el pase activo. En un doble conteo ciego, la lista muestra 100 % cuando el segundo pase apenas empieza.

**Sin alcance por sucursal.** El aislamiento es por tenant (RLS); nada impide que un supervisor de una plaza abra o
mire el folio de otra. Con la lista universal de `[IC.27]` esto importa más que antes.

**El selector de almacén ofrece 18 bodegas de ruta y duplicados**, no sólo las 9 sucursales reales.

**Dos fuentes para el mismo permiso** en la pantalla de folios: lee `auth.user()?.permissions` en un lado y
`PermissionsService` en otro. Una degradación de permisos puede tardar en surtir efecto en una de las dos.

**La lista no filtra los cancelados**, así que hoy muestra seis folios muertos y nada más.

**`inventory.warehouse_stock` como fuente de teórico**: 7,742 filas congeladas desde junio, y 4 de los 6 folios la
usaron. Esa rama debe retirarse con el resto de `[CANON.7.4d]`.

---

## 10. Cómo se prueba

- **Pruebas de unidad y candados** (vitest, `libs/commercial`): `inventory-count.asignar.spec.ts`,
  `.cancelar.spec.ts`, `.ciclico.spec.ts`, `contar-o-asignado.guard.spec.ts` (24 casos, incluye el candado que
  verifica qué rutas llevan el guard y cuáles NO), `existencia-ods-lectores.spec.ts`.
- **Contra Postgres real** (regla 13: un camino que escribe no está probado hasta ejercerlo contra una base real):
  `inventory-monitoring.it.spec.ts` con `TP_IT_DB` apuntando a una base **local**. El patrón: sembrar `kepler_ods.kdil`
  y dejar la copia **mintiendo a propósito**, para que la prueba distinga de qué fuente salió el número.
- **Smoke de base** (`database/tests/`): `test-newdb-inventory-count.js`, `-segregation.js`, `-ritmo.js`,
  `-theoretical-source.js`, `-monitoring.js`, `-investigation.js`, `-variance.js`.

⚠️ Y una advertencia que ya costó caro: una prueba que **copia la consulta en su propio SQL** (un *mirror*) se
comprueba a sí misma y sigue verde describiendo la forma vieja. Si tocás un camino, ejercé el servicio real.

---

## 11. Mapa de archivos

| Archivo | Qué tiene |
|---|---|
| `inventory-count.service.ts` | El motor: abrir, contar, discrepancias, reconciliar, exportar, cancelar, sesiones |
| `inventory-count.controller.ts` | Las 29 rutas con sus permisos |
| `contar-o-asignado.guard.ts` | `[IC.27]` la llave por asignación |
| `inventory-count-plan.service.ts` | El plan del folio cíclico |
| `cycle-count-scheduler.service.ts` | Cron 2:00 (folios cíclicos, apagado) y 3:30 (recompute ABC, siempre) |
| `inventory-abc.service.ts` | Clasificación ABC y cadencia |
| `inventory-variance.service.ts` | Descuadre del físico trimestral de Kepler |
| `inventory-investigation.service.ts` | Expedientes de diferencia |
| `inventory-monitoring.service.ts` | Vigilancia intensiva de un SKU |
| `inventory-monitor.gateway.ts` | Avance en vivo por WebSocket |
| `stock-state.ts` | La existencia del ODS y el apartado derivado — **la fuente de la que todo esto debe leer** |

Fases relacionadas: `FASE_IC_RITMOS_Y_ABC.md` · `FASE_ABC_CYCLE_COUNT.md` ·
`FASE_CANON_ANEXO_EXISTENCIA_Y_LO_QUE_SALE_DEL_ODS_2026-11-18.md` (de dónde sale la existencia).
