# Fase RE.16 — Facturas de entrada: tres pantallas, una por rol

> **Estado:** 🧪 **EN CÓDIGO** — 2026-08-27. Builds `view` + `api` verdes; **sin verificación
> visual** (no hay API local y la regla del repo prohíbe levantar dev servers).
> **Alcance:** el proceso documental completo de órdenes de entrada — de 6 pantallas a 3, sidebar
> de 5 items a 3, y los parámetros del proceso administrables desde la interfaz.
> **Base:** [`FASE_RE15_UI_ENTRADAS.md`](FASE_RE15_UI_ENTRADAS.md) (la auditoría medida que
> disparó esto), [`DESIGN.md`](../../../DESIGN.md) surface Operations,
> [`FASE_RE13_TRES_VISTAS_ENTRADAS.md`](FASE_RE13_TRES_VISTAS_ENTRADAS.md), RE.14 (gemelas).

---

## 1. Las dos correcciones que cambiaron el diseño

Ambas vinieron de Edgar y ambas invalidan decisiones tomadas en RE.13:

1. **Sólo PDF.** RE.13.1 había abierto la subida a imágenes (`putFile`) pensando en el capturista
   con el papel en la mano y sólo un celular. Se cierra otra vez: el expediente sostiene un pago y
   una foto torcida de una hoja de tres no lo sostiene; el PDF junta las hojas en un archivo. La
   cámara no se pierde — la app de Archivos/Cámara escanea a PDF, endereza y agrupa —, y **decir
   cómo es parte del cambio**: prohibir la foto sin explicar la salida deja a la sucursal sin
   forma de subir nada.
2. **Todos trabajan en lap o escritorio.** La lista apilada de RE.13.1 (56 px por renglón, botón
   de cámara anclado, hoja modal) estaba orientada al celular. Mostraba 8 órdenes donde caben 25 y
   el modal tapaba justo la tabla que da contexto.

---

## 2. El mapa final

| | Antes | Después |
|---|---|---|
| Pantallas | 6 | **3** |
| Items de sidebar | 5 | **3** (uno por oficio) |
| Interacciones para adjuntar | 4 | **1** (arrastrar el PDF a su fila) |
| Vocabularios de estado en uso | ≥4 | **1** |

**Las tres pantallas**

| Pantalla | Ruta | Permiso | Quién |
|---|---|---|---|
| Pendientes de subir | `/compras/entradas` | `_VER` (+ `_GESTIONAR` para subir) | sucursal y CEDIS |
| Revisión de facturas | `/compras/entradas/revision` | `_VALIDAR` | revisor |
| Centro de control | `/compras/entradas/control` | `_VER` | administración |

**Las 4 pestañas del Centro de control** — cada una contesta una pregunta distinta:

| Pestaña | Ruta | Pregunta |
|---|---|---|
| Por sucursal | `/compras/entradas/control` | ¿quién no está subiendo, y hay alguien que pueda? |
| Órdenes | `…/control/ordenes` | la lista completa, para buscar una en particular |
| Capturadas dos veces | `…/control/gemelas` | ¿qué dinero se cuenta doble por falta de dictamen? |
| Ajustes | `…/control/ajustes` | los parámetros del proceso (`_VALIDAR`) |

**Lo que desaparece como pantalla propia**

- `/compras/entradas/lote` → **absorbida**: soltar N PDFs sobre la tabla de pendientes *es* el
  lote de CEDIS. Se borró el componente (547 líneas). Una pantalla menos que aprender.
- `/compras/entradas/todas` → pestaña **Órdenes**.
- `/compras/entradas/gemelas` → pestaña **Capturadas dos veces**.
- La tabla de cobertura de **Compras 360** → pestaña **Por sucursal**. En 360 queda el titular y
  el link: dos copias de la misma tabla es cómo terminan contradiciéndose.

Las tres rutas viejas quedan como `redirectTo` — hay links pegados en chats y en Compras 360.

---

## 3. Vocabulario único

Había al menos cuatro maneras de nombrar lo mismo (`pendiente/con_comprobante/por_validar/
validado/rechazado` en el backend; "Enviada/Devuelta/Validada" en una pantalla; "Con remisión" en
otra). Cuatro personas hablando del mismo expediente con cuatro palabras es una discusión
garantizada. Queda:

**Sin factura → Por revisar → Validada**, con **Devuelta** como el único camino de regreso.

Los valores del API no cambian (`estado=pendiente|por_validar|validado|rechazado`): lo que se
unifica es la etiqueta que ve la persona.

---

## 4. Lo que se construyó

### Server (`libs/finance/goods-receipt-proofs`)

- `uploadFile`: `putFile` → **`putPdf`**. El rechazo vive en tres lugares a propósito: el `accept`
  del input (sugerencia), el front (mensaje que dice la salida) y el server (la única frontera que
  no se puede saltar — el arrastre no respeta `accept` en absoluto).
