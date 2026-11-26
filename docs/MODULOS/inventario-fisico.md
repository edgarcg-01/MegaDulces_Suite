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

⚠️ **A quién le tocó SUPERVISAR no se parece a quién hace un inventario** (rol por rol, prod, 2026-11-25). Lo
tienen `superadmin`, `supervisor`, `compras`, `gerente_compras` y **`marketing`**; **no** lo tienen `prevencion`
ni `prevencion_auxiliar`, que son el área cuyo oficio es justamente el descuadre de inventario, ni
`encargado_tienda`, que sí puede ASIGNAR pero no abrir. `almacenista` cuenta pero no asigna. Que Marketing pueda
abrir y congelar un almacén y Prevención no pueda ni mirar el teórico es un reparto que nadie decidió así: es
herencia de cuando el permiso se agrupaba por módulo. **Revisarlo es trabajo de `MATRIZ_ACCESOS.md`, no de código.**

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
y el ajuste sale como archivo para Kepler. Hasta que eso se construya, **el módulo no debe encenderse**.

⭐ **Lo que D-EX8 NO tiene que construir, medido el 2026-11-25: el teórico ya sale del ODS.** `openCount()` elige
fuente en este orden —ERP → `inventory` → `commercial`— y con cualquier almacén que tenga existencia en
`analytics.v_erp_stock_on_hand` gana la primera, que es el ODS; de ahí salen la cantidad **y** la unidad
(`display_box_factor`, `unit_source`) en la misma fila. Las otras dos ramas existen pero hoy ningún almacén las
alcanza. Así que D-EX8 es más chico de lo que parecía: **el ajuste, el guard de congelación y el retiro de esas dos
ramas muertas** — no el teórico.

**El avance del listado miente en el segundo pase.** La lista de folios calcula el progreso con `count_1`, mientras
el detalle usa el pase activo. En un doble conteo ciego, la lista muestra 100 % cuando el segundo pase apenas empieza.

**Sin alcance por sucursal.** El aislamiento es por tenant (RLS); nada impide que un supervisor de una plaza abra o
mire el folio de otra. Con la lista universal de `[IC.27]` esto importa más que antes.

**El selector de almacén ofrece 28 opciones y sólo 10 son lugares donde se puede contar** (prod, 2026-11-25):
CEDIS más las 9 sucursales. Las otras 18 son bodegas de camioneta, y **cinco rutas están dos veces** con códigos
distintos (`01-002`…`01-006` y `RUTA-22`…`RUTA-28`); además sigue vivo `MD-32`, que el propio código llama
«un almacén borrado». Quien abre un folio elige a ciegas entre 28 renglones de los que 18 no tienen anaquel.

**⛔⛔ «Congelar movimientos» congela la Suite, no el almacén (medido el 2026-11-25).** Es el defecto más caro
del módulo, porque el código **cree lo contrario**: `reconcile()` comenta que con el freeze *«el saldo no se movió
desde la apertura»* y por eso aplica un **set absoluto** del físico contado.

Lo que el freeze bloquea de verdad son tres caminos de la Suite —apartados de pedido, recepción y movimientos de
ubicación—, todos a través de `commercial.stock_movements`. Esa tabla tiene **102 filas en toda su historia**
(37 auditorías de recepción, 23 de pedidos, el resto entradas; última el 2026-11-17). Lo que **no** bloquea, y es
todo lo que mueve mercancía de verdad, es **la venta del POS y cualquier captura en Kepler**: la Suite no escribe
en Kepler y la sucursal sigue vendiendo con el folio abierto. Esos movimientos entran por el ODS, y el ODS no se
congela.

Consecuencia directa: el *freeze integrity guard* —el que debería frenar la reconciliación si hubo movimientos—
busca en `commercial.stock_movements`, así que **ve los apartados propios y es ciego a las ventas**. Puede
dispararse, pero no por lo que importa. Y como el teórico es una **foto del ODS** tomada al abrir, mientras se
cuenta la foto envejece sin que nada lo diga.

⭐ Entra al alcance de **D-EX8**: si el teórico sale del ODS, el testigo de «se movió» tiene que salir del ODS
también — comparar la existencia del ODS al abrir contra la del momento de reconciliar, por los SKUs del folio.
Mientras eso no exista, **un conteo total con freeze no debe cerrarse con set absoluto**; el camino relativo
contra `book_at_count` (el que ya usa el cíclico) es el único defendible.

**La lista no filtra los cancelados**, así que hoy muestra seis folios muertos y nada más.

**`inventory.warehouse_stock` como fuente de teórico**: 7,742 filas congeladas desde junio, y 4 de los 6 folios la
usaron. Esa rama debe retirarse con el resto de `[CANON.7.4d]`.

---

## 9b. Auditoría de `/almacen/inventory/sessions` (2026-11-25)

**Nivel de evidencia: B** (prod, sólo lectura) **y C** (fuente: el componente de 802 líneas y
`inventory-count.service.ts`). **Sin pantalla viva**: nada visual se afirma como medido. Quedan
**NO MEDIDOS** el recorrido con teclado, el foco al abrir y cerrar los diálogos, los objetivos
táctiles con `pointer: coarse`, `forced-colors` y el reflujo a 320 px.

### Lo que la pantalla hace bien, medido

- **Contraste: pasa entero, en claro y en oscuro.** Los diez colores de texto del componente se
  calcularon con un instrumento que arranca con su control (negro/blanco = 21.00, `#777` sobre
  blanco = 4.48). El más bajo es la barra de avance, 4.40 sobre el suelo de 3:1 para elementos
  no textuales. ⭐ Usa las variantes `-soft-fg` de cada tono, que es justo donde falla el resto
  del repo: `--warn-fg` como color de texto da **2.15** y aparece en 336 lugares; acá no está.
- **Declara su tope.** Si la lista llega a 200 avisa «tope de la lista, puede haber más». De 35
  servicios del repo con `limit`, sólo 2 traen señal de tope en el contrato; éste la suple a mano.
  No figura en `check-cifra-recorrible.deuda.json`: el Cruce 1 lo pasa limpio.
- **Dos ausencias distintas, no una** (ADR-056): «Sin conteos» (nadie escaneó nunca → lo arregla
  quien asigna) contra «Sin avanzar» (se frenó → lo arregla quien supervisa). Y `last_count_at`
  llega NULL y se pinta vacío: nunca se rellena con `started_at`, que inventaría actividad.
  Un folio sin renglones dice «Sin snapshot», no «0 %».
