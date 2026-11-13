# Comercial › Ventas por ruta

La pantalla `/comercial/ventas-por-ruta`: la venta de cada ruta mes a mes y, al abrir una ruta, su
desglose (productos, unidades, días, clientes, tickets y depósito). Las entradas más nuevas van arriba.

---

## Pestaña «Calendario» en el desglose de la ruta (VEC.42 y VEC.43, 2026-11-11 · 2026-11-12)

### El problema

El desglose de una ruta mostraba la venta día por día, en una lista. Para comparar una semana contra
otra había que sumar los días a mano, y para ver qué día de la semana flojea había que leer fecha por
fecha. Una semana que el periodo corta (el panel en noviembre y la semana que empieza el 26 de
octubre) o que todavía no termina se veía igual que una completa.

### La solución

Una pestaña **«Calendario»** junto a «Por día»:

- **Una fila por semana** de lunes a domingo (`S45 · 2–8 nov`), de la más vieja a la más reciente,
  el mismo orden que «Por día».
- **Un cuadro por día** con su venta y sus tickets. El tono del cuadro dice cuánto se vendió,
  relativo al mejor día del periodo, que la leyenda nombra. La cifra se ve siempre.
- **El total de la semana** al final: venta, tickets, días con venta y promedio por día.
- **Cada día dice lo que es:**
  - con venta: su cifra;
  - «—»: ya pasó y no vendió;
  - «·»: fuera del periodo, o su venta todavía no llega. **Hoy entra aquí**, porque la venta de ruta
    llega al día siguiente.
- **La semana que no termina** dice «en curso», y la que el periodo corta dice qué días cubre
  («sólo 1 nov»). Una semana sin venta sale como renglón propio.
- **Clic en un día:** sus tickets. **Clic en la semana:** los de toda la semana.

Primero fue una tabla «Por semana» (`[VEC.42]`, #532), que llegó a producción el 2026-11-12. El
calendario (`[VEC.43]`) la reemplaza: muestra lo mismo y además el día flojo.

### Cómo se implementó

- `ventas-por-semana.ts` (función pura `agruparPorSemana`) arma las semanas y sus siete días con los
  renglones que ya trae «Por día» (`detail.daily`). No hay consulta, endpoint ni migración nuevos.
- El componente guarda el periodo con que pidió el desglose (`detailRango`) para saber qué semana
  quedó cortada y qué días quedan fuera. Agrega la faceta `dWeek`: los tickets de la semana se piden
  con sus siete días recortados al periodo del panel (`weekBounds`). El clic en un día reusa
  `drillDay`.
- Es una `p-table` (una fila por semana), así que hereda el desplazamiento, el encabezado y el
  estilo de las demás pestañas.
- Pruebas:
  - `ventas-por-semana.spec.ts`, 19 pruebas: domingo, cambio de año, 53 semanas en 2026, semanas
    del periodo hasta hoy, semana cortada, en curso, semana vacía, los cuatro estados del día, hoy
    sin datos, tono relativo, devolución, día repetido, fecha ilegible, montos como texto y suma
    exacta.
  - `comercial-ventas-por-ruta.semana.spec.ts`, 6 pruebas: monta la plantilla, el clic en un día y
    en una semana pide las fechas correctas, la semana cortada se pide recortada, singular en el
    total, y los filtros se sueltan.
  - Cada regla se probó rota a propósito y se puso en rojo.

### Por qué se hizo así

- **Semana ISO de lunes a domingo:** es la que ya usan los reportes semanales del servidor; otra
  semana en esta pantalla daría cifras que no cuadran con ellos. Se descartó la semana de nómina
  (sábado a viernes).
- **Armado en la pantalla y no en el servidor:** los días ya llegan completos (sin tope), así que
  armar las semanas con ellos garantiza que den lo mismo que los días y que el encabezado.
- **Mismo orden que «Por día»:** las dos pestañas están juntas y no deben leerse en sentidos
  contrarios. «Por día» no se reordena porque esa tabla es de Caja General (`[CG.58.7]`).
- **Tono relativo al mejor día, con la cifra al lado:** el día flojo se ve sin leer números, y el
  color nunca es el único portador del dato.
- **Hoy no es «sin venta»:** la venta de ruta llega D+1. Pintar hoy como «—» diría que la ruta no
  vendió cuando todavía no se sabe.
- **Promedio por día:** una semana incompleta tiene menos días; su venta total no se puede comparar
  con la de una semana completa, pero su promedio por día sí.
- **Sin depósito:** lo depositado es de Caja General (`[CG.58.7]`) y se sigue viendo día por día en
  «Por día» y completo en «Depósito».
