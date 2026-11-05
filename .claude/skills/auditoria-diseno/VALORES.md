# Valores de evaluación — el contrato entre diseño y desarrollo

> **Para quién:** quien diseña una pantalla de esta suite (en Figma, Stitch o papel) y quien la
> construye o la audita. Un valor de acá es **el mismo** para los tres: si el diseñador entrega
> 40 px de fila y el dev mide 40 px, no hay discusión.
>
> **Qué es:** el catálogo completo de §3d de [`SKILL.md`](SKILL.md). El método (niveles de
> evidencia, cruces, veredicto) vive allá; acá sólo los valores.
>
> ⚠️ **Copiados de su fuente el 2026-11-04.** Si una fuente cambia, **gana la fuente** y se corrige
> acá. Si dos fuentes se contradicen, el valor de esta tabla es el de **`tokens.css` o el estándar**
> (lo que de verdad se pinta, o la ley) y la contradicción queda en la última sección.

## Cómo se lee

| Columna | Qué dice |
|---|---|
| **Pasa** | el valor que aprueba el renglón. Cada renglón es un sí o no |
| **Nivel** | la evidencia mínima para afirmarlo: **A** pantalla viva · **B** base de datos · **C** código o tokens ([`SKILL.md` §1](SKILL.md)) |
| **Instrumento** | qué lo comprueba HOY. `check:x` = compuerta (frena lo **nuevo**, la deuda vieja está sellada) · *script §3c* = el de contraste, con sus controles · *a mano* = no hay instrumento |
| **Fuente** | la ley que cobra si falla. `STD` = `docs/ESTANDAR_DE_INTERFACES.md` · `DS` = `DESIGN.md` · `TBL` = `docs/DESIGN_TABLES.md` · `TOK` = `libs/design-tokens/tokens.css` · `WCAG` = WCAG 2.2 |

⛔ Un renglón que no se pudo medir se escribe **NO MEDIDO**, nunca ✓. ⛔ Una compuerta en verde
**no** prueba el renglón: casi todas miden **presencia** de una pieza, no que la pieza diga la verdad.

---

## 1. Veracidad — binarios, sin tolerancia

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Cifra del encabezado contra filas recorribles | **N = N**, o la pantalla declara el tope: «10 de 428 · 62 % del total» | B | `check:cifra` (sólo si el contrato trae `has_more`; 2 de 35 servicios lo traen) + Cruce 1 a mano | STD §1.2 · DS datos densos |
| Rótulo contra lo que muestra la celda | igual, leído por alguien ajeno al código | C | a mano (Cruce 2) | STD §1.1 |
| Dato no medido | `—` / «sin dato»; **nunca** `0` ni verde | B | a mano | STD §1.3 · ADR-056 |
| Error de lectura | pantalla de error con **Reintentar**, distinta del vacío | C | `check:pantalla` §2 (presencia de `app-load-state`) | DS §Ing.UI 2 |
| Pantalla, impreso y export | **mismo universo**, o la diferencia escrita | C | a mano (Cruce 5) | STD §1.5 |
| Número publicado | dice periodo y con qué se calculó | C | a mano | STD §1.6 |
| Gráfica con hueco | el hueco se ve; **nunca** se dibuja como 0 ni se interpola | A | a mano | DS §dataviz |
| Indicador sin meta definida | **sin** rojo ni verde: el color llega con la meta | C | a mano | DS anti-patrones |
| Número escrito por un LLM | **0** en pantalla: toda cifra sale de una consulta determinista | C | a mano | DS §IA |

