# Comercial › Ventas por ruta

La pantalla `/comercial/ventas-por-ruta`: la venta de cada ruta mes a mes y, al abrir una ruta, su
desglose (productos, unidades, días, clientes, tickets y depósito). Las entradas más nuevas van arriba.

---

## Pestaña «Por semana» en el desglose de la ruta (VEC.42, 2026-11-11)

### El problema

El desglose de una ruta mostraba la venta día por día, pero no por semana. Para comparar una semana
contra otra había que sumar los días a mano, y una semana que el periodo corta (el panel en noviembre
y la semana que empieza el 26 de octubre) o que todavía no termina se veía igual que una completa.

### La solución

Una pestaña **«Por semana»** junto a «Por día». Cada renglón es una semana de lunes a domingo
(`S45 · 2–8 nov`), de la más reciente a la más vieja, con días con venta, tickets, venta y
**promedio por día**. La semana que no termina dice «en curso» y la que el periodo corta dice qué
días cubre («sólo 1 nov»). Una semana sin venta entre otras dos sale como renglón propio. El clic
en la semana lleva a sus tickets, igual que el clic en un día.

### Cómo se implementó

- `ventas-por-semana.ts` (función pura `agruparPorSemana`) suma los renglones que ya trae «Por día»
  (`detail.daily`). No hay consulta, endpoint ni migración nuevos.
- El componente guarda el periodo con que pidió el desglose (`detailRango`) para saber qué semana
  quedó cortada, y agrega la faceta `dWeek`: los tickets de la semana se piden con sus siete días
  recortados al periodo del panel (`weekBounds`).
- Pruebas: `ventas-por-semana.spec.ts` (11: domingo, cambio de año, 53 semanas en 2026, semana
  cortada, en curso, semana vacía, fecha ilegible, montos como texto, suma exacta) y
  `comercial-ventas-por-ruta.semana.spec.ts` (5: monta la plantilla, el clic pide las fechas
  correctas, la semana cortada se pide recortada, los filtros se sueltan). Cada una se probó rota
  a propósito y se puso en rojo.

### Por qué se hizo así

- **Semana ISO de lunes a domingo:** es la que ya usan los reportes semanales del servidor; otra
  semana en esta pantalla daría cifras que no cuadran con ellos. Se descartó la semana de nómina
  (sábado a viernes).
- **Sumada en la pantalla y no en el servidor:** los días ya llegan completos (sin tope), así que
  sumarlos garantiza que las semanas den lo mismo que los días y que el encabezado.
- **Promedio por día:** una semana incompleta tiene menos días; su venta total no se puede comparar
  con la de una semana completa, pero su promedio por día sí.
- **Sin depósito:** lo depositado es de Caja General (`[CG.58.7]`) y se sigue viendo día por día en
  «Por día» y completo en «Depósito».
