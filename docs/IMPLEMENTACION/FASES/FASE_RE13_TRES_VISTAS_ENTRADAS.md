# Fase RE.13 — Órdenes de entrada por trabajo (sucursal · CEDIS · revisor · global)

> **Estado:** 🧪 **RE.13.0 + 13.1 + 13.2 + 13.3 EN CÓDIGO (local, builds + smoke 23/23 verdes)** — 2026-08-27.
> Las **4 pantallas** existen. Decisiones cerradas con Edgar el mismo día. Falta 13.4 (vista C), 13.5 (SLA/avisos) y 13.6 (permisos y alcance, que es **gate de despliegue**).
> **Depende de:** Fase RE (recepción) · **Fase ID / ADR-050** (alcance de datos + normalización de
> usuarios) · CC ext (evidencia de entradas).
> **Tesis:** una pantalla que sirve a tres trabajos no sirve bien a ninguno. Se parte por **trabajo**,
> no por dato: *subir lo que me falta* · *aprobar o devolver* · *entender el universo*. El trabajo de
> captura tiene **dos regímenes** (sucursal chica y CEDIS), así que son 3 trabajos en 4 pantallas.

---

## 1. Punto de partida (medido, no supuesto)

Hoy existen dos pantallas:

| Pantalla | Qué es hoy | Tamaño |
|---|---|---|
| [`/compras/entradas`](../../../apps/view/src/app/modules/compras/pages/compras-entradas.component.ts) | Un componente que hace **cuatro trabajos**: captura (wizard foto-primero de 2 pasos), auditoría por línea (diálogo de 72rem con conciliación RE.11 + ajustes RE.2 + visor de documento), validación (dos botones en la fila) y monitoreo (KPIs + frescura). | **1,826 líneas** |
| [`/compras/compras-360`](../../../apps/view/src/app/modules/compras/pages/compras-compras360.component.ts) | Grid analítico global: paginación server-side, sort, facetas, presets de fecha, export CSV, filtro de comprobante, rango de monto. Su tesis es el **dinero** (factura / ajuste / neto). | 942 líneas |

### 1.1 La data (DB local `platform_test`, ventana desde `RECEPTION_START = 2026-08-01`)

| Sucursal | Entradas | Monto | Con evidencia | Pendientes >7 días |
|---|---:|---:|---:|---:|
| `00` CEDIS Irapuato | **815** (74%) | $39.35 M | 0 | 651 |
| `01` Padre Hidalgo | 136 | $5.43 M | 0 | 104 |
| `03` 8 Esquinas | 53 | $244 k | 0 | 37 |
| `02` La Piedad Abastos | 33 | $89 k | 0 | 25 |
| `06` **Canindo** | 31 | $1.95 M | 0 | 15 |
| `04` Yurécuaro | 16 | $14 k | 0 | 12 |
| `05` Zamora Centro | 12 | $443 k | 0 | 6 |
| **Total** | **1,096** | **$47.5 M** | **0** | **850** |

Tres hechos que mandan sobre el diseño:

1. **`finance.goods_receipt_proofs` está vacía.** El proceso está construido pero **no adoptado**. El
   objetivo #1 de este rediseño no es analítica: es que el capturista suba el papel. Todo lo que no
   sirva a eso es secundario.
2. **CEDIS es el 74% del volumen** (~30 entradas/día hábil) contra 1–3/día de una sucursal chica.
   Son dos regímenes de trabajo distintos → **flujo propio** (§5).
3. **Ritmo real ~300 entradas/semana en 7 sucursales**, 183 proveedores distintos. El rezago de 850
   con más de 7 días necesita decisión de arranque (§7).

### 1.2 Lo que ya está listo para reusar