- **Doble clic cerrado**: los dos botones que escriben se apagan de forma síncrona en el primer
  clic. **Lote parcial honesto**: «Folio abierto, pero falló la asignación», no una falla total.
- **Fail-closed en el diálogo de asignar**: si no pudo leer lo ya asignado, cierra — porque
  `setAssignments` **reemplaza** la lista y un Guardar en blanco borraría al equipo.
- **Teclado**: la fila es operable con Enter y Espacio y hace **lo mismo** que el clic, a
  propósito, para no mandar a un 403 a quien sólo asigna. No figura en
  `check-keyboard-nav.deuda.json`.
- **La consulta**: 58 ms en frío, 5–8 ms en caliente, con el `LIMIT` dentro del CTE (sin eso, el
  LATERAL agregaba los ítems de todos los folios antes de recortar).

### Lo que hay que mejorar

⛔ **Las tres primeras ya están selladas como deuda declarada** en
`scripts/check-pantalla.deuda.json` desde el 2026-10-19 (`Q.1`, `§2`, `§9`). No son hallazgos
nuevos: son deuda que nadie pagó, y la compuerta las deja pasar por eso.

| Sev | Qué está mal | Qué cuesta | Regla |
|---|---|---|---|
| 🔴 | **Un error de lectura se pinta como «No hay folios».** `load()` falla → aviso efímero y la tabla muestra el vacío: *«No hay folios. Abre uno para empezar a contar.»* | Si había un folio congelando un almacén, desapareció de la vista y nadie sabe que hay que reintentar | `§2` matriz de estados (sellada) · VALORES §1 |
| 🔴 | **«Avance» mide sólo el primer pase.** `items_counted = COUNT(count_1 IS NOT NULL)`, y el doble conteo ciego viene **encendido por default** | La barra llega a 100 % con el segundo pase sin empezar; el detalle calcula otra cosa, así que la misma pregunta da dos respuestas (Cruce 5) | VALORES §1 rótulo ≠ celda |
| 🔴 | **Los dos diálogos descartan lo capturado con un clic afuera** (`dismissableMask`), sin preguntar | En el de asignar se pierden hasta 20 personas elegidas de una lista de 263 | VALORES §9 cambios sin guardar |
| 🟠 | **Quien ve la alarma no tiene el remedio.** La fila avisa «Sin conteos · Congelado»; cancelar existe (`POST :id/cancel`, 31 personas) y **sólo se ofrece en el detalle**, que pide SUPERVISAR | El encargado que sólo asigna ve el almacén congelado y no puede destrabarlo | VALORES §11 endpoints sin botón |
| 🟠 | **No dice de cuándo es lo que se ve.** Hay «Recargar» y ninguna edad del dato | Un folio que avanzó hace diez minutos se lee igual que uno de ayer | `§9` frescura (sellada) |
| 🟠 | **No abre con la respuesta**: la vista empieza por la rejilla, sin tira de indicadores | Lo primero que se ve son los seis folios cancelados | `Q.1` answer-first (sellada) |
| 🟠 | **La lista no filtra ni ordena**, aunque `listCounts` acepta `warehouse_id` y la pantalla nunca lo manda; los cancelados van mezclados con los vivos | Hoy inofensivo (6 folios, los 6 cancelados); el tope es 200 | VALORES §8 |
| 🟡 | **Las definiciones viven en un `title`**: qué significa «Congelado» y el detalle de cada alerta sólo existen con mouse. Y **«Sin snapshot» es jerga publicada como valor de celda** | Sin mouse, la fila más informativa es la menos legible | VALORES §2 ayuda de términos |
| 🟡 | **Cuatro blancos interactivos por renglón** (la fila, el enlace del folio, «Asignar», «Abrir»), y tres llevan al mismo lugar | Presupuesto: ≤ 3 compitiendo | VALORES §11 |
| 🟡 | **Cinco `font-size` literales** (`.7` a `.8rem`), ninguno de la escala `--fs-*`, todos por debajo del piso de 13 px de Operations | — | VALORES §4 |
| 🟡 | **Un color de respaldo escrito a mano** (`var(--text-muted, #78716c)`) en dos reglas, contra el comentario del propio archivo que lo prohíbe; en oscuro daría **3.69** | Sólo dispara si el token falta | VALORES §2 |

**Veredicto por capa:** 🔴 **Veracidad** (el error que se lee como vacío; el avance del primer
pase) · 🔴 **Formularios** (pierde trabajo capturado) · 🟠 Alcance y comprensión · 🟡 Jerarquía y
color. ⛔ Las tres 🔴 **bloquean** encender el módulo, y se suman a la razón de fondo de §9: el
ajuste todavía cae en una tabla congelada.

---

## 9c. Modos de falla: luz, red, servidor y el mundo real (2026-11-25)

Recorrido completo a pedido de Edgar. **Nivel B y C**; lo que exige ejercitar el camino contra una
base real va marcado **NO MEDIDO** — no se da por bueno.

### Lo que YA está resuelto, y bien

| Falla | Qué pasa hoy |
|---|---|
| **Se cae la red mientras se cuenta** | La pantalla del contador es **offline-first**: el escaneo se persiste en el navegador (Dexie) **antes** de intentar la red, el catálogo del folio se cachea al iniciar la jornada para resolver códigos sin señal, y un banner dice «sin conexión» y cuántos van pendientes, con botón de reintentar |
| **Se reenvía la cola dos veces** | Cada escaneo lleva un **UUID generado en el cliente**; el servidor guarda `inventory_count_scan_log` y un replay devuelve `duplicate: true` sin volver a aplicar. La verificación va **antes** de los guards, a propósito: un escaneo ya aplicado no se re-juzga porque el folio avanzó |
| **Se cierra o cancela el folio con escaneos en cola** | El servidor responde 409, el cliente los marca **descartados con su motivo** (no los reintenta en vano) y la pantalla del contador los lista. Se pierde el conteo, pero **se sabe cuál y por qué** |
| **Se va la luz del servidor a mitad de la reconciliación** | Todo el cierre corre en **una transacción**: o se aplica entero o no se aplica. El folio queda abierto y se reintenta |
| **Dos personas cuentan el mismo SKU** | Un renglón por producto (índice único) y tres ranuras de conteo; el segundo pase es otra ranura, no un pisotón |
| **Se cierra el navegador a media jornada** | La cola vive en el navegador, no en memoria: al volver a entrar sigue ahí |
| **Caduca la sesión** | El token dura 12 h, más que un turno. Y aunque caduque, lo capturado está en la cola local |

