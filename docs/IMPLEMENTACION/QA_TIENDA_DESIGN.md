# QA DESIGN.md — Módulo `/tienda/*` (Proyecto Tienda)

> Checklist de revisión pantalla-por-pantalla contra las 14 reglas del [checklist pre-vuelo de DESIGN.md](../../DESIGN.md#️-checklist-pre-vuelo-leer-antes-de-tocar-frontend).
> Regla dura (memoria `feedback_full_designmd_checklist_per_screen`): se auditan **las 14 en CADA pantalla**, y se cierra cada una con **grep de verificación** (0 hex crudo, 0 controles no-PrimeNG), no con "creo que ya".
> Método: ⬜ pendiente · 🔨 en curso · ✅ ok · ⚠️ hallazgo abierto · ➖ N/A justificado.

## Surface + sector (define las reglas)

- **Surface:** Operations (sin Fraunces/Poppins display, quiet-luxury, dark first-class).
- **Sector §14:** **Mostrador/POS** para `live` · `pace` · `branches` (monitor: feed al tope, cifras dominan, KPIs vía `MetricCard`). **Captura de dinero** para `arqueo` (§13 resiliente: estado sucio, botón que muta se auto-deshabilita síncrono, poka-yoke, arqueo por denominación). **Analytics/tablas densas §7** para `analisis-semanal`.

## Inventario (6 pantallas + 2 componentes + estado compartido)

| # | Ruta | Componente | Permiso | Pre-flag grep (hex crudo / controles raw) |
|---|---|---|---|---|
| 1 | `/tienda/live` | `tienda-live` | `STORE_LIVE_VER` | **limpio** (0 / 0) |
| 2 | `/tienda/branches` | `tienda-branches` | `STORE_LIVE_VER` | **limpio** (0 / 0) |
| 3 | `/tienda/pace` | `tienda-pace` | `STORE_LIVE_VER` | **limpio** (0 / 0) |
| 4 | `/tienda/etiquetas` | `tienda-etiquetas` | `STORE_LABELS_VER` | ⚠️ 5 hex · 3 controles raw |
| 5 | `/tienda/arqueo` | `tienda-arqueo` | `STORE_ARQUEO_CAPTURAR` | 🔴 **17 hex · 11 controles raw** (peor deuda) |
| 6 | `/tienda/analisis-semanal` | `tienda-weekly` | `STORE_ANALYTICS_VER` | ⚠️ 13 hex · 4 controles raw |
| C1 | (print) | `components/label` | — | ⚠️ 4 hex (revisar si es hoja de papel = literal legítimo §12b) |
| C2 | — | `tienda-shared.css` | — | revisar tokens compartidos |
| — | — | `tienda-state.service` · `store-socket.service` · `arqueo/weekly/etiquetas.service` | — | lógica (WS, frescura, optimistic) — soporta §6/§13 |

---

## Las 14 reglas (qué mirar en cada pantalla)

1. **Surface correcto** — Operations. Cero Fraunces/Poppins display, cero ilustración editorial.
2. **Cero hex crudo** — todo por token 3-tier; estados = alpha-overlay sobre `--ink-rgb`. (Pre-flag: arqueo/weekly/etiquetas/label fallan.)
3. **PrimeNG-first** — `<table>`→`p-table`, `<select>`→`p-select`/`p-selectButton`, `<input>`→PrimeNG, `<button>`→`p-button`/`.btn-*` tokenizado. (Pre-flag: arqueo/etiquetas/weekly tienen controles raw.)
4. **Tipografía por rol** — body Hanken · cifras/folio/SKU/dinero Geist Mono con `tabular-nums` **obligatorio**. Crítico en tickets, totales, arqueo, KPIs.
5. **Color disciplinado** — sunset `--action` solo en CTA/activo/foco; semánticos vía `p-tag [severity]` (nunca hex). Alertas (`live`), estado de arqueo (cuadra/difiere), delta semanal → `p-tag`, no color inline.
6. **Matriz de estados** — hover · focus-visible (ring) · active (touch) · disabled · **loading (skeleton, no spinner)** · **empty con CTA de dominio** · **error de red ≠ empty** (`catchError`+banner+reintento) · overflow. `live` ya tiene empties ("Aún sin ventas hoy…") — validar que WS caído muestre error, no empty.
7. **Datos densos** — elevación borde 1px **o** sombra (nunca ambas); `--row-h-*`; header sticky + 1ª col congelada; **nada de zebra**; paginar la bandeja auditable. Aplica fuerte a `weekly` y a la lista de tickets de `arqueo`.
7b. **Cards del repertorio** — KPIs = `MetricCard`/`MetricStrip`, cero `p-card` plana ni stat-card suelta; variedad por dato (no 4 idénticas). `live` usa `MetricCard` ✅ — validar `branches`/`pace`/`weekly`.
8. **Motion con techo** — 150/250/**350ms**, solo `transform`+`opacity`, `prefers-reduced-motion`, callbacks WS `runOutsideAngular`, cleanup en `DestroyRef`. El `.flash` del ticker y el `.peak` de barras deben respetar el techo y reduced-motion.
9. **Reutilizable = `libs/` + `@container`** — componente embebido reacciona a container query, no viewport. Revisar `metric-card`/`label` si se reusan.
10. **Dominio + seguridad** — `currency:'MXN'`/pipes es-MX, **TZ ya normalizada en backend, no re-convertir con `new Date()`** (crítico: `hora()`, `idleMin()`, `lastLabel()` en el service). Filtro de sucursal en URL. Cero `[innerHTML]` sin sanitizar (label de impresión).
11. **a11y AA** — `aria-label` en icon-buttons, foco al abrir/cerrar dialog, targets ≥44px en touch (arqueo se captura en tablet/mostrador → `pointer: coarse`).
12. **Verificá** — `nx build view --skip-nx-cache`; QA **light + dark + móvil** con datos reales extremos (sucursal sin ventas, ticket de 40 líneas, arqueo que no cuadra).
12b. **Dark SIEMPRE** — solo tokens que flipean; sombras casi desaparecen en dark → profundidad = borde 1px. Verificar los hex de arqueo/weekly no rompan dark. `label` impresión puede quedar en literal (hoja de papel) — justificar.
13. **Interacción resiliente** — **arqueo**: estado sucio + `CanDeactivate`/`beforeunload`, botón guardar auto-deshabilitado **síncrono** al 1er clic (anti doble-corte), poka-yoke en denominaciones, arqueo por denominación. **live**: frescura ("hace N min" — ya hay `lastLabel`/`idleMin`; considerar `FreshnessPill`), scroll anclado en inserts vivos del ticker.
14. **Layout por sector** — POS/Mostrador keyboard-first en arqueo (foco en captura, total domina); monitor con feed al tope en live; `<app-context-help>` desde diccionario versionado si hay reglas de negocio (p.ej. qué cuenta como "cuadra", denominaciones, qué es un arqueo ciego). No inventar texto de ayuda.

---

## Matriz de seguimiento (llenar en la pasada)

Leyenda por celda: ⬜/🔨/✅/⚠️/➖

| Regla | live | branches | pace | etiquetas | arqueo | weekly |
|---|---|---|---|---|---|---|
| 1 Surface | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 2 Cero hex | ⬜ | ⬜ | ⬜ | ⚠️ | ⚠️ | ⚠️ |
| 3 PrimeNG-first | ⬜ | ⬜ | ⬜ | ⚠️ | ⚠️ | ⚠️ |
| 4 Tipografía/tabular | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 5 Color/p-tag | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 6 Estados (empty≠error) | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 7 Datos densos | ➖ | ➖ | ➖ | ⬜ | ⬜ | ⬜ |
| 7b Cards repertorio | ⬜ | ⬜ | ⬜ | ➖ | ⬜ | ⬜ |
| 8 Motion techo | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 9 libs/@container | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 10 Dominio+seguridad | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 11 a11y AA | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 12 Build+QA 3 vistas | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 12b Dark | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| 13 Resiliente | ⬜ | ➖ | ➖ | ⬜ | ⬜ | ➖ |
| 14 Sector+help | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

## Orden sugerido de ataque

1. **arqueo** (peor deuda + es captura de dinero → riesgo real): 17 hex→token, 11 controles raw→PrimeNG, §13 completo.
2. **weekly** (13 hex, 4 raw, tablas densas §7).
3. **etiquetas** (5 hex, 3 raw; ojo `label` de impresión = posible literal legítimo).
4. **live / branches / pace** (limpios de hex/raw; falta pasar las reglas "blandas": §4 tabular, §5 p-tag en alertas, §6 error≠empty, §8 motion, §10 no `new Date()`, §13 frescura/scroll anclado, §14 context-help).

## Cierre (verificación grep obligatoria al terminar)

- [ ] `grep -E '#[0-9a-fA-F]{3,6}' apps/view/src/app/modules/tienda` → 0 (salvo `label` impresión justificado).
- [ ] `grep -E '<table|<select|<input|<button' apps/view/src/app/modules/tienda` → 0.
- [ ] `nx build view --skip-nx-cache` verde.
- [ ] QA visual light + dark + móvil (lo hace Edgar — no automatizable desde CLI).
