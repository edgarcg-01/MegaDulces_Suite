# Fase GP — Anexo RC: cerrar los restos de centavos de las facturas de telemarketing

> Anexo de [`FASE_GP_PLAN_IMPLEMENTACION.md`](FASE_GP_PLAN_IMPLEMENTACION.md), compañero del
> [anexo EA](FASE_GP_ANEXO_AUTORIZACION_PEDIDOS.md) (autorizar pedidos de telemarketing). Es el lado
> **clientes** del [anexo de residuos de PGP](FASE_PGP_ANEXO_RESIDUOS_DE_CENTAVOS.md), que resuelve lo mismo
> con los proveedores; comparten la regla del resto tolerado (ADR-056: un solo primitivo).
>
> **El pedido, literal.** Edgar, 2026-11-20: *«y qué tan viable es depurar los saldos?»* · *«recuerda que sólo
> estamos hablando de las facturas … de tlmk con centavos o pesos»* · (con la captura de Kepler › Operación ›
> Finanzas › **Ajuste Abono General**, `UA3001`) *«sería este»* · *«entonces ya sabemos dónde insertar cada
> cosa en Kepler, actualiza o genera el plan para poder generar ese submódulo»*.
>
> **Cómo cambió.** La primera pregunta se leyó como cuentas por pagar; se corrigió a **cartera de clientes de
> telemarketing**. La herramienta de cierre no es un documento nuevo: es el **Ajuste Abono** que Kepler ya
> trae.
>
> **Cifras medidas el 2026-11-20** en `pg-prod` (sid `7688376744939610156`, `transaction_read_only = on`),
> sobre `kepler_ods` y `analytics.customer_receivables_current`. Lo que no se pudo medir dice **NO MEDIDO**.
> Por ser el repo público, aquí no van nombres ni RFC de clientes.

---

## 0. En una pantalla

- **El problema:** 207 facturas de telemarketing (`UD0801`) siguen abiertas por **$10 o menos** ($161.32 en
  total, 113 clientes; 176 de ellas por menos de $1). Todas ya tuvieron cobro y 204 están vencidas. Desde
  julio, **1 de cada 14** facturas cobradas quedó así.
- **Por qué pasa:** el cliente paga en pesos cerrados (117 de 207) o el cobro se captura con centavos de menos.
- **Por qué importa:** **17 clientes se ven morosos sólo por el resto**, y con la regla del anexo EA sus pedidos
  irían a la bandeja de Crédito y cobranza por centavos.
- **Cómo se cierra hoy:** con un segundo «Cobro» de centavos (≈105 cobros de ≤ $10 desde julio): un cobro de
  dinero que no entró.
- **La solución:** (1) la Suite trata el resto chico como pagado al decidir; (2) la Suite lo cierra en Kepler
  con el **Ajuste Abono** (`U-A-30`), un ajuste por cliente; (3) Contabilidad recibe la póliza que Kepler no
  hace.

---

## 1. Lo medido

### 1.1 Los restos (cargos abiertos ≤ $10, por tipo de documento)

| Documento | ≤ $1 | $1–$10 | > $10 (no es resto) |
|---|---:|---:|---:|
| `UD0801` Factura Telemarketing | 177 · $57.82 | 30 · $103.50 | 1,847 · $18.4 M |
| `UD1301` Venta crédito | 36 · $6.60 | 1 · $1.58 | 2,445 |
| `UD1201` Venta crédito | 1 · $0.17 | 2 · $12.29 | 2,741 |

Por sucursal (telemarketing): 01 → 94 · 06 → 62 · 08 → 51. Entre $10 y $50 hay 39 más ($1,188; 37 pagadas en
parte), que **no** son restos de redondeo: se quedan fuera (§4, D-R1).

### 1.2 Cómo lo cierran hoy

Abonos de ≤ $10 desde julio, por tipo: **Cobro** (`U-A-5`) ≈105, Devolución (`U-A-25`) 17, Cobro CFDI (`U-A-7`) 7,
Nota de crédito (`U-A-21`) 3. **Ajuste Abono (`U-A-30`): 0.**

### 1.3 El Ajuste Abono en la historia (51 documentos, nov-2025 → oct-2026)

