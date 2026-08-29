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
