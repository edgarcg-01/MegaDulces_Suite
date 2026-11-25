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
| **D-F10** | ⛔⛔ Un resto de una factura **PPD**, ¿se cierra con el **Ajuste Abono** (interno, sin CFDI: la factura queda saldada en Kepler y **sigue debiendo sus centavos ante el SAT**) o con la **nota de crédito `U-A-21`** (timbra y lo cierra de verdad, pero la emite Kepler, no la Suite)? Medido el 2026-11-25: **220 de los 260 restos vivos son facturas PPD con CFDI**, y ya hay **1,782 facturas de 2026 con el resto vivo ante el SAT ($729.78)**. Mientras no se decida, GP.R.3 cierra con el ajuste **y lo declara** (`cfdi_insoluto`) | ⬜ Contabilidad / Fiscal |
| **D-F11** | «Todo debe pasar como PPD» (Edgar, 2026-11-25): ¿incluye las ~2,000 facturas de contado al mes (`UD05`/`UD06`)? Hoy el método lo decide el **tipo de documento** de Kepler, no una captura; pasarlas a PPD obliga a un complemento por cada una | ⬜ Dirección / Fiscal |
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
| **GP.R.2** | 🧪 **HECHO (2026-11-25)** — `libs/finance/src/lib/customer-ledger/ajuste-abono.armador.ts`, función pura: de un cliente y sus facturas con resto → las columnas de `kdm1`, `kdue` y `kdm5`, o **el motivo por el que no se arma**. Valida resto exacto, cobro previo (la MISMA `esRestoDeFactura` de la cartera), tope D-R1, folio, duplicados y **la referencia de 20 caracteres**. Declara `acumulados: 'no_medido'` en vez de dibujar un cero. 12 pruebas, **cada guarda con su rojo verificado**; `tsc --noEmit`: 0 errores propios (42 preexistentes en la lib, ajenos) | C1 | GP.R.0a · D-R1 | — |
| **GP.R.3** | 🧪 **HECHO (2026-11-25)** — el carril entero, **apagado al nacer**: `kepler-ajuste-abono-sink.adapter.ts` (escribe las tres tablas en una transacción, con plantilla, folio del contador real y **el control del efecto adentro**: si el saldo no queda en cero, revierte) · `ajuste-abono.service.ts` (interruptor por sucursal, registro `pendiente` → `escrito`, y **mide el insoluto que deja ante el SAT**) · `ajuste-abono.controller.ts` (`POST /api/finance/ajuste-abono/:sucursal`, llave `FINANCE_RESTOS_CERRAR`). El **ensayo con ROLLBACK** ya había pasado el 2026-11-24. 37 pruebas en verde, `tsc --noEmit` sin errores propios **con su prueba negativa** | C2 | GP.R.2 · GP.R.0c | ⛔ sí: sólo ensayo |
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
| 2026-11-25 | 🚀 **ENCENDIDO EN PROD, en Morelia Abastos y en ninguna otra** (Edgar: «te autorizo»). El carril completo, con su testigo en cada paso: **empujado** `90736a976` (rearmado sobre `origin/main`, que traía 23 commits que este checkout no tenía; un solo conflicto, el `index.ts` de contracts) · **sellado** (`ci-green` lo contiene) · **migración `20261125125330` aplicada** (batch 1253, 0.1 s) · **soltado** (`prod-release` 0->`90736a976`) · **desplegado: `/api/health` contesta `90736a976`** con 62 s de uptime — el único testigo que no depende de dónde escribió nadie. **La bandera**: `KEPLER_AJUSTE_ABONO_ESCRITURA=encendida` por `kubectl patch` (⛔ nunca `--from-env-file`), el secreto pasó de **55 a 56 llaves** con las 9 `KEPLER_PUSH_URL_*` intactas, y `rollout restart` **sin corte** (2 réplicas, `maxUnavailable: 0`, 0 reinicios). **El interruptor**: encendido **sólo en la 08**, en una transacción que revierte si toca más de una fila, si queda otra encendida o si aparece un tope del día — las otras 8 apagadas y ninguna con tope, o sea **el automático sigue apagado**. **La prueba de que la ruta existe y está gateada** (la lección de #414): `POST /api/finance/ajuste-abono/08` sin token da **401**, y una ruta inventada da **404** — el control de que el 401 no es un comodín. ⬜ **Falta el canario, y falta por una razón concreta: no hay pantalla.** La única entrada es el endpoint, así que nadie de Crédito puede dispararlo todavía; eso es **GP.R.4**. Y sigue pendiente ver un Ajuste Abono capturado **a mano** por una persona, con foto antes/después: las cinco tablas tienen cero disparadores y lo que mueve el programa de Kepler **no se ve escribiendo desde afuera**. ⭐ De paso, un hallazgo ajeno medido al regenerar `MATRIZ_ACCESOS.md`: su sección «permisos sensibles» elige **por el nombre** (`/AUTORIZAR|VALIDAR|APROBAR|.../`), así que **`FINANCE_CARTERA_TELEFONOS` queda fuera aunque escriba en Kepler**. Mi llave no sale ahí por otro motivo —todavía no cuelga de ninguna pantalla, o sea no está en `AUTHZ_TREE`—, y por eso la matriz se **revirtió**: sus 66 líneas de cambio eran movimientos de personas, no de este tramo. Deuda con nombre: el criterio debería mirar **qué hace** la llave, no cómo se llama | Claude, a pedido de Edgar |
| 2026-11-25 | ⛔⛔ **Medir prod después de empujar destapó DOS defectos que ninguna prueba vio** (Edgar: «te autorizo»). La migración `20261125100145` **ya estaba aplicada** (batch 1251, 18:09:26 UTC) — la aplicó otra sesión desde el árbol compartido **42 min antes de que el archivo llegara a `origin/main`**, así que lo que corrió allá es la versión previa a la edición de hoy. **(1)** La tabla de prod **no tiene `cfdi_insoluto`**, y el servicio la escribe: cerrar el registro habría reventado con «column does not exist». **(2)** ⛔ El más caro: el `CHECK` de `estado` nació con `(pendiente, escrito, apagado, rechazado)` y el servicio devuelve **`ya_estaba`** en el reintento idempotente — **el camino idempotente habría violado el CHECK justo al reintentar, que es cuando más importa**. La prueba del registro ejercía el CHECK con un estado inventado y **nunca con éste**; ahora va como control positivo, con su negativa (`ya_estaba` sin folio no entra). Las dos entran por `20261125125330_gpr3_insoluto_sat_y_ya_estaba.js`, idempotente (`hasColumn`, restricciones leídas antes de rehacerse), para que prod y una base nueva lleguen al mismo esquema por caminos distintos. La `100145` **no se toca** y queda anotada con lo que realmente corrió. ⭐ **Lo demás de prod sí quedó bien, verificado uno por uno:** los 9 interruptores apagados y sin tope · la llave en `credito_cobranza` (+ superadmin) · `app_runtime` con SELECT/INSERT/UPDATE y **sin DELETE** · los 5 índices (incluido el único parcial de «uno en curso por cliente») · RLS **activo y forzado** con su policy. 0 filas en el registro. ⭐ Y el barrido completo de lo que el servicio escribe contra la tabla real: las 11 columnas del INSERT existen, y los cinco `CHECK` pasan en los cinco estados — el único que fallaba era `ya_estaba` | Claude |
| 2026-11-25 | ⭐⭐ **GP.R.3 HECHO: el carril de escritura completo, apagado al nacer** (Edgar: «realiza todo para que ya podamos probar en prod»). El **adaptador** reusa el carril probado por el ensayo y agrega lo que el ensayo no tenía: **el control del efecto DENTRO de la transacción** —si el saldo de la factura no queda en cero, revierte— y el rechazo distinguido entre reintentable y no. El **servicio** lleva el interruptor por sucursal, el registro (`pendiente` → `escrito`) y **un doble testigo**: lee el resto en la cartera y el adaptador lo relee del Kepler vivo; si no coinciden al centavo, no se escribe. El **controlador** expone `POST /api/finance/ajuste-abono/:sucursal` con `FINANCE_RESTOS_CERRAR`, que se agregó al enum (regla 20). **37 pruebas en verde** y el typecheck **con su prueba negativa** (lo rompí a propósito y verifiqué el rojo antes de creerle al verde). ⛔ **Tres defectos propios, cazados midiendo y corregidos:** (1) el armador **no pisaba la fecha** —el ajuste habría nacido con la de la plantilla, y las plantillas vivas son de **sep/oct-2026 y nov-2025**, meses cerrados—: ahora decide `c9`, `c68`, `c69` y `c43`, con su prueba negativa; (2) escribía `kdue.c17` como texto cuando la columna es `numeric`; (3) la decisión se numeró **D-F9, que ya estaba ocupada** en `VERDAD_ABSOLUTA.md` — es **D-F10**. ⛔⛔ **Y el hallazgo que cambia el alcance, de la frase de Edgar «todo debe pasar como PPD»** (medido en prod, §41.12 de `VERDAD_ABSOLUTA.md`): un Ajuste Abono **no emite CFDI**, y **220 de los 260 restos vivos son facturas PPD** (los 220 tienen CFDI; la liga `serie = <sucursal><doc_code>` + folio se probó: **400 de 400**). O sea que cerrar el resto en Kepler **NO lo cierra ante el SAT**. Ya hay **1,782 facturas de 2026 así, $729.78** —medido sobre los 9,889 complementos, parseando cada `DoctoRelacionado` del XML, con control aritmético de **0 de 15,160 renglones sin cuadrar**— y **están timbradas: no se arreglan hacia atrás**. Por eso cada ajuste guarda `cfdi_insoluto` (`NULL` = no medido, **nunca cero por omisión**). → **D-F10**. ⭐ **Tres cosas más que aparecieron midiendo:** los 40 restos de `UD12`/`UD13` **no tienen CFDI** (control: entre lo emitido sólo existen `UD05`, `UD06` y `UD08`), así que ahí el ajuste no deja nada abierto; **el Kepler de la sucursal 03 contiene 16 Ajustes Abono cuyo `c1` dice `02`** —eso explica por qué el ODS da 67 renglones para los 51 documentos de §1.3, y es la razón por la que el filtro `c1 = <sucursal>` de la plantilla **no es cosmético**—; y **hay 11 complementos de 2026 por $1 a $10** que, si salieron de un «Cobro» de redondeo, declaran un pago que no ocurrió (**D-F12**). ⬜ **Falta para el canario:** aplicar la migración, encender la bandera y el interruptor de UNA sucursal, y que alguien capture un Ajuste Abono a mano para ver qué mueve el programa de Kepler (cero disparadores: no se ve en un ensayo) | Claude, a pedido de Edgar |
| 2026-11-25 | **GP.R.2 hecho: el armador del Ajuste Abono** (`ajuste-abono.armador.ts`), C1 y puro. Estrena las dos restricciones que encontró el ensayo: la referencia **cabe en 20 caracteres** (`kdm1.c11` es `varchar(20)`) y el plan se vuelca con el patrón `_h0 → _h → md`. Reusa `esRestoDeFactura` con el tope de CLIENTE — una prueba se pone roja si alguien vuelve a atar los dos topes. 12 pruebas en verde y **dos guardas rotas a propósito para ver el rojo** (el cobro previo y los 20 caracteres). ⬜ Sigue faltando GP.R.3 (el adaptador) y lo que mueve el programa de Kepler, que **no se ve en un ensayo** | Claude |
| 2026-11-24 | ⭐⭐ **GP.R.3 — LA PRUEBA DE ESCRITURA PASÓ** (Edgar: «hagamos prueba de escritura»). `ops/prod/ensayo-ajuste-abono/` escribe un `U-A-30` de verdad en el Kepler vivo de Morelia Abastos y lo deshace: folio `0000002` del contador real `KFUA3001.08` (antes 2, máximo 1, **no atrasado**), encabezado clonado de la plantilla, renglón de `kdue` y aplicación de `kdm5` (1 fila cada uno), y **el saldo de la factura `8-1-0000470` pasó de $7.20 a $0.00** dentro de la transacción. **Control tras el ROLLBACK: 0 documentos del ensayo · contador IGUAL · saldos IGUALES.** El `ROLLBACK` es incondicional, en `finally`: no hay camino que confirme. ⭐ **Dos restricciones que sólo aparecen escribiendo, cazadas sin escribir nada:** (1) `clonarFila` **inserta y después pisa**, así que clonar directo a `md.kdm1` choca con `pk_kdm1` — hay que armar en una temporal sin llave y volcar al final, como `kepler-nota-sink`; (2) **`kdm1.c11` es `varchar(20)`**: la llave de idempotencia tiene que caber en 20 caracteres. Reusa `reservarFolioKepler` y `clonarFila`, no los reimplementa | Claude, a pedido de Edgar |
| 2026-11-24 | ⭐ **GP.R.0c aplicado y dos premisas corregidas (§2.2).** Medido a nivel COLUMNA —`has_table_privilege` miente cuando el permiso es por columna— faltaba **un solo permiso**: `INSERT` en `md.kdue`. Aplicado en **8 de 9** (CEDIS sin `pg_hba` para `sa`) y verificado con `kepler_push` preguntándose a sí mismo. ⛔ **Falso lo de «los acumulados en `kdud`»**: `kdud` tiene 4 columnas numéricas (control: `kdxg` tiene 49), es el maestro del cliente, no un contador. `kdug` tampoco es su espejo (layout corrido, 147–546 filas por sucursal). ⭐⭐ **Y las cinco tablas tienen CERO disparadores**: todo lo hace el programa de Kepler. De ahí que **el ensayo con ROLLBACK pruebe nuestra escritura pero NO pueda descubrir qué mueve Kepler** — eso se ve mirando un ajuste real capturado por una persona, con foto antes/después. Son 10 min de Crédito y cobranza, no ingeniería | Claude, a pedido de Edgar |
| 2026-11-24 | **D-R1 firmada ($10, automático) y dos tercios de GP.R.0b cerrados SIN escribir** (§2.1): el contador de folios es `KFUA3001.<sucursal>` con el folio siguiente en `c4`, cuadrado contra `max(folio)+1` en **9 de 9** —y con la trampa de los dos renglones por sucursal documentada—, y el Ajuste Abono **no emite CFDI** (no hay serie `U-A-30` en `kdfe33folxdoc` en ninguna sucursal, con control en los dos sentidos: `U-A-7` y `U-A-21` sí están, `U-A-5` no). Queda sólo `kdud` para el ensayo. **Corregida una premisa de §1.3**: 1 de los 51 ajustes sí trae `c11`, así que la idempotencia no puede apoyarse en «los manuales van vacíos». Re-medido hoy: **216 facturas de telemarketing con resto ≤ $10 ($165.53)**, en 01 (95), 06 (69) y 08 (52); la pila crece 50–80 al mes y en 60 días se cerraron **74 restos con un «Cobro» de centavos y cero con Ajuste Abono**. ⭐ Aclarado, porque la pregunta lo destapó: **el cobro se captura en Kepler, no en la Suite** (`/finanzas/cobranza` es evidencia read-only), así que el disparo es ver llegar el cobro por el ODS. Edgar descartó llevar la captura del cobro a la Suite dentro de este anexo | Claude, a pedido de Edgar |
| 2026-11-24 | ⛔⛔ **El tope era UNA constante para las DOS decisiones, y partirla fue el trabajo de firmar D-R1.** `RESTO_TOLERADO = 1` decía en su propio comentario «es D-C1 (PGP) y D-R1 (GP); si cambia, cambia aquí»: subirla a $10 por la decisión de **clientes** habría movido callado el lado de **proveedores**, donde el anexo afirmaba «ninguno de $1 a $10» (19-nov) y **hoy hay 55 documentos por $193.48**. Ahora son `RESTO_TOLERADO_CLIENTE = 10` y `RESTO_TOLERADO_PROVEEDOR = 1`, y **el tope es parámetro obligatorio** de `esRestoTolerado`/`esRestoDeFactura`: el default silencioso es lo que permitió la confusión. Los 5 consumidores nombran el suyo (cliente: regla de autorizar, cartera, pantalla; proveedor: cierre de pago, nota de centavos). **Antes/después de clientes** (regla 15): 32 facturas más ($108.11) cuentan como pagadas y los «morosos sólo por resto» pasan de **16 a 19**, con el control de que los 1,471 clientes con algún vencido **no cambian**. Pruebas: 2 controles nuevos (los topes no se mueven juntos; $5 es resto de cliente y deuda de proveedor) **con su rojo verificado**, y la prueba espejo del SQL dejó de clavar el literal y ahora se arma con las constantes. `ngc --noEmit`: 0 errores. `check:pantalla` de `finanzas-cartera`: sin falla nueva. ⚠️ **NO MEDIDO**: la pantalla viva (el rótulo del redondeo ahora dice «hasta $10», no se vio en navegador) | Claude |
| 2026-11-20 | **GP.R.1 (pantalla) 🧪.** `/finanzas/cartera`: el cliente cuyo vencido es puro redondeo dice «Redondeo» en la columna Vencido (con el monto atenuado), no pinta la fila de vencida y en «Más vencido (cobrar)» cuenta como cero; en el detalle, la partida de centavos de una factura cobrada dice «Redondeo» en vez de «Nd» (misma `esRestoDeFactura`). Sin KPI nuevo: $58 contra $64 M no decide nada arriba. Cinco preguntas por escrito en la sesión; 3 pruebas nuevas (28/28) con mutante rojo; `check:pantalla`: 0 fallas nuevas, tipa 0 errores; `check:templates` verde. **Sin validación visual** (no se levantó la app) | Claude |
| 2026-11-20 | **GP.R.1 (servidor) 🧪.** La regla vive en `libs/contracts/src/finance/resto-tolerado.contract.ts` (`esRestoDeFactura`; `cierre-kepler` la re-exporta, mismo objeto). La cartera (`CustomerLedgerService.cartera`) agrega por cliente `resto_redondeo`, `n_restos` y `solo_resto_vencido`, y en el KPI `resto` — **aditivo: `saldo` y `vencido` no cambian** ($64,523,305.85 vencido antes y después). Medido en prod con la misma condición: $57.92 en 188 partidas ≤ $1, **17 clientes vencidos sólo por resto** (15 de telemarketing). Ojo: la cartera lee `customer_receivables.saldo_ajustado` y da 155 restos ≤ $1 de telemarketing; `customer_receivables_current.saldo_documento` da 177 — dos saldos distintos, por conciliar. Pruebas: 5 del contrato + 4 de la cartera, cada una con su mutante rojo. Falta: mostrarlo en la pantalla (C3, skill `diseno`) y usarlo en GP.A.1 | Claude |
| 2026-11-20 | Nace el anexo. Medido en prod (sólo lectura): 207 facturas de telemarketing con resto ≤ $10 ($161.32, 113 clientes, 17 morosos sólo por eso); hoy se cierran con «Cobros» de centavos; el Ajuste Abono (`U-A-30`) existe y no deja póliza (control `U-A-5`/`U-A-21` en el mismo mes); su huella es `kdm1` + `kdue` + `kdm5`, y Kepler no guarda saldo en la factura de cartera (632/632). Se corrigió una primera lectura que medía proveedores | Claude, a pedido de Edgar |

---

## 7. ⭐ Cómo se enciende el canario (lo que falta para probar en prod)

> Escrito el 2026-11-25, cuando GP.R.3 quedó hecho y **apagado**. El código ya no es el cuello: lo que
> falta son cuatro actos, y **tres de ellos los tiene que autorizar una persona**.

El carril tiene **cuatro candados en serie** y están los cuatro puestos. Se quitan en este orden, y
cada paso se verifica antes del siguiente:

| | Acto | Quién | Cómo se comprueba que quedó |
|---|---|---|---|
| 1 | **Aplicar la migración** `20261125100145` en prod, una por una (⛔ nunca `migrate:latest`) | Dev, con push previo | `finance.customer_credit_adjustments` existe, el interruptor trae **9 renglones apagados** y la llave quedó en `credito_cobranza` — la propia migración lo imprime y se niega si nace encendido |
| 2 | **Repartir la llave**: quien ya la tenga por rol, vuelve a entrar (el JWT trae los permisos) | — | La persona de Crédito ve la acción en la pantalla |
| 3 | **La bandera** `KEPLER_AJUSTE_ABONO_ESCRITURA=encendida` en el secreto `prod/kepler-push` (⛔ **`kubectl patch`, nunca `--from-env-file`**: ese secreto tiene llaves que su maestro no) + `rollout restart` | Edgar autoriza | El adaptador deja de contestar «apagado» |
| 4 | **El interruptor de UNA sucursal** (Morelia Abastos, 08 — la del ensayo), **sin tope del día**: encendido = se puede **a mano**; el automático necesita además un `tope_dia` | Edgar autoriza | `kepler_push_switch` con `encendida = true` en la 08 y en **ninguna otra** |

Y entonces el canario es **un solo ajuste, sobre un resto que Edgar elija**, con la foto antes/después
tomada del ODS —no de la respuesta del POST, que es la misma fuente que escribió—.

### ⛔ Lo que el canario sí puede descubrir, y que ningún ensayo puede

Las cinco tablas tienen **cero disparadores**: todo lo mueve el programa de Kepler. Así que **lo que la
aplicación hace al postear un ajuste —acumulados, póliza— no se ve escribiendo desde afuera**. Para
saberlo hay que pedirle a alguien de Crédito y cobranza que **capture un Ajuste Abono a mano en
Kepler** mientras se mira el antes/después por `xmin`. Eso sigue pendiente y es **lo único** que
distingue «nuestra escritura es igual a la de Kepler» de «se le parece».

### ⬜ Y dos cosas que NO se arreglan encendiendo esto

1. **El insoluto ante el SAT** (D-F10): 220 de los 260 restos son facturas PPD y el ajuste no emite
   CFDI. El ajuste **declara** lo que queda debiendo; cerrarlo es otra decisión y otro documento.
2. **Las 1,782 facturas de 2026 que ya quedaron con su resto vivo ante el SAT** ($729.78): sus
   complementos están timbrados y no se editan. Esto para el goteo hacia adelante, no hacia atrás.

---

## 8. `[GP.R.4]` La entrada: las cinco preguntas, contestadas antes de maquetar

> Obligatorio por [`diseno` §0b](../../../.claude/skills/diseno/SKILL.md). Escrito el 2026-11-25,
> **antes de la primera línea de plantilla**, con prod medido en sólo lectura.

### Lo medido primero (pasos 1–3 de `diseno` §0a)

**El propósito** no es «una pantalla de restos»: es **un acto que falta en una pantalla que ya
contesta la pregunta**. La ficha del cliente en `/finanzas/cartera` ya dice qué centavos le quedan
—marca «Redondeo» desde `[GP.R.1]`—; lo que no hay es **cómo cerrarlos**.

**Quién entra y con qué pregunta** (`analytics.ui_usage`, últimos 30 días, último uso **hoy**):

| Endpoint | Rol | Hits |
|---|---|---:|
| `/api/finance/receivables` (la lista) | `credito_cobranza` | **2,771** |
| `/api/finance/receivables/:sucursal/:cliente` (**la ficha**) | `credito_cobranza` | **867** |
| `/api/finance/cartera-telefonos/:sucursal/:cliente` | `credito_cobranza` | 140 |

⭐ **La ficha se abre 867 veces al mes, y la misma gente ya ejerce desde ahí una acción que escribe
en Kepler** (el teléfono del cliente, `[CXC.48]`). O sea: el lugar existe, el rol existe y el
precedente de escritura existe. ⛔ *Corrección de instrumento: `node .claude/skills/pm/uso.js
/finanzas/cartera` dio «SIN LLAMADAS» — `ui_usage` guarda la ruta de la **API**, no la del front.
Un cero de instrumento, no de uso.*

**El estado real** — restos vivos (≤ $10, con cobro previo), por sucursal:

| Sucursal | Restos | Clientes | Pesos |
|---|---:|---:|---:|
| **Morelia Abastos** (la única encendida) | **53** | **27** | $27.31 |
| Canindo | 98 | 51 | $87.64 |
| Morelia Madero | 72 | 43 | $58.01 |
| CEDIS | 37 | 22 | $8.18 |
| Zamora | 1 | 1 | $6.16 |

⭐ **La unidad de trabajo es el CLIENTE, no la factura**: un `U-A-30` cierra varias facturas de una
vez. En Morelia Abastos son **27 decisiones**, no 53.

### ⛔ La decisión de fondo: NO va una bandeja nueva

`[GP.R.4]` estaba escrito como «bandeja Restos por cerrar». **Se cambia, y por lo medido:** una
bandeja sería **una segunda lista del mismo hecho** que la ficha ya muestra —justo lo que
[`diseno` §9](../../../.claude/skills/diseno/SKILL.md) prohíbe y lo que costó las dos pestañas de
`/compras/oc-abiertas`—, y mandaría a Crédito a un lugar nuevo cuando ya va a la ficha 867 veces al
mes. **El acto se pone donde el resto ya se ve.** Si algún día hace falta trabajar los 144 clientes
en lote, esa es otra conversación y otra medición.

### Las cinco preguntas

| # | Pregunta | Respuesta |
|---|---|---|
| **1** | **¿Qué ve al entrar, y en qué orden?** | En la ficha del cliente, **arriba de las partidas**: una línea que dice **cuántos centavos sueltos tiene y en cuántas facturas**, con el acto al lado. El orden de las partidas **no cambia** — esto no reordena nada |
| **2** | **¿Qué NO ve?** | No ve una bandeja nueva · no ve el tope ni el nombre del documento de Kepler como si fueran configuración · y **donde el interruptor está apagado no ve el acto** (8 de 9 sucursales hoy): ofrecer un botón que va a fallar es el error como primer recurso (Poka-yoke) |
| **3** | **¿Qué accesibilidad necesita la información?** | ⛔ La jerga sale del `title`: hoy *«Centavos que quedaron de una factura ya cobrada… se cierran con un Ajuste Abono, no con otro cobro»* vive **sólo en un `title`**, y sin mouse no existe (regla P). Va a `<app-context-help>`. El acto es un botón real, alcanzable con teclado, con **confirmación en línea** —el patrón que esta misma pantalla ya usa para cancelar un compromiso, no un diálogo encima del diálogo— y **deshabilitado síncrono en el primer clic** (idempotencia visual) |
| **4** | **¿Está ligada a otro proceso?** | Sí, a dos. Hacia atrás: el **cobro** que dejó el resto (ya se ve como aplicación bajo la factura). Hacia adelante: el **Ajuste Abono** queda con su folio de Kepler, y al recargar las partidas las facturas aparecen saldadas con su aplicación. ⛔ Y una liga que **no** se puede cerrar: el **CFDI**. El ajuste no timbra, así que la respuesta **declara lo que la factura sigue debiendo ante el SAT** y la pantalla lo dice — nunca dibuja la factura como cerrada ante Hacienda (D-F10) |
| **5** | **¿Este proceso la debe ver?** | Sí: es Crédito y cobranza quien decide hoy —con un «Cobro» de centavos— y quien ya está en esta pantalla. Llave propia (`FINANCE_RESTOS_CERRAR`), que no viene con «ver cartera» |

### ⬜ Lo que la interfaz NO puede resolver (paso 12, se dice primero)

1. **El insoluto ante el SAT** (D-F10): ninguna pantalla lo cierra. Se **declara**.
2. **El automático**: existe en el interruptor (`tope_dia`) y sigue **apagado**. Esta entrada es
   sólo a mano, con nombre y motivo.
3. **Las 8 sucursales apagadas**: la acción no aparece ahí hasta que alguien las encienda, y eso no
   es una decisión de diseño.

### Las cinco preguntas, otra vez — con la pantalla terminada (2026-11-25)

La skill las pide **dos** veces, y la segunda cambió dos cosas:

| # | Lo que se contestó antes | Lo que quedó |
|---|---|---|
| **1** | una línea con el conteo y el monto, arriba de las partidas | igual, y **el monto se puede recorrer**: las facturas que lo forman están abajo, marcadas «Redondeo» (`check:cifra`: 0 nuevas) |
| **2** | donde está apagado no se ve el acto | igual, **y se dice por qué** — un «no se puede» mudo manda a buscar el problema donde no está |
| **3** | la jerga sale del `title` y va al diccionario | hecho: tema `restos_cliente`, con lo que el ajuste **no** cierra. ⛔ Y el `title` del tag dejó de ser la definición: ahora es una etiqueta corta |
| **4** | el ajuste queda ligado a las facturas que cerró | igual, **y la ficha se recarga sola** para que las facturas se vean saldadas |
| **5** | le toca a esta pantalla, con llave propia | igual |

#### ⛔ Dos cosas que cambiaron al construir, y la segunda era un defecto de verdad

1. **El motivo ya no se teclea: lo deriva el sistema.** El diseño pedía un campo de texto obligatorio.
   Medido contra el trabajo real: en Morelia Abastos son **27 clientes**, o sea 27 textos a mano para cerrar
   $27.31. Lo que aporta la persona es **la decisión**, no la redacción — y su nombre queda en el registro
   igual. El motivo describe el acto («Resto de centavos de facturas ya cobradas, hasta $10»).
2. ⛔⛔ **El aviso se borraba solo, y lo cazó una prueba, no la vista.** Al cerrar, la ficha se recarga para
   mostrar las facturas saldadas; esa recarga volvía a preguntar si el acto está habilitado, y ese paso
   **limpiaba el aviso recién puesto**. O sea: la persona cerraba los centavos y **nunca veía la confirmación
   ni la advertencia del SAT**. Ahora el aviso sólo se limpia al empezar algo nuevo o al cambiar de cliente,
   y el arreglo está sellado con su **prueba negativa** (roto a propósito: 2 pruebas en rojo; restaurado: 50 en verde).

#### Lo medido al cerrar

- **50 pruebas** del componente (9 nuevas), **154** de finanzas, **1,846** de contratos.
- `check:pantalla -- finanzas-cartera`: **tipa con 0 errores semánticos** y **0 fallas NUEVAS** (las 3 que
  quedan son deuda declarada desde antes). `check:templates-types`: *«las plantillas de lo que se va a pushear
  typechequean»*. `check:templates`, `check:cifra`, `check:tables`: sin falla nueva.
- ⛔ **La compuerta me cazó a mí**: puse backticks en un comentario **dentro** de la plantilla, que es justo lo
  que parte el template literal (con número par el archivo parsea igual y revienta después). Verificado que sin
  mi cambio el repo estaba en verde, o sea que la falla era mía.
- ⚠️ **Sin validación visual**: no se vio en navegador, ni a 390 px. La advertencia `#9` (qué hace en angosto)
  y los otros `title` con definición son **deuda previa** de esta pantalla, no de este tramo.