- El **30-sep-2026** (corte): uno por sucursal a «CONTADO», de $3 mil a $135 mil, cada uno aplicado a decenas de
  facturas; en la 05, uno por cliente (24).
- La **02 el 26-nov-2025**: 16 ajustes de $1.16 a $616, capturista `MD`.
- **IVA en cero en los 51.** ⚠️ **Corrección (2026-11-24): uno SÍ lleva referencia** (`c11 = 'c-1419'`, sucursal
  00, enero). Aquí decía «ninguno», y de ahí salía la idea de usar `c11` como llave de idempotencia *porque el
  ajuste manual lo deja vacío*. **Esa premisa es falsa**: 1 de 51. La llave de la Suite tiene que distinguirse
  **por su forma** (un prefijo propio, verificado contra lo que ya existe), no por «los manuales van vacíos».

---

## 2. Dónde se escribe cada cosa en Kepler (C0)

Medido sobre dos ajustes reales de la 02 (uno a 1 factura, otro a 2) y contrastado con 632 facturas de
telemarketing de la 08.

| Tabla | Qué escribe el Ajuste Abono | Evidencia |
|---|---|---|
| `md.kdm1` | **Encabezado** `U-A-30-01-<folio>`: `c7` moneda · `c9` fecha · `c10` cliente · `c12` vendedor (si hay) · `c16 = c42` total · `c22` RFC · `c31 = 'Aju'` · `c32..c35` nombre y domicilio (copiados de `kdud`) · `c40 = 1` · `c43 = 'N'` · `c63 = 'UA3001-'` · `c67` capturista · `c68` fecha · `c69` hora | 51 de 51 |
| `md.kdm2` | **Nada** (sin renglones de producto) | 0 filas en los dos casos |
| `md.kdue` | **Un renglón del abono**: `c1` sucursal · `c2` cliente · `c3 = 'A'` · `c4 = 30` · `c5 = 1` · `c6` folio · `c7` fecha · `c8` moneda · `c11 = c17` monto · `c18` vendedor · `c28 = 'U'` · `c29 = 'A'` | 51 de 51 (tipo 30 en `kdue` = 67 renglones con los cancelados) |
| `md.kdm5` | **Una aplicación por factura**: `c7` renglón · `c8 = 'D'` · `c9/c10/c11` tipo, subtipo y folio de la factura · `c12 = c13` monto aplicado · `c14` = la referencia de la factura (su `kdue.c16`) | 1 y 2 aplicaciones; el corte de la 01, más de 20 |
| `kdue` de la **factura** | **No se toca.** Kepler no guarda saldo en cartera: `c17` = importe en **632 de 632** facturas, y `c18` es el vendedor. El saldo = importe − Σ `kdm5` | 632 / 632 |
| Pólizas `md.kdc2AAMM` | **Nada.** Sep-2026 tiene **0** renglones `U-A-30`; el **control** pasa (en el mismo mes `U-A-5` tiene 4,188 y `U-A-21` 698) | 4 meses revisados |

### 2.1 Lo que faltaba de §2, cerrado en sólo lectura (2026-11-24)

Dos de las tres incógnitas no necesitaban el ensayo: se contestan leyendo el ODS. Quedan asentadas acá y
**salen de la lista de NO MEDIDO**.

**① El contador de folios: `KFUA3001.<sucursal>`, y su `c4` guarda el folio SIGUIENTE.**
Se presumía `KFUA30..`. El renglón real de `kepler_ods.sqliov` es `KFUA3001.<NN>` con `NN` = la **sucursal**, y
`c4` (texto) es el próximo folio. Verificado contra los documentos reales: `c4 = max(folio) + 1` en **9 de 9
sucursales** (00→3/2 · 01→2/1 · 02→19/18 · 03→2/1 · 04→2/1 · 05→26/25 · 06→2/1 · 07→2/1 · 08→2/1).

> ⛔ **La trampa: hay DOS renglones por sucursal.** Ocho de los nueve servidores arrastran además una copia de
> `KFUA3001.02` que **no avanza** (vale 1 en seis sucursales y **17** en la 03, un valor rancio). Sólo en la 02
> coinciden llave y sucursal, y ahí es el vivo. Una implementación que busque «el renglón de UA3001» encuentra
> dos y puede tomar el equivocado: **la llave se arma con la sucursal, no se busca por patrón.**
>
> ⚠️ Y el contador se lee e incrementa **en el Kepler vivo, dentro de la misma transacción** del ajuste. El ODS
> sirvió para aprender el nombre de la llave, no para tomar el folio: es una réplica y llegaría tarde.