### Lo que NO está resuelto

| # | Falla | Qué pasa hoy | Severidad |
|---|---|---|---|
| 1 | **La sucursal sigue vendiendo durante el conteo** | «Congelar movimientos» no frena el POS ni Kepler — ver §9. El teórico es una foto del ODS que envejece mientras se cuenta, y el guard que debería detectarlo mira la tabla equivocada | 🔴 |
| 2 | **El teléfono se pierde, se formatea o se rompe** | La cola vive **sólo** en ese navegador. Lo contado y no subido se va con el aparato, y **el servidor nunca supo que existía**: no aparece como faltante en ningún lado. Hoy no hay forma de preguntar «¿cuántos escaneos hay sin subir, y en qué aparatos?» | 🔴 |
| 3 | **El ODS viene atrasado al abrir el folio** | `openCount` **no consulta la frescura del ODS** (`analytics.ods_branch_checks`) ni la declara. Si la ingesta de esa sucursal viene atrasada, el folio nace con un teórico viejo y toda la varianza sale corrida, sin un solo aviso | 🔴 |
| 4 | **La reconciliación no cabe en su tiempo** | `reconcile()` fija `statement_timeout = 60s` y recorre **renglón por renglón** (bloqueo, actualización, movimiento, estado). Un folio total de Padre Hidalgo son **4,819 SKUs** ≈ 19 mil sentencias en una sola transacción: el presupuesto queda en ~3 ms por sentencia. **NO MEDIDO** — nunca se reconcilió un folio en prod | 🔴 |
| 5 | ⭐ **El folio abandonado congela el almacén para siempre — y ya pasó** | `INV-2026-00009` congeló **Padre Hidalgo 101 días**, del 19-jun al 28-sep de 2026, con 8 escaneos sobre 2,094 artículos. Se destrabó recién cuando `cancel` se abrió a `CANCELAR_CONTEO`: hasta entonces abandonar exigía la misma llave que aplica el ajuste, y de las 5 personas del Andén **sólo 1** la tenía. No hay caducidad (ni la habrá: no usamos crons), y **quien ve el aviso no siempre puede cancelar** — `encargado_tienda` no tiene esa llave (§9b) | 🔴 |
| 6 | **El archivo para Kepler se genera y nadie lo captura** | `inventory_kepler_exports` está **vacía**: el lazo se cierra fuera del sistema y nada comprueba que el ajuste llegó al ERP. El mismo hueco que D-EX8 tiene que cerrar | 🟠 |
| 7 | **Falla la reconciliación a la mitad por un saldo reservado** | Los renglones bloqueados quedan como `discrepancy` con su nota y el resto se aplica. Está bien resuelto, pero **el resumen no dice cuántos quedaron fuera** de forma que se puedan reintentar seleccionados | 🟡 |

⭐ **Los tres primeros comparten causa**: el módulo trata la existencia como si fuera suya, y desde
`[CANON.7.5]` **no lo es** — vive en el ODS. Un conteo físico contra una fuente que la Suite no
controla necesita declarar **con qué foto se contó y de cuándo es**, y volver a mirarla al cerrar.
Eso es exactamente **D-EX8**, y por eso el módulo no debe encenderse antes.

---

## 9d. ⛔⛔ Lo medido EJERCIENDO el módulo en producción (2026-11-25)

> **Nivel de evidencia: A — pantalla viva**, con la suite de producción abierta en un navegador
> real, sesión iniciada, y cada afirmación verificada contra la respuesta de la API. No es lectura
> de código: es el módulo funcionando.
>
> **Qué se ejerció:** se abrió el folio **`INV-2026-00010`** en Padre Hidalgo (3,363 artículos),
> **con «Congelar movimientos» APAGADO** para no bloquear la operación en horario hábil (autorizado
> por Edgar). Se resolvió un artículo desde la pantalla del supervisor y se contó otro desde la
> pantalla del contador.
>
> ⚠️ **Alcance: sólo funcionalidad.** Lo de diseño, accesibilidad y carga visual queda fuera de esta
> sección por decisión de Edgar; vive en §9b.
>
> ⛔⛔ **CON QUÉ USUARIO.** Los defectos de lógica y captura (F1-F14) se ejercieron con **`superoot`,
> rol `superadmin`**. No dependen del permiso: un conteo que no se guarda no se guarda para nadie.
>
> **La capa de permisos SÍ se midió en vivo** (2026-11-25), entrando como una cuenta de rol
> **`almacenista`** asignada al folio. Resultado:

| Endpoint | almacenista | Correcto |
|---|---|:---:|
| `GET /counts` (lista) | **200** (7 filas) | ✅ |
| `GET /counts/:id/items` (**el teórico**) | **403** | ✅ |
| `GET /counts/:id/progress` (avance supervisor) | **403** | ✅ |
| `GET /counts/:id/catalog` (contador) | **200** (sin teórico) | ✅ |
| `GET /counts/:id/count-progress` | **200** | ✅ |
| `GET /counts/:id/assignments` · `assignable-users` · `kepler-export` · `interruptions` | **403** | ✅ |

> ⭐⭐ **El conteo ciego se sostiene en el SERVIDOR, no en la interfaz.** El almacenista recibe un
> **403** al pedir los items (que llevan el teórico) y su único acceso con datos —el catálogo del
> contador— no trae existencia. No hay camino desde su cuenta hasta el teórico. Ésa es la mejor
> noticia del módulo.
>
**También se midió en vivo `encargado_tienda`** (`monica_mejia`, suc 01 · `VER`+`AJUSTAR`+`ASIGNAR`):

| Endpoint | encargado | Correcto |
|---|---|:---:|
| `GET /counts` · `/progress` · `/assignments` · `assignable-users` | **200** | ✅ |
| `GET /counts/:id/items` (**el teórico**) | **403** | ✅ |
| `GET /catalog` · `/count-progress` (del contador) | **403** | ✅ |
| `GET /kepler-export` · `/interruptions` · `/sessions` | **403** | ✅ |

