# Tablero · Caja General v2 — «la tarea primero»

El diseño que `[CG.59]`–`[CG.64]` implementan: la barra con la jornada plegada arriba (el 10 %) y
los dos apartados abajo (el 90 %) — **1 · Qué vas a arquear** y **2 · El arqueo**.

| Archivo | Qué es |
|---|---|
| [`claro.html`](claro.html) | El artboard en modo claro |
| [`oscuro.html`](oscuro.html) | El mismo, en oscuro |

Se abren con doble clic en el navegador. Son **maquetas estáticas**: los `{{…}}` y las etiquetas
`<sc-if>` / `<sc-for>` son marcadores de la herramienta de diseño, no código del proyecto.

## ⚠️ Por qué están acá y no en un enlace

Vivían en `https://claude.ai/artifact/K4p1CMkAKkUGuCCsggXt6v`, y **ese artefacto dejó de existir
para la cuenta el 2026-10-07** — con cuatro commits y dos secciones de
[`FASE_CG_CAJA_GENERAL.md`](../../FASE_CG_CAJA_GENERAL.md) citándolo. O sea: **cuatro citas que ya
no se podían verificar**, que es exactamente lo que le pasó a `[CDRP.0]` con la especificación de
Dirección y se resolvió del mismo modo — versionarla verbatim.

⭐ La regla que queda: **si una decisión de diseño se cita en un commit o en una fase, su fuente
vive en el repo.** Un enlace a algo que no controlamos no es una fuente: es una promesa.

## Qué NO es

No es la pantalla. La implementación se apartó del tablero en cosas que se midieron después, y
cada desvío está anotado en su sección de la fase:

- La **cola** conserva su tabla (`p-table` + `pSelectableRow`) en vez de los botones de fila del
  tablero: D.7 pide el primitivo de PrimeNG, y el lote necesita el recorrido con teclado (`[CG.61]`).
- **Guardar** no está donde el tablero lo pone: bajó al pie del arqueo por pedido explícito, con
  una ventana de confirmación que el tablero no tiene (`[CG.62]`).
- La **clasificación** completa (tipo, fecha, sucursal, documento, beneficiario, cuenta) sigue
  debajo de la ficha: el tablero sólo muestra concepto y glosa, que alcanza para el movimiento
  anclado pero no para una captura libre (`[CG.60]`).
