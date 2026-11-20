# Reporte para Crédito y cobranza antes de empujar (`[GP.A.3]`)

**Cuándo se corre:** cada vez que un cambio de la autorización de pedidos TELEMARK queda «listo, sólo es empujar»
(pedido de Edgar, 2026-11-20). La lista se le manda a Crédito y cobranza **antes** de empujar: cada pedido de ella es
un aviso de «se autorizó solo» que les va a llegar.

```bash
npx tsx --tsconfig tsconfig.base.json ops/prod/reporte-autorizacion-automatica/reporte.ts --salida <scratchpad>/reporte-cyc.md
```

⛔ La salida lleva nombres de clientes: va **fuera del repo** (el repo es público).

## Qué hace

- Corre **las mismas consultas** que la bandeja «Por autorizar» (`leerBandeja`) y **la misma regla** (`armarBandeja` →
  `decidirAutorizacion`). No copia nada: si la bandeja cambia, el reporte cambia con ella.
- Va a prod en **sólo lectura** (`default_transaction_read_only`), por `pgprod.sh` en `md`, una consulta por sesión.
  Tarda ~25 s, casi todo de `ssh`.
- Saca dos escenarios:
  1. **Al empujar**: con el interruptor de prod tal como está (`commercial.kepler_push_switch`, tipo `autorizacion`;
     sin renglón = apagado).
  2. **Al encender** la autorización automática en todas las sucursales, con la frescura real de los datos. Los que
     sólo se detienen porque los datos no están al día se cuentan aparte.
- Cierra con lo que sigue esperando a Crédito y cobranza (su bandeja) y lo que va aparte (viejos y ruta vecinal).

## Control

El 2026-11-20 dio **6 pedidos al encender** (los 6 de venta de contado), **9 a Crédito y cobranza** y **789 aparte**.
Es lo mismo que la simulación hecha antes ese día con otra lectura (SQL y armado escritos a mano): dos caminos, la
misma respuesta.
