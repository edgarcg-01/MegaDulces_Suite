# Investigación — Por dónde entra y por dónde sale el efectivo

> **Escrito para:** Edgar y quien siga construyendo Caja General (backend y frontend).
>
> **Estado:** investigación, **sin código**. Medido contra producción en lectura el 2026-10-13,
> fuera de horario. Fuentes: el espejo del Access `Control` (`analytics.caja_general_*`) y el ERP
> (`analytics.erp_collections`, `analytics.erp_supplier_payments`), que es un **árbitro
> independiente** — no se derivan uno del otro.
>
> **Pregunta:** *«¿de dónde ingresa o egresa el dinero, el efectivo?»*, con Control como fuente y
> buscando patrones en los ingresos.

---

## 1. La respuesta en una línea

**La Caja General no es una caja chica: es una tesorería paralela de ~$82 M al año que recibe la
cobranza de las rutas y paga mercancía a proveedores, casi sin pasar por el banco.**

| 2026 (2 ene → 10 oct) | movs | monto |
|---|---|---|
| **Entra** | 2,922 | **$81,596,693.56** |
| **Sale** | 10,492 | **$82,493,738.24** |
| Neto | 13,414 | **−$897,044.68** |

Sale un poco más de lo que entra, y la caja no se queda sin dinero — o sea que **hay al menos una
fuente de entrada que este libro no registra**. Es el primer hueco con nombre (§6).

---

## 2. Por dónde ENTRA — el 95.5 % son las rutas

| cuenta | nombre | movs | monto | % |
|---|---|---|---|---|
| `41000001` | VENTAS RD LA PIEDAD | 1,384 | $27,679,094.81 | **33.9 %** |
| `41000000` | Ventas De Vendedor | 306 | $17,955,399.52 | **22.0 %** |
| `41000002` | VENTAS RD ZAMORA | 384 | $17,280,711.09 | **21.2 %** |
| `41000003` | PRESTAMO VENTAS PADRE HIDALGO | 316 | $10,155,845.48 | **12.4 %** |
| `41000007` | Ventas Ruta Vecinal | 271 | $4,932,833.36 | 6.0 % |
| `41000010` | Directivos | 16 | $1,920,661.00 | 2.4 % |
| `41000006` | Nomina / Pagares | 159 | $1,137,886.80 | 1.4 % |
| resto (mostrador de sucursal, cartón, cambios) | | 86 | $534,261.50 | 0.6 % |

⭐ **El efectivo entra por una sola puerta: el vendedor que vuelve de la ruta y liquida.** Las
cinco cuentas de ruta/vendedor suman **95.5 %**. El mostrador de las sucursales aporta **0.6 %**,
que es ruido.

Dos cuentas que el nombre no explica y conviene preguntar, no suponer:

- **`41000003` «PRESTAMO VENTAS PADRE HIDALGO»** — $10.2 M al año entrando como «préstamo». O es
  un nombre heredado para la liquidación de esa plaza, o es otra cosa.
- **`41000010` «Directivos»** — $1.92 M en **16 movimientos** ($120 k promedio).

### 2.1 La cadencia: de lunes a sábado, nunca domingo

| día | movs | monto |
|---|---|---|
| lunes | 506 | $13,266,030.07 |
| **martes** | 568 | **$20,871,136.72** |
| miércoles | 541 | $18,150,066.76 |
| jueves | 594 | $15,024,632.90 |
| viernes | 518 | $10,372,464.13 |
| sábado | 164 | $3,912,362.98 |

⚠️ **Hay texto que dice «domingo» y no hay un solo movimiento en domingo**: se vende el domingo y
se liquida el lunes. Para la Suite importa porque **la fecha del movimiento no es la fecha de la
venta** — el mismo rezago que la bandeja ya declara en `fecha_valor` contra `fecha_captura`.

### 2.2 Quién entrega: el campo es texto libre, y está roto

