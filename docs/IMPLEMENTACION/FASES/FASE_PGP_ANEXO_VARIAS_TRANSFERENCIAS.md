# Fase PGP — Anexo VT: un pago que sale en varias transferencias

> Anexo de [`FASE_PGP_PAGO_A_PROVEEDOR.md`](FASE_PGP_PAGO_A_PROVEEDOR.md). El método: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> **No es una fase nueva:** es un item del Calendario de Pagos (`[PGP.190]`), en la fase PGP ya abierta.

## 0. El pedido

Francisco, 2026-11-20, sobre «Preparar pago» de un pago de más de un millón a DE LA ROSA (CD015): *«hay pagos que se
hacen con varias transferencias, ¿me ayudas a adecuar el preparar el pago para llenarlo con varias transferencias?»*

## 1. Lo medido (prod, sólo lectura, `system_identifier` de prod, 2026-11-20)

| Qué | Cifra |
|---|---|
| Pagos del Calendario ejecutados desde octubre con X-D-26 en Kepler | 179 |
| … que recibieron **dos** X-D-26 | **8** (4.5 %); 3 desde dos cuentas nuestras distintas |
| … de esos, los 3 más grandes | **sin casar con su salida del banco y sin validar**: la Suite buscaba UNA salida por el importe completo y el banco tenía dos parciales |
| Cómo los registra Kepler | **cada transferencia es su propio X-D-26** con su cuenta de origen (`kdxe.c22`); si una factura se paga en dos, cada X-D-26 le abona una parte (CE012 31-ago y 24-sep, CP007 4-nov: un millón y el resto) |
| ¿Hay un tope fijo por transferencia? | **No**: desde junio, 16 X-D-26 de más de un millón (uno de la misma cuenta que partió a CE012). Los importes los escribe la persona. ⚠️ **Corregido el 2026-11-26 (`[PGP.221]`): BBVA SÍ tiene tope, $1,000,000.00 por operación** (Francisco; en la descarga del banco desde junio ninguna transferencia de BBVA pasa del millón y 14 son de un millón exacto). Ver §9 |
| Pagos pendientes de más de un millón hoy | 7 |
| Facturas de Kepler hoy en dos pagos pendientes a la vez | 0 (de 345 renglones pendientes) |

## 2. La decisión (Francisco, 2026-11-20)

Dos formas, con maqueta: **«Partir en pagos»** (elegida) o «un pago con N transferencias adentro». Se eligió partir porque
cada transferencia ya es, en Kepler y en el banco, un movimiento propio: siendo un **pago del Calendario**, se casa sola
con su salida del banco por su importe, lleva su comprobante y su X-D-26 (la escritura en Kepler ya está encendida: 56
X-D-26 escritos por la Suite), y todo lo que ya funciona por pago —autorizar, casar, escribir, cerrar— no cambia. La otra
forma obligaba a rehacer esas cuatro piezas.

## 3. Cómo queda

- **«Preparar pago»** (transferencia, no anticipo): casilla **«Sale en varias transferencias»**. Al activarla, un renglón
  por transferencia —importe y cuenta de origen—; la última no se teclea: lleva **el resto**. Hasta 10. La cuenta destino
  es una (la del proveedor). El botón dice **«Partir en N y preparar»**.
- **Al guardar** (`POST allocations/:id/preparar-en-transferencias`, una transacción, todo o nada): el pago original se
  queda con la 1ª transferencia y nacen las demás **en el mismo día**, cada una **ya preparada** con las mismas reglas de
  «Preparar pago» (CLABE, mismo banco, anticipo). Las facturas se reparten **en el orden del pago**; la que cruza de una
  transferencia a otra se abona en dos renglones (como los dos X-D-26 de CE012). Bitácora `partido_en_transferencias` en
  cada parte.
- **El renglón del día** dice **«transferencia k de n»** (columna `finance.payment_allocations.split_from_id`, migración
  `20261120202543_pgp190_pago_partido_en_transferencias`). Reprogramar una parte la deja en su grupo.
- **Lo que se rechaza, dicho:** importes que no suman el pago al centavo · una transferencia sin origen · pago o día ya
  autorizado · un **anticipo** (sale en una sola, a la cuenta aprobada de su cotización, `[PGP.128]` D12) · la **factura con
  descuento al pagar** en la frontera (el descuento es de la factura entera): el aviso dice a cuánto dejar la transferencia.