## 2. Contraste y accesibilidad

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Texto normal | **≥ 4.5:1**, en claro **y** oscuro | C | script §3c (⛔ no hay compuerta: `[AUD.4]`) | WCAG 1.4.3 |
| Texto grande (≥ 24 px, o ≥ 18.66 px en negritas) | **≥ 3:1** | C | script §3c | WCAG 1.4.3 |
| Texto ≤ 14 px en celdas densas | **APCA Lc ≥ 75**; manda cuando difiere de WCAG | C | a mano | DS §Ing.UI 3 |
| Bordes de control, iconos con significado | **≥ 3:1** | C | script §3c | WCAG 1.4.11 |
| Anillo de foco | **2 px, ≥ 3:1**: `outline` con **`--focus-ring`** (sólido). `--action-ring` es el halo de `box-shadow`; como `outline` da **1.44:1** | C | `check:estilos`: `outline:none` sin `:focus-visible` = 0 · `outline` con el halo: trinquete en 39 (regla 5, desde el 2026-11-04) | TOK · DS §Acción |
| Foco tapado | **ninguna parte** del control enfocado queda bajo un encabezado pegajoso o una barra | A | a mano | WCAG 2.4.11 |
| Botón principal | claro: blanco sobre `#C8401A` = **5.00:1** · oscuro: `#18181B` sobre `#F05A28` = **5.23:1**. ⛔ Blanco sobre `#F05A28` da **3.39:1** | C | script §3c | TOK `[AUD.4]` 2026-10-26 |
| Texto atenuado | `--text-faint` claro `#6B6B74` (5.28:1) · oscuro `#8B8B94` (5.25:1) | C | script §3c | TOK |
| Texto deshabilitado | `rgba(ink, 0.45)` (exento de contraste, pero no se usa para dato) | C | a mano | TOK |
| `--warn-fg` / `--ok-fg` como texto | **nunca** (2.15 y 3.30 sobre blanco); para texto, `--warn-soft-fg` / `--ok-soft-fg` | C | script §3c · línea base: 336 y 280 usos | SKILL §3c |
| Objetivo táctil con `pointer: coarse` | **≥ 44 × 44 px** (`--tap-min`), también acciones de fila y overlays | A | a mano | TOK · TBL §5 |
| Objetivo con mouse | **≥ 24 × 24 px** | A | a mano | WCAG 2.5.8 · DS datos densos 13 |
| Color como único portador | **0** estados sin palabra o icono | C | a mano | STD §2.3 |
| `forced-colors` (Alto Contraste de Windows) | foco y estados visibles; `forced-color-adjust: none` **sólo** en gráficas | **A** (si no, NO MEDIDO) | ⛔ ninguno (la hoja `forced-colors.css` existe en las 3 apps) | DS · `libs/ui-web` |
| Zoom | `user-scalable=no` y `maximum-scale=1` **prohibidos** salvo justificación en el PR | C | a mano | DS · WCAG 1.4.4 |
| Reflujo | sin scroll horizontal de página a **320 px CSS** (zoom 400 %); las tablas pueden desplazarse dentro de su caja | A | a mano | WCAG 1.4.10 |
| Espaciado de texto forzado | no se corta nada con interlineado 1.5, párrafo 2×, letra 0.12 em, palabra 0.16 em | A | a mano | WCAG 1.4.12 |
| Movimiento reducido | con `prefers-reduced-motion`, fundidos de opacidad de baja amplitud (**reducido ≠ cero**) | C | a mano | DESIGN_FOUNDATIONS §7.2 |
| Tarea completa sin mouse | sí, y el atajo **escrito en pantalla** (`aria-keyshortcuts` + rótulo) | A | `check:teclado` (filas con `(click)` sin teclado) | STD §2.2 · DS |
| Foco al abrir y cerrar | entra al diálogo o panel, queda atrapado, `Esc` cierra, **vuelve al disparador** | A | a mano | DS §Ing.UI 3 |
| Etiqueta de campo | `<label for>` + `id` en todo input; `aria-label` en todo botón de icono | C | a mano | DS §Ing.UI 3 |
| Tablas | `scope="col"`, `caption` o `aria-label`, `aria-sort` en las ordenables, `<th>` vacío con `.sr-only` | C | a mano | TBL §5 |
| `aria-live` | **1 anuncio por cambio de estado**, no por tanda | C | a mano | SKILL §3c |
| Ayuda de términos | en `<app-context-help>` (diccionario versionado); **nunca** sólo en un `title` | C | `check:pantalla` P y TBL (advertencias) | STD §3.8 · DS §P |