**Y `prevencion_auxiliar`** (`camila_verdines`, **un solo rol**, única llave `VER`): **403 en TODO
menos la lista de folios** — avance, items, catálogo, asignaciones, asignables, export,
interrupciones y sesiones. La API es impecable.

> ⛔ **Pero eso deja un hueco de negocio**: el área cuyo oficio ES el descuadre **no puede ver ni un
> dato del conteo** —ni avance, ni artículos, ni discrepancias, ni quién contó—. Sólo que el folio
> existe. Es coherente con §6, y ahora está medido en vivo.
>
> ⭐⭐ **LA API ACIERTA EN LOS TRES PERFILES MEDIDOS. LO QUE FALLA ES LA INTERFAZ.** El servidor
> protege bien el módulo —el teórico da 403 a almacenista, encargado y prevención—, pero la
> pantalla **no condiciona NI UN botón al permiso** (**F11**: hasta quien sólo mira ve «Reconciliar»
> verde y «Cancelar folio»), pinta el 403 como lista vacía (**F17**) y, lo peor, **lo convierte en
> ceros que se leen como un inventario cuadrado** (**F18**).
>
> **Sigue sin medirse en vivo**: `supervisor` y `marketing`. Y **F4** —si «Resolver item» le aparece
> a quien no tiene `SUPERVISAR`— **no se pudo comprobar en ninguno de los dos perfiles sin esa
> llave**, porque a ambos la tabla de artículos les llega vacía por el 403. Queda abierto.
>
> ⛔⛔ **HALLAZGO DE SEGURIDAD DE PLATAFORMA, NO DEL MÓDULO — a Dirección, no a este doc.** Al probar
> permisos se confirmó que al menos una cuenta sin estrenar entra con una contraseña por defecto
> trivial, sobre un dominio público. No es universal (una cuenta de cliente la rechazó), pero
> **mientras exista, arreglar los permisos del conteo no protege nada**. El detalle (qué cuenta, qué
> contraseña) **no se escribe acá: el repo es público.** Se trató verbalmente con Edgar el
> 2026-11-25.

### ✅ Asignar contadores: funciona

Se asignaron dos contadores desde la pantalla y quedaron en el servidor (`GET :id/assignments` los
devuelve). **Seleccionar es asignar**, sin paso de confirmación. ⚠️ El sistema **deja asignar a
cuentas que nunca entraron** sin aviso (ver F15), y asignar no restringe a los demás (ver F16).

### ⭐⭐ El hallazgo que explica todo lo demás: el catálogo duplicado rompe el conteo

> ⚠️ **Esta sección se reescribió el 2026-11-25 tras medir la base.** La primera versión decía que
> «el conteo no se escribe en el artículo». **El efecto es ése, pero el mecanismo es otro, y el
> mecanismo es lo que hay que arreglar.** Se deja dicho para que nadie persiga el defecto donde no
> está.

**El conteo SÍ se escribe — en un artículo NUEVO que él mismo crea, con teórico cero.**

El código actualiza el item correctamente (`patch.status = 'counted'` → `update` sobre
`inventory_count_items`). Lo que falla es **a cuál item le pega**:

1. El folio se siembra con el producto que **sí tiene SKU** (`eeaf8d47…`, sku `00203`).
2. El escáner resuelve el código con `GET /counts/resolve`, que devuelve **otra fila del catálogo
   para el mismo producto** — la que **no tiene SKU** (`39c7d7c4…`, mismo nombre
   `$330 NESTLE = GRATIS 1 LONCHERA`).
3. Los `product_id` no coinciden, así que el servicio **no encuentra el artículo en el folio y crea
   uno nuevo**, con `expected_qty = 0`.

**Medido en prod sobre `INV-2026-00010`:** el folio pasó de 3,363 a **3,364** artículos; el nuevo
tiene `count_1 = 3`, `expected_qty = 0`, `status = counted`; y el original `00203` quedó en
`count_1: null`, `status: pending`.

**Las cuatro consecuencias, en cadena:**

- El artículo original **nunca se cuenta** → el folio **no puede cerrarse jamás**.
- El total **crece con cada escaneo** → el 100 % se aleja a cada paso (ver **F2**).
- El renglón nuevo tiene **teórico 0**, así que todo lo contado es **sobrante puro**.
- Si llegara a reconciliarse, **sumaría existencia que no corresponde**.

⛔⛔ **El catálogo está duplicado**, y es lo que habilita el defecto. Medido en prod el 2026-11-25
sobre `public.products` (14,986 filas): **1,162 filas sin SKU**, **887 SKUs que aparecen en más de
una fila** y **1,017 nombres con más de un `product_id`**.

### ⭐⭐⭐ El camino SIN CONEXIÓN funciona bien y el camino normal está roto

Medido el 2026-11-26 en el mismo folio, contando un producto con la red cortada y reconectando:

| | conteo **online** | conteo **sin conexión** |
|---|---|---|
| Resuelve con | `GET /counts/resolve` → **catálogo GLOBAL** | `resolveLocal` → **catálogo DEL FOLIO** (caché de `/counts/:id/catalog`) |
| `product_id` | `39c7d7c4` | `a469892b` |
| **SKU** | **(vacío)** | **`00182`** ✅ |
| **teórico** | **0.000** ❌ | **19.000** ✅ |
| Efecto | **crea un renglón nuevo** | **llena el renglón correcto** |

⭐ **El modo degradado acierta y el modo normal falla**, porque la caché offline se arma con
`/counts/:id/catalog` —que trae los `product_id` **del folio**— mientras el endpoint online busca en
todo el catálogo y se topa con el duplicado.

> ⭐⭐ **EL ARREGLO ES CHICO Y ESTÁ IDENTIFICADO:** `GET /counts/resolve` **ni siquiera recibe el
> `count_id`** (su firma es `resolveProduct(barcode?, product_id?)`), así que **no puede acotar la
> búsqueda al folio**. Pasarle el folio y resolver contra sus artículos —exactamente lo que ya hace
> la caché offline— elimina F1 y F2 sin tocar el catálogo. **Limpiar los 887 SKUs duplicados sigue
> siendo necesario**, pero es otro frente y de otro dueño (Catálogo).

Eso explica lo que §2 ya había medido: **seis folios en toda la historia, los seis cancelados, siete
conteos en total**. ⛔ **No es que la gente no use el módulo: es que contar no avanza el folio, y
nadie había llegado a contar lo suficiente para verlo.**

