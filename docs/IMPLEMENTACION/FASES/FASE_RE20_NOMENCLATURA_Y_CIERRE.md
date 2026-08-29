# Fase RE.20 — Nomenclatura formal del proceso de entradas + cierre de huecos

> **Estado:** ✅ RE.20.0 (nomenclatura) · ✅ RE.20.2 (ordenar por columna) — 2026-08-29 ·
> ⬜ RE.20.1 · RE.20.3 · RE.20.4.
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

### 3.2 RE.20.3 — Descartar una entrada con motivo ⬜

Hoy el único camino de salida es *Devuelta*, que **rebota a la sucursal**. Pero hay entradas que
**nunca van a tener factura de proveedor**:

- **Traspasos entre sucursales** — `proveedor_code` con prefijo `TI` (`TI001` PH, `TI002` 8
  Esquinas…). No hay proveedor externo, así que no hay factura que subir.
- Entradas canceladas o capturadas por error en el ERP.

Esas se quedan *Sin factura* para siempre, **inflan el atraso de su sucursal** y ensucian el
semáforo del Control. Hace falta un estado terminal `descartada` con motivo tipificado
(`traspaso · cancelada_erp · duplicada · otro`), gateado con `_VALIDAR` (no lo decide quien
sube), y que salga del denominador de cobertura.

> El discriminador de traspaso **ya está decodificado** (`reference_goods_receipts_multisource`):
> prefijo `TI` = traspaso, prefijo `C…` = compra externa. El RFC **no** sirve, viene sucio.
> Con eso se puede pre-marcar el motivo y hasta descartar los traspasos en lote.

Requiere migración (`finance.goods_receipt_proofs` o tabla nueva de descartes) → **es el único
item de esta fase con cambio de esquema**.

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
| **RE.20.3** | Descartar con motivo | **medio + migración** | Es el que arregla un número **falso** (el atraso de sucursales con traspasos). |
| **RE.20.4** | Aviso de devolución | medio | Cierra el lazo del proceso, pero nada se pierde mientras tanto. |
| **RE.20.1** | Fusionar 360 ↔ Listado | medio, toca permisos | Último: es el que más superficie mueve y necesita decisión de Edgar. |

---

## 5. Verificación

- `nx build view` verde por item.
- Nomenclatura: **cero** apariciones de los nombres viejos en texto visible (sidebar, H1,
  pestañas, ayuda contextual, empty states).
- **RE.20.2 ✅ hecho:** `tsc` de `view` y de `api` limpios · `nx build view` verde (1m38s) ·
  las 4 cláusulas nuevas (`proveedor` ↑↓, `monto` ↑↓) corridas contra la DB real ·
  `test-newdb-goods-receipts-scope` y `-lifecycle` verdes, con 5 aserciones nuevas que cubren
  las claves y el empuje de la fecha futura al final.
- RE.20.3: smoke que confirme que una entrada descartada **sale del denominador** de
  `coverage()` — si no, el descarte esconde el problema en vez de resolverlo.
- Light + dark + móvil.