## 3. Visibilidad y desglose

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Plegados al entrar con algo que define el estado | **0** | C | a mano (Cruce 4) | STD §2.1, §2.5 |
| Bloque plegado | dice, cerrado, cuánto hay adentro y si algo falló | C | a mano | STD §2.1 |
| Datos cortados con «…» (folio, razón social, SKU) | **0** | A | a mano | STD §2.5 |
| Cifras que animan al cargar | **0**: nacen con su valor final (`instant`) | C | a mano | STD §2.5 (gana sobre el *count-up* de DS, ver §17) |
| Total sin desglose en la misma pantalla | **0** | C | a mano | STD §2.5 |
| **Documento fuente** (factura, comprobante, póliza) | desde **cada** renglón donde aparece: su archivo (PDF o imagen) a **≤ 1 clic** del desglose, y su **folio interno + el del tercero** a la vista; sin archivo, el UUID o el motivo, **nunca un silencio** | B (cobertura) + A | a mano | Edgar 2026-11-04 · `diseno` §0a paso 7 |
| La misma pieza de detalle en todas las vistas | lo que trae el PDF impreso también se alcanza en pantalla | C | a mano (Cruce 5) | STD §1.5 |
| Razonamiento largo de la IA | plegado por default, y **nada crítico vive sólo en el chat** | C | a mano | DS §IA |
| Pantalla sin entrada en el menú | **0**: toda pantalla nueva va en la barra lateral, con su permiso **repartido** | C/B | `sidebar-tabs` (sólo pestañas, sin `:self`) | STD §2.4 |

## 4. Jerarquía y tipografía

**La escala real** (`TOK`):

| Rol | Token | Valor |
|---|---|---|
| Cifra titular — **una por vista** | `--fs-display` + `--fw-black` | 40 px / 800 |
| Título de página (Storefront) | `--fs-h1` | 30 px |
| Título de página (Operations) | `--fs-h2` | 20 px |
| KPI dentro de un panel | `--fs-lg` | 18 px |
| Título de panel | `--fs-h3` | 16 px |
| Cuerpo | `--fs-body` | 14 px |
| Celda de tabla (base Operations) | `--fs-sm` | 13 px |
| Metadato | `--fs-xs` | 12 px |
| Encabezado de columna / chip | `--fs-micro` + `--fw-medium`, versalitas +0.02–0.06 em | 11 px / 500 |
| Último recurso | `--fs-nano` | 10 px |
| Pesos | `--fw-regular/medium/bold/black` | **sólo 4**: 400 · 500 · 700 · 800 (800 sólo la cifra titular) |

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Tamaños fuera de la escala | **0** `font-size` literal | C | `check:estilos` (techo 2,680, frena si sube) | DS · TOK |
| Niveles de jerarquía | **3** declarados (primario · secundario · terciario), por tamaño + peso + `--fg-1/2/3`, **nunca por color** | C | a mano | DS Q.5 |
| Veredicto contra encabezado de columna | el veredicto **más grande** | C/A | a mano | SKILL §5 paso 2 |
| Primero la respuesta | la pantalla abre con `MetricStrip`, no con la rejilla | C | `check:pantalla` Q.1 (presencia) | STD §3.1 · DS Q.1 |
| Atenuados contra enfatizados | hay un ganador (caso: 41 contra 5) | A | a mano | STD §3.7 |
| Interlineado de tabla | **1.25–1.35** | C | a mano | DS datos densos 10 |
| Títulos | `text-wrap: balance` (≤ 4 líneas); párrafos y microcopia `pretty` | C | a mano | DS §R |
| Cifras, montos, cantidades, fechas, folios | **100 %** con `tabular-nums`, a la derecha (`.num` en `th` **y** `td`) | C | a mano | DS · TBL |
| Alfanumérico de > 6 caracteres (SKU, folio, RFC, UUID) | segmentado **sólo por CSS**: lo copiado sale sin adornos | A | a mano | DS §10.2 |
| Fuentes en Operations | Hanken Grotesk + Geist Mono; **0** Poppins / Fraunces | C | a mano | DS regla 4 |
| Iconos | **sólo PrimeIcons**; emojis fuera de la UI; nada de iconos en círculos de color | C | `sin emojis` (techo 75, sólo en push, fuera del CI) | DS · SKILL `diseno` |

