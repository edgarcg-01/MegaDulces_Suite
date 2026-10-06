---
name: Mega Dulces — Mercado (Operations)
colors:
  background: '#F4F4F5'
  surface: '#FFFFFF'
  surface-container: '#F4F4F5'
  outline: '#E4E4E7'
  on-surface: '#09090B'
  on-surface-variant: '#52525B'
  on-surface-faint: '#A1A1AA'
  primary: '#F05A28'
  primary-hover: '#D2451C'
  primary-press: '#B83C15'
  on-primary: '#FFFFFF'
  ai-accent: '#F05A28'
  ai-gradient-from: '#F8B400'
  ai-gradient-to: '#F05A28'
  info: '#2563EB'
  dark-background: '#09090B'
  dark-surface: '#18181B'
  dark-outline: '#27272A'
  dark-on-surface: '#FAFAFA'
  dark-on-surface-variant: '#A1A1AA'
  dark-on-surface-faint: '#71717A'
typography:
  display:
    fontFamily: Hanken Grotesk
    fontSize: 40px
    fontWeight: '700'
  title-page:
    fontFamily: Hanken Grotesk
    fontSize: 20px
    fontWeight: '700'
  title-panel:
    fontFamily: Hanken Grotesk
    fontSize: 16px
    fontWeight: '600'
  body:
    fontFamily: Hanken Grotesk
    fontSize: 14px
    fontWeight: '400'
  table-cell:
    fontFamily: Hanken Grotesk
    fontSize: 13px
    fontWeight: '400'
  meta:
    fontFamily: Hanken Grotesk
    fontSize: 12px
    fontWeight: '400'
  label-caps:
    fontFamily: Hanken Grotesk
    fontSize: 11px
    fontWeight: '600'
    letterSpacing: 0.04em
  data:
    fontFamily: Geist Mono
    fontSize: 13px
    fontWeight: '400'
spacing:
  sp-1: 4px
  sp-2: 8px
  sp-3: 12px
  sp-4: 16px
  sp-5: 20px
  sp-6: 24px
  sp-8: 32px
  sp-10: 40px
  sp-12: 48px
radius:
  sm: 8px
  md: 12px
  lg: 16px
  pill: 999px
---

# Mercado — el sistema de diseño de Mega Dulces

> ⛔ **Este archivo es DERIVADO. No se edita a mano.**
> La fuente de verdad son [`DESIGN.md`](../../DESIGN.md) (1,562 líneas) y
> [`libs/design-tokens/tokens.css`](../../libs/design-tokens/tokens.css) (647 líneas), que es el
> archivo único de las tres apps. Esto es el extracto que se le entrega a Stitch, porque el
> `DESIGN.md` completo pesa 238 KB y lo que Stitch consume ronda los 10 KB. Si cambia un token,
> se cambia en `tokens.css` y se vuelve a destilar acá — nunca al revés.

## Un sistema, dos superficies

| | Storefront | Operations |
|---|---|---|
| App | `apps/portal` (portal B2B) | `apps/view`, `apps/vendor` |
| Modo | storefront + herramienta | **sólo herramienta** |
| Decoración | intencional (ilustraciones SVG, eyebrows) | **nula** |
| Fuente display | Poppins | **ninguna** |
| Densidad | comfortable | **compact++** |

Comparten: neutrales zinc, el naranja de acción, la identidad de IA ámbar, la escala de radios,
los tokens semánticos y la tipografía de cuerpo y de dato.

**La regla en una línea: Operations es el portal sin storefront. Mismo lenguaje, menos drama.**

Casi todo lo que se diseña acá es **Operations**. Si no se dice lo contrario, es Operations.

## La tesis: esto es serio

Operations es la herramienta con la que alguien trabaja ocho horas, no una página que convence a
nadie de nada. De ahí salen las reglas duras:

- **El organismo principal es la tabla densa con master-detail**, no la tarjeta. Una tarjeta por
  registro desperdicia el ancho y obliga a recorrer de arriba abajo lo que una tabla deja comparar
  de un vistazo.
