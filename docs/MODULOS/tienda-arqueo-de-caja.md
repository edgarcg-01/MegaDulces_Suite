# Tienda › Arqueo de caja — la confirmación del corte desglosa pieza por pieza (SM.44)

## Problema

Antes de sellar un corte, el diálogo «¿Confirmas el corte?» mostraba sólo dos renglones: total de billetes y total de
monedas. La persona no podía comparar contra sus fajos qué capturó de cada denominación; un error de captura en una sola
casilla (por ejemplo 50 billetes de $500 en vez de 5) se sellaba sin que se viera.

## Solución

- El diálogo lista cada billete y cada moneda contados, con sus piezas e importe, en el orden del catálogo
  ($1,000 → 50¢).
- Total de billetes y total de monedas con sus piezas, el efectivo contado marcado entre dos reglas, los medios de pago
  con su total y el total del turno.
- Las denominaciones en cero no se listan. La de $20 dice si es billete o moneda.

## Cómo se implementó

- `tienda-arqueo.component.ts`: `desgloseFamilia(fam)` arma las filas desde el mismo `denomCount` que viaja al
  servidor, así que lo que se confirma es exactamente lo que se guarda. Plantilla del `p-dialog` con secciones por
  familia; estilos con los tokens de la escala.
- Prueba en `tienda-arqueo.component.spec.ts`: el orden, los rótulos de la $20, los importes y una negativa (lo que va
  en cero no aparece en el diálogo).

## Por qué así

El diálogo existe como poka-yoke del dinero (sellar es irreversible). Un resumen de dos números no sirve para detectar
el error más común, que es una casilla mal tecleada; el desglose sí. No se listan los ceros para que la lista se lea en
segundos con la fila esperando.