## 5. Espacio, layout y responsivo

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Espaciado | sólo la escala de 4 px: `--sp-1…12` = 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 | C | a mano | TOK |
| Agrupación | por **espacio**; el borde o la caja, último recurso; margen entre grupos = **2×** la distancia rótulo ↔ campo | C | a mano | DS §Ing.UI 1 · §10 |
| Radios | `--r-sm/md/lg/xl/2xl` = 8 · 12 · 16 · 20 · 24 px y `--r-pill` (vendor: 10 · 14 · 18 · 22 · 26) | C | a mano | TOK |
| Color crudo | **0** hex en el componente | C | `check:estilos` (techo 1,396) · `check:tokens` (todo `var(--x)` existe) | DS regla 2 |
| Ancho máximo del contenido | **1,180–1,280 px** | A | a mano | DS |
| Maestro-detalle | lista lateral **280–320 px** pegajosa + resto flexible | A | a mano | DS |
| Panel de detalle lateral | **480–560 px**, desde la derecha, ~250 ms | A | a mano | DS datos densos 8 |
| Paleta de comandos `⌘K` | obligatoria con **≥ 20** destinos; modal de 560–640 px | C | a mano | DS datos densos 12 |
| Puntos de quiebre | en **`rem`**, nunca en px; un componente reutilizable usa `@container`, no `@media` de ancho | C | `check:estilos` (px = 0) · `check:pantalla` #9 (advertencia) | DS §R |
| `clamp()` | máximo **≤ 2.5×** el mínimo, con un término en `rem` | C | a mano | DS §R |
| Tabla ancha en estrecho | con `min-width ≥ 48rem` u **≥ 8 columnas**: `.dt-stack` (apila bajo **34rem** = 544 px) o `.dt-matrix-ok` si es pivote | C | `check:tables` | TBL §6 |
| Columnas congeladas en móvil | no se comen la pantalla (caso: 344 de 390 px = 88 %) | A | a mano | TBL |
| Navegación en móvil | barra inferior de **4** destinos + cajón de desborde | A | a mano | DS |
| Áreas seguras (vendor) | `env(safe-area-inset-*)` + `viewport-fit=cover` | C | a mano | DS §PWA |
| Documentos fiscales | división permanente; **nunca** un modal para leer un CFDI o una póliza | A | a mano | DS §O |

## 6. Elevación, capas y retroalimentación

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Superficie dentro de la página | línea de **1 px**, **sin** sombra | C | a mano | DS datos densos |
| Superficie flotante (menú, popover, modal, `⌘K`, toast, cajón) | `--shadow-float` + borde | C | a mano | DS · TOK |
| Profundidad en oscuro | la lleva el borde de 1 px (la sombra no se ve) | A | a mano | DS |
| Vidrio esmerilado (`backdrop-filter: blur`) | **0** | C | a mano | DS anti-patrones |
| Avisos y confirmaciones | `p-toast` y `p-confirmDialog`; **nunca** `alert()` / `confirm()` | C | a mano | SKILL `diseno` |
| Diálogos | `<dialog>` nativo; Popover + anchor positioning; **sin** posicionar con JS | C | a mano | DS §R |
| Ayuda contextual | ícono `?` en el encabezado de la sección; **nunca** se abre sola | A | a mano | DS §P |
| Estados de interacción | capas alfa sobre `--ink-rgb`: hover **0.045** · selección **0.07** · presión **0.09** | C | a mano | TOK |

## 7. Color

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Elementos con `--action` | **1 papel**: el único botón principal de la vista | A (contar) | a mano | STD §3.10 |
| Elementos con `--bad` | sólo lo que está mal **y** pide hacer algo | A | a mano | STD §3.10 |
| «Bien», «falta», lo elegido, hoy, el paso | **sin tono**: palabra, icono o peso | A | a mano | STD §3.10 (gana sobre los chips verde/ámbar de DS, ver §17) |
| Tonos por papel | **1 significado por tono** (caso: 44 elementos, 3 tonos, 16 papeles) | A | a mano | SKILL §3c |
| Acción destructiva | **nunca** `--action`; `--bad-fg` fantasma, separada de «Guardar», con confirmación o deshacer | C | a mano | DS §10.5 |
| Morado `#8b5cf6`, azul `#2563EB`, negro `#000` puro | **0** (excepción declarada: `--avatar-4`, ver §17) | C | a mano | CLAUDE.md |
| Oscuro de Operations | zinc: fondo `#09090B` · tarjeta `#18181B` · suelo `#111113` · borde `#27272A`; texto `#FAFAFA` / `#A1A1AA` | C | a mano | TOK (gana sobre «`#111111`» de DS, ver §17) |
| Selector del tema oscuro | cubre `:root` **y** `body` | C | a mano | TOK |
| Pruebas de color | **claro + oscuro + móvil**, las tres, cada vez | A | a mano | DS regla de QA |
| Color de grupo en una rejilla | determinista, tinte sutil, con leyenda, **nunca** único portador | A | a mano | DS Q.6 |
| Impresión | papel siempre claro; sin barra ni menú; encabezado de tabla repetido; filas sin partir; `print-color-adjust: exact` en estados; tamaños en px (no `--fs-*`) | A | a mano | DS |

