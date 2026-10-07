# `[RD.35]` Verdad absoluta de las dos fuentes del inventario de ruta

Medido contra prod el **2026-10-06**, con las 10 camionetas empujando su foto.
Hereda ADR-059: *la verdad se **arbitra**, y lo que no se puede arbitrar se **declara***.

## Las dos fuentes

| | qué es | quién la produce |
|---|---|---|
| **Foto** | el saldo del kardex de la camioneta (`md.kdij`, entradas `c5='A'` menos salidas `c5='D'`, filtrado al almacén de esa van) | el Kepler local de cada camioneta, cada 15 min |
| **Reconstrucción** | `Σ carga − Σ venta`; carga = `U-D-41` del ERP hacia el rótulo de esa ruta, venta = el push de tickets | la plataforma, derivando del ODS |

## El cuadre, valuando LOS DOS LADOS con el mismo costo

```
foto                      $505,153.32  ·  29,455 uds
reconstrucción NETA       $120,651.48  ·   5,379 uds
Δ                         $384,501.84
   pares sólo en la foto       $7,564.40     ( 2.0 %)
   pares sólo en la recon    $132,745.55     (34.5 %)
   diferencia de CANTIDAD    $244,191.89     (63.5 %)
   RESIDUO                        $0.00   ✔ cierra al centavo
```

La descomposición es exacta por construcción:
`qf·c − qr·c = (qf−qr)·c` en los pares comunes, más el valor entero de cada lado
en los pares que sólo tiene uno. No hay nada sin clasificar.

## ⭐ Lo que el cuadre PRUEBA

**Las dos fuentes están de acuerdo en cuánto vale cada cosa, y en desacuerdo en qué
hay arriba del camión.** Valuando cada par con su propio costo, el desacuerdo de
**costo** entre la foto y el ledger es de **$2,651.69 sobre $505,153 = 0.52 %**.
El otro 99.5 % de la brecha es cantidad y cobertura.

⇒ No es un problema de valuación ni de peldaño de unidad. Es que **el ledger no ve
todos los movimientos del camión**.

## ⛔ La pantalla compara contra un número que esconde la mitad

`check-route-stock-push.js` compara la foto contra la reconstrucción **filtrada a los
saldos positivos**:

```
reconstrucción POSITIVOS (lo que compara la pantalla):  $384,490.27
reconstrucción NETA                                  :  $120,651.48
negativos que la pantalla NO muestra                 :  $263,838.79
```

**Un camión no puede traer existencia negativa.** Esos $263,838.79 son la prueba
directa de que `carga − venta` no es un sistema cerrado: si lo fuera, el saldo de
cada par sería ≥ 0 por construcción.

⚠️ **Y la banda de plausibilidad es CIRCULAR en cuanto el ancla funciona**: la
reconstrucción con que compara incluye `clase='conteo'`, o sea la foto misma. Por eso
la ruta 22 marcaba `1.00x` — no era una validación, era el número comparado consigo
mismo. Cuando `[RD.34]` ancle las 10, las 10 van a marcar `1.00x` y la banda va a
dejar de decir nada. **Hay que cambiarla para que compare contra `carga − venta` sin
ancla**, que es el testigo independiente.

## ⚠️ Lo que NO se puede arbitrar desde acá, y se declara

1. **El costo de la venta está cubierto al 28 %** (`costo_erp` de `kdm2.c62`), y al
   **0 % en las cinco rutas de Canindo** (501-505). Sin él, la brecha no se puede
   cerrar en dinero por el lado de la venta: sólo se puede en unidades, que dependen
   del peldaño.

2. **El kardex de la camioneta tiene tipos de documento que el ledger NO modela.**
   Medido en la ruta 27: además de `U-A-50` (recepción) y `U-D-10` (ticket), aparecen
   `N-A-30` (ajuste de entrada), `X-D-40` (devolución de compra), `U-A-25`, `N-D-5` y
   `N-D-30`. La reconstrucción sólo conoce `U-D-41` y el ticket. **Todo lo demás que
   entra o sale del camión es invisible para ella** — y no existe documento de retorno
   de ruta, así que lo que la van devuelve se queda como saldo fantasma para siempre.

3. ⛔ **RETRACTADO: la regla de `venta/carga`.** El 2026-10-06 se publicó que el signo
   de la brecha lo ordena cuánto vende cada ruta de lo que carga (ordenaba 7 de 9).
   **Esa medición está en UNIDADES**, y las unidades dependen del peldaño: comparar
   carga contra venta en unidades es justo la trampa de ADR-051. No se puede confirmar
   en dinero porque el costo de venta está al 0 % en las cinco rutas de Canindo, que
   son la mitad de la evidencia. **Queda como correlación observada, no como causa.**

