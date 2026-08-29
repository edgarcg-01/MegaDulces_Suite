# Fase RE.20 — Nomenclatura formal del proceso de entradas + cierre de huecos

> **Estado:** ✅ RE.20.0 (nomenclatura) · ✅ RE.20.1 (fusión, **en dirección contraria a la
> planeada**) · ✅ RE.20.2 (ordenar por columna) · ✅ RE.20.3 (descartar con motivo) ·
> ✅ RE.20.5 (Compras 360 → Costo por compra) — 2026-08-29 · ⬜ RE.20.4.
> **Depende de:** [RE.17/RE.18/RE.19](FASE_RE17_UX_ENTRADAS.md) (PR #45).
> **Disparador:** Edgar — *"formalicemos los nombres ya que los actuales no son intuitivos o
> profesionales"* + *"revisar las ventanas existentes, cuáles faltan, cuáles sobran"*.
> **Tesis:** el proceso ya funciona y se ve bien; lo que falla es que **no se nombra igual dos
> veces**. Un nombre inconsistente cuesta más que una pantalla fea: obliga a traducir en la
> cabeza en cada paso.

---

## 1. RE.20.0 — El sistema de nombres

### 1.1 Por qué los de hoy no sirven

Tres problemas medidos, no de gusto:

**a) El mismo sustantivo para tres cosas distintas.** El grupo del sidebar se llamaba
`Órdenes`, adentro vivía `Órdenes de compra` (`/compras/ordenes`) y el Control tenía una pestaña
`Órdenes` que son órdenes de **entrada** (`/compras/entradas/control/ordenes`). Dos rutas casi
idénticas para dos cosas opuestas: lo que pedimos y lo que llegó.

**b) Tres palabras para el mismo acto.** La misma pantalla se llamaba `Revisión de facturas` en
el sidebar, `Bandeja de revisión` en su propio título, y el permiso que la gatea es
`COMPRAS_ENTRADAS_VALIDAR`. Quien la usa no sabe si va a *revisar* o a *validar*.

**c) Estilo fuera de la casa.** El sidebar de la app nombra con **sustantivos**: *Ventas ·
Catálogo · Reportes · Operación · Existencias · Conteo físico · Pagos · Gastos · Impuestos ·
Egresos y bancos*. Los de entradas quedaron con **verbos** (`Subir facturas`, `Revisar
facturas`) y con **guiones explicativos** (`Salida — lo que pedimos`), únicos en toda la app.

### 1.2 Las tres reglas

1. **Sustantivo, no verbo.** Es como nombra la casa y como se lee una lista de destinos.
2. **Una palabra por concepto**, y es la que **ya usa la máquina de estados**. El estado es
   *Por revisar* → la pantalla es **Revisión**. El resultado es *Validada* → el botón es
   *Aprobar* y el permiso `_VALIDAR`. No se inventan sinónimos.
3. **El grupo dice la ETAPA del proceso**, no el tipo de documento. Compra y Recepción son las
   dos etapas reales de procure-to-pay, y separan sin ambigüedad lo que pedimos de lo que llega.

### 1.3 Tabla de nombres (BINDING)

