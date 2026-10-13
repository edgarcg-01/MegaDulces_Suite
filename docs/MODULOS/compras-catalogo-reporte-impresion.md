# Compras › Catálogo › Reportes — la hoja que sale de la impresora

## Problema

El reporte de precios por proveedor salía impreso **como una captura de pantalla**. En la hoja
aparecían la migaja «Comercial / Compras / Reabastecimiento / Catálogo», el aviso flotante «Hay una
versión nueva · Actualizar» encima de la tabla, y arriba y abajo los encabezados del navegador (la
fecha, la URL y el «1/1»). Medido en producción el 2026-10-13, con el documento en la mano.

No era que faltara una regla de impresión: **estaba, y no podía funcionar**. El componente imprimía
con el `print()` del navegador y escondía el resto con un bloque de impresión dentro de sus propios
estilos — y los estilos de un componente Angular están encapsulados, así que su `display:none`
alcanza sólo a los elementos de ese componente. La migaja, el aviso y la barra lateral viven en
otros componentes: ninguna regla de acá podía tocarlos.

Además, lo que sí salía tenía tipografía de pantalla (tokens en `rem`, que dependen del zoom y del
tema) y ningún margen declarado, así que el navegador ponía el suyo y, con él, sus encabezados.

## Solución

La hoja se imprime **aislada**: se clona a un documento aparte y se imprime ese documento. Lo que no
está en la hoja no puede salir, sin depender de esconder nada.

El formato pasa a ser un documento de la empresa:

- **Membrete** en cada página: `MEGA DULCES` · «Precios por proveedor» · plaza y fecha, con filete.
- **Carátula** (sólo en la primera): título, una línea de qué es, y una ficha en cuatro casillas —
  plaza del precio, fecha de cálculo de los precios, renglones y fecha de emisión.
- **Tabla por proveedor** con el nombre del proveedor y los títulos de columna **repitiéndose en
  cada página**; precios alineados a la derecha, en una sola línea; renglones que no se parten.
- **Pie en cada página**: «Documento interno de Mega Dulces · Compras» y de cuándo son los precios.
- **Nota de lectura** al final: qué es la unidad base y qué significa el guion.
- Hoja **carta**, sin el encabezado del navegador.

## Cómo se implementó

- `apps/view/.../compras/pages/compras-catalogo-reporte.component.ts`:
  - `imprimir()` usa `printIsolated()` (`apps/view/src/app/shared/util/print-isolated.ts`), el mismo
    helper del cartel del andén y de las etiquetas de checado. Trae además la red de seguridad para
    las tablets que ignoran el `print()` del marco aislado.
  - La hoja va envuelta en una tabla de una celda: su `thead` es el membrete y su `tfoot` el pie.
    El navegador **repite** los grupos de encabezado y pie en cada página — es lo que da margen
    arriba y abajo en todas las hojas con la página declarada en margen cero.
  - El nombre del proveedor se mudó de un `h2` suelto a una fila del `thead` de su tabla, para que
    en la página 2 se siga sabiendo de quién es la lista.
  - Tipografía del papel en milímetros, como tokens `--fs-hoja-*` acotados a la hoja.
- Prueba: `compras-catalogo-reporte.component.spec.ts` suma cuatro candados (no se imprime con el
  `print()` del navegador, no vuelve el bloque encapsulado, membrete y pie en `thead`/`tfoot`, y el
  proveedor dentro del `thead`). Los dos primeros leen el **código** sin comentarios, para que
  documentar el método viejo no ponga roja la prueba.

## Por qué así

- **Aislar en vez de esconder.** Esconder exige enumerar todo lo que puede aparecer en la pantalla,
  y la lista crece cada vez que alguien agrega un aviso. Clonar la hoja invierte la regla: sale lo
  que se declaró, no lo que se olvidó tapar.
- **Margen de página en cero** es lo único que apaga los encabezados del navegador. El margen real
  lo pone el membrete repetido, que además es lo que hace que la hoja 2 no empiece pegada al borde.
- **Milímetros y no tokens de pantalla** (mismo criterio que `[DS.6.1]`): el papel no tiene zoom ni
  tema oscuro. La pregunta no es en qué archivo está el estilo, es dónde se renderiza.
- **Repetir el proveedor** porque una tabla de precios sin dueño en la página 2 es un error que no
  se ve: se lee como si siguiera la anterior.

## Lo que no hace

- **No numera las páginas.** El contador de páginas de CSS no existe en el navegador que se usa, y
  el del navegador se apaga junto con sus encabezados. Queda declarado, no disimulado.
- No genera el PDF en el servidor: lo sigue produciendo el diálogo «Guardar como PDF», sin
  dependencias nuevas ni archivos guardados.