## 8. Tablas

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Rejilla principal | `p-table`; `<table>` crudo sólo de apoyo; tabla de una columna = `<ul>` | C | `check:pantalla` O.4 | DS |
| Encabezado | **pegajoso** con scroll vertical; títulos de **1–2 palabras** | A | a mano | TBL §2.3 |
| Columna identificadora | congelada en scroll horizontal (sólo en rejillas anchas) | A | a mano | TBL |
| Separación de filas | divisor de 1 px; **sin cebra** | C | a mano | TBL (quiet-luxury 2026-06-23) |
| Alto de fila con mouse | 24 encabezado/chip · 32 auxiliar · **40 default** · 48 con avatar + 2 líneas · 64 Storefront/vendor; **nunca** dos densidades en una tarjeta | C | a mano | TOK · DS |
| Alto de fila con touch | **44 / 48** (lo sube `pointer: coarse`; no se promedia) | A | a mano | TOK |
| Paginación | del lado del servidor; **25** por default, opciones 25 / 50 / 100 / 200; transaccional o auditable: 25–50 | C | a mano | TBL §3 · DS |
| Virtualización | sólo listas exploratorias o **> 200 filas visibles** | C | a mano | DS |
| Orden | flecha visible + `aria-sort` + operable con Enter/Espacio; orden por default **el de la tarea** (caso: `/compras/oc-abiertas` abría por la más vieja) | A | a mano | TBL §4.1 · `diseno` §0b |
| Búsqueda | con *debounce* de **250 ms**, en vivo, sin botón; **nunca** `.toLowerCase().includes()` ni filtrar en el cliente una lista paginada | C | `check:busqueda` | TBL · DS D.8 |
| Selección | casilla + fondo teñido; barra de lote desde **≥ 1** fila | A | `check:teclado` (`pSelectableRow`) | DS |
| Acciones por fila | botones fantasma a la derecha, **≤ 3** compitiendo | A | a mano | DS · SKILL §3c |
| Edición en línea | Enter guarda · Esc cancela · Tab a la derecha | A | a mano | DS datos densos 9 |
| Filtros | rango de fechas arriba a la derecha; cuenta de filtros activos; «Limpiar» sólo si hay algo activo | A | a mano | DS |
| Desborde | montos de **8 dígitos** y nombres de **80** caracteres no rompen la columna | A | a mano | DS §Ing.UI 2 |
| Más de ~200 filas | latencia **medida** en el PR | A | a mano | DS §V |

## 9. Formularios y captura

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Validación | al **salir del campo**; enviar **deshabilitado** mientras sea inválido; el mensaje de error es el último recurso | A | a mano | STD §4.5 · DS §10.6 |
| Formatos guiados | máscara para RFC, teléfono e importe; **unidades** escritas | A | a mano | DS §10.6 |
| Entrada tolerante | acepta `1,250.00`, `$`, espacios; lo ambiguo (`03/04`) **se pregunta**, no se asume | A | a mano | DS §10 (Postel) |
| Teclado | foco al primer campo; Enter envía (salvo `textarea`); tabulación = orden visual | A | a mano | DS §10.7 |
| Captura numérica | `inputmode="numeric"`; sin flechitas del navegador (~9 px); la rueda no cambia el valor | A | a mano | DS |
| Datos ya capturados | **no se vuelven a pedir** en el mismo proceso: se proponen o se eligen | A | a mano | WCAG 3.3.7 · STD §4.7 |
| Cambios sin guardar | «¿Descartar cambios sin guardar?» al salir (`CanDeactivate` + `beforeunload`); `Esc` pregunta | A | a mano | DS §10.8 · STD §5.1 |
| Doble clic | todo botón que escribe se deshabilita **en el primer clic**, de forma síncrona | A | a mano | DS §10.11 |
| Resultado de un lote | «48 procesados · 2 fallaron»; los fallidos **quedan seleccionados** | A | a mano | DS §10.10 |
| Fechas de calendario | con `isoLocalDate()`; **nunca** `toISOString().slice(0,10)` (a las 18:00 ya es mañana) | C | a mano | DS |
| Selectores | **nunca** un `<select>` nativo junto a un `p-select`; **0** selectores de una sola opción | C | a mano | DS · STD §4.6 |
| Lo que se abre | no empuja lo que se está usando | A | a mano | STD §5.2 |