> ⭐ El segundo camino de escritura falla aparte: **«Resolver item» sí fija el `final_qty` del
> artículo correcto, pero no cuenta como conteo** — la cobertura siguió en 0 %. Cerrar exige las dos
> cosas, así que tampoco por ahí se llega (ver **F3**).

### Los defectos, por severidad

> ⭐ **Qué se arregló y qué no vive en [`inventario-fisico-SOLUCION.md`](inventario-fisico-SOLUCION.md)**,
> por frentes. Esta tabla es el **hallazgo** y no cambia cuando el defecto se arregla: si una fila y
> el plan se contradicen, gana la fecha más nueva.

| # | Sev. | Defecto | Cómo se midió |
|---|:---:|---|---|
| **F1** | 🔴🔴 | **El conteo crea un artículo NUEVO con teórico 0 en vez de llenar el que existe** — porque el catálogo tiene el producto **dos veces** y el `resolve` del código de barras devuelve la fila **sin SKU**, mientras el folio se sembró con la que **sí lo tiene**. El artículo original queda `pending` para siempre → **el folio no puede cerrarse jamás**, y lo contado entra como **sobrante puro** (teórico 0). ⛔ **La causa raíz es del CATÁLOGO, no del inventario.** Ver la sección de arriba. | Base de prod: el item contado es `39c7d7c4…` (`expected_qty 0`, `count_1 3`, `counted`); el original `00203` es `eeaf8d47…` (`pending`). Los dos se llaman `$330 NESTLE = GRATIS 1 LONCHERA`. En `public.products` (14,986 filas): **1,162 sin SKU**, **887 SKUs repetidos**, **1,017 nombres con más de un `product_id`**. |
| **F2** | 🔴 | **El total del folio crece con cada escaneo** — consecuencia directa de **F1**: cada conteo agrega un renglón. **El 100 % es inalcanzable**: contando los 3,363 el folio terminaría con 6,726 y la barra se aleja a cada paso. | Antes de contar: `total: 3363`. Después de **un** conteo: `total: 3364, counted: 1, remaining: 3363`. Confirmado en la base: `count(*) = 3364`, de los cuales **1** tiene `count_1`. |
| **F3** | 🔴 | **«Resolver item» fija la cantidad final sin que exista ningún conteo, y no suma a la cobertura.** Tras resolver un artículo, la pantalla siguió diciendo «0 contados · 0.0 % · 0 discrepancias»; sólo bajó el renglón «sin valor final» (3363 → 3362). Quedan **dos verdades paralelas** sobre el mismo folio. ✅ **Acotado el 2026-11-26** por decisión de Edgar: `resolveItem()` ahora exige folio abierto, **C1** (y **C2** si el folio es ciego) y que el artículo esté **en discrepancia** —o ya resuelto, para poder corregirlo—. El freno va en el servicio, no en el botón. ⛔ Lo que NO se hizo, a propósito: **que resolver sume a la cobertura**. `coverage_pct` significa «cuánto se contó», y subirlo al resolver dejaría ver **100 % sin que nadie contara** — la enfermedad de F18. Con el freno nuevo el síntoma se va solo: resolver una discrepancia **baja «DISCREPANCIAS»** y achica la lista de lo que falta para cerrar. | Se resolvió el SKU `00135` con cantidad 4 contra un teórico de 5. |
| **F4** | 🔴 | **«Resolver item» está disponible desde el minuto cero y muestra el teórico.** En un folio con **doble conteo ciego activado**, el diálogo imprime `Teórico: 5.000` justo encima del campo de captura. El control que define al módulo tiene al lado una puerta que lo anula, y encima le sopla la respuesta a quien la usa. Debería aparecer sólo para artículos en discrepancia, después de C1 y C2. ✅ **Eso es exactamente lo que se implementó el 2026-11-26** (ver F3): el servicio lo exige y la pantalla ya no ofrece el botón antes. ⛔ **No es teórico: la puerta la tienen 21 personas y sólo 17 pueden cerrar el inventario** — hay más gente capaz de anular el control que de terminar el proceso. | Visible en el diálogo con 0 conteos registrados. `POST :id/items/:itemId/resolve` exige `COMMERCIAL_INVENTORY_SUPERVISAR`; medido en prod el 2026-11-25: SUPERVISAR 21 personas, RECONCILIAR 17. |
| **F5** | 🟠 | **`GET /counts/:id/items` se topa en 2,000 y no lo declara.** Devuelve un **array pelado**, sin `total` ni `has_more`: el front no podría avisar del tope ni queriendo. Con 3,363 artículos, **el supervisor no puede ver ni resolver 1,363**. Como la lista va ordenada por nombre, el corte cae en la letra **O**. | Medido sobre la respuesta real: 2,000 elementos exactos; iniciales presentes `$ * 1 2 3 4 5 6 7 A B C D E F G H I J K L M N O`; primero `$330 NESTLE…`, último `OBLEA FIGURA TIRA…`. |
| **F6** | 🟠 | **El artículo resuelto desaparece de la lista del supervisor**, y **no hay forma de revisar ni corregir lo ya resuelto**. ⚠️ **Corrige la primera versión de este renglón**, que explicaba mal el porqué: decía que la consulta «trae los primeros 2,000 **pendientes**» y que al resolver uno «sale del universo». **Falso: no se excluye nada.** `listItems` ordena `discrepancy → pending → el resto` y **corta en 2,000**; lo resuelto cae al final de la fila y **el tope se lo come**. O sea que **F6 y F5 son el mismo defecto con dos caras**, y en un folio de menos de 2,000 artículos F6 no pasaría. Leer esto como «la consulta filtra lo resuelto» manda a arreglar un `WHERE` que no existe. | Control: el SKU `00135` estaba en la respuesta anterior (era el primero, `final: null`); tras resolverlo **ya no aparece**, y el último pasó de `OBLEA ECONOMICA…` a `OBLEA FIGURA TIRA…`. La causa se midió el 2026-11-26 leyendo `listItems` en `inventory-count.service.ts`: `orderByRaw` por estado y `.limit(2000)`, **sin ningún filtro por `status`**. |
| **F7** | 🟠 | **Tras un código no reconocido, el foco salta a «Cantidad física».** Con un escáner de pistola —que manda Enter solo— el siguiente disparo entra **como cantidad**, y el operario mira la tarima, no la pantalla. | Se escaneó `NOEXISTE12345` (rechazo correcto) y el código siguiente `00203` cayó en Cantidad quedando **`203`**. El campo de código seguía con el código inválido. |
| **F8** | 🟠 | **Enfocar el campo de cantidad no selecciona lo que hay: corregir CONCATENA.** Quien quiera cambiar 75 por 3 termina con **753**. | Medido por instrumento: al enfocar, `selectionStart` y `selectionEnd` valen ambos la posición final. Se tecleó `3` sobre `75` → `753`. |
| **F9** | 🟠 | **Las flechas del teclado cambian la cantidad.** Quien se mueva por la lista con el teclado modifica el conteo en vez de bajar de fila, en silencio. | `5` + `ArrowDown` → `4`. |
| **F10** | 🟡 ⚠️ **MECANISMO NO CONFIRMADO** | **Tope mudo de 6 dígitos en la cantidad.** El campo es `type=text` con `min=0` y **`max` vacío**; a partir de `999,999` dejó de aceptar teclas **sin decir nada**. ⛔ **Al ir a arreglarlo, el 2026-11-26, el mecanismo no apareció y hay que decirlo.** En las dos pantallas el campo no tiene `max` **ni `maxlength`**, y en PrimeNG 22.1.4 todo lo que recorta depende de uno de esos dos (`validateValue` mira `max()`; `onInputKeyPress`, `insert`, `onPaste` y `spin` miran `maxlength()`): **sin ellos no hay nada en la librería que corte en seis dígitos**. La observación queda; la explicación, no. **No se arregló**: poner un tope «para declararlo» sería declarar un límite que no se estableció. | Se teclearon nueve dígitos (`999999999`) y quedó `999,999`. ⚠️ Falta re-medirlo **tecleando** en Chrome: PrimeNG cancela el `keypress` e inserta el carácter por su cuenta, así que un instrumento que escriba el valor de golpe (`fill`) recorre otro camino y pudo producir el recorte. |
| **F11** | 🔴 | **⭐ Cuanto MENOS permiso tenés, más habilitado se te ve el botón.** El estado de «Reconciliar» se calcula de los **bloqueos del folio**, no del permiso. Quien tiene `RECONCILIAR` recibe los datos, ve los 3,363 sin contar y **el botón le sale `disabled`** — correcto ✅. Quien **no** tiene permiso recibe **403 → ceros** (ver **F18**), así que **no hay bloqueos que calcular y el botón se le habilita**: una cuenta con sólo `VER` lo apretó, confirmó el diálogo y mandó el `POST` de verdad. La interfaz tampoco condiciona **«Cancelar folio»** ni los selectores de equipo. El servidor rechaza todo (defensa de fondo correcta ✅), así que no es agujero de seguridad: es que **la pantalla ofrece cerrar el inventario justo a quien no puede**, y se calla al rechazarlo (**F19**). | ⚠️ **Corrige la primera versión de este renglón**, que decía «Reconciliar está habilitado con cero conteos» a secas: **es falso para quien tiene permiso**. Medido el 2026-11-26 con `superoot` (botón `disabled: true`, sin tooltip; la razón sí está en el bloque ámbar de arriba) contra el 2026-11-25 con `monica_mejia` y `camila_verdines` (habilitado y clickeable). |
| **F19** | ⚠️ **NO CONFIRMADO** | ⛔ **Este renglón se degradó el 2026-11-26 y hay que decir por qué.** Se publicó como 🔴🔴 sobre una evidencia débil: **no haber visto un mensaje en una captura de pantalla**. Al ir a arreglarlo se midió el código y **los tres caminos SÍ llaman al toast** (`error: (e) => this.toast.add(...)` en reconciliar, cancelar y calcular discrepancias), el componente **provee `MessageService`** y el `<p-toast>` está **al inicio del template, sin condición**: se renderiza siempre. Un toast dura unos segundos, así que lo más probable es que **la captura cayera fuera de esa ventana**. **No se arregla lo que no está diagnosticado.** Para confirmarlo o descartarlo hace falta reproducirlo mirando la pantalla en el momento del clic, no una foto posterior. ⚠️ Lo que sí quedó medido y es cierto: el servidor respondió **403** en `reconcile` y en `cancel`, y **no escribió nada**. | Evidencia original: capturas tras confirmar los tres diálogos, sin mensaje visible. Contra-evidencia: `comercial-inventory-session-detail.component.ts` — manejadores con toast, `providers: [MessageService]`, `<p-toast>` incondicional. |
| ~~F19 (texto original)~~ | ~~🔴🔴~~ | **TODAS las acciones rechazadas fallan en silencio.** Quien sólo tiene `VER` aprieta «Reconciliar», recibe un diálogo que le advierte «**No se puede deshacer**», confirma… y **no pasa nada visible**: ni error, ni aviso, ni toast. Lo mismo con «Cancelar folio» y «Calcular discrepancias». **No es el descuido de un botón: es el patrón de las tres.** ⛔ Encadenado con **F18**, la pantalla le sigue mostrando **ceros** —que se leen como «contado y cuadrado»—, así que **la persona puede concluir que reconcilió bien**. Silencio sobre la única acción del módulo que mueve existencia. | Medido en vivo con `camila_verdines`: `POST :id/reconcile` → **403**, `POST :id/cancel` → **403**, «Calcular discrepancias» → sin efecto. Las tres **sin un solo mensaje en pantalla**. El folio quedó intacto (`counting`, `closed_at: null`): **el servidor no escribió nada** ✅. |
| **F20** | 🟠 | **`reconcile()` trata el no-contado como CERO; lo salva un solo guard.** En el bucle que aplica los ajustes: `const finalQty = Number(it.final_qty)` — y `Number(null)` es **0**, así que un artículo sin contar da `delta = −expected`, **no** entra en el `if (delta === 0) continue` y **se aplica**, dejando la existencia en cero. Hoy no ocurre porque `bloqueosParaReconciliar` frena antes por `count_1 == null` y `final_qty == null` (bien hecho, y es lo que cumple la promesa «un no-contado NO se trata como cero»). Pero es **protección de capa única**: un camino nuevo, un «reconciliar parcial» o un filtro distinto entre guard y bucle pondría el almacén en cero. **Falta la defensa barata**: `if (it.final_qty == null) continue;` dentro del bucle. | Leído en `inventory-count.service.ts` (bucle de aplicación y `bloqueosParaReconciliar`). ⚠️ El guard se verificó por código, **no se ejerció el 409**: hace falta una cuenta con `RECONCILIAR`. |
| **F18** | 🔴🔴 | **Un 403 se convierte en CEROS: la pantalla dibuja un inventario impecable.** A quien sólo tiene `VER`, el detalle del folio le muestra «COBERTURA **0.0 %** · CONTADOS **0/0** · SIN CONTAR **0** · DISCREPANCIAS **0** · VALOR EN RIESGO **$0**» — sobre un folio con **3,363 artículos sin contar**. No dice «sin permiso» ni «no disponible»: dice **cero**, que se lee como *contado y cuadrado*. El bloque «Falta para poder cerrar este folio» tampoco aparece, así que no queda ni una pista. ⛔ Y le toca justo a **prevención**, cuyo oficio ES el descuadre. Además el título pierde el folio: dice **«Folio»** a secas, porque el número venía de `progress` (403). **Viola la regla 11 del proyecto de frente** (lo no medido se declara, nunca se dibuja como cero). | Medido en vivo el 2026-11-25 con `camila_verdines` (`prevencion_auxiliar`, **un solo rol**, única llave `COMMERCIAL_INVENTORY_VER`). |
| **F17** | 🔴 | **Un 403 de permisos se pinta como «Sin items para este filtro».** Al encargado, que recibe 403 en `GET :id/items`, la tabla de artículos le muestra el texto de lista vacía — mientras el encabezado de la MISMA pantalla le dice «SIN CONTAR 3,363». Dos afirmaciones contradictorias a la vez, y la causa real (no tiene permiso) no aparece. Quien lo vea concluye que el folio está vacío o que se perdieron los datos. Es el mismo defecto que §9b ya tenía para la lista de folios, agravado: acá es por permisos y en el detalle. ⚠️ El encabezado de la tabla además anuncia la columna **«Teórico»**, que su permiso le niega. | Captura en vivo con `monica_mejia`: `items` → 403, y la tabla pinta «Sin items para este filtro». |
| **F12** | 🟡 ✅ **MEDIDO el 2026-11-26** | **El teórico del mismo almacén saltó de 2,094 a 3,363 artículos** entre junio y hoy (+61 %). La primera versión de este renglón decía *«puede ser crecimiento real o un cambio de fuente: no está medido»*. **Ya está medido, y la respuesta tiene tres pasos porque el segundo refuta al primero:** (1) la fuente **sí cambió** —junio se sembró de `commercial.stock` (`stock_source` = `commercial`) y hoy del ERP derivado del ODS (`erp`)—, pero (2) **hoy las dos fuentes coinciden** para ese almacén (3,376 contra 3,377 SKUs con existencia), así que **el cambio de fuente NO explica el salto**; y (3) el folio de hoy **no se está dejando nada**: de los **924** productos que estaban en junio y hoy no, **sólo 11 siguen teniendo existencia** — los otros 912 se fueron a cero. ⭐ Lo que queda establecido, y es lo que importa para **D-EX8**: los dos folios comparten **1,164** productos, **un tercio de los de hoy**, así que **cruzarlos como si midieran lo mismo es incorrecto**. Que el salto sea rotación normal de una distribuidora de dulces es **plausible y NO está probado**: eso pide un testigo del movimiento, no un conteo de SKUs. | `INV-2026-00009` y `00007` (Padre Hidalgo, junio): 2,094 y 2,093, `stock_source = commercial`. `INV-2026-00010` (hoy): 3,364, `stock_source = erp`. Hoy, mismo almacén: `commercial.stock` con cantidad > 0 → **3,376**; `analytics.v_erp_stock_on_hand` con unidades > 0 → **3,377**. Cruce de `product_id` entre los dos folios: 1,164 en ambos, 924 sólo en junio (11 con existencia hoy), 2,200 sólo en noviembre. |
| **F13** | 🟡 | **`GET /counts/resolve` devuelve `product_id: null` y un `brand_name` que vale `"341"`**, y la pantalla del contador pinta ese «341» junto al SKU como si fuera un dato del producto. ⭐ **Medido el 2026-11-26, y resultó peor y más fácil de lo que decía este renglón:** no es «el nombre de la marca en el catálogo», es el **código de la categoría** — de 10,266 productos de `inventory.products`, 9,321 traen categoría y los **9,321 son numéricos**, o sea que ese campo **nunca** llevó una marca. Y el nombre existe: el **97.1 %** de los códigos casa con `catalog.categories.code`, donde **341 = «PROMOCIONES»**, que es justo lo que era ese producto. ⛔ `product_id: null` es aparte y es a propósito (*«el conteo por sku es parte del rework pendiente»*). | Respuesta real: `{"product_id":null,"sku":"00203","barcode":"00203","brand_name":"341","location":null,…}`. Medición en prod: `count(*) FILTER (WHERE categoria ~ '^[0-9]+$')` = 9,321 de 9,321 con categoría; 492 códigos distintos; `LEFT JOIN catalog.categories ON code = categoria` cubre 9,053 (97.1 %). |
| **F14** | 🟡 | **Dos formatos numéricos para el mismo dato en la misma pantalla**: el teórico se lee `5.000` (punto) y el campo de captura escribe `999,999` (coma). Quien vea `5.000` arriba y teclee `5,000` abajo mete mil veces más. | Observado en el diálogo «Resolver item». |
| **F15** | 🟠 | **La lista de contadores asignables no dice sucursal ni rol.** `assignable-users` devuelve sólo `id, username, nombre, role_name`; el desplegable pinta **sólo el nombre**. Quien arma el equipo de un conteo en Padre Hidalgo ve 24 nombres y **no puede distinguir al único almacenista de esa tienda** de los de Zamora, La Piedad o Canindo, ni ve a los que nunca entraron. | Respuesta real de `assignable-users?role=counter`: 24 personas, campos `id, username, nombre, role_name`, **sin sucursal**. En prod sólo `luis_espino` es almacenista de PH; 4 de los 11 nunca entraron. |
| **F16** | ⛔ **RETIRADO el 2026-11-26: el hallazgo estaba MAL** | Decía: *«Asignar restringe lo que se VE, no lo que se PUEDE — el guard deja pasar a cualquiera con la clave `CONTAR` aunque no esté asignado»*. **Falso.** Lo leí en `ContarOAsignadoGuard`, y ese archivo **nunca se commiteó**: existe suelto en el árbol compartido desde el 2026-11-24 y **no está en producción** (en el controlador desplegado, `POST :id/count` sólo lleva `@RequirePermissions(CONTAR)`). El control real vive en `submitCount()`, commiteado desde antes de la auditoría: *«si el folio tiene contadores asignados, solo ellos cuentan»* → `ForbiddenException('No estás asignado como contador de este folio.')`, y además restringe por pasillo si se asignaron pasillos. O sea que **la regla que se aprobó el 2026-11-26 ya estaba implementada** y no hubo nada que cambiar. ⭐ La lección, que es lo que vale guardar: **leí un archivo del árbol y lo di por desplegado**. Un archivo sin commitear compila en todas las sesiones y no existe en prod. | Verificado con `git show HEAD:…/inventory-count.controller.ts` (sin el guard) y `git show HEAD:…/inventory-count.service.ts` (con el freno por asignación, líneas 483-492). `git log` del guard: **vacío**. |
| **F22** | 🟡 | **El contador sin asignación recibe un mensaje que lo manda a pedir algo que ya existe.** La pantalla vacía dice «**No hay ningún folio de inventario abierto para contar. Pedile a tu supervisor que abra uno.**» cuando la causa real es que **no está asignado a ninguno** — el folio existe y está vivo. El supervisor que reciba ese pedido va a ver el folio abierto y no va a entender el reclamo. ⭐ El mensaje correcto **ya está escrito en el backend**: `ContarOAsignadoGuard` dice «No estás asignado a este conteo. Pídele a quien arma el equipo que te agregue como contador». La pantalla no lo usa. | Medido el 2026-11-26: `/counts/mine` devolvió **vacío** con `INV-2026-00010` vivo en `review`, porque la cuenta no figura entre los dos contadores asignados. |

