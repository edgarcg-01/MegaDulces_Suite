# Fase RE.13 — Órdenes de entrada en tres vistas (sucursal · revisor · global)

> **Estado:** 🔨 DISEÑADO (planeación) — 2026-08-27. Sin código todavía.
> **Depende de:** Fase RE (recepción), Fase ID / ADR-050 (alcance de datos), CC ext (evidencia de entradas).
> **Tesis:** una pantalla que sirve a tres trabajos distintos no sirve bien a ninguno. Partirla por
> **trabajo**, no por dato: *subir lo que me falta* · *aprobar o devolver* · *entender el universo*.

---

## 1. Punto de partida (medido, no supuesto)

Hoy existen dos pantallas:

| Pantalla | Qué es hoy | Tamaño |
|---|---|---|
| [`/compras/entradas`](../../../apps/view/src/app/modules/compras/pages/compras-entradas.component.ts) | Un componente que hace **cuatro trabajos**: captura (wizard foto-primero de 2 pasos), auditoría por línea (diálogo de 72rem con conciliación RE.11 + ajustes RE.2 + visor de documento), validación (dos botones en la fila) y monitoreo (KPIs + frescura por fuente). | **1,826 líneas** |
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
   objetivo #1 de este rediseño no es analítica: es que el capturista de sucursal suba el papel. Todo
   lo que no sirva a eso es secundario.
2. **CEDIS es el 74% del volumen** (~30 entradas/día hábil) contra 1–3/día de una sucursal chica.
   Son dos regímenes de trabajo distintos con la misma pantalla.
3. **Ritmo real ~300 entradas/semana en 7 sucursales**, 183 proveedores distintos. El backlog de 850
   entra a la cola el día 1 si no se decide qué hacer con él (ver §6, decisión abierta 5).

### 1.2 Lo que ya está listo para reusar

- **Alcance de datos (ADR-050 / Fase ID):** `identity.role_scopes` + `identity.user_scopes` +
  [`ScopeService`](../../../libs/platform-core/src/lib/scope/scope.service.ts) con dimensión
  `warehouse`, `applyToCurrent(qb, dim, columna)`, `intersect()`, `assertCanWrite()` y el contrato de
  params [`scope-params.ts`](../../../libs/platform-core/src/lib/scope/scope-params.ts)
  (`warehouse_codes` canónico, alias `sucursal` aceptado). Primer consumidor: `/tienda` análisis
  semanal. **Entradas es el segundo consumidor natural.**
- **Permisos:** `COMPRAS_ENTRADAS_VER` / `_GESTIONAR` / `_VALIDAR` ya existen y ya están separados.
- **Backend de 360:** paginación, sort, facetas y el filtro `comprobante` con `por_validar` /
  `validado` / `rechazado` **ya existen** — la vista global casi no necesita backend nuevo.
- **Motor de evidencia:** OCR de remisión (Claude vision, imagen **y** PDF), dedup por `sha256` y por
  folio, cuadre con tolerancia $1, clasificación del descuadre (`cuadra`/`iva`/`typo`/`otro`),
  conciliación por línea con aprendizaje de alias, auto-explicación con `X-D-40`/`X-D-55`,
  frescura por fuente, WS de entradas nuevas.

### 1.3 Hallazgos que hay que arreglar sí o sí (independientes del split)