- **Alcance de datos normalizado (Fase ID / ADR-050).** Cuando RE.13 se construya, la normalización
  de usuarios ya estará cerrada: `users.warehouse_code`/`warehouse_id` poblados,
  `identity.role_scopes` + `identity.user_scopes` configurados, **fail-closed real**, `mode_write`
  separado de lectura y `warehouses.kind='branch'` para el picker. Entonces RE.13 **no adivina** de
  quién es qué: le pregunta a [`ScopeService`](../../../libs/platform-core/src/lib/scope/scope.service.ts)
  (`applyToCurrent(qb, 'warehouse', 'c.sucursal')`, `intersect()`, `assertCanWrite()`) y el contrato
  de params [`scope-params.ts`](../../../libs/platform-core/src/lib/scope/scope-params.ts)
  (`warehouse_codes` canónico). **Ésta es la dependencia dura de la fase** (§6.1).
- **Permisos:** `COMPRAS_ENTRADAS_VER` / `_GESTIONAR` / `_VALIDAR` ya existen y ya están separados.
- **Backend de 360:** paginación, sort, facetas y el filtro `comprobante` con `por_validar` /
  `validado` / `rechazado` **ya existen** — la vista global casi no necesita backend nuevo.
- **Motor de evidencia:** OCR de remisión (Claude vision, imagen **y** PDF), auto-enlace por folio con
  fallback a monto (`matchByOcr`), dedup por `sha256` y por folio, cuadre con tolerancia $1,
  clasificación del descuadre (`cuadra`/`iva`/`typo`/`otro`), conciliación por línea con aprendizaje
  de alias, auto-explicación con `X-D-40`/`X-D-55`, frescura por fuente, WS de entradas nuevas.

### 1.3 Hallazgos que hay que arreglar sí o sí (independientes del split)

| # | Hallazgo | Evidencia | Impacto |
|---|---|---|---|
| H1 | **No se puede subir una foto.** El input pide `accept="application/pdf"`, pero eso era el síntoma: **`uploadFile` llama a `ObjectStorageService.putPdf`, que rechaza imágenes** ("Solo se aceptan archivos PDF"). Viene de la migración desde Cloudinary, donde el problema era *servir* PDFs — no una política contra las fotos. El OCR (`parseDataUri`) acepta `image/jpeg\|png\|webp\|gif` desde siempre, `signFiles` firma cualquier tipo y el detalle ya distingue imagen de PDF; el único tapón era el almacenamiento. `putFile` (el camino que ya usa `bank-capture` para las fotos que llegan por WhatsApp) resuelve las dos capas. | `goods-receipt-proofs.service.ts` → `putPdf` vs `object-storage.service.ts` → `putFile` | El capturista con el celular y el papel en la mano **no puede subir nada**. Candidato #1 a explicar la adopción cero. ✅ **corregido en RE.13.1**. |
| H2 | **La lista trunca en silencio.** `limit` default 300 (máx 1,000), sin paginación ni `total` en la respuesta; los KPIs sí cuentan el universo. | `listReceipts()` | El KPI dice 1,096 y la tabla muestra 300. Nadie sabe qué falta. |
| H3 | **No hay filtro por sucursal** en `GET /finance/goods-receipts`. | `ListReceiptsQuery` | El de Yurécuaro (16 entradas) navega entre las 815 de CEDIS. |
| H4 | **No hay cola de "por validar".** Los estados son `pendiente` (sin evidencia) / `con_comprobante` / `validado` / todas. | idem | El revisor no tiene bandeja: recorre "Con remisión" leyendo tags. |
| H5 | **`attach` no valida alcance de escritura.** Cualquiera con `_GESTIONAR` adjunta a cualquier sucursal. | `attach()` | Falta `assertCanWrite('warehouse', …)`. |
| H6 | **`_VALIDAR` está otorgado a 15 roles**, incluidos `coordinadora_marketing`, `tele_operator`, `gestor_tesoreria`, `contabilidad`, `sistemas` y `encargado_sucursal`. El comentario del controller dice "permiso especial restringido". | `role_permissions` en DB | El permiso no restringe nada. |
| H7 | **Sin segregación de funciones:** `validate(id)` no compara `created_by` con el actor. | `validate()` | El mismo humano sube y aprueba — crítico ahora que hay revisor **por sucursal** (§4). |
| H8 | **Rechazar no le avisa a nadie.** No hay notificación ni WS al que subió; el motivo es texto libre. | `reject()` | La evidencia devuelta se queda muerta y no se puede medir *por qué* se devuelve. |
| H9 | **Sin historial de decisiones.** `status` + `validated_by` + `validated_at` se sobrescriben; un `recibido → rechazado → validado` no deja rastro (y `reject` reusa `validated_by` para decir "quien rechazó"). | tabla `goods_receipt_proofs` | Existe el patrón `commercial.order_status_history` para copiar. |
| H10 | **Sin antigüedad ni SLA** en ninguna vista. 850 de 1,096 pendientes tienen >7 días y nada lo grita. | — | Sin urgencia visible no hay proceso. |
| H11 | `KEPLER_BRANCH_NAMES` no tiene `'06'` (= **Canindo**, sucursal Kepler nueva desde 2026-08-15) y sí tiene `'50': 'Canindo'` (código de otro espacio). | [`branches.ts`](../../../libs/platform-core/src/lib/constants/branches.ts) vs `commercial.warehouses` | La sucursal nueva se muestra como `06` crudo. |
| H12 | **Parámetros de negocio hardcodeados**: `RECEPTION_START = '2026-08-01'` y `TOLERANCIA = 1.0` son constantes de módulo. | `goods-receipt-proofs.service.ts` | Cambiar la fecha de arranque o la tolerancia exige redeploy. Se vuelven configuración (§7, decisión 6). |