| Antes | Ahora | Por qué |
|---|---|---|
| Grupo `Órdenes` | Grupo **`Compra`** | Etapa, no documento. Deja de colisionar con las entradas. |
| — | Grupo **`Recepción`** | Las tres pantallas de facturas de entrada tienen etapa propia. |
| `Pendientes de subir` · `Subir facturas` | **`Captura de facturas`** | Sustantivo. Es el acto del `_GESTIONAR`. |
| `Revisión de facturas` · `Bandeja de revisión` · `Revisar facturas` | **`Revisión de facturas`** | Un solo nombre, el del estado *Por revisar*. El H1 deja de contradecir al sidebar. |
| `Centro de control` | **`Control de entradas`** | Decía "control" de qué nada. |
| Pestaña `Órdenes` | Pestaña **`Listado`** | Son entradas, no órdenes de compra. Dentro de *Control de entradas* no hace falta repetirlo. |
| Pestaña `Por sucursal` | Pestaña **`Cobertura por sucursal`** | Dice qué mide, no cómo agrupa. |
| Pestaña `Capturadas dos veces` | Pestaña **`Capturas duplicadas`** | Misma idea, registro profesional. |
| Pestaña `Ajustes` | Pestaña **`Parámetros`** | *Ajustes* choca con los **ajustes de compra** (notas de crédito X-D-55 / devoluciones X-D-40), que son otra cosa y viven en `/compras/descuentos`. |
| `Compras 360` | **`Costo por compra`** | RE.20.5 — *360* es vocabulario del backend (`execution_360`, Customer 360): decía algo al que lo construyó y nada al comprador. |
| `Costo neto` | **`Costo por proveedor`** | RE.20.5 — arrastrado por el anterior. Las dos son **la misma cifra a dos granularidades**, y nombrarlas por la unidad de la fila las vuelve legibles de un vistazo. |

**Vocabulario de estado — NO se toca** (viene de RE.16 y ya está en el diccionario de ayuda):
*Sin factura → Por revisar → Validada*, con *Devuelta* como único regreso.

**Las rutas NO se tocan.** Hay links pegados en chats y en Compras 360. Los redirects de RE.16
siguen vivos.

---

## 2. RE.20.1 — Lo que sobra: dos listas globales de lo mismo ⬜

`Control de entradas · Listado` y `Compras 360` son **una fila por orden de entrada (XA2001)**,
la misma entidad. Se diferencian por el verbo, no por el dato:

| | Listado | Compras 360 |
|---|---|---|
| Tesis | operar (adjuntar, validar, auditar por línea) | el dinero (factura · ajuste ligado · neto) |
| Datos | server-paginado, alcance, carril | server-paginado, facetas, presets, export CSV |
| Detalle | `SidePeek` con conciliación por línea RE.11 | diálogo con los ajustes que explican el descuadre |

No son duplicados exactos, pero **un usuario que ve las dos en el sidebar no tiene cómo saber
cuál abrir** — y RE.16.8 ya había movido la cobertura de 360 al Control, dejando el solape a
medio resolver.

**Propuesta:** que **Compras 360 sea la única lista global** y el `Listado` muera como pestaña,
mudando su expediente (`SidePeek` + conciliación por línea) al detalle de 360.

- Gana: una pantalla menos que aprender; 360 ya tiene facetas y export, que el Listado no.
- Cuesta: 360 debe heredar el alcance por sucursal y el carril del Listado, y el permiso pasa a
  ser `COMPRAS_360_VER` — hay que verificar que quien opera hoy lo tenga.
- **Decisión abierta:** ¿se fusiona, o se dejan las dos y sólo se aclara la bajada de cada una?
  Fusionar es más limpio pero toca dos permisos y una pantalla que no es de esta fase.

> **HECHO (2026-08-29) — pero en la dirección CONTRARIA a la de arriba.**

### 2.1 Por qué se invirtió la dirección

La propuesta original decía *«que Compras 360 sea la única lista y el Listado muera»*. Al medirlo
antes de construir, resultó al revés. Tres hallazgos:

**a) El permiso mataba la propuesta.** `COMPRAS_360_VER` **⊂** `COMPRAS_ENTRADAS_VER`: todo rol
con 360 tiene también ENT_VER, y **`auxiliar_tienda` (4 personas) tiene ENT_VER sin 360**.
Fusionar hacia 360 los dejaba sin la lista; hacia el Listado no pierde nadie.

**b) Lo que había que mover era muy distinto en cada dirección.** El Listado tiene las
**escrituras** (adjuntar `_GESTIONAR`, validar/devolver/descartar `_VALIDAR`), el alcance por
sucursal, el carril de rezago y la conciliación por línea RE.11. 360 era **read-only** sobre
`analytics.*`. Mover columnas hacia adentro es aditivo; mover escrituras y tres niveles de
permiso hacia una pantalla read-only es un rediseño.