**② No emite CFDI.** `kepler_ods.kdfe33folxdoc` (la configuración de series de timbrado por sucursal y tipo) sólo
tiene renglones `U-A` para los subtipos **7, 21, 26, 41 y 42**, en las 9 sucursales. **El 30 no está en ninguna.**
*Control en los dos sentidos:* aparecen los que sabemos que timbran (`U-A-7` Cobro CFDI y `U-A-21` Nota de
crédito) y **no** aparece el que sabemos que no (`U-A-5` Cobro simple). Coincide con la otra evidencia: de los 51
ajustes, ninguno trae folio digital ni `c62`/`c64`.

### 2.2 Los permisos, aplicados — y dos premisas de §2 que resultaron FALSAS (2026-11-24)

**③ El permiso (GP.R.0c) está aplicado y verificado.** Medido primero **a nivel columna**, que es donde el
instrumento engaña: ⚠️ `has_table_privilege(…,'UPDATE')` devuelve **false** cuando el permiso es por columna, así
que una primera medición dijo que faltaba el contador de folios **y no faltaba** (`pgp1224` ya daba
`UPDATE (c4)`). Con `has_column_privilege`, el estado real era: `kdm1.ins` ✅ · `kdm5.ins` ✅ ·
`sqliov.c4upd` ✅ · `kdud.sel` ✅ · **`kdue.ins` ❌ en las 9**. O sea **un solo permiso faltaba**.
Aplicado con `kepler-su-grants.sh` (`KSU=sa`, desde `md`) en **8 de 9** —CEDIS sigue sin línea de `pg_hba` para
`sa`— y verificado con el **testigo independiente** (`kepler_push` preguntándose a sí mismo), no con la
comprobación del propio script: `kdue.ins = true` en 01–08. Archivo: `ops/prod/kepler-grants/gpr0c_ajuste_abono.sql`.

⛔⛔ **Lo que se creía y NO es cierto:**

1. **«Los acumulados del cliente en `kdud`» — `kdud` NO es una tabla de acumulados.** Tiene **4 columnas
   numéricas** (control: `kdxg`, el acumulador de proveedores, tiene **49**). `kdud` es el maestro del cliente
   —nombre, límite, plazo, teléfono—, no un contador mensual. La frase de §2 apuntaba a la tabla equivocada.
2. **`kdug` tampoco es el espejo de `kdxg`.** Tiene 49 columnas numéricas (igual que `kdxg`, por eso parecía), pero
   su layout está **corrido** —`c1` es la moneda, `c2` la sucursal, `c3` el cliente— y sólo tiene **147 a 546 filas
   por sucursal**, no una por cliente. **No se confirmó como el acumulador** y no se le atribuye ese papel.

⭐⭐ **Y el hallazgo que cambia el plan de RC.0b: las cinco tablas tienen CERO disparadores.** Medido en el Kepler
vivo de la 08 sobre `kdm1`, `kdm5`, `kdud`, `kdue` y `sqliov`: ningún trigger. **Todo lo hace el programa de
Kepler, nada la base.** De ahí se sigue algo que hay que decir claro, porque separa dos preguntas que se venían
confundiendo:

> ⛔ **El ensayo con ROLLBACK prueba que NUESTRA escritura funciona; NO puede descubrir qué mueve el programa de
> Kepler.** Si insertamos las filas nosotros, ningún acumulador se moverá — no porque el ajuste no los mueva, sino
> porque quien los movería es la aplicación, que en el ensayo no participa.

**NO MEDIDO, con su camino correcto:**
- **Qué toca Kepler además de las tres tablas** al postear un Ajuste Abono. ⛔ **No lo resuelve el ensayo de RC.3**:
  lo resuelve mirar un ajuste **real capturado por una persona en Kepler**, con foto antes/después por `xmin`. Son
  ~10 minutos de alguien de Crédito y cobranza, no trabajo de ingeniería. *Y «esperar al próximo ajuste real»
  tampoco es un plan: van 60 días con cero.* **Hay que pedirle a alguien que capture uno.**