## 10. Texto, formatos y nombres

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Tratamiento | **tú** (tuteo mexicano), nunca «vos» en la interfaz | C | ⛔ `scripts/check-voseo.js` existe pero **no está conectado** | SKILL §9 · memoria |
| Vacío | ícono mediano + título neutro + descripción + **acción**: «Ninguna ruta registra actividad entre 01/06/26 y 08/06/26. [Ampliar a 30 días]»; **nunca** «No data found»; **no** centrado por default | A | a mano | DS §Ing.UI 7 |
| Error | qué pasó + **Reintentar** | A | `check:pantalla` §2 (presencia) | DS |
| Excepción | por nombre: «a 2 les falta la cuenta destino: X, Y» | A | a mano | STD §4.7 |
| Frescura | «actualizado hace N min»; sin hora del servidor, «cargado hace N»; **nunca** «Datos actualizados» con la hora del navegador. «hace 3 min» y «hace 9 h» se **ven** distinto | A | `check:pantalla` §9 (presencia de la píldora) | STD §3.6 · DS §10.9 |
| Umbral de dato añejo | ⚠️ **ningún número fijado**: cada pantalla pone su `staleAfterSec` y tiene que declararlo | C | a mano | (hueco de las fuentes) |
| Variación de un indicador | flecha + signo + número: `▲ +3.2%` | C | a mano | DS |
| Nombre de pantalla | sustantivo del dominio: «Por revisar» → **Revisión** | C | a mano | STD §3.9 |
| Sucursal y almacén | **por nombre**, nunca «07», «01» ni «00» (`{{ code \| sucursal }}`); el código sólo pegado a un folio | C | ⛔ `scripts/check-sucursal-pipe.js` existe pero **no está conectado** | SKILL `diseno` §4 |
| Moneda | `money()` (es-MX, MXN, 2 decimales); `moneyShort()` sólo en indicadores y ejes | C | a mano | `apps/view/.../money.util.ts` |
| Idioma de formato | `registerLocaleData(localeEsMx)` (⚠️ sólo `apps/view` lo registra; portal y vendor caen en en-US en silencio) | C | a mano | DS |
| `numeric` de Postgres | `Number()` antes de formatear (llega como texto) | C | a mano | SKILL `diseno` §4 |
| Versión nueva | «Hay una nueva versión — actualizar»; **nunca** recargar a la fuerza | A | a mano | DS §PWA |
| Sin conexión | aviso visible «sin conexión» | A | a mano | DS §PWA |

## 11. Carga y sencillez

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Prueba de la frase | **1 oración, sin «y»** | C | a mano | STD §4.0b |
| Elementos seguidos sin separador (campos, cifras) | **≤ 6** | C/A | ⛔ ninguno (`[AUD.5]`) | STD §4.1 · DS §10.2 |
| Controles que compiten por renglón | **≤ 3** | A | a mano | SKILL §3c |
| Acciones primarias por vista | **1** | A | a mano | STD §4.4 |
| El mismo dato repetido | **1 vez** (caso: «31 pagos» ×6) | A | a mano | SKILL §3c |
| Avisos visibles a la vez | **1** compitiendo por «lo primero» | A | a mano | SKILL §3c |
| Clics que sólo confirman lo que el sistema ya sabía | **0**, contando el proceso con **N registros** | A | a mano | STD §4.7 |
| Endpoints que la pantalla no ofrece | **0** acciones del backend sin botón (caso: `fallo` y `cerrar` en Pagos) | C | a mano | STD §4.7 |
| Promos en Storefront | 1 por pliegue; venta cruzada = 3 productos | A | a mano | DS Storefront |