- `runOcr` rechaza no-PDF **antes** de gastar la llamada a Claude.
- **`PUT /finance/goods-receipts/settings`** (`_VALIDAR`, firmado, rangos validados). Existía el
  GET desde RE.13.0, pero los cinco parámetros sólo se movían con un `UPDATE` a mano en la base —
  contra la regla de que el dato operativo se administra desde la interfaz.
- `coverage` devuelve **`responsables[]`** por sucursal + `responsables_red`. Se resuelve igual que
  `ScopeService` pero para todos a la vez: rol con `COMPRAS_ENTRADAS_GESTIONAR` × alcance de
  escritura sobre `warehouse` (override del usuario > default del rol; `own` = su propia sucursal).

  > **Hallazgo al implementarlo:** 29 personas tienen `_GESTIONAR`, 12 con alcance de red, y las
  > sucursales **00 (CEDIS), 04 y 06 no tienen a nadie**. Cero cobertura ahí no es gente que no
  > trabaja: es un permiso que falta. Son dos conversaciones distintas y sin la columna el tablero
  > acusa al inocente.

### Pendientes de subir (rediseño)

- Tabla densa de escritorio con las clases canónicas (`surf-table--sticky/--frozen-first/
  --compact`), ~25 órdenes a la vista.
- **Arrastrar el PDF sobre su fila.** La fila resaltada es lo único naranja de la pantalla (`--action`
  = actuar, no semántica), y por eso se ve. El botón "elegir" sigue en cada fila: el arrastre es un
  atajo, no el único camino.
- **Panel lateral**, no diálogo: la tabla se sigue viendo.
- **Un solo camino de guardado** (`attach-bulk` agrupando por expediente), venga de una fila o de
  un lote. Tener dos fue exactamente cómo el lote terminó creando dos evidencias para la misma
  entrada cuando la factura traía dos hojas.
- Answer-first: una oración con lo que falta antes de la tabla; estado en la URL (`?suc=&estado=`).

### Centro de control

- **Por sucursal**: cobertura + "quién sube" + p50/p90 de la antigüedad de lo pendiente + rezago
  aparte + fila de totales de la red. Es lectura: cada renglón enlaza a la pantalla que sí opera.
- **Ajustes**: los 5 parámetros, cada uno diciendo **qué se rompe** si se mueve.

### Transversal

- `ContextHelp` con topic `compras-entradas` (la pantalla con más jerga del proyecto no tenía
  ninguna ayuda): los 4 estados, el cuadre, las gemelas, la cobertura y el documento.
- `FreshnessPill` en las dos pantallas nuevas.
- `LoadState` para los tres estados (antes sólo el de error), con empties que ofrecen una salida.
- **`--surface-sunken` → `--surface-2`** en las 4 pantallas de Compras: el token no existe en
  `tokens.css`, así que toda superficie "hundida" caía al color de la card, en light y en dark.

---

## 5. Verificación

| Qué | Resultado |
|---|---|
| `nx build view --skip-nx-cache` | ✅ |
| `nx build api --skip-nx-cache` | ✅ |
| `test-newdb-goods-receipt-twins` | ✅ |
| `test-newdb-goods-receipts-lifecycle` | ✅ |
| `test-newdb-goods-receipts-scope` | ✅ |
| `test-newdb-supplier-receipt-proofs` | ⚠️ 42/44 — las 2 que fallan son de la Fase CC (ver §6) |
| Consulta de `responsables` contra la DB | ✅ (corrida en vivo, sólo lectura) |
| **Verificación visual (light + dark)** | ⛔ **pendiente** — requiere navegador |

---

## 6. Pendientes y hallazgos ajenos

- **QA visual** de las tres pantallas (light + dark + el checklist de 14 puntos de `DESIGN.md`).
  O lo corre Edgar, o se autoriza levantar dev servers para automatizarlo.
- **`--surface-sunken` sigue en 9 usos de Finanzas** (`finanzas-pagos-comprobantes`,
  `finanzas-cobranza`, `finanzas-capturar-gasto`) — otro carril, no se tocó.
- **`test-newdb-supplier-receipt-proofs`, 2 fallas ajenas a esta fase:** localmente
  `analytics.erp_supplier_payments` **es una vista** (PK vacía), pero el smoke afirma "la PK del
  espejo incluye `doc_prefix`", y el anticipo CONVERMEX de referencia no está en la data local. Es
  divergencia local↔prod de la Fase CC; el smoke se hizo robusto donde reventaba por data
  (`rows[0]?.deposits ?? 0`) pero estas dos aserciones necesitan que su dueño decida.
- **Prod:** nada desplegado. Falta redeploy `api` + `view`. Sin migraciones nuevas: el `PUT` de
  ajustes escribe sobre `finance.receipt_settings`, que ya existe.
- **Re-login no hace falta**: no se agregaron permisos.