### ✅ Lo que está BIEN, y hay que decirlo

- ⭐⭐ **El conteo ciego es REAL, no una promesa de la interfaz.** Ni `GET /counts/resolve` ni
  `GET /counts/:id/catalog` devuelven el teórico. El catálogo completo que baja al navegador del
  contador trae `product_id, sku, barcode, product_name, location` y **ningún campo de existencia**:
  el teórico nunca llega a esa máquina.
- ⭐ **El catálogo del contador SÍ trae los 3,363 completos** — el tope de 2,000 es sólo de la
  pantalla del supervisor. El almacenista llega a cualquier producto escaneándolo.
- **Un código que no está en el catálogo se rechaza** con «Código no reconocido en el catálogo»,
  inmediato y claro.
- **Tras registrar un conteo**, la pantalla limpia los dos campos y devuelve el foco al código.
- **«Guardar» nace deshabilitado** con el campo vacío, y **los negativos se descartan**.
- ⭐ **El aviso de cierre dice la regla de la casa en palabras**: «un no-contado **NO** se trata como
  cero». Y el guard que la cumple (`bloqueosParaReconciliar`) está bien hecho — ver **F20** para su
  única debilidad.
- **Reconciliar pide confirmación y advierte que es irreversible**: «Esto ajusta el stock teórico al
  físico contado y genera los movimientos. **No se puede deshacer.** ¿Continuar?». El diálogo existe
  y dice lo que corresponde; el problema es a quién se le ofrece (**F11**) y que su rechazo sea mudo
  (**F19**).