Los mayores «Recibido de» de 2026:

```
Rodolfo Sepulveda            2 movs   $1,650,000.00
RODOLFO SEPULVEDA            1 mov      $600,000.00     ← la misma persona, otra fila
Ventas Suc Morelia Abastos   1 mov      $550,000.00
Ventas RD Canindo            8 movs     $376,947.50
Ventas suc 8 esq 04 y 05 juli
Ventas Suc PH Sabado 14/02
Ventas Suc PH 20/06
Ventas suc ph domingo 12
```

⛔ **Tres defectos en un solo campo:** la misma persona en dos grafías; **la fecha metida dentro
del nombre** (`20/06`, `14/02`, `04/01/26`); y el día de la semana como parte de la identidad. No
se puede agrupar por quién entrega, ni sumar por ruta, ni cruzar con nada.

⭐ Esto no es cosmético: es **exactamente lo que el autollenado por entidad viene a resolver**, y
la razón por la que el vínculo tiene que ser al **código** del ERP y no al texto.

---

## 3. Por dónde SALE — dos de cada tres pesos son mercancía

| cuenta | nombre | movs | monto | % |
|---|---|---|---|---|
| `1005` | Matriz Compras Mercancia | 2,929 | $54,792,097.26 | **66.4 %** |
| `1010` | Matriz Gastos X Comprobar | 1,266 | $5,051,439.61 | 6.1 % |
| `10007` | PHidalgo Mantenimiento Sucursal | **17** | $4,010,600.00 | 4.9 % |
| `10004` | PHidalgo Nomina | 530 | $3,340,322.17 | 4.0 % |
| `10018` | PHidalgo Impuesto Sobre Nomina | 78 | $2,309,522.78 | 2.8 % |
| `1008` | Matriz Mantenimiento Vehiculos | 105 | $2,261,436.97 | 2.7 % |
| `90` | MANTENIMIENTO DEPTO. | 20 | $1,759,418.00 | 2.1 % |
| `1009` | Matriz Viaticos | 1,203 | $1,717,033.44 | 2.1 % |
| `1013` | Matriz Telefono | 813 | $1,246,887.30 | 1.5 % |

### 3.1 ⭐ El ERP confirma la salida grande, por su cuenta

No hay que creerle a Control: **Kepler etiqueta el medio de pago él mismo**, y coincide.

| Kepler — pagos a proveedor 2026 | monto |
|---|---|
| medio `banco` | $357,997,958.73 (86 %) |
| **medio `caja`** | **$56,922,129.35 (14 %)** |
| medio `puente` | $22,774,272.12 |
| sin declarar | $1,106,886.13 |

**Control dice $54,792,097 · Kepler dice $56,922,129 → coinciden al 96.3 %.** Dos sistemas que no
se derivan uno del otro, midiendo lo mismo por caminos distintos. La diferencia de **$2.13 M**
queda declarada, no explicada.

⭐ Y el caso individual aguanta el mismo cruce. **«Bolsas de los Altos»**, el mayor cobrador en
efectivo:

| | movs | monto |
|---|---|---|
| Control (caja) | 34 | $16,783,780.58 |
| Kepler, medio `caja` | 56 | $17,007,918.73 |
| Kepler, medio `puente` | 32 | $14,734,286.77 |

Es un proveedor real al que se le paga **~$1.9 M mensuales en efectivo**, con pagos individuales
de hasta **$1,261,627.50**. No es un error de captura: está corroborado por el ERP.

### 3.2 ⛔ El depósito al banco está muerto

| | movs | monto |
|---|---|---|
| cuenta `1990` «Deposito En El Banco» | 20 | $267,841.00 |
| forma `Depositos` (`TipoDto = 3`) | **0** | — |

**$267,841 de $82.5 M = 0.3 %.** La pantalla de depósitos de Control existe y **nadie la usa desde
2016**. El efectivo que entra no va al banco: **se vuelve a gastar en efectivo**.