---

## 2. Las cuatro pantallas (tres trabajos)

Regla de partición: **un usuario, una pregunta, una pantalla.** Todas viven en **`apps/view`**
(`apps/vendor` es la app de vendedores y no participa).

| Pantalla | Usuario | La pregunta | Ruta |
|---|---|---|---|
| **A-suc. Mis pendientes** | Capturista de sucursal (`auxiliar_sucursal`: VER+GESTIONAR, sin VALIDAR) | *"¿qué papel me falta subir?"* | `/compras/entradas` (reemplaza la actual) |
| **A-cedis. Captura por lote** | CEDIS (~30/día) | *"¿cómo descargo el bonche de facturas de hoy?"* | `/compras/entradas/lote` (nueva) |
| **B. Bandeja de revisión** | Revisor **central** y, en algunas sucursales, revisor **local** | *"¿apruebo o devuelvo esta?"* | `/compras/entradas/revision` (nueva) |
| **C. Todas las entradas** | Gerencia, compras, contabilidad | *"¿cómo va el universo y por qué?"* | `/compras/compras-360` (se extiende, **no** se duplica) |

El wizard de captura (subir → OCR → cuadre → guardar) se extrae a **un componente compartido** que
usan A-suc y A-cedis; el expediente de auditoría (veredicto + 3 cifras + documento + líneas +
conciliación + ajustes) se extrae a **otro** y lo usan B y C. Nada de eso se reescribe: se muda.

---

## 3. Vista A-suc — "Mis pendientes" (sucursal)

**Tesis:** es una **lista de tareas**, no un reporte. Se usa de pie, con el celular, junto a la
mercancía. Cero analítica, cero conciliación por línea, cero ajustes de proveedor.

### 3.1 Qué necesita el usuario (priorizado)

1. **Aterrizar ya scopeado.** Sin elegir sucursal: `ScopeService` resuelve `warehouse` desde la
   configuración normalizada de Fase ID. Selector visible **sólo si su alcance tiene más de una**
   (caso del encargado de zona con 3 sucursales: lee las 3, pero `mode_write` lo deja capturar sólo
   en la suya).
2. **Orden por antigüedad DESC** (lo más viejo primero). Hoy ordena por fecha descendente, o sea
   muestra lo recién llegado y esconde lo atrasado — exactamente al revés de lo que hay que hacer.
