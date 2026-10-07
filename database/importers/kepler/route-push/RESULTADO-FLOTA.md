# `[RD.32]` La flota midiendo su propio inventario — 2026-10-06

**10 de 11 camionetas** empujan su existencia. La 505 lleva 22 días sin vender ni
cargar (van caída, no es un problema del push).

| ruta | plaza | productos | importe | empalme | foto / reconstrucción |
|---|---|---|---|---|---|
| 21  | Padre Hidalgo | 257 | $41,693 | 98.8 % | 1.20× |
| 22  | Padre Hidalgo | 358 | $65,101 | 99.7 % | — (circular, ver abajo) |
| 23  | Padre Hidalgo | 282 | $50,106 | 100.0 % | 2.18× |
| 26  | Padre Hidalgo | 320 | $55,743 | 96.6 % | 1.72× |
| 27  | Padre Hidalgo | 280 | $59,186 | 100.0 % | 1.11× |
| 28  | Padre Hidalgo | 330 | $52,190 | 96.1 % | 1.63× |
| 501 | Canindo | 340 | $42,545 | 90.0 % | 0.79× |
| 502 | Canindo | 265 | $48,440 | 99.2 % | 2.07× |
| 503 | Canindo | 264 | $44,393 | 97.3 % | 1.48× |
| 504 | Canindo | 314 | $48,407 | 93.6 % | 0.66× |

**Inventario de ruta medido: $507,805.**

## ⭐ Lo que explica la razón: `venta/carga`, NO la plaza

Se propusieron dos reglas y la primera quedó **REFUTADA**:

⛔ *«las de Padre Hidalgo salen por arriba y las de Canindo por abajo, por la
ventana ciega del arranque»* — la 502 y la 501 son las dos vecinales, misma
plaza, las dos con `dias_ciegos = 0`, y caen en **2.07×** y **0.79×**.

✔ Lo que sí ordena es **cuánto vende cada ruta de lo que carga**:

| ruta | venta/carga | razón |
|---|---|---|
| 502 | 101.7 % | 2.07× |
| 23  | 100.8 % | 2.18× |
| 26  | 100.6 % | 1.72× |
| 503 | 100.1 % | 1.48× |
| 28  |  99.9 % | 1.63× |
| 21  |  99.4 % | 1.20× |
| 27  |  97.3 % | 1.11× |
| 501 |  94.1 % | 0.79× |
| 504 |  88.6 % | 0.66× |

**El SIGNO se predice al 100 % (9 de 9)**: por encima de ~97 % la foto sale
mayor, por debajo de ~95 % sale menor. **El ORDEN casi** — 7 de 9, con dos pares
adyacentes invertidos (502/23 y 503/28). **La MAGNITUD no se predice**, y se
intentó dos veces: a la 23 se le dio 1.1–1.8× y salió 2.18×.

**Mecanismo:** la reconstrucción es `Σcarga − Σventa`. Si la ruta vende todo lo
que carga, esa resta tiende a cero y la existencia real es un múltiplo grande de
un número chico. Si vende menos, la diferencia se queda como **saldo fantasma**
— el ledger no tiene documento de retorno de ruta — y la reconstrucción se infla
por encima de lo que el camión trae.

⇒ `venta/carga` sirve de **termómetro por ruta**. La 504 (88.6 %) y la 501
(94.1 %) acumulan mercancía que no se vendió ni se devolvió en el papel.

## ⛔ La 22 no cuenta: su 1.00× es circular

Su ledger tiene **sólo `clase='conteo'`** (357 renglones, todos de hoy), cero
carga y cero venta: el ancla le borró la historia. O sea que la «reconstrucción»
contra la que se compara **es el propio conteo**. Es el defecto que corrige
`20261006150000_rd_route_counts_no_borra_historia.js` (RD.33), **sin aplicar**.

## ⚠️ La razón se mueve durante el embarque de la tarde

La foto es de un instante (el push corre cada 15 min) y la reconstrucción es en
vivo. Entre las 17:00 y las 19:00 entra la carga y la razón baja sola: la 21
pasó de **2.00× a 1.20×** en veinte minutos, con **$21,159** de carga ese día.
Las razones se leen estables a media mañana, no durante el embarque.

⇒ Otro argumento para RD.33: si el ancla **reemplaza** el saldo, una foto tomada
antes del embarque borra la carga de esa tarde. Como **ajuste**, la carga
posterior se suma encima y la cuenta cierra sin importar la hora de la foto.

## Testigo independiente

La ruta 21 tenía un Excel exportado a mano de Kepler: **$37,766 contra $18,427
reconstruidos = 2.05×**. Su kardex, por un camino que no toca ni la interfaz de
Kepler ni a una persona, dio **2.00×** el día siguiente. **2.4 % de diferencia.**

## Operativo, para preguntar en la plaza

- **504**: sin una sola venta desde el **1-oct** (confirmado en el runner, no es
  el ledger — las otras vecinales están al 5-oct), y le siguen cargando:
  **4,168 unidades en octubre contra 538 vendidas**.
- **501, 503, 504**: cargadas el 6-oct con **cero ventas** ese día.
- **505**: 22 días sin vender ni cargar.