- **El encabezado de página va en Hanken Bold**, nunca en una fuente display.
- **Nada de ilustraciones, nada de momentos editoriales, nada de adorno en reposo.**
- **Iconos, nunca emojis.**
- **El borde es el último recurso.** Una caja dentro de otra caja del mismo color no se separa con
  un borde: se separa con fondo, con espacio o con tipografía.
- **El color codifica DATO, no decoración.** Un color que no significa nada no entra.

## Color

El acento es **sunset `#F05A28`**. La calidez de la marca vive en el acento, no en el sustrato:
el fondo es neutro y el color se gana la pantalla por acento.

Los neutrales son **una sola familia en toda la suite: Zinc**, en las tres apps y en los dos modos.

| | Claro | Oscuro |
|---|---|---|
| fondo | `#F4F4F5` | `#09090B` |
| tarjeta | `#FFFFFF` | `#18181B` |
| borde | `#E4E4E7` | `#27272A` |
| texto 1 / 2 / 3 | `#09090B` · `#52525B` · `#A1A1AA` | `#FAFAFA` · `#A1A1AA` · `#71717A` |

**Vetados, por decisión explícita:**

- ⛔ **Morado `#8b5cf6`** — es la identidad genérica de «IA» y acá la IA ya tiene la suya.
- ⛔ **Azul `#2563EB` como color de acción** — es el azul de aplicación por defecto; sólo vive como
  color informativo.
- ⛔ **Negro puro `#000`** — el oscuro es zinc `#09090B`.

**La IA tiene identidad propia: ámbar.** Degradado `#F8B400 → #F05A28`. Todo lo que genera o sugiere
un modelo se marca con eso, y se distingue de lo que midió el sistema.

## Tipografía

**Hanken Grotesk** para todo (cuerpo e interfaz) y **Geist Mono** para el dato.

⚠️ Ninguna de las dos está en el catálogo de Stitch. Si hay que sustituir: la más cercana a Hanken
Grotesk es **Public Sans** o **Inter**; a Geist Mono, **JetBrains Mono**. Es una sustitución **del
mockup**, no del sistema — el código usa las de arriba.

| Nivel | px | Para qué |
|---|---|---|
| display | 40 | la cifra titular, **UNA por vista** |
| título de página | 20 | Hanken Bold |
| título de panel | 16 | |
| cuerpo | 14 | el default |
| celda de tabla | 13 | **la base de Operations** |
| metadato | 12 | |
| etiqueta en mayúsculas | 11 | |

Los números que se comparan van en **Geist Mono con cifras tabulares**: una columna de importes que
no alinea el punto decimal no se puede leer en diagonal, que es para lo que existe la columna.

## Espacio, forma y movimiento

Escala de espaciado de 4 px: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48.

Radios: 8 (`sm`) · 12 (`md`) · 16 (`lg`) · 999 (`pill`).
⚠️ `apps/vendor` corre con radios propios (10/14/18) por ser app de campo.

**Techo de movimiento: 350 ms.** Nada supera eso, y nada se anima en reposo. Toda transición
respeta `prefers-reduced-motion`.

## El dato manda

En una interfaz densa de valores, la jerarquía la decide el dato, no el adorno:

- **Lo que no se pudo medir se DECLARA** — nunca se dibuja como cero ni como verde. «No hay datos»
  y «el valor es cero» son dos cosas distintas y se ven distinto.
- **Un número publicado dice con qué se calculó**: su frescura, su cobertura y su unidad.
- **Un estado necesita un tercer valor además de sí y no**: `fresco`, `viejo` y **`no se sabe`**.
- Nada de rankings de personas, nada de semáforos sin un umbral registrado detrás.

## Accesibilidad

- Contraste **AA** como mínimo, y se mide — no se estima.
- El foco siempre visible: `outline` de 2 px con separación, nunca `outline: none` suelto.
- Objetivo táctil mínimo 44 px en superficies de campo.
- **Lo que una señal visual dice, lo tiene que decir también el nombre accesible.** Un borde
  punteado no se oye; un icono sin texto tampoco.