| # | Hallazgo | Evidencia | Impacto |
|---|---|---|---|
| H1 | **El input de archivo sólo acepta PDF** (`accept="application/pdf"` en los dos pasos del wizard), sin `capture`. El backend y el OCR **sí** aceptan `image/jpeg\|png\|webp\|gif`. | `compras-entradas.component.ts` (2 inputs) vs `parseDataUri()` del service | El capturista de sucursal con el celular y el papel en la mano **no puede subir nada**. Candidato #1 a explicar la adopción cero. |
| H2 | **La lista trunca en silencio.** `limit` default 300 (máx 1,000), sin paginación ni `total` en la respuesta; los KPIs sí cuentan el universo. | `listReceipts()` | El KPI dice 1,096 y la tabla muestra 300. Nadie sabe qué falta. |
| H3 | **No hay filtro por sucursal** en `GET /finance/goods-receipts`. | `ListReceiptsQuery` | El de Yurécuaro (16 entradas) navega entre las 815 de CEDIS. |
| H4 | **No hay cola de "por validar".** Los estados son `pendiente` (sin evidencia) / `con_comprobante` / `validado` / todas. | idem | El revisor no tiene bandeja: recorre "Con remisión" leyendo tags. |
| H5 | **`attach` no valida alcance de escritura.** Cualquiera con `_GESTIONAR` adjunta a cualquier sucursal. | `attach()` | Sin `assertCanWrite('warehouse', …)`. |
| H6 | **`_VALIDAR` está otorgado a 15 roles**, incluidos `coordinadora_marketing`, `tele_operator`, `gestor_tesoreria`, `contabilidad`, `sistemas` y `encargado_sucursal`. El comentario del controller dice "permiso especial restringido". | `role_permissions` en DB | El permiso no restringe nada, y `encargado_sucursal` puede validar la evidencia que subió su propia sucursal. |
| H7 | **Sin segregación de funciones:** `validate(id)` no compara `created_by` con el actor. | `validate()` | El mismo humano sube y aprueba. |
| H8 | **Rechazar no le avisa a nadie.** No hay notificación ni WS al que subió; el motivo es texto libre. | `reject()` | La evidencia devuelta se queda muerta y no se puede medir *por qué* se devuelve. |
| H9 | **Sin historial de decisiones.** `status` + `validated_by` + `validated_at` se sobrescriben; un `recibido → rechazado → validado` no deja rastro (y `reject` reusa `validated_by` para decir "quien rechazó"). | tabla `goods_receipt_proofs` | Existe el patrón `commercial.order_status_history` para copiar. |
| H10 | **Sin antigüedad ni SLA** en ninguna vista. 850 de 1,096 pendientes tienen >7 días y nada lo grita. | — | Sin urgencia visible no hay proceso. |
| H11 | `KEPLER_BRANCH_NAMES` no tiene `'06'` (= **Canindo**, sucursal Kepler nueva desde 2026-08-15) y sí tiene `'50': 'Canindo'` (código de otro espacio). | [`branches.ts`](../../../libs/platform-core/src/lib/constants/branches.ts) vs `commercial.warehouses` | La sucursal nueva se muestra como `06` crudo. |

---

## 2. Las tres vistas

Regla de partición: **un usuario, una pregunta, una pantalla.**

| Vista | Usuario | La pregunta | Dónde |
|---|---|---|---|
| **A. Mis pendientes** | Capturista de sucursal (`auxiliar_sucursal`: VER+GESTIONAR, sin VALIDAR) | *"¿qué papel me falta subir?"* | `/compras/entradas` (reemplaza la actual) |
| **B. Bandeja de revisión** | Revisor central (compras / contabilidad / prevención, con `_VALIDAR`) | *"¿apruebo o devuelvo esta?"* | `/compras/entradas/revision` (nueva) |
| **C. Todas las entradas** | Gerencia, compras, contabilidad | *"¿cómo va el universo y por qué?"* | `/compras/compras-360` (se extiende, **no** se duplica) |

---

## 3. Vista A — "Mis pendientes" (sucursal)

**Tesis:** es una **lista de tareas**, no un reporte. Se usa de pie, con el celular, junto a la
mercancía. Cero analítica, cero conciliación por línea, cero ajustes de proveedor.

### 3.1 Qué necesita el usuario (priorizado)

1. **Aterrizar ya scopeado.** Sin elegir sucursal: `ScopeService` resuelve `warehouse`. Selector
   visible **sólo si su alcance tiene más de una**. Con `mode='own'` y `users.warehouse_code` NULL
   (hoy **105 de 137 usuarios**) el resultado es vacío → **empty-state honesto**: *"tu usuario no
   tiene sucursal asignada; pedí que te la configuren"*, nunca una tabla en blanco.
2. **Orden por antigüedad DESC** (lo más viejo primero). Hoy ordena por fecha descendente, o sea
   muestra lo recién llegado y esconde lo atrasado — exactamente al revés de lo que hay que hacer.