Eso explica el circuito: *cobranza de ruta → caja → proveedor*, sin intermediación bancaria para
~$55 M al año.

---

## 4. ⛔ El catálogo de cuentas MIENTE sobre qué es cada gasto

El hallazgo de clasificación más caro de esta investigación. La cuenta `10007` se llama **«PHidalgo
Mantenimiento Sucursal»** y mueve **$4,010,600 en 17 movimientos**. Sus mayores renglones, con el
concepto que el capturista escribió a mano:

| fecha | contraparte | monto | concepto escrito |
|---|---|---|---|
| 2026-03-23 | G Guadalupe Fruti Fresk | $2,000,000.00 | **Prestamo Personal** |
| 2026-07-01 | G Pago Terreno | $500,000.00 | **Pago Terreno** |
| 2026-06-30 | g Luis Francisco Lopez Gtz | $500,000.00 | **compra de terreno** |
| 2026-06-10 | G Bolsas de los Altos | $100,000.00 | abono al prestamo |
| 2026-02-10 | G Juan Jesus Bautista | $100,000.00 | **compra de activo** |
| 2026-01-22 | G Juan Jesus Bautista Flores | $100,000.00 | Prestamo personal |

⭐ **Nada de esto es mantenimiento.** Son préstamos, compra de terreno y compra de activo: partidas
de **inversión y financiamiento**, no gasto operativo. El dato correcto existe —está en el texto
libre `concepto`— y el campo estructurado (la cuenta) dice otra cosa.

⚠️ **Esto no es una acusación y no debe leerse como tal**: son operaciones que pueden ser
perfectamente legítimas. Lo que está mal es **dónde quedan registradas**: cualquiera que sume la
cuenta `10007` para saber cuánto cuesta mantener Padre Hidalgo se lleva $4 M que no son
mantenimiento, y cualquiera que busque cuánto se prestó no lo encuentra.

Es la consecuencia directa de lo que `FASE_CG` §3.3 ya había medido: **114 cuentas planas donde
concepto y sucursal están fundidos**, sin un nivel que diga de qué naturaleza es la partida.

---

## 5. El cruce con la cobranza del ERP, y por qué NO se puede comparar de corrido

La tentación es cuadrar «lo que entró a la caja» contra «lo que el ERP cobró». **No se puede en
una sola serie**, y conviene saber por qué antes de intentarlo.

La cobranza de Kepler en 2026 se parte en tres y la mayor parte **no es dinero que entre**:

| `tipo_cuenta` | movs | monto |
|---|---|---|
| **interno** (traspasos entre plazas) | 20,719 | $408,918,100.13 (82 %) |
| ruta | 3,620 | $59,919,636.39 |
| cliente final | 3,053 | $27,501,839.04 |

Contra la caja, mes a mes:

| mes | ruta (ERP) | cliente final (ERP) | caja (Control) | caja / externa |
|---|---|---|---|---|
| ene | $5.87 M | $0.81 M | $9.95 M | 148.9 % |
| feb | $5.87 M | $0.27 M | $9.20 M | 149.8 % |
| mar | $6.69 M | $0.29 M | $9.40 M | 134.6 % |
| abr | $6.66 M | $0.02 M | $8.36 M | 125.0 % |
| may | $6.44 M | $0.10 M | $7.90 M | 120.9 % |
| jun | $7.30 M | $0.15 M | $10.09 M | 135.6 % |
| **jul** | $7.19 M | **$4.06 M** | $10.45 M | 92.9 % |
| ago | $6.87 M | $4.16 M | $6.96 M | 63.1 % |
| sep | $6.48 M | $8.18 M | $7.08 M | 48.3 % |
| oct | $0.54 M | $8.22 M | $2.21 M | 25.3 % |