### 3.1 «Lleva de más» con una factura partida (`[PGP.147]`/`[PGP.148]`)

Antes cada pago se comparaba contra el saldo **completo** de la factura en Kepler. Partida en dos y con una nota de crédito,
ninguna parte pasaba del saldo nuevo y juntas sí: se habría pagado de más sin aviso — el problema del pedido anterior
(`[PGP.184]`). Ahora cada renglón ve **su parte**: el saldo menos lo que cubren los renglones vivos anteriores de la misma
factura (por día, alta e id). **La última transferencia, la del resto, absorbe primero la nota.** Si la nota es mayor que la
última parte, la 1ª baja y la última queda en cero: no baja a $0 (un renglón paga algo) — se dice **«las otras
transferencias ya cubren lo que debe: quítala de este pago»**. Aplica al aviso rojo, a «Bajar a» y al ajuste automático.

## 4. Las cinco preguntas (skill `diseno` §0b), contestadas antes de la plantilla

1. **Qué ve y en qué orden:** método · cuenta destino (una) · «Sale en varias transferencias» · un renglón por transferencia
   (importe, origen) con la última «el resto» · qué va a pasar al guardar.
2. **Qué no ve:** el reparto de facturas (lo hace el servidor en el orden del pago y se ve en cada renglón del día) ni un
   destino por transferencia (el proveedor es uno).
3. **Accesibilidad:** cada importe y cada origen con su etiqueta; el error del servidor se queda **dentro del diálogo**
   (`role="alert"`), no en un toast que se va; nada depende sólo del color.
4. **Ligas:** cada parte = un pago con su salida del banco, su X-D-26 y su comprobante; «transferencia k de n» las mantiene
   juntas a la vista.
5. **¿Le toca a esta pantalla?** Sí: preparar es donde se elige de qué cuenta sale el dinero.

## 5. Qué NO incluye (declarado)

- **Volver a juntar** las partes en un pago: no hay botón. Si se partió mal, cada parte se puede mover, quitarle facturas o
  partirse otra vez.
- **Cheque, efectivo o cargo automático** en varias partes: sólo transferencia (es lo que se midió).
- **Elegir qué factura va en qué transferencia:** se reparten en el orden del pago.
- **Los 3 pagos ya ejecutados sin casar** con el banco (octubre–noviembre) no se arreglan solos: siguen como están.

## 6. Verificación

| Qué | Resultado |
|---|---|
| `partir-en-transferencias.spec.ts` (reparto puro) | 10/10 |
| `debe-menos.spec.ts` (la parte del saldo) | 16/16, con la NEGATIVA «contra el saldo entero no se veía» |
| `test-newdb-pgp190-partir-en-transferencias.js` — servicio y migración REALES contra Postgres local, rollback | **24/24**: migración ×2 (idempotente), una factura en dos, varias facturas (sólo la de la frontera se parte; la otra se mueve), tres transferencias en orden, los 5 rechazos sin efecto (todo o nada), anticipo, nota de crédito absorbida por la última, nota mayor que la última, reprogramar en su grupo, preparar sin partir igual |
| Prueba negativa: 8 mutaciones | cada una en rojo en su caso (descuento, saldo entero ×2, bajar a $0, grupo al reprogramar, origen equivocado, parte en cero, día autorizado) |
| `test-newdb-pgp148-ajuste-al-saldo.js` (regresión de PGP.148/184) | 25/25 |
| `tsc` de la API · `ngc` de la vista (con un error sembrado en la plantilla nueva: rojo) | limpios |
| `check:pantalla -- finanzas-calendario-pagos` | 0 fallas nuevas |
| Consulta nueva en prod (peor caso, todas las facturas pendientes) | 8.5 ms |
| Antes/después del «debe» en prod | 0 de 345 renglones cambian hoy |

**No verificado:** sin validación visual del diálogo ni del renglón (escriben; la API local contra prod es de sólo lectura).

## 7. Despliegue

**Primero la migración** `20261120202543_pgp190_pago_partido_en_transferencias` (una columna nula, una llave y un índice
parcial sobre una tabla chica; sin `NOT NULL`), **luego** el código. Si el código llegara antes, el día se ve igual (sin
partes) y partir responde 503 «falta aplicar la migración». Sin permisos nuevos (usa `FINANCE_PAYMENTS_GESTIONAR`).