**c) 360 ya se estaba fusionando sola, del lado equivocado.** Tenía adentro un lente
`cumplimiento` (RE.13.4) — *"las MISMAS filas contestando dos preguntas distintas"*— que
duplicaba el propósito del Listado. La fusión iba a pasar igual; sólo faltaba elegir el lado.

### 2.2 Lo que se hizo

**Una pantalla, dos lentes, dos puertas.** El componente de 360 (1,059 líneas) se borró; el
Listado gana un selector `El proceso` / `El dinero`:

| | El proceso | El dinero |
|---|---|---|
| Pregunta | ¿tengo el papel? | ¿cuánto pagamos? |
| Columnas propias | días, remisión, gemela, descarte | vale, **factura · ajuste · neto** |
| Filtros propios | estado, carril, antigüedad | ajuste (con/sin/operativo/comercial), con OC |
| Totales | — | de **todo lo filtrado**, no de la página |

Dos puertas al mismo cuarto, cada una con su lente por default:
`Análisis › Costo por compra` → `/compras/costo-por-compra` · `Control › Listado` →
`/compras/entradas/control/ordenes`. **Rutas distintas a propósito**: con `?lente=` a secas el
sidebar marcaba los dos items a la vez. `/compras/compras-360` queda como **redirect**.

- **Backend:** `listReceipts` gana `lente=dinero`, que engancha el join de ajustes
  (`analytics.erp_purchase_adjustments` por `(sucursal, entrada_folio)` — el folio **no es único
  entre sucursales**) + `factura/ajuste/neto` + totales. En `proceso` **no se paga el join**.
  El buscador hereda `vale_folio` y `concepto` de 360.
- **El ajuste no se pinta de rojo por existir:** ámbar sólo si tiene parte **operativa**
  (faltante, mal estado, no solicitado). 3 de cada 4 son beneficio negociado, y pintar de rojo un
  apoyo de marca entrena a ignorar el color.
- **`COMPRAS_360_VER` queda huérfano a propósito.** Retirarlo del enum obliga a tocar
  `identity.role_permissions` en prod; se queda en el catálogo etiquetado *(retirado)* y diciendo
  que **no abre nada**, para que nadie lo reparta creyendo que sí.

**Diferido:** las **facetas con conteo** y el **export CSV** que 360 tenía y el Listado no.

---

## 3. Lo que falta

### 3.1 RE.20.2 — Ordenar por columna ✅ (2026-08-29 · deuda de RE.16.10)

Ninguna de las tablas de entradas ordenaba por columna. Era la deuda de haber salido de
`p-table` a `<table>` crudo con `surf-table--plain`: los modificadores no traen sort. Con 7
filas daba igual; con las **875 entradas** del Listado, no.

#### Lo que se hizo

**Un solo estado, no dos controles.** Los dos listados tenían un segmentado *Recientes / Más
viejas* en la barra de filtros. Se quitó y el orden se fue al encabezado. No es preferencia de
estilo: con los dos, en cuanto alguien ordenara por proveedor uno de los dos tenía que mentir
—el segmentado seguiría marcando "Recientes" sobre una lista que ya no lo está—. El **default
no cambia**: las dos siguen abriendo por lo más reciente.

**El orden, dicho en palabras.** Junto al contador del pager (`1–100 de 875 · de la más reciente
a la más vieja`). La flecha del encabezado es una convención, y *Captura de facturas* la usa
gente que no vive en tablas; además avisa que el orden cambió sin scrollear hasta arriba.

| Pantalla | Columnas ordenables | Dónde ordena |
|---|---|---|
| **Captura de facturas** | Proveedor · Recepción · Total Kepler | servidor |
| **Control · Listado** | Fecha · Proveedor · Monto | servidor |
| **Control · Cobertura por sucursal** | las 9 de datos | en memoria |

*Días* no se ordena aparte en Captura: es la misma fecha en otra unidad, y dos encabezados
activos por un solo criterio se leen como dos órdenes distintos.

#### Dos correcciones al plan

