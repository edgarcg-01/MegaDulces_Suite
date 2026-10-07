# Fase Etiquetas — Plan de correcciones (impresión + datos + a11y)

> Correcciones sobre la etiquetera de anaquel (`/tienda/etiquetas`). Errores detectados en uso real + auditoría de datos en prod (Railway) el 2026-07-10. Base: `LabelComponent` (`apps/view/.../tienda/components/label.component.ts`) + página (`.../pages/tienda-etiquetas.component.ts`) + importer (`database/importers/kepler/import-label-data.js`) + tabla `commercial.product_label_prices`.

Estado: **🔨 EN CÓDIGO (2026-07-10)** — F1/F2/F3/F4/F8/F-Scan ✅ (label verificado con testigo 78148 + caso extremo $342k). F5 ✅ parcial (guarda de label; decode importer diferido). F6 ✅ (anillo de foco en nav; falta verificar teclado en localhost desktop). F7 ✅ decidido (sin código). **Todo compilado; pendiente push + redeploy + validación en localhost.**

### Progreso por fase
- **F1** ✅ Ocultar tiers sin dato (`hasMayoreoPza/Paquete/MayoreoPaq/Caja/Barcode` data-driven).
- **F2/F8** ✅ Hero = precio de pieza + fallback (paq→caja) si pieza 0. Verificado: 78148 → $37.33.
- **F3** ✅ Auto-fit hero (`fitPrice`, offsetWidth×1.12 por el scaleX) + montos de tier (`fitAmts`). Verificado: $342,299.99 encoge y cabe.
- **F4** ✅ Separador de miles en el hero (regex de agrupación) — unificado con los tiers.
- **F-Scan** ✅ Campo `#scanInput` autofocus; `onScan()` al Enter resuelve (SKU 5díg / barcode 8-13, backend acepta ambos), agrega, limpia y re-enfoca. Falta prueba con pistola real.
- **F5** ✅ parcial — guarda en label: un mayoreo solo se muestra si `< precio base` (oculta 68 mayoreo-pza + 13 mayoreo-paq ilógicos). **Diferido:** el decode de `pack_price` equivocado en estuche/granel/display (repetidos $667.69/$1177.15) requiere revisar el importer contra Kepler on-prem.
- **F6** ✅ Anillo `focus-visible` en items del nav lateral. **Nota:** la expansión del sidebar por teclado (`onSidebarFocusIn` gateado por `keyboardFocus`) NO se tocó — parece funcionar por diseño en desktop; las "fallas" observadas fueron artefacto de headless en 508px (mobile) + bundle viejo. Verificar en localhost desktop.
- **F7** ✅ Decisión: NO se hace PDF rasterizado (degradaría calidad). La impresión ya es **vectorial**; PDF exacto vía "Guardar como PDF" del diálogo; manos-libres vía `chrome --kiosk-printing`. Ver §3.

---

## Ejemplo testigo (SKU 78148 — "GOMA CHAROLA SURTIDA D ELIZ /40")

Un solo label concentra 4 errores:
```
piece_price   37.33     ← precio por pieza (legible)
pack_size 30, pack_price 1044.00  → $34.80/pza
wholesale_piece null      → "MAYOREO 3 PZAS: $0.00"   (A1)
box_size 0, box_price 0    → "CAJA (0 PZAS): $0.00"    (A1+A2)
wholesale_pack 34.80       → es el $/pieza, mal rotulado "c/u paquete" (A4)
unit_base PAQ → hero=pack_price 1044 → "$1044.00" DESBORDA la caja (B1)
```

---

## 1. Catálogo de errores

Leyenda tipo: **CÓDIGO** (label/página Angular) · **DATOS** (importer/decode Kepler) · **OPS** (impresora/navegador).

### A. Datos / precios en la etiqueta
| # | Sev | Error | Cuántos (prod) | Causa raíz | Tipo |
|---|---|---|---|---|---|
| **A1** | 🔴 alta | Tiers se pintan en `$0.00` (no se ocultan sin dato) | 6,780 mayoreo-pza · ~5,989 caja (PAQ) · 1,175 mayoreo-paq | El template gatea el tier solo por el multiselect, nunca valida `precio > 0` | CÓDIGO |
| **A2** | 🔴 alta | Cantidad inválida `(0 PZAS)` / `( PZAS)` | 7,647 box_size · 788 pack_size en 0/null | Se pinta `size` sin validar | CÓDIGO |
| **A3** | 🟠 media | Precio grande en `$0.00` | 84 | `bigUnit` toma el campo de `unit_base` sin fallback (ej. CJA con box=0 ignora pieza=$81) | CÓDIGO |
| **A4** | 🟠 media | **Precios que no cuadran** | 68 mayoreo-pza > menudeo · 80 paq/pza > pieza · 13 mayoreo-paq > paq · 5 caja · 36 pieza ≥ $1,000 | Decode de tiers Kepler no confiable en estuche/granel/display; `pack_price` repetido en productos distintos ($667.69, $1177.15) = fila equivocada | DATOS |

### B. Render / desbordes
| # | Sev | Error | Datos | Causa raíz | Tipo |
|---|---|---|---|---|---|
| **B1** | 🔴 alta | Precio grande se sale del recuadro | hero PAQ usa `pack_price`, máx **$342,299.99** | Fuente fija 16 mm; sin auto-ajuste | CÓDIGO |
| **B2** | 🔴 alta | Precio de tier desborda su celda de 20 mm | 2,426 paquete + 218 caja + 36 pza ≥ $1,000 (máx $6,270) | `pricecell` ancho fijo sin auto-ajuste | CÓDIGO |
| **B3** | 🟢 baja | Formato de miles inconsistente (tiers con coma, hero sin coma) | — | Pipe `number` vs `toFixed` | CÓDIGO |