## El camino para cerrarlo al centavo

La reconciliación de arriba es exacta pero **algebraica**: dice *cuánto* y *dónde*,
no *por qué documento*. Para arbitrarla hace falta el tercer testigo, y está barato:

> **El push ya corre en las 10 camionetas.** Agregarle un resumen de movimientos por
> tipo de documento es una línea más en el `.cmd`, el mismo patrón que el bloque de
> existencia que se instaló hoy.

Con eso, `saldo_kardex = Σ entradas − Σ salidas` abierto por doctype, y **cada peso de
los $384,501.84 queda con un tipo de documento pegado**. La reconciliación deja de ser
estadística y pasa a ser arbitrada.

Sin eso, lo honesto es publicar la foto como el saldo (es el testigo más cercano al
hecho físico) y **declarar** la brecha, no explicarla.

---

# La verdad absoluta del inventario de ruta: **no puede salir del ERP**

Medido el 2026-10-06. Son tres pruebas independientes y apuntan al mismo lado.

## 1. La sucursal no tiene los documentos de sus rutas

Consultadas las réplicas completas (`pgvector-md`), no el ODS recortado:

| almacén | tickets en la SUCURSAL | renglones que empujó la VAN | recepciones `U-A-50` |
|---|---|---|---|
| `01-001` (ruta 21) | 6,330 | **14,618** | **6** |
| `01-002` (ruta 22) | 5,354 | **12,688** | **5** |
| `01-005` (ruta 27) | 5,828 | **13,728** | **2** |
| `06-00N` (vecinales) | **0** | 8,344 – 10,886 | **0** |

La sucursal tiene **menos de la mitad** de los tickets de sus rutas, **dos a seis
recepciones** en toda la vida de cada ruta, y de Canindo **nada en absoluto**.

## 2. ⭐ El saldo acumulado se vuelve NEGATIVO en 10 de 11 rutas

`carga − venta`, día a día, desde el primer movimiento:

| ruta | 21 | 22 | 23 | 26 | 27 | 28 | 501 | 502 | 503 | 504 | 505 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **mínimo acumulado** | −1,459 | −244 | −1,613 | −1,105 | −143 | −865 | +27 | **−1,346** | −1,570 | −881 | −727 |

**Un camión no puede haber vendido mercancía que nunca recibió.** Cada mínimo
negativo es una fecha en la que el camión entregó producto que el embarque no
documenta.

## 3. La ruta 502 lleva toda su vida en negativo

Su acumulado **nunca** fue positivo: el máximo histórico es **−73 unidades**. Y su
camión trae hoy **2,561 unidades / $48,440** medidas por su propio kardex.

## Conclusión

**El documento de embarque (`U-D-41`) no captura todo lo que sube al camión.** La
magnitud, flota completa:

```
carga documentada (U-D-41)   503,541 uds
venta (push del camión)      498,162 uds
saldo que implica el ledger    5,379 uds
existencia REAL (la foto)     29,455 uds
                             ──────────
llegó sin documento           24,076 uds  ≈ $465,575   (4.8 % de lo documentado)
```

⚠️ En las rutas de Padre Hidalgo una parte de esos $465,575 es **carga documentada
pero fuera de la ventana**: el ledger arranca en `carga_desde = GREATEST(primer
embarque, primera venta)` y la ruta 21 tiene $113,566 cargados antes de ese corte.
No se puede separar sin reprocesar la carga desde el primer embarque — **se declara**.
En Canindo no hay ese recorte: **7,980 uds ≈ $168,226 en 501/502/503 es limpio**.

## Lo que esto invierte

La suposición de partida era que el ERP es la verdad y la camioneta el dato a
verificar. **Es al revés.** El único registro completo de lo que entra y sale de un
camión vive en el camión:

- la venta la empuja la van y **no duplica** (228,064 filas = 228,064 llaves);
- la existencia la mide su propio kardex;
- el embarque es el único dato que sí es del ERP, y está **corto**.

⇒ **Anclar en la foto no es una concesión: es usar la única fuente completa.**
`carga − venta` sirve como indicador de FLUJO, no como inventario, y la pantalla
tiene que decirlo.

## Lo que sigue sin medirse, con nombre

- **Qué documento** trae esas 24,076 unidades: necesita el parche de movimientos en
  la van (`PARCHE-MOVIMIENTOS.txt`, escrito y probado, sin aplicar).
- **El costo de la venta**: 28 % de cobertura, **0 % en las cinco de Canindo**.
- **La ruta 505**: sin foto, 22 días sin vender ni cargar.
- ⛔ **Cuatro rutas que empujan venta y la plataforma no conoce**: `1V001`–`1V004`,
  **103,394 renglones y $9,152,047** sin almacén asignado, desde abril.