## 8. Bitácora

- **2026-11-20** — Pedido de Francisco, C0 medido, decisión «Partir en pagos», C0–C3 en código y probados (`[PGP.190]` 🧪).
- **2026-11-26** — Caso Effem: un pago de BBVA de más de un millón salió en dos SPEI sin estar partido en la Suite (Caja General no sabía usar «Sale en varias transferencias»: capacitada ese día). Francisco confirma el tope de BBVA. `[PGP.221]` (§9) y `[PGP.220]` 🧪.

## 9. El tope por operación del banco (`[PGP.221]`, 2026-11-26)

**El caso.** Effem, Morelia Abastos, $1,020,891.81 desde BBVA 5712, 25-nov: salió en $1,000,000.00 + $20,891.81 con la
misma referencia. El banco lo dio por pagado como grupo (`[PGP.201]`) y la Suite escribió **un** X-D-26 por la suma; los dos
PDF no entraron por ningún lado (el renglón acepta uno por pago, por su importe; «Comprobantes PDF» casa uno a uno). Francisco
decidió dejar ese documento (y el del Effem del 23-nov) como uno; lo que se arregla es que no vuelva a pasar.

**Lo medido (prod, sólo lectura, descarga del banco desde el 1-jun):** ninguna transferencia de BBVA pasa de $1,000,000.00
(14 de un millón exacto: 9 SPEI, 1 traspaso BBVA→BBVA, 4 de otros formatos); arriba del millón sólo hay pagos de crédito.
Santander sí deja (2 pagos > $1M desde octubre). «Sale en varias transferencias» se ha usado 0 veces. Francisco: *«es el tope
por operación»*.

**Cómo queda.** La regla vive en `@megadulces/contracts` (`tope-por-transferencia.contract.ts`): un tope por banco (hoy sólo
BBVA; un banco sin tope medido no se bloquea).
- «Preparar pago» abre **partido** cuando el origen es BBVA y el pago pasa del millón: $1,000,000.00 en cada transferencia y
  el resto en la última, desde la misma cuenta, con una línea que dice por qué. Se puede cambiar importes y cuentas.
- Si la persona quita «varias», el aviso sale bajo el origen y no se guarda. Un anticipo (no se parte, `[PGP.128]` D12) pide
  una cuenta de origen de otro banco.
- El servidor no prepara entera una transferencia que pasa del tope, nombra la parte que pasa al partir, y no autoriza (el pago
  ni el día) lo preparado entero antes de la regla o con facturas sumadas después. El renglón lo dice: «Falta partirla».

**Las cinco preguntas (`diseno` §0b).** (1) Lo que ve: el diálogo ya partido, con la razón arriba de las transferencias. (2) Lo
que no ve: nada nuevo cuando el banco no tiene tope o el pago cabe. (3) Accesibilidad: la razón en texto, el error con
`role="alert"`, mismos controles de teclado. (4) Ligas: cada parte casa con su salida del banco, recibe su PDF y lleva su
X-D-26. (5) Le toca a «Preparar pago»: es donde se decide de qué cuenta sale.

**Verificación.** Contrato 8/8; pantalla montada 8/8; servicio real contra Postgres local 12/12 (rollback) y PGP.190 24/24;
11 mutantes en rojo, más uno de la prueba visual. **Prueba visual (2026-11-26; escritorio 1440, Fold 7 750 táctil y celular
390; API local contra prod en sólo lectura y toda escritura bloqueada):** el pago de $1,128,131.19 del 26-nov desde BBVA abre
partido en «1,000,000.00 + el resto»; sin «varias», el aviso bajo el origen y «Guardar» no manda nada; Santander, entero y sin
aviso; el renglón **simulado** como preparado entero dice «Falta partirla…» y no ofrece «Autorizar». La prueba encontró que el
importe precargado se veía «1000000.00» (ahora con comas). Sin tocar, por ser de antes: los controles del diálogo miden 35 px
de alto con el dedo.

**Fuera de alcance, con nombre:** que el banco parta un pago NO partido en la Suite y la Suite lo escriba como N documentos (la
propuesta 2 del caso, sobre `[PGP.201]`, de Edgar); varios PDF para un pago (propuesta 3).