**a) Sí hizo falta backend.** El plan decía que no. Pero `monto` y `riesgo` eran DESC fijo: un
encabezado que dibuja la flecha y no puede invertirse es una mentira. Se agregó `dir=asc|desc`
(el string del usuario nunca entra a la SQL: un ternario resuelve a uno de dos literales) y dos
claves nuevas, `fecha` y `proveedor`. Cada clave tiene su dirección inicial —importe↓, nombre↑,
fecha↓— porque un primer clic que cae del lado inútil obliga siempre a un segundo.

**b) Apareció un bug de orden, y era el default.** `LEAST(receipt_date, current_date)` aplasta a
hoy la captura de CEDIS con fecha 29/12/2026. RE.19 puso el flag de futuro como **desempate**,
que sólo la baja si además hay entradas de HOY con las que empatar. Verificado contra la DB el
2026-08-29: la más reciente de verdad era del 26, así que **la de diciembre llevaba tres días
encabezando la pantalla de los dos que suben**. El flag pasó a ser la **primera** clave.

#### De paso: `surf-sort` y `table-sort.util`

El encabezado ordenable existía —en `modules/finanzas/pages/`, con estilos adentro de un archivo
de módulo—. El propio comentario del archivo ya se quejaba de que Caja importara del vecino.
Compras era la tercera pantalla, así que se promovió: `shared/util/table-sort.util.ts` (con
`sortRows` para memoria y `serverSortParams` para tablas paginadas) y `.surf-sort` en
`styles.css`, junto a la base de tabla que ya es global. Finanzas quedó usando el compartido y
`.tw-sort` murió.

### 3.2 RE.20.3 — Descartar una entrada con motivo ✅ (2026-08-29)

Hoy el único camino de salida era *Devuelta*, que **rebota a la sucursal**: le pide que suba otra
vez algo que sí existe. Pero hay entradas que **nunca van a tener factura de proveedor**, y para
ésas el proceso no tenía final — se quedaban *Sin factura* para siempre, inflando el atraso de su
sucursal.

#### ⚠️ Corrección de la premisa (verificado contra la DB antes de construir)

El plan decía que **los traspasos están inflando el atraso de las sucursales**. Medido: es cierto
en general, **pero no hoy**.

| | |
|---|---|
| Traspasos (`proveedor_code` `TI*`) en el histórico | **1,176** |
| Último traspaso emitido | **15/06/2026** |
| Traspasos en el carril **vivo** (desde el arranque, 01/08/2026) | **0** |

O sea: los 1,176 caen todos en el carril de **rezago**, que por diseño ya está segregado y **no
entra al % de cobertura**. La categoría que sí está en el carril vivo son las **entradas en
$0.00** — 13 sólo en agosto (muestras, bonificaciones, correcciones del ERP).

Además, hoy **no hay ninguna evidencia subida** (`finance.goods_receipt_proofs` está vacía): la
cobertura es 0% en todas las sucursales. Así que esto **no arregla un número torcido hoy**;
tapa el agujero **antes** de que el proceso arranque en serio, que es cuando empezaría a doler.
Si el ERP vuelve a emitir traspasos, el motivo ya está listo.

#### Lo que se construyó

**Migración `20260829180000`** — la única de esta fase:

- `finance.goods_receipt_discards` (RLS forzado + trigger de tenant + único por
  `(tenant, sucursal, folio)`). Tabla aparte y no columna en `erp_goods_receipts`, porque esa es
  una **vista viva** sobre `kepler_ods` (derive-no-copy) y es de sólo lectura. Mismo patrón que
  el dictamen de gemelas.
- Grants `SELECT, INSERT, DELETE` — **sin `UPDATE`**: cambiar el motivo de un descarte viejo sin
  dejar rastro es reescribir la historia. Se reactiva y se vuelve a descartar, y las dos cosas
  quedan en el historial append-only.