- ⭐⭐ **El servidor nunca escribió de más en toda la prueba.** Se ejerció `reconcile` desde una
  cuenta sin permiso: **403**, y el folio quedó intacto (`counting`, `closed_at: null`).

### Lo que queda SIN MEDIR

⛔ Nada de esto se ejerció, y **no se declara como funcionando**:

- **`POST /counts/:id/reconcile` con permiso.** Ya se ejerció **sin** permiso (403, nada escrito) y
  ya se leyó el código (**F20**: el guard frena por los nulos). Falta el **409 real** desde una
  cuenta con `RECONCILIAR`, y el camino feliz, que exige un folio contado al 100 % — hoy imposible
  por **F1** y **F2**.
- **«Calcular discrepancias»** — por eso **«Discrepancias 0» probablemente sea «no calculado», no
  «cero medido»**; no se afirma ninguna de las dos cosas sin correrlo.
- **«Cancelar folio»** y **equipos por pasillo**. (Asignar contadores ✅ ya se ejerció.)
- **El camino sin conexión** (cola de Dexie, reintento, 409) y el **doble envío**.
- Los perfiles **`supervisor`** y **`marketing`** en vivo; **F4** depende de ellos.

> ⚠️ **Fuera del módulo, visto al elegir cuentas de prueba:** una persona tiene **35 roles**
> asignados a la vez, y aparece simultáneamente como `almacenista`, `encargado_tienda`, `prevencion`
> y `supervisor`. Para esa cuenta cualquier matriz de permisos es decorativa, y **no sirve como
> caso puro de ningún perfil** al probar. Es de `identity`, no de inventario; se deja apuntado.

