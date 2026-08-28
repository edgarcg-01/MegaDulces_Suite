# Fase RE.15 — Las pantallas de órdenes de entrada, al canon de diseño

> **Estado:** 📋 **PLAN** — 2026-08-27. Sin código.
> **Alcance:** las 5 pantallas del proceso documental de entradas + la lente de Compras 360, todas
> escritas entre RE.13 y RE.14 (2026-08-27). Surface **Operations**.
> **Base normativa:** [`DESIGN.md`](../../../DESIGN.md) (checklist pre-vuelo + Operations + reglas de
> datos densos, BINDING), [`docs/DESIGN_TABLES.md`](../../DESIGN_TABLES.md),
> [`tokens.css`](../../../libs/design-tokens/tokens.css), ADR-033 (MetricStrip).
> **Tesis:** las 4 pantallas nuevas funcionan y respetan la estructura de Operations
> (`surf-page`, master-detail, tabla densa, quiet-luxury), pero **cada una inventó su propio ritmo
> visual** y ninguna usa las piezas compartidas que el sistema ya tiene. No es un problema de
> gusto: es medible, y la causa de que "se parezcan pero no encajen".

---

## 1. Lo que hay hoy

| Pantalla | Ruta | Dueño del trabajo | Líneas |
|---|---|---|---|
| Pendientes de subir | `/compras/entradas` | capturista de sucursal (celular, junto a la mercancía) | 729 |
| Captura por lote | `/compras/entradas/lote` | capturista de CEDIS (~30/día, facturas digitales) | 547 |
| Revisión de facturas | `/compras/entradas/revision` | revisor central / por sucursal | 816 |
| Capturadas dos veces | `/compras/entradas/gemelas` | quien dictamina pares (RE.14) | 356 |
| Órdenes de entrada (global) | `/compras/entradas/todas` | auditoría / "tengo este papel" | 1,799 |
| Compras 360 · lente Cumplimiento | `/compras/compras-360` | jefatura | 1,115 |

**Nada de esto se verificó visualmente**: no hay API local y la regla del repo prohíbe levantar dev
servers. Todo lo de abajo sale de leer el código contra `DESIGN.md`, no de mirar la pantalla. El QA
visual (light + dark + móvil) es un ítem del plan, no un supuesto.

---

## 2. La medición (por qué el plan es esto y no otra cosa)

| | pendientes | lote | revisión | gemelas | todas | 360 |
|---|---|---|---|---|---|---|
| `--sp-*` (espaciado) | **0** · 43 rem a mano | **0** · 22 | **0** · 47 | **0** · 10 | 4 · 118 | **0** · 46 |
| `--fs-*` (tipografía) | 16 · 7 a mano | 10 · 3 | 29 · 5 | **0** · 7 | 14 · 77 | 8 · 26 |
| `--row-h-*` (densidad) | **0** | **0** | **0** | **0** | **0** | **0** |
| `--tap-min` (touch) | **0** | **0** | **0** | **0** | **0** | **0** |
| Tabla canónica (`surf-table--*`) | n/a (lista) | **0** | **0** | **0** (tabla cruda) | **0** | 3 |
| `MetricStrip` (ADR-033) | **0** (KPIs a mano) | — | **0** | **0** | 2 | 2 |
| `FreshnessPill` | **0** | **0** | **0** | **0** | **0** | **0** |
| `ContextHelp` | **0** | **0** | **0** | **0** | **0** | 1 |
| `LoadState` | 1 (sólo error) | **0** | 1 (sólo error) | 1 (sólo error) | 1 | **0** |
| Estado en URL | **0** | **0** | **0** | **0** | **0** | 6 |
| `prefers-reduced-motion` | 2 | **0** | 1 | 1 | 1 | **0** |

**286 valores de espaciado a mano contra 4 usos de la escala.** Ese único número explica la
sensación de desalineación: pendientes respira en `.45/.6/.7rem`, revisión en `.5/.85rem`, gemelas
en `.5/.7/.9rem`. Tres ritmos distintos para tres pantallas del **mismo proceso**.

---

## 3. Hallazgos, ordenados por daño al usuario

### H1 — `--surface-sunken` no existe. 28 usos en 7 pantallas. 🔴
Se usa como `var(--surface-sunken, var(--card-bg))`, así que **siempre cae al fallback**: toda
superficie que debía verse "hundida" tiene exactamente el color de la card que la contiene. Se
pierde, en light y en dark: las filas skeleton, el panel de la gemela, el aviso "te la devolvieron",
el recuadro del otro importe, los empty states. Es el caso exacto que `DESIGN.md §12b` describe
("un token inexistente se ve bien en light y roto en dark") — acá se ve mal en los dos.
El token canónico existe y flipea por tema: **`--surface-2`** (= `--layout-bg`).
Viene de antes de RE.13 (el legacy tiene 10 usos) y RE.13/14 lo propagaron.
**Fix:** un reemplazo global. Riesgo funcional cero, arregla 7 pantallas de una.