- `goods_receipt_proof_history.proof_id` pasa a **nullable**: descartar es una decisión sobre la
  **entrada**, no sobre una evidencia — y justo se descarta lo que nunca va a tener una. La tabla
  ya denormaliza `(sucursal, folio)` y se lee por ahí, así que queda **una sola línea de tiempo**
  por entrada.

**Motivos** (sin `CHECK`, igual que `motivo_codigo` de RE.13.2 — el catálogo va a crecer):
`traspaso · cancelada_erp · duplicada · sin_costo · otro`. El diálogo **pre-elige** por lo que
dice la fila (proveedor `TI*` → traspaso; monto 0 → sin costo) y muestra una pista por motivo:
el revisor confirma, no adivina. `otro` **exige** nota.

**El descarte no puede esconder el problema.** Sale del denominador de cobertura, pero:

- El tablero de Control gana una columna **Descartadas**, con el desglose por motivo en el
  tooltip y link a la lista. 40 traspasos es el ERP haciendo lo suyo; 40 *otro* es alguien
  limpiando su número.
- El Listado gana el estado **Descartadas**, que las muestra con su motivo, quién y cuándo.
- *Captura de facturas* también lo tiene — sin poder descartar. Si no, un folio que el capturista
  venía persiguiendo desaparece de su lista y del buscador **sin explicación**, que es
  exactamente la crítica que se le hace al descarte.

**Reglas duras del server** (la UI no es la que decide): gateado con `_VALIDAR` y no `_GESTIONAR`
—si el que tiene que subir pudiera declarar que no hace falta, la cobertura sería
autoevaluación—; y **no se descarta lo que ya tiene factura subida** (la respuesta ahí es
validarla o devolverla).

### 3.3 RE.20.4 — Avisarle al que sube que le devolvieron ⬜

Cuando el revisor devuelve una factura, el capturista **sólo se entera si entra a la pantalla**.
El expediente queda parado hasta que alguien lo note.

La infra existe: el gateway `/goods-receipts` ya empuja `new_receipts`. Falta un evento
`proof_rejected` dirigido a la sucursal del expediente, y que *Captura de facturas* lo levante
como aviso (ya tiene el botón "te las devolvieron" en el veredicto — le faltaría el empujón).

---

## 4. Orden propuesto

| # | Item | Costo | Por qué en ese orden |
|---|---|---|---|
| ✅ **RE.20.0** | Nomenclatura | bajo, sólo strings | Es el pedido explícito y no depende de nada. |
| ✅ **RE.20.2** | Ordenar por columna | bajo + `dir` en el backend | Era la queja más probable con 875 filas. De paso apareció el bug del orden por default. |
| ✅ **RE.20.3** | Descartar con motivo | medio + migración | La premisa cambió al verificarla: hoy los traspasos están todos en el rezago. Tapa el agujero **antes** de que el proceso arranque en serio. |
| **RE.20.4** | Aviso de devolución | medio | Cierra el lazo del proceso, pero nada se pierde mientras tanto. |
| ✅ **RE.20.1** | Fusionar 360 ↔ Listado | medio, tocó permisos | Último, como se planeó. Se invirtió la dirección al medir los permisos: ver §2.1. |

---

## 4.bis RE.20.6 — Revisión del backend ✅ (2026-08-29)

Edgar: *"hay que revisar todo el backend de nuestras interfaces creadas/modificadas"*. Auditoría
del **flujo completo**, no de los archivos tocados. Un hallazgo serio.

### El hallazgo: el alcance no llegaba a las escrituras

Los filtros de las **listas** estaban scopeados desde RE.13, pero **nadie pasa por la lista para
hacer un POST**. Cinco endpoints recibían el id (o la sucursal) por la ruta y escribían donde les
dijeran:

| Endpoint | Alcance antes | ¿Mío? |
|---|---|---|
| `validate` · `reject` | ❌ ninguno | no (RE.13) |
| `validateBulk` | ❌ ninguno — **no delega en `validate()`**, reimplementa la lógica | no (RE.13.2) |
| `descartar` · `reactivar` | ❌ ninguno | **sí (RE.20.3)** |
| `attach` · `decideTwin` · `detail` · `matchByOcr` | ✅ ya lo hacían | — |