### C. Semántica de unidad
| # | Sev | Error | Datos | Causa raíz | Tipo |
|---|---|---|---|---|---|
| **C1** | 🟢 baja | `unit_base` no mapeados → título "Precio por pieza" incorrecto | ~150 (`500/250/400/2KG/SER/BTO/CUB/IND/null`) | `bigUnit` solo mapea PZA/PAQ/KG/CJA/BTO/CUB | CÓDIGO |

### D. Accesibilidad de teclado
| # | Sev | Error | Evidencia | Tipo |
|---|---|---|---|---|
| **D1** | 🟠 media | Indicador de foco invisible | `outline: solid 1.6px rgba(0,0,0,0)` en el input de búsqueda | CÓDIGO |
| **D2** | 🟠 media | Nav lateral inalcanzable por teclado (colapsado) | `navLinksVisibleCount = 0`; los links solo aparecen al hover con mouse | CÓDIGO |
| **D3** | 🟢 baja | Cola (copias/eliminar) y multiselect sin operación clara por flechas; sin "saltar al contenido" | — | CÓDIGO |

### E. Impresión (OPS — límite del navegador)
| # | Error | Detalle |
|---|---|---|
| **E1** | La web no puede forzar impresora | No se puede fijar por código: tamaño de papel, orientación, calidad/DPI, márgenes ni seleccionar impresora. Solo `@page` (sugerencia) + `print-color-adjust:exact` (ya aplicados). |
| **E2** | Falta salida garantizada | El diálogo/driver puede variar la salida. Alternativas robustas: **Chrome `--kiosk-printing`** (salta diálogo, usa default) o **generar PDF** con geometría exacta. |

### N. Escáner / captura
| # | Sev | Error | Datos | Tipo |
|---|---|---|---|---|
| **N4** | 🔴 alta | Carga por escáner falla; falta auto-agregar | SKU = 5 díg (8,008/8,013); barcode = 8/12/13 díg; **sin traslape** → clasificación por longitud es segura. El backend `resolve` ya acepta SKU o barcode. | CÓDIGO |

---

## 2. Plan de corrección (fases)

| Fase | Arregla | Qué se hace | Tipo | Depende |
|---|---|---|---|---|
| **F1** | A1, A2 | Ocultar cada tier si `precio ≤ 0` o `size ≤ 0` (data-driven, además del multiselect) | CÓDIGO | — |
| **F2** | A3 | `bigUnit` con fallback: si el precio de la unidad base es 0/null, usar el primer precio > 0 (pieza→paq→caja) y ajustar el título | CÓDIGO | — |
| **F3** | B1, B2 | Auto-ajuste de fuente (patrón `fitHead`): hero y montos de tier se encogen hasta caber; nada desborda | CÓDIGO | — |
| **F8** | B1 (raíz) | **Decisión:** precio grande = **precio de pieza** (legible; recom.) vs precio de la unidad base (paquete → desborda). Testigo 78148: pieza $37.33 vs paquete $1044 | DECISIÓN | bloquea F2/F3 |
| **F-Scan** | N4 | Campo dedicado **"Escanear"** (single-line, autofocus, sin autocomplete): en cada Enter clasifica por longitud (5→SKU, 8/12/13→barcode), `resolve`, agrega a la cola (suma copias), limpia y re-enfoca; feedback por escaneo. La textarea de pegado masivo se mantiene | CÓDIGO | — |
| **F4** | B3, C1 | Formato de miles unificado + mapa completo de `unit_base` (con "unidad" genérico de respaldo) | CÓDIGO | — |
| **F6** | D1, D2, D3 | Pasada a11y: foco visible real, nav lateral alcanzable por teclado, operar cola/multiselect por flechas + skip-link | CÓDIGO | — |
| **F5** | A4 | Re-verificar el decode de tiers Kepler para estuche/granel/display; corregir/ocultar precios ilógicos (mayoreo > menudeo, paq/pza > pieza). Requiere revisar el importer contra Kepler | DATOS | importer |
| **F7** | E1, E2 | Evaluar salida **PDF** (jsPDF/pdfmake) para tamaño/calidad garantizados; documentar límites del print del navegador; opción kiosk-printing | CÓDIGO/OPS | — |

### Secuencia recomendada
`F8 (decisión)` → `F1` → `F2` → `F3` → `F-Scan` → `F4` → `F6` → `F5` → `F7`.

Racional: F1+F2+F3 matan lo visible (los `$0.00`, `(0 pzas)` y desbordes) y dependen de F8 (qué precio es el hero). F-Scan desbloquea el uso real con pistola. F5 (decode) es el más profundo y toca el importer/datos. F7 es mejora de robustez.

---

## 3. Estándar de impresión (configurar una vez en el diálogo/driver)

| Ajuste | Valor |
|---|---|
| Papel | **Carta / Letter** (216×279 mm) |
| Orientación | **Horizontal (Landscape)** |
| Escala | **100% / Tamaño real** (NUNCA "Ajustar al área" — deforma los mm) |
| **Gráficos de fondo** | **ACTIVADO** (sin esto no salen verde/amarillo) |
| Color | **Color** |
| Márgenes | **Predeterminado** (empata con `@page` 8 mm) |
| Encabezados y pies | **Desactivado** |
| Calidad | **Alta / 600 dpi** (el label es vectorial → nítido a cualquier DPI) |

---

## 4. Pendientes de deploy (previo a estas fases)
Ya en árbol, sin push/redeploy: fixes de acceso (superroot ve Etiquetas, redirect `/tienda`), gramaje (LITROS + refresh prod — data ya aplicada), acentos naranja, Bebas Neue en tiers, `text-align:left` reset del label. Requieren **push + redeploy del `view`** + (los de acceso) surten sin re-login.