### ⚠️ Dos afirmaciones anteriores que se corrigen acá

1. **«`INV-2026-00009` congeló Padre Hidalgo 101 días»** — en pantalla ese folio figura
   **Cancelado**, con inicio en junio y última actividad hace 126 días. Las dos cosas pueden
   convivir, pero **la cifra no se vuelve a usar hasta re-medir cuándo se canceló**.
2. **«Medio catálogo no se puede contar»** — falso, y se dijo en esta misma sesión antes de medir el
   catálogo. El **contador** llega a los 3,363 escaneando. Lo correcto es **F5**: es el
   **supervisor** quien no ve 1,363 artículos, y sobre esa lista truncada se arma su tablero.

### Rastro de la prueba

El folio **`INV-2026-00010`** quedó vivo en Padre Hidalgo, **sin congelar** (no bloquea ninguna
operación), con un artículo resuelto (`00135`) y un conteo huérfano (`00203`, 3 unidades). **Se
cancela al cerrar las pruebas pendientes.**

---

## 10. Cómo se prueba

> ⭐ **La lista de verificación para probar con Playwright —95 pruebas, una sección por tipo de
> usuario, con errores humanos, de causalidad, de diseño y las negativas— vive en
> [`inventario-fisico-PRUEBAS.md`](inventario-fisico-PRUEBAS.md).** Su §0 trae la decisión
> pendiente (**D-PW1**): hoy ningún Playwright del repo apunta a la aplicación corriendo.

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
