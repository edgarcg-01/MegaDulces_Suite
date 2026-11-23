# Cuadre de los libros del pago — las consultas del 2026-11-23

Las consultas con las que se midió el [anexo CL de PGP](../../../docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_CUADRE_DE_LIBROS.md)
(Calendario, Kepler, banco y SAT). Son el punto de partida para repetir el análisis o para construir el cuadre
permanente (`[PGP.198]`); **no** son un proceso que corra solo.

## Cómo se corren

Sólo lectura, contra `pg-prod`, desde una máquina con acceso a `md`:

```bash
ssh superoot@<md> "sh ~/ops/prod/pgprod.sh -At -F '|'" < archivo.sql > archivo.out
```

- Cada archivo abre `BEGIN TRANSACTION READ ONLY`, imprime el `system_identifier` (tiene que ser el de prod) y cierra
  con `ROLLBACK`. No hay tablas temporales: todo son CTEs `AS MATERIALIZED`.
- **Las fechas están fijas** (las del análisis: octubre a noviembre de 2026). Ajústalas antes de correr.
- Son consultas pesadas (minutos): una a la vez y, si se puede, fuera de horario hábil.

| Archivo | Qué mide | Reglas del anexo |
|---|---|---|
| `calendario.sql` | Pagos cancelados con el dinero ya fuera, importe del banco contra el pago, facturas programadas dos veces, ligas a pagos cancelados en Kepler y los pagos que salieron sin estar en Kepler separados con el banco | R4, R6, R7 |
| `banco/` | Kepler contra banco **uno a uno por cuenta**. Se arma `0-cabeza.sql` + `1-base.sql` + una cola: `2-resumen.sql` (emparejados y sin pareja), `3-sin-pareja-por-cuenta.sql`, `4-pagos-gemelos.sql` (mismo acreedor e importe en ≤5 días), `5-control.sql` (los controles negativos). Ejemplo: `cat banco/0-cabeza.sql banco/1-base.sql banco/2-resumen.sql \| ssh … > resumen.out` | R1, R2, R5 |
| `deuda/capas-del-vencido.sql` + `deuda/saldo-a-favor.sql` + `deuda/capas.js` | Las capas del vencido (deuda financiera, duplicados, cancelados en el SAT, saldo a favor, anterior al corte, vencido real). `node deuda/capas.js capas-del-vencido.out saldo-a-favor.out` | R3, R10 |
| `sat-kepler.sql` | Factura de Kepler ↔ CFDI recibido, uno a uno (mejor pareja mutua) en cuatro pasadas con sus controles | R9 |

## Lo que hay que saber antes de leer un resultado

- **Un cruce por importe sin su control negativo no dice nada.** Cada archivo trae el suyo (+$100 o la fecha corrida).
- **El libro del banco es copia fiel del banco**, pero trae los SPEI devueltos como salida y entrada: no restarlos los
  cuenta como pago. La descarga del banco empieza en noviembre.
- **Kepler:** filtrar siempre `btrim(c1) = sucursal`; un pago cancelado se excluye con `kdm1.c43 = 'C'`; la cuenta de
  tesorería del pago es `kdxe.c22` (`0011` es Caja General, efectivo); la referencia `c16` es texto libre, no llave.
- **`sat-kepler.sql` no trae la lista de RFC corregidos** que usó el análisis (incluye RFC de personas físicas y el repo es
  público). Sin ella casan menos acreedores; se rearma comparando el RFC de `analytics.v_supplier_rfc` con el emisor de
  los CFDI que casan por importe con sus facturas.