3. **Semáforo de días** por fila: `0–2` neutro · `3–7` ámbar · `>7` rojo, con el número de días. Es
   el único adorno que se justifica: es la urgencia.
4. **Fila mínima**: proveedor · monto · **últimos 4 del folio en grande** (es como identifican el
   papel) · días. Tap en cualquier lado = subir.
5. **Cámara y galería** (H1): `accept="image/*,application/pdf"` + `capture="environment"`,
   multi-archivo, compresión en cliente antes de subir (una foto de 4 MP en base64 sobre la red de
   una sucursal es una subida fallida).
6. **Lo devuelto va arriba.** Banner *"2 evidencias te las devolvieron"* con el motivo tipificado y
   acción directa "volver a subir". Hoy el capturista **nunca se entera** (H8).
7. **Progreso del día**: *"8 de 11 subidas · 3 te faltan"*. El objetivo es cerrar el día en cero; los
   KPIs de dinero (`$ por comprobar`) no le sirven a este usuario y se van.
8. **Búsqueda por últimos 4** — ya existe y funciona bien (match exacto por sufijo del folio); se
   conserva para el caso "tengo el papel y no sé cuál renglón es".
9. **Tolerancia a red mala** *(diferible a RE.13.6)*: cola local + reintento.

### 3.2 Qué se le quita a la pantalla actual

Conciliación por línea, ajustes X-D-40/55, visor de documento a dos paneles, KPIs de monto, frescura
por fuente, tira de facetas. Todo eso es trabajo de revisor o de gerencia y hoy le pesa al chunk lazy
que carga el capturista.

### 3.3 Criterios de aceptación

- Un usuario de la sucursal `04` ve **16** filas, no 1,096.
- Se completa "subir la factura" **desde un celular, con la cámara**, en ≤ 3 toques desde la fila.
- La entrada más vieja pendiente está en la primera pantalla, sin scroll ni filtros.
- Un usuario cuyo alcance de escritura no incluye la sucursal ve la fila pero **no** el botón de subir
  (y el backend responde 403 explicado, no mudo).

---

## 4. Vista B — "Bandeja de revisión" (central + local)

**Tesis:** es una **cola con veredicto**, no un CRUD. El revisor no busca: decide lo que le toca, en
orden de riesgo, y pasa a la siguiente.

**Una sola pantalla para los dos tipos de revisor.** No hay código condicional: lo resuelve el
alcance.

| Revisor | `warehouse` en `identity.*` | Qué ve |
|---|---|---|
| **Central** (el caso general) | `all` | Toda la cola, con filtro por sucursal disponible. |
| **Local** (sólo algunas sucursales) | `own` / `listed` | Únicamente su(s) sucursal(es). |

Consecuencias de ese modelo, que hay que construir:

- Las sucursales **sin** revisor local caen al central sin configuración extra: nadie más tiene
  alcance sobre ellas.
- Las sucursales **con** revisor local quedan visibles para los dos → **colisión posible**. El backend
  ya rechaza la segunda decisión (`whereIn('status', …)` → *"evidencia no encontrada o ya validada"*);
  lo que falta es que la UI lo muestre bien: *"X ya la validó hace 2 min"* y avanzar a la siguiente,
  no un toast de error rojo.
- La **segregación de funciones (H7) pasa a ser indispensable**, no un lujo: en una sucursal chica el
  revisor local y el capturista son el mismo puñado de gente. `validate()` bloquea si
  `created_by = actor`, con la razón visible en el botón.

### 4.1 Qué necesita el usuario (priorizado)

1. **Cola = sólo `status='recibido'`** (H4), ordenada por **riesgo**: descuadre operativo grande →
   monto → antigüedad. Filtros: sucursal, proveedor, tipo de descuadre (`cuadra`/`iva`/`typo`/`otro`),
   monto mínimo.