O sea: la comprobación existía y era la **excepción**, no la regla. Yo agregué dos endpoints más
sin notarlo.

**No es teórico.** Medido: **8 `encargado_tienda` tienen `_VALIDAR` con alcance `own`** (su
tienda). Y `descartar` **saca la fila del denominador de cobertura**, que es el número por el que
se le exige a esa sucursal — el incentivo para tocar el de al lado, o el propio desde afuera,
está servido. `validateBulk` era el peor: hasta **200 expedientes** de una pasada.

### El arreglo

Un `exigirAlcance(sucursal)` que delega en **`scope.assertCanWrite`** y **no** en
`sucursalesVisibles`. La diferencia importa: el segundo es el alcance de **lectura**, y
`mode_write` es lo que permite *"ve las 3 de su zona, captura sólo en la suya"* — autorizar una
escritura con el alcance de lectura afloja el control sin que se note. `attach` ya lo hacía así.

Va **antes de `tk.run`** donde la sucursal viene de la ruta (`descartar`, `reactivar`): no hace
falta abrir una transacción para saber que no. Donde sale de la fila (`validate`, `reject`,
`validateBulk`) va adentro, como en `decideTwin`.

### Dos sustos que resultaron ser míos, no del código

1. **"`attach` no valida alcance"** — sí lo hace; mi grep buscaba `sucursalesVisibles` y `attach`
   usa `assertCanWrite`. El error me llevó al primitivo correcto, así que salió barato.
2. **"El fix bloquea a 9 superadmins"** — el god-mode es por **nombre de rol**
   (`PLATFORM_ADMIN_ROLES = {superadmin, admin}`), no por clave de permiso. Con la regla real:
   **0 usuarios se rompen**, 8 quedan limitados a su sucursal.

El segundo susto vale como aviso permanente: el default de `modeWrite` es **`none`**
(fail-closed), así que un usuario con `_VALIDAR` y **sin regla de alcance** se queda sin poder
validar nada en cuanto entra el guard. Por eso el smoke nuevo lo vigila.

### Lo demás que se revisó y quedó bien

- **Rutas y permisos**: las 20 tienen `RequirePermissions`; VER lee, GESTIONAR captura, VALIDAR
  decide. Sin colisiones de patrón (`discards` va antes de `:sucursal/:folio`; `validate-bulk`
  antes de `:id/validate`).
- **RLS / tenant**: `goods_receipt_discards` con RLS forzado; `analytics.*` (sin RLS) siempre con
  `tenant_id` explícito. Sin `tk.run` anidado — `ScopeService` usa su propia conexión con caché.
- **El join del lente de dinero no infla filas**: `adj` va agrupado por `(sucursal,
  entrada_folio)`, así que es 1:1 y el `count` del paginador no se dispara.
- **Una inconsistencia corregida de paso**: el contador de **rezago** de `coverage()` no
  descontaba descartadas. Pesa justo ahí — los **1,176 traspasos `TI*`** viven todos en el
  rezago, así que descartarlos no movía el número y se leía como que el descarte no hizo nada.

---

## 4.ter Análisis — por qué el cuadre nunca va a ser perfecto (⬜ propuesta RE.21)

Edgar: *"no se consideran las notas de crédito, devoluciones, etc., el análisis no siempre cuadra
a la perfección"*. Tiene razón, y medido resulta peor —y más arreglable— de lo que parecía.

### 4.ter.1 Qué compara hoy `monto_match`

Un **match de 2 vías**: lo que Claude leyó en la factura (`total` **o** `subtotal`) contra el
valor de la entrada en Kepler, con la tolerancia del tenant, aceptando también la copia gemela de
oficinas. Nada más. Los **ajustes de compra no entran**, aunque `classifyDiscrepancy` ya lo sabe:
su bucket `'otro'` dice literalmente *"faltante/devolución/descuento → auto-explain"* y ahí se
detiene.