- Pólizas de los meses no revisados.

---

## 3. Diseño

### 3.1 La regla del resto (C1)

Una factura de cliente **cuenta como pagada para decidir** si debe **≤ el tope** (D-R1) y **ya tuvo al menos un
cobro**. Es la misma función que proveedores (`esRestoTolerado` de `[PGP.157]`, hoy en
`libs/contracts/src/finance/cierre-kepler.contract.ts`), que se **mueve a un lugar neutro de `libs/contracts`** y
la usan los dos lados.

- Una factura **sin cobros** que debe $0.08 **no** es resto: sigue sin pagar (prueba negativa).
- La pantalla no la esconde: dice «pagada · queda $0.37 de redondeo».
- La consumen la cartera, la ficha de crédito (GP.A.5) y la regla de autorización (GP.A.1, condición de
  vencido).

### 3.2 El cierre en Kepler (C2)

- ⭐ **De dónde viene el disparo.** El cobro **se captura en Kepler**, no en la Suite: `/finanzas/cobranza` sólo
  le pega la ficha de depósito a un cobro que el ERP ya tiene («no escribe a Kepler, es evidencia read-only»).
  Así que aquí no hay un pago que escribir — **el pago ya está en Kepler**. Lo que hace la Suite es **ver llegar
  el cobro** por el ODS y cerrar el resto. (Llevar la captura del cobro a la Suite sería escribir `U-A-5`, un
  carril nuevo sobre dinero que entra: Edgar lo dejó **fuera** de este anexo el 2026-11-24.)
- **Disparo por evento** (no cron): al entrar un cobro que deja una factura con resto (la cartera por evento,
  CXC.21, ya lo ve), el resto entra a la bandeja «Restos por cerrar».
- **Un ajuste por cliente y sucursal** que salda todos sus restos de una vez (`kdm5`, una aplicación por
  factura), como hace la pantalla con «Cobra todo».
- **Automático hasta el tope; arriba de él, lo firma Crédito y cobranza.**
- **Escritura:** `kdm1` + `kdue` + `kdm5` en **una transacción** desde `md` con `kepler_push`, más el folio y lo
  que el ensayo demuestre en `kdud`.
  - Interruptor por sucursal apagado al nacer, tope diario.
  - Idempotente por la referencia de la Suite (se llena `kdm1.c11`, que el ajuste manual deja vacío) y por
    «la factura todavía debe exactamente ese resto», contra el `kdm5` vivo.
- **Registro propio** (tabla con `tenant_id` y auditoría): cada ajuste, sus facturas, quién o qué lo cerró y el
  folio de Kepler.
- **Reusa el carril** del pago y de la nota de proveedores (`clonarFila`, `insertarFila`,
  `reservarFolioKepler`): se clona el encabezado de un ajuste vivo como plantilla, igual que la nota `X-D-55`.

### 3.3 La póliza que Kepler no hace (D-R2)

Kepler baja la cartera y la contabilidad no se entera. Opciones:
- **(a)** La Suite arma una **póliza mensual** con el total de redondeos (cargo a la cuenta de redondeos que diga
  Contabilidad, abono a clientes) en el archivo de ContPAQi (ADR-040: la Suite arma, no escribe).
- **(b)** Se deja como diferencia conocida y Contabilidad la ajusta a mano.

Recomendación: **(a)**.

### 3.4 Prevenir

Al capturar un cobro en la Suite que deja un resto ≤ el tope, se avisa «queda $0.37: ¿cerrarlo como redondeo?».
Los cobros capturados en Kepler los atrapa §3.2.

---

## 4. Decisiones