2. **Master-detail permanente** (DESIGN §O.1), no diálogo: izquierda la cola densa
   (suc · proveedor · monto · Δ · días), derecha el expediente completo.
3. **El expediente, en este orden** (answer-first; ya construido en el diálogo actual y se muda tal
   cual): veredicto en llano → las tres cifras comparables (**Kepler / Σ renglones / documento OCR**)
   → documento embebido al lado → líneas Kepler → conciliación por línea → *"¿por qué no cuadra?"*
   (devoluciones y notas de crédito del proveedor ±15 días).
4. **Decidir y avanzar solo**: al validar o rechazar, la siguiente se abre automáticamente. Atajos de
   teclado (`A` aprobar · `R` rechazar · `J`/`K` navegar). Una cola sin "siguiente" obliga a volver a
   la lista y buscar dónde estabas.
5. **Motivo de rechazo tipificado** (H8): catálogo corto — *ilegible · no corresponde a la entrada ·
   el total no cuadra · falta una hoja · duplicada · otro (texto)*. Sin esto no se puede responder
   "¿por qué se devuelve el 30% de lo que sube la 01?".
6. **Aprobación en lote sólo del caso limpio.** La puerta es la **tolerancia de ±$1** (`|Δ| ≤
   tolerancia`, hoy `TOLERANCIA = 1.0` y pasa a configuración) **más** checklist de documentos
   completo. Sin techo de monto: lo que cuadra al peso, cuadra. Confirmación que **enumera** lo que va
   a aprobar; nunca un "aprobar todo".
7. **Su propio SLA**: *"5 por validar con más de 3 días"* + *"decidiste 12 hoy"*.
8. **Historial visible** (H9): quién subió, quién decidió, cuándo, y si hubo ida y vuelta.

### 4.2 Criterios de aceptación

- La cola trae **sólo** lo que espera decisión, y el primer renglón es el de mayor riesgo.
- Validar → la siguiente aparece sin clic extra.
- Rechazar exige motivo del catálogo y el capturista lo ve en su vista A-suc.
- Quien subió la evidencia no puede validarla, y la pantalla dice por qué.
- Un revisor local no ve ni una fila de otra sucursal (verificado en smoke, no a ojo).

---

## 5. Vista A-cedis — "Captura por lote" (flujo propio de CEDIS)

**Por qué flujo propio:** 815 entradas/mes (74% del total), ~30/día hábil, en manos de una o dos
personas, y las facturas llegan **ya digitales** (PDF del proveedor). El wizard de a-una — dos pasos,
diálogo modal, buscar el folio a mano — son ~8 interacciones por entrada: **240 interacciones al día**.
Inviable.

**Tesis:** el humano no busca la entrada; **suelta el bonche y confirma el enlace**. Todo el motor ya
existe (`ocr` lee cada hoja, `matchByOcr` enlaza por folio con fallback a monto ±$2, el dedup por
`sha256` detecta la hoja repetida). Lo que falta es la **superficie de lote**.

### 5.1 El flujo

1. **Soltar N archivos** de golpe (PDF e imágenes, tope configurable ~50).
2. El cliente los lee con **concurrencia limitada** (3–4 en vuelo, barra de progreso por archivo) y
   pide el auto-enlace: **folio primero**, monto como fallback.
3. **Tabla de conciliación del lote** — una fila por archivo:
   `archivo → entrada propuesta → confianza (exacto por folio / por monto / ambiguo / sin match) → Δ del cuadre`.
   Editable: cambiar la entrada enlazada sin salir de la tabla.
4. **Guardar los que cuadran en una sola acción**; los ambiguos y los sin-match quedan en la tabla
   para resolver a mano (o se dejan para mañana sin perder lo ya enlazado).
5. **Contadores honestos** arriba: *enlazados N · ambiguos N · sin match N · duplicados N*. El
   duplicado se marca y no se guarda (ya hay backstop server-side).