### H2 — La escala de espaciado no se usa. 🔴
`DESIGN.md`: la escala 4px (`--sp-1..12`) es *"el único origen de paddings/gaps/margins"*.
286 literales dicen lo contrario. Además de la desalineación, rompe el zoom 200% (mezcla de rem
crudos sin término medio) y hace imposible cambiar la densidad del apartado desde un lugar.

### H3 — Densidad no tokenizada y touch sin piso. 🔴
Regla BINDING de datos densos #2: fila Operations = `--row-h-md` (40px) con toggle a
`--row-h-sm`. Cero usos en las 6 pantallas. Y **cero usos de `--tap-min`** en la pantalla que se usa
**con el teléfono en la mano junto a la mercancía**: el piso de 44px en `pointer: coarse` no está
garantizado en las filas ni en los botones de foto. Es Fitts, y es la pantalla más operativa de las 5.

### H4 — Gemelas se desvía en tres reglas a la vez. 🟠
Es la más nueva (RE.14.4) y la que más se sale:
- **tabla cruda** con CSS propio (~40 líneas) en vez del look canónico: sin header sticky, sin
  primera columna congelada, sin densidad tokenizada (reglas de datos densos #5 y #2);
- **KPIs en cajitas ad-hoc** (`.eg-kpis`), justo lo que **ADR-033 (binding)** reemplazó con
  `MetricStrip` en 50 pantallas;
- **`--fs-*`: 0 usos** — 7 tamaños a mano.
Bonus: `.mono` sólo pone `tabular-nums`, **no** `--font-mono`, así que las cifras no salen en Geist
Mono (checklist #4 lo marca obligatorio para folio/dinero).

### H5 — La frescura del dato se tira a la basura. 🟠
El server ya devuelve `frescura` por fuente en `listReceipts` (y `FreshnessPill` existe, 15
adopciones). Las **3 pantallas nuevas la ignoran**; sólo el legacy la muestra. Una pantalla que
afirma "te faltan 12 facturas" sobre un espejo que puede tener dos días de atraso, sin decir de
cuándo es el espejo, no es cosmética: es la diferencia entre que le crean o no.

### H6 — Cero ayuda contextual en la pantalla con más jerga del proyecto. 🟠
`gemela`, `canónica`, `propuesto`, `dictaminar`, `cuadre`, `rezago`, `carril`, `Δ`, `SLA`,
`sin dictaminar`. El checklist marca `ContextHelp` **obligatorio** donde hay jerga o reglas
estrictas, el diccionario versionado ya existe y ya tiene `compras-360`. Falta escribir 4 entradas.

### H7 — El estado no vive en la URL. 🟠
Filtro, búsqueda, carril, sucursal y fila seleccionada son estado local. Consecuencias reales: el
revisor no puede mandar "mirá esta cola" por chat, recargar pierde el filtro, y el back del
navegador no deshace nada. Compras 360 ya lo hace bien (6 usos) → el patrón está en casa.

### H8 — Los tres estados, a mano y a medias, cuatro veces. 🟡
`LoadState` existe para separar loading/empty/error y se usa **sólo para el error**; el skeleton y
el empty se reescribieron en cada pantalla (`.ep-skel`, `.eg-skel`, …). Y los empties nuevos no
cumplen el patrón 4 de Operations: son icono + una línea, **sin CTA accionable**
("Ninguna orden pendiente en este filtro. [Ver el rezago] · [Quitar filtros]").

### H9 — Presupuesto de interacción sin techo. 🟡
Gemelas pinta hasta 200 filas de tabla cruda y revisión pide `pageSize: 200`, sin virtualización ni
`content-visibility`. El checklist #17 dice que INP < 200 ms en vistas densas es **criterio de
aceptación, no tarea posterior**, y que se mide, no se estima. Hoy no está medido.

### H10 — La marca usada como semántica. 🟡
En gemelas marqué con `--action` (color de marca) que el proveedor difiere y que hay Δ. La regla #5
reserva `--action` para CTA / activo / seleccionado / foco; "esto hay que mirarlo" es `--warn-*`.
Como está, el ojo lee "acción disponible" donde hay "dato sospechoso".

---

## 4. Sprints

### RE.15.0 — Tokens: el que falta y la escala que no se usa ⛔ ruta crítica
Mecánico, sin cambio de comportamiento, arregla las 6 pantallas a la vez.
1. `--surface-sunken` → `--surface-2` (28 sitios, 7 archivos).
2. Espaciado → `--sp-*` (mapa: `.25rem→--sp-1`, `.5rem→--sp-2`, `.75rem→--sp-3`, `1rem→--sp-4`…).
   Los valores raros (`.45`, `.62`, `.85`) se **redondean a la escala**, que es el punto.
3. Tipografía → `--fs-micro/xs/sm` (gemelas primero: 0 usos hoy).
4. `.mono` → `font-family: var(--font-mono)` + `tabular-nums` (o adoptar la clase global si se crea).
5. Densidad: `--row-h-md` en filas/celdas, `--row-h-sm` en la vista compacta, `--tap-min` bajo
   `pointer: coarse` en pendientes y lote.
6. `--action` → `--warn-*` donde marca "revisar esto" (H10).
**DoD:** build prod de `view`; diff de CSS revisado a ojo; cero literales de espaciado nuevos.

### RE.15.1 — Gemelas al canon
1. Adoptar `surf-table surf-table--sticky surf-table--frozen-first surf-table--compact` (ver
   decisión D1 sobre `p-table`).
2. KPIs → `MetricStrip`. El dato manda el modo (regla 9): los tres estados del par
   (`auto` + `confirmado` + `propuesto`) **suman al total de pares** → modo `composition`, una barra
   segmentada con leyenda, no tres cajitas iguales.
3. Fila orientada al diff: los dos importes alineados por decimal y **el Δ como único elemento con
   color**; el resto neutro.
4. Teclado como en revisión (`A` confirmar · `R` rechazar · `J/K` moverse) + `aria-live` al avanzar.
   Es una cola: quien dictamina 77 pares no debería tocar el mouse.

### RE.15.2 — Confianza del dato (frescura, jerga, motor)
1. `FreshnessPill` en pendientes / revisión / gemelas (el server ya manda `frescura`).
2. `ContextHelp` con 4 entradas nuevas de diccionario: `compras-entradas`,
   `compras-entradas-revision`, `compras-entradas-gemelas`, `compras-entradas-lote`.
3. **Contrato de superficie con motor (§X / checklist #18)** para gemelas, que es exactamente eso:
   razón en llano ✅ (la regla), confianza visible ✅ (score) — falta **reversa explícita**
   ("se puede volver a cambiar", hoy no se dice) y **ruta de escalación** ("no sé / que lo vea
   contabilidad"). El motor decide, el humano dictamina, y la pantalla tiene que decirlo.

### RE.15.3 — Matriz de estados completa
`LoadState` para los tres estados en las 4 pantallas · empties con CTA accionable y voz técnica ·
overflow 10× en proveedor/motivo · skeletons dimensionados (CLS 0) desde un solo lugar.

### RE.15.4 — Estado en la URL
Filtros, búsqueda, carril, sucursal y selección a query params en las 4 (patrón de Compras 360).
Habilita compartir la cola y que el back del navegador signifique algo.

### RE.15.5 — Presupuesto de interacción
Medir INP en las dos vistas densas con data real; `content-visibility: auto` en filas;
virtualización sólo si la medición la pide (regla #7: paginado server 25–50, virtual >200).

### RE.15.6 — QA visual light + dark + móvil 🚧 **no lo puedo hacer yo**
Requiere navegador y API viva; el repo prohíbe levantar dev servers. Sale de dos formas: lo corre
Edgar con el checklist de 14 puntos por pantalla, o se autoriza explícitamente levantar `view` +
API local y lo automatizo con Playwright (screenshots light/dark/móvil por pantalla).

---

## 5. Decisiones que no me corresponden

**D1 — ¿`p-table` o tabla cruda con las clases canónicas?**
El checklist #3 dice "PrimeNG-first"; la nota de licencia de agosto dice "no crecer la dependencia
sin necesidad — si nativo lo cubre, nativo". Las clases `surf-table--*` de `styles.css` son
selectores genéricos (`thead > tr > th`), así que **funcionan igual sobre una `<table>` cruda**.
**Recomiendo tabla cruda + clases canónicas** en gemelas y lote: mismo look, cero KB nuevos, y no
apuesta a una licencia abierta. Es un conflicto explícito del checklist → decide Edgar.

**D2 — ¿5 items de sidebar o 2 + tabs?**
Hoy el proceso ocupa **5 entradas de sidebar** que se leen como 5 módulos distintos. `PageTabs`
(46 adopciones) gatea cada tab por permiso y **se esconde solo si queda un tab visible**: el
capturista de sucursal no vería barra alguna, y el revisor central vería las facetas.
**Recomiendo 2 items por trabajo** ("Pendientes de subir" · "Revisión de facturas") y las 3 vistas
de administración (Órdenes · Lote · Capturadas dos veces) como tabs del segundo. Baja el ruido del
sidebar y hace legible que son caras de **un** proceso.

**D3 — El legacy de 1,799 líneas** (`/compras/entradas/todas`): 77 tamaños de fuente y 118
espaciados a mano. No lo toco en este plan más allá de H1/H2. La mejora con más valor por línea es
mover su diálogo de 72rem a `SidePeek` (existe, 6 adopciones) y **dejar de crecerlo**.

---

## 6. Qué NO hace esta fase

- No rediseña el flujo ni la información: RE.13/RE.14 decidieron qué ve cada usuario y eso queda.
- No crece la dependencia de PrimeNG mientras la licencia esté abierta (D1).
- No inventa tokens: si falta un rol, se agrega a `tokens.css` y se justifica.
- No toca backend. Lo único que pide del server ya existe (`frescura`, KPIs, `settings`).