| | Pregunta | Recomendación | Estado |
|---|---|---|---|
| **D-R1** | Tope del resto que se cierra solo | **$10, automático** — lo decidió Edgar el 2026-11-24 (*«facturas que tengan adeudo de menos de 10 pesos … se genera automáticamente un abono»*). La recomendación era $1 solo y $1–$10 con firma; **la diferencia entre los dos topes son 31 facturas y $106**, y no alcanza para partir el criterio en dos. Arriba de $10 no es redondeo y no entra | ✅ **Edgar, 2026-11-24** |
| **D-R2** | ¿Contabilidad quiere la póliza del redondeo? | Sí, la arma la Suite en el archivo de ContPAQi (§3.3 a) | ⬜ Contabilidad |
| **D-R3** | ¿Se dejan de usar los «Cobros» de centavos? | Sí: un cobro dice que entró dinero. El Ajuste Abono es el documento correcto | ⬜ Crédito y cobranza |
| **D-R4** | ¿Escribir en Kepler amplía ADR-117 (la Suite escribe en Kepler) al `U-A-30`? | Sí, con el mismo carril y candados | ⬜ Edgar (ADR) |
| **D-R5** | ¿Las ventas a crédito de sucursal (`UD1201`/`UD1301`, 40 restos) entran? | Sí, en una segunda pasada, con la misma regla | ⬜ Edgar |

---

## 5. Los bloques

| # | Resultado | Capa | Depende | ¿Escribe? |
|---|---|---|---|---|
| **GP.R.0a** | ✅ Huella del Ajuste Abono en `kdm1`/`kdue`/`kdm5`, sin `kdm2` ni póliza, y el saldo de cartera = importe − Σ `kdm5` (§2) | C0 | — | no |
| **GP.R.0b** | 🟡 **Lo NO MEDIDO de §2.** ✅ **2 de 3 cerradas en sólo lectura el 2026-11-24** (§2.1): el folio (`KFUA3001.<sucursal>`, 9 de 9) y el CFDI (no timbra, con control en los dos sentidos). ⬜ Falta **sólo `kdud`**, que sí exige foto antes/después. ⛔ Esperar «al próximo ajuste real» **no es un plan**: van 60 días con cero Ajustes Abono. Lo cierra el ensayo de RC.3 | C0 | — | no |
| **GP.R.0c** | ✅ **APLICADO el 2026-11-24 en 8 de 9** (`gpr0c_ajuste_abono.sql`, `KSU=sa` desde `md`; CEDIS sin `pg_hba` para `sa`), verificado con el testigo independiente. Medido a nivel COLUMNA, faltaba **un solo permiso**: `INSERT` en `md.kdue`. ~~Permisos de `kepler_push` en los 9 servidores~~: `INSERT` en `md.kdm1`, `md.kdue` y `md.kdm5`; `UPDATE` en `md.sqliov` y lo que diga RC.0b en `kdud`, con su línea `-- verificar:`. Archivo en `ops/prod/kepler-grants/`; lo corre el PM | C0 | GP.R.0b | sí (permiso) |
| **GP.R.1** | **La regla del resto** movida a un lugar neutro de `libs/contracts`, usada por proveedores y clientes, con sus pruebas negativas. La cartera, la ficha y GP.A.1 la usan; la pantalla muestra «queda $X de redondeo» | C1 | — | — |
| **GP.R.2** | **Armador del ajuste** en `libs/finance` (función pura): de un cliente y sus facturas con resto → los renglones de `kdm1`, `kdue` y `kdm5`. Valida que cada resto sea exacto, que la factura tenga cobro y que el total no pase el tope | C1 | GP.R.0a · D-R1 | — |
| **GP.R.3** | **Adaptador de escritura** + **ensayo con ROLLBACK** contra el Kepler vivo (como `ops/prod/ensayo-nota-kepler/`): cada `INSERT` con su `rowCount` y un control de 0 documentos con la referencia del ensayo | C2 | GP.R.2 · GP.R.0c | ⛔ sí: sólo ensayo |
| **GP.R.4** | **Disparo por evento y bandeja «Restos por cerrar»** (vista de la bandeja de Crédito y cobranza del anexo EA): automático hasta el tope; arriba, con firma. Interruptor por sucursal y tope diario | C2/C3 | GP.R.3 · GP.A.4 | ⛔ sí: prueba contra base real con el payload de la pantalla |
| **GP.R.5** | **Póliza mensual del redondeo** en el archivo de ContPAQi | C2 | D-R2 | no (arma archivo) |
| **GP.R.6** | **Aviso al capturar un cobro** que deja resto | C3 | GP.R.1 | — |
| **GP.R.7** | **Cierre del rezago**: los 207 de hoy, sucursal por sucursal, con la bandeja. Medición antes/después: restos ≤ tope = 0 y clientes «morosos sólo por resto» = 0 | C0 | GP.R.4 en prod | sí |