⛔ **La razón va de 149 % a 25 % y el negocio no cambió: cambió la MEDICIÓN.** La columna «cliente
final» salta en julio y sigue subiendo, y las fechas lo explican solas — es cuándo cada plaza dejó
Wincaja y empezó a registrar en Kepler:

```
02 → 2025-10-10     01 → 2026-06-27     06 → 2026-08-15
07 → 2026-09-08     08 → 2026-09-19     00 → 2026-09-30
```

⭐ **Consecuencia operativa, y es una regla:** cualquier KPI que cruce ese borde tiene que marcarse
`comparable: false`. Si no, se va a leer **cobertura como crecimiento** — el mismo defecto que
`[IC.8]` ya pagó en inventario.

⚠️ **`analytics.route_collections` no sirve para esto hoy:** sólo tiene **48 renglones, del 2 al 12
de octubre**. Está viva, pero no es historia.

---

## 6. Los huecos, con nombre y monto

1. **−$897,044.68 de 2026 que no cuadran.** Sale más de lo que entra y la caja sigue operando →
   hay una entrada no registrada en este libro. Candidatos a verificar: el fondo inicial que nunca
   se declaró, dispensaciones de la caja fuerte (CAOS), o traspasos entre cajas.
2. **$2.13 M de diferencia** entre lo que Control llama compra de mercancía y lo que Kepler
   etiqueta `medio = caja`. Es 3.7 %; puede ser rezago de captura o alcance distinto.
3. **$22.77 M con medio `puente`** en los pagos de Kepler — ni banco ni caja. Nadie ha decodificado
   qué es, y es dinero grande.
4. **El 82 % de la «cobranza» es interna.** Hasta no separarla, cualquier cifra de cobranza que se
   publique está inflada 5×.
5. **La identidad de quien entrega no existe** como dato (§2.2).
6. **`41000003 «PRESTAMO VENTAS PADRE HIDALGO»`**, $10.2 M al año: el nombre no dice qué es.

---

## 7. Qué significa para lo que estamos construyendo

- **El autollenado tiene que resolver la ruta, no el beneficiario.** El 95.5 % de los ingresos son
  cinco cuentas de ruta. Si el ingreso se liga a su ruta, se autollena casi todo el lado de la
  entrada — y por eso el vínculo tiene que ser al código, no al texto libre.
- **El lado del gasto es largo, no concentrado**: mercancía es 66 % pero el resto son 10,492
  movimientos pequeños repartidos en decenas de cuentas. Ahí la regla por beneficiario rinde, y es
  lo que ya mide `FASE_CG` §8.3 (top 50 acreedores = 86 % de los documentos).
- **El depósito al banco hay que construirlo, no migrarlo**: la forma de Control existe y lleva
  diez años sin uso.
- **La naturaleza de la partida (gasto / inversión / financiamiento) no está en ningún campo.** Sin
  eso, el libro de caja no puede alimentar nada contable — es lo que §4 destapa con $4 M.

---

## 8. Cómo se midió (para que se pueda repetir)

Todo con `sh ~/ops/prod/pgprod.sh` en lectura, con `app.tenant_id` fijado en sesión.

| pregunta | fuente |
|---|---|
| entra / sale | `analytics.caja_general_movimientos` (`tipo_dto` 1 = ingreso, 2 = gasto, 3 = depósito) |
| cobranza del ERP | `analytics.erp_collections` (`tipo_cuenta`, `cobro_date`) |
| pagos del ERP | `analytics.erp_supplier_payments` (`metodo_pago`, `medio_pago`) |
| corte de migración | `analytics.v_branch_erp_cutover` |

⚠️ **Trampa de medición, por si alguien repite esto:** el `psql` del servidor está en **español** y
usa **coma decimal** — «Duración: 32,886 ms» son **32.9 ms**, no 32.9 segundos. Se caza corriendo
`select 1` como placebo: si también «tarda cientos de ms», lo que está mal es la lectura.