## 12. Movimiento

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Duraciones | `--dur-micro` 120 · `--dur-short` 150 · `--dur-standard` 250 ms | C | a mano | TOK |
| Techo | **350 ms** en Operations y vendor (el portal queda fuera a propósito) | C | `check:motion` (duro) | DS §Motion |
| Qué se anima | **sólo `transform` y `opacity`**; barras con `scaleX()`, nunca `width` | C | `check:motion` (propiedades de layout: techo 48) | DS datos densos 11 |
| Respuesta al tocar (`:active`) | **≤ 100 ms** | A | a mano | DS §Ing.UI 2 |
| Indicador de espera | esqueleto del tamaño real; ruedita **sólo en línea** y < 300 ms; nada de ruedita de bloque | A | a mano | DS datos densos |
| Esqueleto → dato | fundido de **~180 ms** | A | a mano | DS |
| Curva de resorte | sólo en gestos de arrastrar para cerrar | C | a mano | TOK |
| Animación que no codifica un dato | **0** | C | a mano | STD «Lo que NO es perfección» |
| Biblioteca de animación | ninguna nueva; GSAP sólo con `import()` diferido | C | a mano | DS |

## 13. Gráficas

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Eje de barras | arranca en **0**, sin excepción; el de líneas puede recortarse si lo dice | A | a mano | DS §dataviz |
| Color de serie | `--chart-1…8` en orden, **fijo por categoría** | C | a mano | DS |
| Rótulos | ≤ 4 series → rótulo directo; leyenda ordenada por valor | A | a mano | DS |
| Prohibidas | dona de > 5 rebanadas, dona para comparar, doble eje, degradado decorativo bajo una línea | C | a mano | DS |
| Unidad | eje de tiempo completo; unidad y moneda escritas; píldora de frescura también en gráficas | A | a mano | DS |
| Biblioteca | micro-gráficas en SVG crudo (0 KB); uPlot sólo para series interactivas | C | a mano | DS |

## 14. Superficies de IA

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Identidad | degradado ember 135° `#F8B400 → #F05A28` + sello ✦: se ve como **propuesta de un motor**, no como dato | A | a mano | DS §Color IA |
| Plan propuesto | «Proceder / Editar / Lo hago yo»; **nunca** «listo, ya lo hice» primero | A | a mano | DS §IA |
| Confianza | en forma perceptible, no sólo un número | A | a mano | DS §IA |
| Deshacer | ventana explícita («hasta el cierre del día») | A | a mano | DS §IA |
| Progreso | honesto («buscando en 3 fuentes…»); sin ruedita opaca | A | a mano | DS §IA |
| «No sé» | el chat puede decirlo | A | a mano | DS §IA |
| Dinero o terceros | **nunca** autónomo por default | C | a mano | DS §IA |

## 15. Rendimiento — los de la suite, no los de la literatura

| Parámetro | Pasa | Nivel | Instrumento | Fuente |
|---|---|---|---|---|
| Consulta que corre al **cargar** la vista | **< 500 ms**, la del service real (`EXPLAIN (ANALYZE, BUFFERS)`) | B | a mano | regla de Edgar, 2026-10-06 |
| Respuesta a una interacción | **INP < 200 ms**, medido | A | telemetría `web_vital` (p75 en `GET /telemetry/portal/summary`, ⚠️ mezcla portal y suite) | DS §V |
| Pérdida del hilo | ~400 ms: arriba, la persona reconstruye la tarea | — | — | DS §Ing.UI 1 (Doherty) |
| Saltos de diseño | **CLS 0** | A | telemetría `web_vital` | DS §V |
| Retardo artificial | **0** | C | a mano | STD §5.3 · ADR-056 |
| Peso que viaja sin pintarse | **0 %** de columnas que la vista no usa (caso: 98.8 % eran firmas) | B | a mano (Cruce 6) | STD §5.5 |
| Paquete de `apps/view` | aviso a **1 MB**, error a **1.4 MB** | C | build del CI | DS |
| Errores por ruta | un 4xx alto en una ruta es defecto de pantalla | B | `analytics.ui_usage` (`.claude/skills/pm/uso.js`) | `errores-a-issues.js` |

## 16. Pruebas con personas — referencia externa

La suite **no mide hoy** tiempo de tarea, éxito de tarea ni abandono: la telemetría de `apps/view`
registra sólo aperturas desde «Mi trabajo», web vitals y un incidente. Cuando se haga una prueba
con usuarios reales, estos son los promedios publicados contra los que se compara. Son **promedios
de la industria, no umbrales de esta suite**:

| Métrica | Promedio de referencia | Fuente |
|---|---|---|
| SUS (escala de usabilidad, 0–100) | **68** = la media; abajo de 68, peor que el promedio | MeasuringU, 500 estudios |
| Éxito de tarea | **78 %** | MeasuringU, > 1,100 tareas |
| SEQ (facilidad de la tarea, 1–7) | **5.5** (corregido en 2022; antes 4.8) | MeasuringU |