### 4.ter.2 Los números (medidos sobre `kepler_ods.kdm1`, 2026-08-29)

**1,583 ajustes · $23.8M.** La liga por folio de entrada (`c39`) cubre casi nada:

| | ajustes | liga por `c39` (entrada) |
|---|---|---|
| **X-D-40** devoluciones | 327 · $2.4M | 65 (**20%**) |
| **X-D-55** notas de crédito | 1,256 · $21.4M | **0 (0%)** |
| **Total** | 1,583 · $23.8M | 65 (**4%**) |

**Las notas de crédito nunca traen folio de entrada. Cero de 1,256.** Y son el 90% del dinero.
O sea: el join exacto del lente del dinero —y el de *Compras 360* antes— explica el **4%** de los
ajustes. El resto queda fuera, y por eso 360 tenía un fallback heurístico por proveedor+fecha.

### 4.ter.3 ⚠️ NO hay una segunda llave — corrección de este mismo análisis

**La primera versión de esta sección estaba mal y se corrige acá.** Decía que `c11` es la
*referencia de factura* (así la llama el importer), que está poblada en el 86% y que el OCR ya lee
ese mismo folio del PDF → **1,297 ajustes ligables**. Le creí a la etiqueta de la columna en vez
de mirar el dato.

Mirado (2026-08-29), `c11` es un **campo de texto libre** que en Kepler se llena con lo que sea:

| Qué hay en `c11` | de 1,361 |
|---|---|
| El **código de proveedor** (literalmente `= c10`) | 398 (**29%**) |
| Destinos / almacén (`DP-0CEDIS`, `DC-0CEDIS`…) | 104+ |
| **Sólo dígitos** — los únicos que parecen folio real (`45283`, `6338`) | **172 (13%)** |

O sea que **no existe llave estructural** entre la nota de crédito y la factura. El máximo
teórico de la liga por folio es **~13%**, no 86%, y aun ésos habría que verificarlos contra un
folio real.

**Consecuencia de diseño — y es la buena noticia:** como no hay llave, el sistema **no puede
afirmar** qué ajuste corresponde a qué recepción. Lo que sí puede hacer es lo que haría una
persona: buscar candidatos del mismo proveedor en una ventana y ver **cuál tiene el tamaño del
hueco**. El cuadre se apoya en el **monto**, no en un folio que no existe — y el dictamen queda
en el humano (ADR-016: el motor propone, la persona decide).

Eso además esquiva un problema que no está resuelto: **el signo**. Verificado sobre los 65 que sí
ligan, el ajuste va del **8% al 100%** de la entrada (varios son 100% = la recepción entera
revertida). No hay una regla contable estable de si el ajuste ya viene aplicado en la factura o
no, así que **afirmar dirección sería inventar**. Comparar magnitudes no.

### 4.ter.4 El timing: se juzga contra un número que todavía va a cambiar

De los 65 que sí ligan a una entrada real: **42 (65%) llegan DESPUÉS de la recepción**.
Mediana **4 días**, p90 **40 días**, promedio **32**.

El cuadre se calcula **al capturar la factura**. La nota de crédito puede no existir todavía. Aun
con la liga perfecta, un `monto_match` de hoy no es una verdad estable — es una foto. Cualquier
diseño que trate el cuadre como definitivo va a estar mal el 65% de las veces que haya ajuste.

### 4.ter.5 No todos los ajustes deberían mover el cuadre

Éste es el punto de fondo, y hoy los tres caen juntos en `'otro'`:

| Naturaleza | Ejemplo real (motivo `c24`) | ¿Debe mover `monto_match`? |
|---|---|---|
| **Operativa** — no llegó completo | *"devolución por error unidad de medida y costos"* · faltante · mal estado | **Sí.** La factura del proveedor legítimamente difiere de lo que entró. |
| **Comercial** — beneficio negociado | *"descuento incentivo 3% dd"* · *"descuento ganado por…"* · apoyo de marca | **No.** Llega después y no cambia lo que se recibió: la factura al recibir está bien. |
| **Corrección de captura** | *"duplicadas"* ($5.2M) · *"facturas duplicadas"* ($589k) · *"error de entrada"* | **No es descuadre, es hallazgo.** El número malo es el de Kepler, no el de la factura. |