3. **Semáforo de días** por fila: `0–2` neutro · `3–7` ámbar · `>7` rojo, con el número de días.
   Es el único adorno que se justifica: es la urgencia.
4. **Fila mínima**: proveedor · monto · **últimos 4 del folio en grande** (es como identifican el
   papel) · días. Tap en cualquier lado = subir.
5. **Cámara y galería** (H1): `accept="image/*,application/pdf"` + `capture="environment"`,
   multi-archivo, compresión en cliente antes de subir (una foto de 4 MP a base64 por HTTP es una
   subida fallida en la red de una sucursal).
6. **Lo devuelto va arriba.** Banner *"2 evidencias te las devolvieron"* con el motivo tipificado y
   acción directa "volver a subir". Hoy el capturista **nunca se entera** (H8).
7. **Progreso del día**: *"8 de 11 subidas · 3 te faltan"*. El objetivo es cerrar el día en cero;
   los KPIs de dinero (`$ por comprobar`) no le sirven a este usuario y se van.
8. **Búsqueda por últimos 4** — ya existe y funciona bien (match exacto por sufijo del folio);
   se conserva para el caso "tengo el papel y no sé cuál renglón es".
9. **Tolerancia a red mala** *(diferible a A.2)*: cola local + reintento, patrón `apps/vendor`/Dexie.

### 3.2 Qué se le quita a la pantalla actual

Conciliación por línea, ajustes X-D-40/55, visor de documento a dos paneles, KPIs de monto, frescura
por fuente, tira de facetas. Todo eso es trabajo de revisor o de gerencia y hoy le pesa al chunk lazy
que carga el capturista.

### 3.3 Criterios de aceptación

- Un usuario de la sucursal `04` ve **16** filas, no 1,096.
- Se puede completar "subir la factura" **desde un celular, con la cámara**, en ≤ 3 toques desde la fila.
- La entrada más vieja pendiente está en la primera pantalla, sin scroll ni filtros.
- Sin sucursal asignada → mensaje que dice qué hacer, no vacío.

---

## 4. Vista B — "Bandeja de revisión" (revisor)

**Tesis:** es una **cola con veredicto**, no un CRUD. El revisor no busca: decide lo que le toca, en
orden de riesgo, y pasa a la siguiente.

### 4.1 Qué necesita el usuario (priorizado)

1. **Cola = sólo `status='recibido'`** (H4), ordenada por **riesgo**: descuadre operativo grande →
   monto → antigüedad. Filtros: sucursal, proveedor, tipo de descuadre (`cuadra`/`iva`/`typo`/`otro`),
   monto mínimo.
2. **Master-detail permanente** (DESIGN §O.1), no diálogo: izquierda la cola densa
   (suc · proveedor · monto · Δ · días), derecha el expediente completo.
3. **El expediente, en este orden** (answer-first, ya construido en el diálogo actual y se muda tal cual):
   veredicto en llano → las tres cifras comparables (**Kepler / Σ renglones / documento OCR**) →
   documento embebido al lado → líneas Kepler → conciliación por línea → *"¿por qué no cuadra?"*
   (devoluciones y notas de crédito del proveedor ±15 días).
4. **Decidir y avanzar solo**: al validar o rechazar, la siguiente se abre automáticamente. Atajos
   de teclado (`A` aprobar · `R` rechazar · `J`/`K` navegar). Una cola sin "siguiente" obliga a
   volver a la lista y buscar dónde estabas.
5. **Motivo de rechazo tipificado** (H8): catálogo corto — *ilegible · no corresponde a la entrada ·
   el total no cuadra · falta una hoja · duplicada · otro (texto)*. Sin esto no se puede responder
   "¿por qué se devuelve el 30% de lo que sube la 01?".
6. **Aprobación en lote sólo del caso limpio**: cuadra + checklist completo + monto bajo un umbral
   configurable, con confirmación que **enumera** lo que va a aprobar. Nunca "aprobar todo".
7. **Segregación de funciones** (H6/H7): quien subió no puede validar — botón deshabilitado con la
   razón visible, y 403 explicado del lado del servidor. Y hay que **revisar el grant de `_VALIDAR`**
   (15 roles hoy).