6. Cero diálogos modales por archivo. Teclado: `Enter` confirma la fila, `↓` baja.

### 5.2 Backend

Casi nada nuevo: el cliente reusa `POST /ocr`, `GET /match` y `POST /upload` que ya existen. Se agrega
**una** ruta para el guardado atómico del lote (`POST /finance/goods-receipts/attach-bulk`), que
adjunta N expedientes en una transacción y devuelve el resultado por archivo (guardado / duplicado /
sin enlace), para que un fallo en el archivo 12 no tire los 11 anteriores.

### 5.3 Criterios de aceptación

- 30 facturas se procesan en **una** pasada, sin abrir un diálogo por entrada.
- El auto-enlace por folio acierta y lo que no acierta queda **visible como ambiguo**, no enlazado a
  ciegas.
- Un archivo repetido no crea evidencia duplicada.
- El conjunto de documentos requeridos de CEDIS sigue siendo el que ya está configurado para su fuente
  (`md_00` → set Wincaja), no se cambia acá.

---

## 6. Vista C — "Todas las entradas" (global)

**No se crea una quinta pantalla.** Compras 360 ya es el grid global (paginado, ordenable, con facetas
y export). Lo que le falta es el **lente de cumplimiento** junto al de dinero.

1. **Dos lentes explícitos** (segmented, mismas filas):
   - **Dinero** (actual): factura · ajuste comercial/operativo · neto.
   - **Cumplimiento** (nuevo): evidencia sí/no · estado · días de antigüedad · Δ del cuadre · quién decidió.
2. **Cobertura por sucursal** — la tabla que contesta *"¿quién no está subiendo?"*: `%` con evidencia,
   `%` validadas, `$` pendiente, antigüedad p50/p90 por sucursal. Es el arranque de RE.7.
3. **SLA captura → validación** y aging (empalma RE.3/RE.7).
4. **Deep-links a A y B**: fila sin evidencia → "avisar a la sucursal"; fila por validar → "abrir en
   la bandeja" (`?ent=suc|folio`, el patrón de deep-link ya existe en 360).
5. **Export** ya existe; se le agregan las columnas del lente de cumplimiento.
6. **Frescura del feed** ya existe (`data_as_of` + chip stale) — se conserva.

C es la única vista que **no** se scopea a la sucursal del usuario: es la vista de red. Su alcance lo
define el permiso `COMPRAS_360_VER`, y si un día se quiere una versión scopeada, el mismo
`ScopeService` la da sin tocar la query.

---

## 7. Decisiones cerradas (2026-08-27)

| # | Decisión | Resuelto |
|---|---|---|
| 1 | ¿Dónde vive la captura? | **`apps/view`**, todas las vistas. `apps/vendor` es la app de vendedores y no participa. |
| 2 | ¿Revisor central o por sucursal? | **Los dos**: un revisor central + revisor local en algunas sucursales. Una sola pantalla; lo resuelve el alcance (§4). |
| 3 | Umbral para el lote | **Tolerancia ±$1** (`\|Δ\| ≤ 1`) + checklist completo. Sin techo de monto. Configurable. |
| 4 | ¿CEDIS? | **Flujo propio** — captura por lote (§5). |
| 6 | `RECEPTION_START` | **Configurable** (tabla `finance.receipt_settings` por tenant, patrón `commercial.replenishment_settings`), junto con la tolerancia y los días de SLA (H12). |

### 7.1 La única pregunta abierta (era la #5, reformulada)

Hoy `RECEPTION_START = 2026-08-01` define **desde qué fecha las entradas de Kepler entran al
proceso**. Eso significa que el día que prendamos la vista A, entran de golpe **850 entradas con más
de 7 días de atraso** — todas en rojo. Un semáforo donde el 78% está en rojo deja de informar, y el
capturista abre la pantalla, ve una montaña imposible y no la vuelve a abrir.