Y un dato que conviene mirar de frente: **338 notas de crédito por $4.5M vienen con el motivo en
blanco**, y el importer les asigna `descuento_comercial` por `doctype_default`. **$4.5M
clasificados por convención, no por evidencia.**

Falta una cuarta fuente que ni siquiera es un documento de ajuste: el **descuento por pronto pago
al pagar** (`c84`, ~7.41%), que vive en el pago y no en la recepción.

### 4.ter.6 Lo que esto cuesta hoy, en operación

`validateBulk` **exige `monto_match === true`**. O sea que toda recepción con una devolución
legítima **nunca** se puede aprobar en lote: se va a revisión manual para siempre, aunque su
descuadre esté perfectamente explicado por un X-D-40 que Kepler ya tiene registrado.

### 4.ter.7 Forma propuesta

Sin llave estructural (§4.ter.3), el motor **propone** y la persona **decide**:

1. **Explicar por MONTO, no por folio.** Buscar ajustes del mismo proveedor en una ventana y
   marcar los que tienen **el tamaño del hueco** (`|ajuste| ≈ |Δ|` dentro de la tolerancia).
   Comparar magnitudes es defendible; afirmar dirección contable no lo es.
2. **Etiquetar la confianza con honestidad**: `exacto` (liga por `c39`, el 4%) · `monto`
   (explica el hueco al peso) · `proveedor+fecha` (candidato, puede ser ruido). Que se vea cuál
   es cuál en vez de mezclarlos.
3. **Distinguir la naturaleza** (§4.ter.5): un descuadre explicado por un ajuste **operativo** es
   otra cosa que uno explicado por uno **comercial**, y las correcciones de captura son un
   hallazgo, no un descuadre.
4. **El cuadre deja de ser una foto**: `monto_match` se recalcula cuando llega un ajuste
   posterior, o se guarda con su fecha de corte para que se lea como "cuadraba al 12/08".
5. **Un estado nuevo**: *cuadra con ajuste* — ni "cuadra" ni "no cuadra". Es lo que desbloquea el
   lote para las recepciones con devolución explicada (§4.ter.6).
6. **Marcar lo que no se puede explicar** en vez de dejarlo como descuadre mudo.

> **Lección para el próximo que lea una columna de `analytics.*`:** el nombre de la columna es la
> intención del importer, no el contenido. `factura_ref` trae códigos de proveedor el 29% de las
> veces. Mirar los datos, siempre — es la misma regla que ya está escrita para `c2/c3/c4`.

---

## 5. Verificación

- `nx build view` verde por item.
- Nomenclatura: **cero** apariciones de los nombres viejos en texto visible (sidebar, H1,
  pestañas, ayuda contextual, empty states).
- **RE.20.2 ✅ hecho:** `tsc` de `view` y de `api` limpios · `nx build view` verde (1m38s) ·
  las 4 cláusulas nuevas (`proveedor` ↑↓, `monto` ↑↓) corridas contra la DB real ·
  `test-newdb-goods-receipts-scope` y `-lifecycle` verdes, con 5 aserciones nuevas que cubren
  las claves y el empuje de la fecha futura al final.
- **RE.20.3 ✅ hecho:** `test-newdb-goods-receipt-discards` (13/13, ya en la regression) — corre
  en transacción con rollback y afirma las **dos** mitades: la descartada **sale del
  denominador** (594 → 593 en CEDIS) **y** se sigue contando aparte. Más: RLS forzado,
  `app_runtime` sin `UPDATE`, `proof_id` nullable, no se descarta dos veces (índice único), la
  decisión entra al historial sin evidencia detrás, y reactivar devuelve la fila al denominador
  (593 → 594). `tsc` view + api limpios · `nx build view` verde.
- Light + dark + móvil.