8. **Su propio SLA**: *"5 por validar con más de 3 días"* + *"decidiste 12 hoy"*.
9. **Historial visible** (H9): quién subió, quién decidió, cuándo, y si hubo ida y vuelta.

### 4.2 Criterios de aceptación

- La cola trae **sólo** lo que espera decisión, y el primer renglón es el de mayor riesgo.
- Validar → la siguiente aparece sin clic extra.
- Rechazar exige motivo del catálogo y el capturista lo ve en su vista A.
- Un revisor que subió la evidencia no puede validarla.

---

## 5. Vista C — "Todas las entradas" (global)

**No se crea una cuarta pantalla.** Compras 360 ya es el grid global (paginado, ordenable, con
facetas y export). Lo que le falta es el **lente de cumplimiento** junto al de dinero.

1. **Dos lentes explícitos** (segmented, mismas filas):
   - **Dinero** (actual): factura · ajuste comercial/operativo · neto.
   - **Cumplimiento** (nuevo): evidencia sí/no · estado · días de antigüedad · Δ del cuadre · quién decidió.
2. **Cobertura por sucursal** — la tabla que contesta *"¿quién no está subiendo?"*: `%` con
   evidencia, `%` validadas, `$` pendiente, antigüedad p50/p90 por sucursal. Es el arranque de RE.7.
3. **SLA captura → validación** y aging (empalma RE.3/RE.7).
4. **Deep-links a A y B**: fila sin evidencia → "avisar a la sucursal"; fila por validar → "abrir en
   la bandeja" (`?ent=suc|folio`, el patrón de deep-link ya existe en 360).
5. **Export** ya existe; se le agregan las columnas del lente de cumplimiento.
6. **Frescura del feed** ya existe (`data_as_of` + chip stale) — se conserva.

---

## 6. Plan de implementación

Numeración: **RE.13** (RE.11 = conciliación por línea y RE.12 = copias CEDIS ya están tomadas en
código, aunque el doc de la Fase RE todavía no las liste — deuda de doc aparte).

| Sprint | Alcance | Toca | Tamaño |
|---|---|---|---|
| **RE.13.0** ⛔ ruta crítica | **Backend, sin UI.** `warehouse_codes` (contrato ID.5) + `ScopeService.applyToCurrent` en `list`/`detail` + `assertCanWrite` en `attach` (H3, H5) · `estado` += `por_validar` \| `rechazado` (H4) · paginación real `page`/`pageSize` + `total` + `truncated` (H2) · `orden` = `antiguedad` \| `monto` \| `riesgo` · `dias_min` · `dias_pendiente` calculado por fila (H10) · fix `'06': 'Canindo'` (H11). Smoke `test-newdb-goods-receipts-scope`. | `goods-receipt-proofs.service.ts`, `.controller.ts`, `branches.ts`, tests | M |
| **RE.13.1** | **Vista A.** Componente nuevo y chico (~350 líneas) que reemplaza el actual en `/compras/entradas`: worklist scopeada + semáforo de días + banner de devueltas + progreso del día + **cámara/imagen** (H1) + compresión en cliente. El wizard de captura se extrae a un componente propio compartido con B. | `apps/view/.../compras/pages/` (nuevo), `entradas.service.ts` | L |
| **RE.13.2** | **Vista B.** `/compras/entradas/revision`: cola + master-detail permanente + siguiente automático + atajos + lote limpio + **motivo tipificado** (migración aditiva `motivo_codigo`) + guard de segregación de funciones (H6/H7) + `finance.goods_receipt_proof_history` (H9, patrón `order_status_history`). El expediente se muda del diálogo actual (código ya escrito y probado). | migración newdb, service, controller, componente nuevo, nav | L |
| **RE.13.3** | **Vista C.** Lente de cumplimiento + `GET /finance/goods-receipts/coverage` (por sucursal) + deep-links a A/B + columnas nuevas en el export. Puede ir **en paralelo** a 13.1/13.2: su backend ya existe casi completo. | `purchase-adjustments.service.ts`, `compras-compras360.component.ts` | M |
| **RE.13.4** | **SLA + avisos** (cierra RE.3/RE.4 y el H8): `@Cron` → `finance.findings` (sin evidencia >N días · descuadre > umbral · por validar >3 días) + WS al capturista cuando le devuelven y al revisor cuando le entra trabajo. Reusa `FINANCE_NOTIFIER_PORT` y el patrón de detectores Maat. | scanner nuevo, gateway existente | M |
| **RE.13.5** | **Alcance y permisos:** limpiar el grant de `_VALIDAR` (H6), configurar `role_scopes`/`user_scopes` de `warehouse` para los roles de sucursal, y `mode_write` = su sucursal aunque lea varias. Sin código nuevo: es configuración + migración de datos + verificación. | seeds/migración, `identity.*` | S |
| **RE.13.6** *(diferible)* | Cola offline en la captura (Dexie, patrón vendor) — sólo si la red de sucursal lo pide de verdad. | — | M |
| **RE.13.7** *(diferible)* | PDF/XLSX del expediente para contabilidad (patrón SellOutExport). | — | S |