**Orden:** GP.R.1 va primero y sola: sin escribir en Kepler, quita a los 17 clientes de la lista de morosos y
deja lista la regla de EA. GP.R.0b–R.3 en paralelo; GP.R.4–R.7 después.

**Fuera:** restos de más de $10 (son aclaraciones, no redondeo), cancelar o rehacer cobros, y escribir en
ContPAQi directo.

---

## 6. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-24 | ⭐⭐ **GP.R.3 — LA PRUEBA DE ESCRITURA PASÓ** (Edgar: «hagamos prueba de escritura»). `ops/prod/ensayo-ajuste-abono/` escribe un `U-A-30` de verdad en el Kepler vivo de Morelia Abastos y lo deshace: folio `0000002` del contador real `KFUA3001.08` (antes 2, máximo 1, **no atrasado**), encabezado clonado de la plantilla, renglón de `kdue` y aplicación de `kdm5` (1 fila cada uno), y **el saldo de la factura `8-1-0000470` pasó de $7.20 a $0.00** dentro de la transacción. **Control tras el ROLLBACK: 0 documentos del ensayo · contador IGUAL · saldos IGUALES.** El `ROLLBACK` es incondicional, en `finally`: no hay camino que confirme. ⭐ **Dos restricciones que sólo aparecen escribiendo, cazadas sin escribir nada:** (1) `clonarFila` **inserta y después pisa**, así que clonar directo a `md.kdm1` choca con `pk_kdm1` — hay que armar en una temporal sin llave y volcar al final, como `kepler-nota-sink`; (2) **`kdm1.c11` es `varchar(20)`**: la llave de idempotencia tiene que caber en 20 caracteres. Reusa `reservarFolioKepler` y `clonarFila`, no los reimplementa | Claude, a pedido de Edgar |
| 2026-11-24 | ⭐ **GP.R.0c aplicado y dos premisas corregidas (§2.2).** Medido a nivel COLUMNA —`has_table_privilege` miente cuando el permiso es por columna— faltaba **un solo permiso**: `INSERT` en `md.kdue`. Aplicado en **8 de 9** (CEDIS sin `pg_hba` para `sa`) y verificado con `kepler_push` preguntándose a sí mismo. ⛔ **Falso lo de «los acumulados en `kdud`»**: `kdud` tiene 4 columnas numéricas (control: `kdxg` tiene 49), es el maestro del cliente, no un contador. `kdug` tampoco es su espejo (layout corrido, 147–546 filas por sucursal). ⭐⭐ **Y las cinco tablas tienen CERO disparadores**: todo lo hace el programa de Kepler. De ahí que **el ensayo con ROLLBACK pruebe nuestra escritura pero NO pueda descubrir qué mueve Kepler** — eso se ve mirando un ajuste real capturado por una persona, con foto antes/después. Son 10 min de Crédito y cobranza, no ingeniería | Claude, a pedido de Edgar |
| 2026-11-24 | **D-R1 firmada ($10, automático) y dos tercios de GP.R.0b cerrados SIN escribir** (§2.1): el contador de folios es `KFUA3001.<sucursal>` con el folio siguiente en `c4`, cuadrado contra `max(folio)+1` en **9 de 9** —y con la trampa de los dos renglones por sucursal documentada—, y el Ajuste Abono **no emite CFDI** (no hay serie `U-A-30` en `kdfe33folxdoc` en ninguna sucursal, con control en los dos sentidos: `U-A-7` y `U-A-21` sí están, `U-A-5` no). Queda sólo `kdud` para el ensayo. **Corregida una premisa de §1.3**: 1 de los 51 ajustes sí trae `c11`, así que la idempotencia no puede apoyarse en «los manuales van vacíos». Re-medido hoy: **216 facturas de telemarketing con resto ≤ $10 ($165.53)**, en 01 (95), 06 (69) y 08 (52); la pila crece 50–80 al mes y en 60 días se cerraron **74 restos con un «Cobro» de centavos y cero con Ajuste Abono**. ⭐ Aclarado, porque la pregunta lo destapó: **el cobro se captura en Kepler, no en la Suite** (`/finanzas/cobranza` es evidencia read-only), así que el disparo es ver llegar el cobro por el ODS. Edgar descartó llevar la captura del cobro a la Suite dentro de este anexo | Claude, a pedido de Edgar |
| 2026-11-24 | ⛔⛔ **El tope era UNA constante para las DOS decisiones, y partirla fue el trabajo de firmar D-R1.** `RESTO_TOLERADO = 1` decía en su propio comentario «es D-C1 (PGP) y D-R1 (GP); si cambia, cambia aquí»: subirla a $10 por la decisión de **clientes** habría movido callado el lado de **proveedores**, donde el anexo afirmaba «ninguno de $1 a $10» (19-nov) y **hoy hay 55 documentos por $193.48**. Ahora son `RESTO_TOLERADO_CLIENTE = 10` y `RESTO_TOLERADO_PROVEEDOR = 1`, y **el tope es parámetro obligatorio** de `esRestoTolerado`/`esRestoDeFactura`: el default silencioso es lo que permitió la confusión. Los 5 consumidores nombran el suyo (cliente: regla de autorizar, cartera, pantalla; proveedor: cierre de pago, nota de centavos). **Antes/después de clientes** (regla 15): 32 facturas más ($108.11) cuentan como pagadas y los «morosos sólo por resto» pasan de **16 a 19**, con el control de que los 1,471 clientes con algún vencido **no cambian**. Pruebas: 2 controles nuevos (los topes no se mueven juntos; $5 es resto de cliente y deuda de proveedor) **con su rojo verificado**, y la prueba espejo del SQL dejó de clavar el literal y ahora se arma con las constantes. `ngc --noEmit`: 0 errores. `check:pantalla` de `finanzas-cartera`: sin falla nueva. ⚠️ **NO MEDIDO**: la pantalla viva (el rótulo del redondeo ahora dice «hasta $10», no se vio en navegador) | Claude |
| 2026-11-20 | **GP.R.1 (pantalla) 🧪.** `/finanzas/cartera`: el cliente cuyo vencido es puro redondeo dice «Redondeo» en la columna Vencido (con el monto atenuado), no pinta la fila de vencida y en «Más vencido (cobrar)» cuenta como cero; en el detalle, la partida de centavos de una factura cobrada dice «Redondeo» en vez de «Nd» (misma `esRestoDeFactura`). Sin KPI nuevo: $58 contra $64 M no decide nada arriba. Cinco preguntas por escrito en la sesión; 3 pruebas nuevas (28/28) con mutante rojo; `check:pantalla`: 0 fallas nuevas, tipa 0 errores; `check:templates` verde. **Sin validación visual** (no se levantó la app) | Claude |
| 2026-11-20 | **GP.R.1 (servidor) 🧪.** La regla vive en `libs/contracts/src/finance/resto-tolerado.contract.ts` (`esRestoDeFactura`; `cierre-kepler` la re-exporta, mismo objeto). La cartera (`CustomerLedgerService.cartera`) agrega por cliente `resto_redondeo`, `n_restos` y `solo_resto_vencido`, y en el KPI `resto` — **aditivo: `saldo` y `vencido` no cambian** ($64,523,305.85 vencido antes y después). Medido en prod con la misma condición: $57.92 en 188 partidas ≤ $1, **17 clientes vencidos sólo por resto** (15 de telemarketing). Ojo: la cartera lee `customer_receivables.saldo_ajustado` y da 155 restos ≤ $1 de telemarketing; `customer_receivables_current.saldo_documento` da 177 — dos saldos distintos, por conciliar. Pruebas: 5 del contrato + 4 de la cartera, cada una con su mutante rojo. Falta: mostrarlo en la pantalla (C3, skill `diseno`) y usarlo en GP.A.1 | Claude |
| 2026-11-20 | Nace el anexo. Medido en prod (sólo lectura): 207 facturas de telemarketing con resto ≤ $10 ($161.32, 113 clientes, 17 morosos sólo por eso); hoy se cierran con «Cobros» de centavos; el Ajuste Abono (`U-A-30`) existe y no deja póliza (control `U-A-5`/`U-A-21` en el mismo mes); su huella es `kdm1` + `kdue` + `kdm5`, y Kepler no guarda saldo en la factura de cartera (632/632). Se corrigió una primera lectura que medía proveedores | Claude, a pedido de Edgar |