Como `reception_start` ya queda configurable (decisión 6), la pregunta es sólo **qué valor le
ponemos el día del arranque** y qué hacemos con lo anterior:

- **Mi recomendación:** `reception_start` = la fecha real de arranque (p. ej. 2026-09-01), y el rezago
  anterior vive en **su propio carril**: un filtro "Rezago" en la vista A y una fila aparte en la
  cobertura de la vista C. Así el SLA mide el proceso vivo (y se puede exigir), y el rezago se trabaja
  como campaña con su propia meta, sin contaminar el semáforo del día.
- **La alternativa** (entra todo junto) sólo tiene sentido si el rezago de agosto **se va a cobrar**
  igual que lo nuevo — decime y lo dejo en un solo carril, que es menos código.

---

## 8. Plan de implementación

Numeración: **RE.13** (RE.11 = conciliación por línea y RE.12 = copias CEDIS ya están tomadas en
código, aunque el doc de la Fase RE todavía no las liste — deuda de doc aparte).

> **Avance al 2026-08-27:** 13.0, 13.1, 13.2 y 13.3 ✅ en código local (builds api + view verdes, smoke
> `test-newdb-goods-receipts-scope` **23/23** en la regression). **Sin verificar por HTTP**: no
> hay API local levantada y la regla del repo es no arrancar dev servers — la integración con
> `ScopeService` sobre el request real se valida en el primer arranque.
> **Pendiente prod:** migraciones `20260827130000_receipt_settings` y `20260827140000_goods_receipt_proof_history`
> + redeploy api/view + configurar el alcance `warehouse` de los capturistas (13.6) antes de anunciar
> la pantalla. Sin permisos nuevos → no requiere re-login.

| Sprint | Alcance | Toca | Tamaño |
|---|---|---|---|
| **RE.13.0** ✅ | **Backend, sin UI.** `warehouse_codes` (contrato ID.5) + `ScopeService.applyToCurrent` en `list`/`detail` + `assertCanWrite` en `attach` (H3, H5) · `estado` += `por_validar` \| `rechazado` (H4) · paginación real `page`/`pageSize` + `total` + `truncated` (H2) · `orden` = `antiguedad` \| `monto` \| `riesgo` · `dias_min` · `dias_pendiente` por fila (H10) · migración `finance.receipt_settings` (`reception_start`, `match_tolerance`, `sla_capture_days`, `sla_review_days`, `bulk_max_files`) y las constantes salen del código (H12) · fix `'06': 'Canindo'` (H11). Smoke `test-newdb-goods-receipts-scope`. | `goods-receipt-proofs.service.ts`, `.controller.ts`, migración newdb, `branches.ts`, tests | M |
| **RE.13.1** ✅ | **Vista A-suc.** Componente nuevo y chico (~350 líneas) que reemplaza el actual en `/compras/entradas`: worklist scopeada + semáforo de días + banner de devueltas + progreso del día + **cámara/imagen** (H1) + compresión en cliente. El wizard de captura se extrae a componente compartido. | `apps/view/.../compras/pages/` (nuevo), `entradas.service.ts` | L |
| **RE.13.2** ✅ | **Vista B.** `/compras/entradas/revision`: cola + master-detail permanente + siguiente automático + atajos + lote por tolerancia + **motivo tipificado** (migración aditiva `motivo_codigo`) + guard de segregación de funciones (H7) + aviso de colisión entre revisor central y local + `finance.goods_receipt_proof_history` (H9, patrón `order_status_history`). El expediente se muda del diálogo actual (código ya escrito y probado). | migración newdb, service, controller, componente nuevo, nav | L |
| **RE.13.3** ✅ | **Vista A-cedis.** `/compras/entradas/lote`: drop de N archivos + OCR con concurrencia limitada + tabla de conciliación del lote + `POST /attach-bulk` transaccional + contadores. Reusa `ocr`/`match`/`upload`. | componente nuevo, 1 endpoint | L |
| **RE.13.4** | **Vista C.** Lente de cumplimiento + `GET /finance/goods-receipts/coverage` (por sucursal, con el carril de rezago) + deep-links a A/B + columnas nuevas en el export. Puede ir **en paralelo** desde el día 1: su backend ya existe casi completo. | `purchase-adjustments.service.ts`, `compras-compras360.component.ts` | M |
| **RE.13.5** | **SLA + avisos** (cierra RE.3/RE.4 y el H8): `@Cron` → `finance.findings` (sin evidencia > SLA · descuadre > umbral · por validar > SLA) + WS al capturista cuando le devuelven y al revisor cuando le entra trabajo. Reusa `FINANCE_NOTIFIER_PORT` y el patrón de detectores Maat. | scanner nuevo, gateway existente | M |
| **RE.13.6** | **Permisos:** limpiar el grant de `_VALIDAR` (H6) y dejar sólo los roles que revisan de verdad + configurar el alcance de los revisores locales (`listed`) en `identity.*`. Configuración + migración de datos + verificación con el snapshot de ID.0. | seeds/migración, `identity.*` | S |
| RE.13.7 *(diferible)* | Cola offline en la captura de sucursal — sólo si la red lo pide de verdad. | — | M |
| RE.13.8 *(diferible)* | PDF/XLSX del expediente para contabilidad (patrón SellOutExport). | — | S |