⭐ En esta suite la métrica de tarea que manda es otra, y ya está arriba: **clics para terminar el
proceso con N registros** (§11), contados en la pantalla viva.

## 17. Contradicciones entre fuentes (detectadas el 2026-11-04)

Ninguna se resolvió todavía; son deuda de documentación con nombre. Esta tabla usa el valor de la
columna «Se usa». Corregir la fuente perdedora es trabajo aparte.

| # | Tema | Una fuente dice | La otra dice | Se usa |
|---|---|---|---|---|
| 1 | Oscuro de Operations | DS: «zinc neutro `#111111`» | TOK: `#09090B` / `#18181B` / `#111113` (y dice que `#111111` se reemplazó) | TOK |
| 2 | Oscuro de Storefront | TOK y DESIGN_FOUNDATIONS: espresso `#16130F` | TOK más abajo: retirado | ⚠️ sin resolver: medir el portal |
| 3 | `--warn-fg` | DS: `#D97706` | TOK: `#F59E0B` | TOK |
| 4 | Fila en móvil | DS y DESIGN_FOUNDATIONS: 40 escritorio / **56** móvil | TOK: `coarse` 44 / 48 | TOK |
| 5 | Token del anillo de foco | DS datos densos 13: `--action-ring` | TOK y DS §Acción: `outline` → `--focus-ring` (el otro da 1.44:1) | TOK |
| 6 | Cifras que cuentan | DS: *count-up* ~900 ms al entrar | STD §2.5: la cifra nace con su valor final | STD (gana por ley) |
| 7 | Morado | «sin morado» | TOK `--avatar-4` `#7E22CE` / `#C084FC` | excepción a declarar o a quitar |
| 8 | Acento | `--action`, único acento | TOK `--c-accent` = ámbar de marca («PENDIENTE DE DECISIÓN») | `--action` |
| 9 | Botón de IA en el portal | DS: degradado ember | DS en otro lugar: «carbón, ya no es degradiente» | ⚠️ sin resolver |
| 10 | «Bien» y «falta» | STD §3.10: sin tono | DS: chips verde / ámbar | STD |
| 11 | Panel lateral | DS §R ejemplo: ~420 px | DS datos densos 8: 480–560 px | 480–560 |
| 12 | Detalles | interlineado de tabla 1.2–1.3 (FND) contra 1.25–1.35 (DS) · curva estándar distinta en FND y TOK · FND conserva la escala de espacio vieja `--space-*` | — | DS y TOK |

## 18. Lo que todavía no tiene instrumento

Para que nadie dé por medido lo que no se mide:

- **Contraste**: ninguna compuerta (`[AUD.4]`). Tampoco `forced-colors`, axe, pa11y ni Lighthouse en el repo.
- **Sencillez** (Miller, Hick, Tesler, Von Restorff): ninguna (`[AUD.5]`).
- **`check:pantalla`** mira sólo `apps/view` y **no corre en el CI** (sólo en el push local); vendor y portal no tienen contrato de pantalla.
- **Tuteo y sucursal por nombre**: los scripts existen (`check-voseo.js`, `check-sucursal-pipe.js`) y **no están conectados** a ningún carril.
- **Regresión visual**: no existe (ni capturas comparadas ni Storybook). Las pruebas e2e de Playwright corren a mano.
- **Integración con herramientas de diseño**: no hay exportación de tokens en JSON (DTCG) para Figma o Tokens Studio; es el pendiente **DT.5**. Hoy el diseñador copia los valores **de esta tabla** o de `tokens.css`.
- **Tiempo de tarea y abandono**: la telemetría no los registra (§16).
- **Accesibilidad**: de los 24 parámetros de §2, **3 tienen compuerta**; la propuesta (axe dentro de
  las pruebas e2e) está en [`SKILL.md` §8](SKILL.md).
- **Retrabajo**: sus parámetros están repartidos en §9 (cambios sin guardar, doble clic, lote
  parcial, dato pedido dos veces, validación) y §11 (clics que sólo confirman, acciones sin botón).
  El recorrido para auditarlo está en [`SKILL.md` §3c](SKILL.md). **No hay métrica en
  producción**; las tres señales propuestas, y lo que falta para creerlas, en `SKILL.md` §8.