**MVP = 13.0 → 13.1 → 13.2.** Con eso el proceso arranca de verdad: el de sucursal sube desde el
celular y el revisor decide en cola. 13.3 corre en paralelo. 13.4/13.5 son lo que lo hace sostenible.

### 6.1 Riesgos

- **El scope puede cerrar la puerta.** 105 de 137 usuarios no tienen `warehouse_code` y 45 roles
  quedaron en `warehouse='own'`. Sin RE.13.5 y sin el empty-state de A.1, la vista A aparece vacía
  para la mayoría y el remedio se lee como "no funciona". **Mitigación:** el empty-state explicativo
  va en el mismo sprint que el scope, y 13.5 se configura antes de anunciar la pantalla.
- **CEDIS tiene otro régimen** (30/día vs 1–3/día). Si la vista A se diseña sólo para la sucursal
  chica, CEDIS la va a odiar; si se diseña para CEDIS, la sucursal chica carga peso que no usa.
  **Mitigación:** misma pantalla, pero el modo lote (multi-selección + subida secuencial) se habilita
  cuando la cola supera N filas.
- **Dos "recepciones" en el menú.** Almacén ya tiene `/almacen/recepcion` (WMS, ADR-044: conteo
  físico caja→pieza contra lo esperado). Esto es la **evidencia documental**, no el conteo.
  **Mitigación:** nombres explícitos ("Órdenes de entrada · factura del proveedor" vs "Recepción ·
  vales de entrada") y un link cruzado entre ambas, no una fusión.
- **Backlog de 850 pendientes viejos.** Si entran a la cola el día 1, el semáforo queda todo rojo y
  deja de informar. Ver decisión abierta 5.

### 6.2 Decisiones abiertas (necesito tu llamada, Edgar)

1. **¿Dónde vive la vista A?** `apps/view` (Operations, con sidebar, escritorio de sucursal) o
   `apps/vendor` (la app que ya está instalada en celulares). Cambia el sprint 13.1 entero.
2. **¿El revisor es central o por sucursal?** Si es central, la bandeja B **no** se scopea por
   `warehouse`; si el encargado de sucursal revisa lo suyo, sí — y entonces H7 (no aprobar lo propio)
   pasa a ser la única defensa.
3. **Umbral de monto** para la aprobación en lote, y si hay un segundo umbral que exija doble
   revisión.
4. **CEDIS**: ¿misma pantalla con modo lote, o merece su propio flujo de alta velocidad?
5. **El backlog**: ¿arrancamos la cola desde una fecha nueva (p. ej. 2026-09-01) y el histórico
   2026-08 se trabaja como campaña aparte, o entra todo?
6. **`RECEPTION_START`**: hoy es un constante `2026-08-01` en el código. ¿Se mueve a configuración
   por tenant o se deja fija?

---

## 7. Qué NO hace esta fase

- No escribe a Kepler (regla de siempre: el ERP es fuente, no destino).
- No toca el motor de OCR, el dedup, la conciliación por línea ni la auto-explicación de ajustes:
  todo eso funciona y se **muda** de pantalla, no se reescribe.
- No unifica con la recepción física de Almacén (§6.1).
- No migra el histórico del Excel de recepción (eso sigue siendo RE.9).