**MVP = 13.0 → 13.1 → 13.2.** Con eso el proceso arranca: el de sucursal sube desde el celular y el
revisor decide en cola. **13.3 (CEDIS) es el que mueve el 74% del volumen** — va inmediatamente
después, o en paralelo si hay manos. 13.4 puede correr en paralelo desde el inicio. 13.5/13.6 son lo
que lo hace sostenible.

### 8.1 Riesgos

| Riesgo | Mitigación |
|---|---|
| **Dependencia dura de Fase ID.** RE.13 asume usuarios normalizados y alcance confiable. Si se construye antes de que ID cierre la normalización, la vista A sale vacía para quien no tenga sucursal y el remedio se lee como "no funciona". | **Gate explícito:** RE.13.1 no se despliega antes de que el alcance `warehouse` esté configurado y verificado con el snapshot de ID.0. Mientras tanto, 13.0 (backend) y 13.4 (vista C, que no se scopea) se pueden construir sin bloqueo. |
| **Dos "recepciones" en el menú.** Almacén ya tiene `/almacen/recepcion` (WMS, ADR-044: conteo físico caja→pieza contra lo esperado). Esto es **evidencia documental**, no conteo. | Nombres explícitos ("Órdenes de entrada · factura del proveedor" vs "Recepción · vales de entrada") + link cruzado entre ambas. No se fusionan. |
| **El rezago de 850 apaga el semáforo.** | §7.1: carril separado, `reception_start` en la fecha de arranque. |
| **CEDIS con 50 archivos = 50 llamadas de OCR.** Costo y rate-limit de Claude vision. | Concurrencia limitada (3–4), dedup por `sha256` **antes** de leer (la hoja ya subida no se relee) y tope `bulk_max_files` configurable. |
| **El lote invita a aprobar sin mirar.** | La aprobación en lote de la vista B es sólo del caso que cuadra al peso + checklist completo, y enumera antes de aplicar. La captura por lote de CEDIS **no** valida: sólo adjunta. |

---

## 9. Qué NO hace esta fase

- No escribe a Kepler (regla de siempre: el ERP es fuente, no destino).
- No toca el motor de OCR, el dedup, la conciliación por línea ni la auto-explicación de ajustes: todo
  eso funciona y se **muda** de pantalla, no se reescribe.
- No unifica con la recepción física de Almacén (§8.1).
- No migra el histórico del Excel de recepción (eso sigue siendo RE.9).
- No cambia el contenido de los roles más allá de recortar `_VALIDAR` (H6): el alcance es un eje
  aparte y lo administra Fase ID.
