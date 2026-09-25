# Fase CS.3.1 — Captura de caja SIN fricción (autorrelleno + bloqueo + CAOS automático)

> Plan de mejora pedido por el usuario sobre la captura de Caja General (`/finanzas/caja-general`).
> Nace de dos observaciones suyas sobre la pantalla real (foto 2026-09-25):
> 1. *"no debe ser opcional… dejar lo menos posible al usuario final… automatizar. Ejemplo: 'ya se
>    tomaron 30 mil de CAOS' → adjunta lo faltante."*
> 2. *"la interfaz menciona que faltan datos, pero estos datos ya se traen y deben de estar disable."*
>
> Hereda el diseño de la Fase CS (CAOS) y de CG (Caja General). ADRs: 034 (adapter sin API),
> 056 (declarar lo que no se mide), 059 (arbitrar/declarar).

---

## El problema, con la foto en la mano

La pantalla «Registrar movimiento de caja» está anclada a un documento de Kepler
(`X-D-60 0000178 · RIFA ROSI · $130,000.00 · CAJA GENERAL`) y aun así:

- Pinta un buscador **vacío** «Cuenta y concepto de Kepler — Buscá por nombre, cuenta o código» y
  abajo dice **«Sin propuesta: no hay historia de este proveedor»** y **«Falta la cuenta y el concepto
  de Kepler: sin eso el movimiento no se puede contabilizar»**.
- Pero ese documento **ES de Kepler y su póliza ya tiene la contra-cuenta**. No falta el dato: falta
  **traerlo**.
- CAOS aparece como un **autocompletado opcional** («…o traer de la caja fuerte») que el capturista
  tiene que acordarse de abrir y buscar. Nadie lo usa solo.

**Dos síntomas, una sola causa:** la captura le pide a mano datos que el origen ya conoce.

---

## Principios (del pedido del usuario)

1. **Lo menos posible al usuario final.** Cada campo que el origen conoce se **trae**, no se teclea.
2. **Lo traído va BLOQUEADO (disable)** — se ve, no se edita (con un escape explícito «corregir»
   sólo si de verdad hace falta). Un campo vacío que dice «falta» sobre un dato que existe es un bug
   de UX, no un dato faltante.
3. **CAOS no es opcional.** Entra solo a la bandeja, como una fuente más, junto a los de Kepler.
4. **«Adjunta lo faltante».** Sólo lo genuinamente ausente queda editable, y lo mínimo posible.

---

## La matriz de campos: qué se TRAE+bloquea y qué queda al usuario (por origen)

| Campo | Origen KEPLER (documento) | Origen CAOS (caja fuerte) |
|---|---|---|
| Fecha | traído del doc · **bloqueado** | traído (`occurred_at`) · **bloqueado** |
| Sucursal | traído (`00`) · **bloqueado** | traído (`00`) · **bloqueado** |
| Tipo (ingreso/gasto) | del signo del doc · **bloqueado** | Depósito→ingreso / Dispensar→gasto · **bloqueado** |
| Beneficiario | traído del doc · **bloqueado** (escape) | operador (`user_external`) · **bloqueado** (escape) |
| **Cuenta + concepto de Kepler** | **⭐ traído de la póliza del doc · bloqueado** (hoy: manual) | **lo faltante** — proponer por `ref`; si no, manual |
| Glosa / «qué pasó» | del doc · **bloqueado** (escape) | `ref` de la máquina · editable |
| **Arqueo (billetes 500/200/100/50/20)** | **conteo FÍSICO · EDITABLE** (no se bloquea — ver ⚠️) | **⭐ conteo de la máquina · bloqueado** |
| Morralla / monedas | editable (lo faltante) | editable (lo que la máquina no cuenta) |
| Monto del movimiento | del arqueo · **bloqueado** (ya es así, CG.23) | del arqueo · **bloqueado** |

⚠️ **El arqueo de un documento de KEPLER NO se bloquea, a propósito.** La foto lo prueba: el doc dice
`$130,000.00` pero se contó `$1,003.00` (es una RIFA — el efectivo que pasó por la caja ≠ el importe
del documento). El conteo físico es **el control** de CG.23; bloquearlo con el importe del documento
sería falsear la caja. Sólo el arqueo de **CAOS** se bloquea, porque ahí la máquina contó de verdad,
billete por billete.

---

## R2 — La contra-cuenta se TRAE del documento (y se bloquea)  ⭐ el núcleo del pedido 2

**Hoy** (`cash-ledger.service.ts`): la cuenta se resuelve por, en este orden, (a) regla
`beneficiario→cuenta` (`cuentaPorRegla`), (b) mapa de ruta, (c) `autofill` = **historia** del
proveedor. Si ninguna pega → «Falta la cuenta» + buscador vacío. **Nunca se lee la cuenta del propio
documento.**

**Mejora:** el documento de caja (`X-D-25/26/60`, `X-A-45`) es una póliza; su **contra-pata**
(la cuenta de gasto/ingreso, la que NO es `c45=0011 CAJA GENERAL`) está en el ODS y **ya se lee** en
`import-expenses-polizas.js` / `analytics.expense_doc_chain`. Se deriva una vista
`analytics.v_caja_doc_contracuenta` (kdb1 del mismo folio, patas con `c45 <> '0011'`) y la bandeja la
trae junto al pendiente.

**Nueva precedencia de la cuenta (de más fuerte a más débil):**
1. **Contra-cuenta del propio documento** (nueva) → se trae y **se bloquea**. Es el dato de Kepler,
   no una inferencia.
2. Regla `beneficiario→cuenta` (se conserva; para lo que el doc no ancla).
3. Historia / `autofill` (se conserva como propuesta editable).
4. Manual con **motivo** (sólo cuando de verdad no hay de dónde).

⚠️ **Gate de medición (ADR-056/059), ANTES de bloquear:** una póliza puede **partirse** en varias
contra-cuentas (un depósito repartido). Hay que medir, por sucursal y doctype, **cuántas pólizas de
caja tienen UNA contra-cuenta limpia vs varias**. Sólo la **limpia** se bloquea; la **split** se
**declara** («este documento reparte en N cuentas — elegí/confirmá») y cae a manual acotado. Nunca se
inventa una sola cuenta para una póliza partida. Se mide el % y se publica en la pantalla (cobertura).

---

## R1 — CAOS entra a la bandeja SOLO (no picker)  ⭐ el núcleo del pedido 1

**Hoy:** CAOS es un `p-autocomplete` dentro del diálogo manual (`caosOpciones`/`buscarCaos`/
`elegirCaos`/`tomarMovimientoCaos`). Opcional y escondido.

**Mejora:** los movimientos de CAOS aparecen como **filas pendientes en la MISMA bandeja** que los de
Kepler, rotuladas «CAOS», con TODO lo que la máquina sabe ya puesto:

- Arqueo **pre-cargado y bloqueado** (denominaciones que contó la máquina).
- Tipo, fecha, sucursal, operador, `ref`→glosa: traídos.
- **Lo faltante = la clasificación** (contra-cuenta): se **propone por `ref`** donde se pueda
  (`ruta NN` → cuenta de efectivo de ruta; `pagos gdl` → cuenta de pago a proveedor), y donde no,
  queda a mano. Con propuesta → **un clic**; sin propuesta → clasificar y confirmar.

Ejemplo del usuario, ya cableado: *«ya se tomaron 30 mil de CAOS»* → esa dispensación aparece en la
bandeja con el arqueo de 30 000 ya contado y bloqueado; el capturista sólo dice **para qué fue** (o lo
confirma si el `ref` lo propuso) y listo.

⛔ **Auto-STAGE, no auto-CONFIRM.** «Dejar lo menos posible» ≠ «cero humano» cuando es dinero. La fila
llega pre-llena, pero un humano sigue metiendo el movimiento al libro con un clic. Auto-crear la fila
del `cash_ledger` sin confirmación abriría la puerta a asientos incompletos/duplicados en masa.

---

## Anti-doble-conteo (se mantiene, medido)

CAOS guarda el **bulto** de las rutas; Kepler los **cobros individuales** de esas mismas rutas → es el
mismo dinero por dos lados. Medido: **0% de llave común** por importe/grano (placebo ya corrido). Por
eso:

- Cada fuente se captura **una vez por su propia identidad** (candado `ux_cash_ledger_origen_vivo`).
- Las dos se muestran **rotuladas distinto** para que el capturista no asiente el mismo efectivo dos
  veces.
- **Red de seguridad = CS.4** (`/finance/caos/conciliacion`, control-total): si CAOS + Kepler
  asentados superan el flujo real de la caja, salta en el total. Se muestra como aviso en la pantalla.
- La partición limpia (qué flujo pasa por CAOS y qué no) es un **follow-up operativo declarado**.

---

## Mediciones (RESULTADO — corridas en `md`/prod read-only, 2026-09-25)

**Gate PASADO.** La contra-cuenta del propio documento **existe y es limpia**:

- Fuente: `analytics.gl_poliza_lines` con `source='kepler'` (281,173 líneas) — es el detalle de póliza
  keyed por **`tipo_pol`=doc_tipo compacto** (`X-D-26`→`XD2601`, `U-A-5`→`UA0501`, `X-D-60`→`XD6001`,
  `X-A-45`→`XA4501`) + `folio` + `num_movto`=pata. La pata que NO es `102…` (la caja) es la contra.
- **9,189 docs de caja (180 d) → 9,162 ligan (99.7%), 9,161 con UNA contra-cuenta limpia (99.75%)**;
  1 split, 27 sin ligar (recientes/timing). Por tipo: X-D-26 6647/6667 · U-A-5 2480/2486 ·
  X-D-60 31/32 · X-A-45 3/3.
- ⚠️ **Grano medido**: la contra es de nivel **mayor** — X-D-26 gasto → **`201 PASIVO A PROVEEDORES`**
  (24,750 de ~24,800 líneas), U-A-5 cobro → **`115 CLIENTES`**, algún X-D-26 → `103 OTROS INGRESOS`.
  **NO** es el concepto granular 601-xxx (ése lo pone el documento de gasto upstream, no el pago de
  caja). Es lo que **Kepler realmente postea** para ese documento → es el mirror fiel (ADR-059).
- Los tres (`201`/`115`/`103`) **existen en `analytics.v_kepler_conceptos`** (el catálogo que valida
  la captura): 201→5 conceptos, 115→14, 103→1. O sea la **cuenta** case y se puede fijar; el
  **concepto** (subcódigo) queda acotado a esa cuenta.
- ⭐ **`finance.cash_ledger` está VACÍO (0 filas) en prod.** Por eso «Sin propuesta: no hay historia»
  sale SIEMPRE — la propuesta por historia nunca tuvo con qué. Y significa que no hay grano heredado
  que romper: se diseña limpio.

**Diseño afinado por la medición:**
- **Cuenta**: autoritativa, de la póliza del propio documento → **se trae y se bloquea** (99.75%).
- **Concepto**: si la cuenta tiene UN solo concepto → se fija también; si tiene varios → elección
  **acotada a esa cuenta** (5–14 opciones), no un buscador en blanco sobre todo el catálogo. Al
  elegirlo se ofrece **recordarlo por beneficiario** (`declararCuenta`, CG.22.6) → la próxima vez va
  fijo. «Aprender una vez», honesto.
- **Fallback** (el 0.3% sin póliza + el split): cae al camino actual (regla/manual) **con su motivo**;
  ahí sí aplica «Falta la cuenta», pero como excepción, no como norma.

Pendiente de medir para R1 (no bloquea el arranque): **`ref` de CAOS → cuenta** (`ruta NN`,
`pagos …`) para proponer la clasificación de dispensaciones. CAOS NO tiene póliza en Kepler para estos
movimientos → su contra sale de regla por `ref`, o manual. Placebo CAOS↔Kepler: **ya medido 0%**.

Lo que no se pueda derivar se **declara** en pantalla (cobertura), nunca cero ni default disfrazado.

---

## Entregables (sprints)

- **CS.3.1a — Medición** (gate): las 2 mediciones de arriba en `md`. Sin esto no se bloquea nada.
- **CS.3.1b — Contra-cuenta del documento**: vista `analytics.v_caja_doc_contracuenta` +
  `cash-ledger.service.ts` la trae con nueva precedencia + UI: cuenta/concepto **traídos y bloqueados**
  (con «corregir»); el mensaje «Falta la cuenta» sólo para la póliza split o sin derivar.
- **CS.3.1c — CAOS a la bandeja**: `caosCapturables` alimenta la bandeja (no el picker); arqueo
  pre-cargado y **bloqueado**; fila rotulada «CAOS». Se retira el `p-autocomplete` como camino
  principal (se puede dejar como búsqueda de respaldo).
- **CS.3.1d — Propuesta de clasificación por `ref`**: regla `ref → cuenta` para CAOS (ruta/pago),
  con «sin propuesta» declarado. Un clic donde propone.
- **Verificación**: DB-direct en `md` (read-only + INSERT con ROLLBACK) para la derivación y el
  candado; **visual con clic real** (ejercer el gesto: elegir un pendiente, ver la cuenta bloqueada,
  ver el arqueo CAOS bloqueado, guardar). Gates del repo (`nx build/test`, `check-primeng-api`).

---

## Lo que NO se hace (crítico, para que nadie lo "arregle")

- **No se bloquea el arqueo de un documento de Kepler** — es el conteo físico, el control de CG.23
  (caso RIFA ROSI: $130k doc vs $1,003 contado).
- **No se auto-confirma** un movimiento de dinero — auto-stage sí, auto-insert al libro no.
- **No se inventa una sola cuenta** para una póliza que reparte — se declara y cae a manual acotado.
- **No se deduplica CAOS↔Kepler por fila** — 0% de llave común medido; la red es CS.4.

---

## ⚠️ Frescura del GL (medido) — el único hueco real de R2

El GL kepler (`gl_poliza_lines`) se recomputa **de noche** (último cómputo medido: 2026-09-25 03:35).
La liga de la contra-cuenta por recencia: **≤7 d 88.0% · 8-30 d 100% · 31-90 d 99.8% · >90 d 97.7%**.
O sea: los documentos de **HOY** (capturados después del corte nocturno) aún no tienen póliza en el
GL → **caen al fallback** (regla/ruta/manual) hasta que el GL corra esa noche. Es aceptable y honesto:
R2 resuelve casi todo, y lo fresco que no liga NO dice «faltan datos» a la ligera — usa el camino de
siempre. No se fuerza nada. (Mejora futura declarada: adelantar el GL de caja o derivar la contra en
vivo desde `kdb1`/`kdc2` para el mismo día.)

## CS.3.2 — Patrones de enlace caja⇄CAOS + base que APRENDE (medido 2026-09-25)

Pedido: conectar los movimientos de nuestro sistema con CAOS; que al capturar un gasto el arqueo tome
lo que ya salió del cajero («ya se agregaron 20 mil») y agregue lo restante. Como CAOS↔Kepler **no
comparten llave (0%)**, el enlace se APRENDE de confirmaciones humanas y se propone por patrones — no
por monto ciego.

**Patrones medidos (prod, read-only):**
- **Fecha**: el enlace es **MISMO DÍA**. Monto exacto + mismo día = **~90% precisión** (47 real / 5
  placebo); ±1 d ~80% (60/12); ±3 d ~68% (84/27). `accounting_date` = `occurred_at` (981/982).
- **Ref**: depósitos = **ruta** (`rd28`, `ruta 21`, `rd morelia/canindo`); dispensaciones =
  **propósito/proveedor** (`cueritos`, `bolsas`, `nomina`, `gnf ma`, `lic omar`). Señal fuerte.
- **Operador = rol**: 006 sólo deposita (495/0), 003 sobre todo dispensa (125/250), 002 dispensa (29/61).
- **Hora**: depósitos por la tarde (~15 h), dispensaciones a mediodía. Kepler no guarda hora → sólo
  ordena dentro del día, no cruza.
- **Monto solo NO alcanza** (1 de 3 «matches» es falso por azar) **y falla el caso parcial** (gasto
  25k pagado con 20k del cajero: los montos no coinciden). Por eso: **proponer + confirmar**, nunca
  aplicar a ciegas.

**La base que aprende (migración `20260925170000`, verificada read-only):**
- `finance.caos_cash_links` (tabla real — HITL/feedback, RLS): enlaces **CONFIRMADOS** caja↔CAOS;
  **CONSUME** el movimiento (índice único vivo `ux_caos_link_vivo`, anti-doble-conteo); `senales jsonb`
  guarda qué patrones matchearon (para aprender cuáles son confiables).
- `analytics.v_caos_link_patterns` (vista, derive-no-copy): `ref → cuenta/concepto/beneficiario/
  operador típico + casos + rezago`. Cada enlace confirmado la afina → **la precisión sube sola**.
- El **matcher** (siguiente): rankea candidatos por señales cold-start (mismo día + ref + operador) +
  boost de lo aprendido, y el humano confirma con un toque; el confirm escribe el enlace.

**Pendiente CS.3.2:** el matcher (candidatos rankeados + confirmar en el arqueo) · seguir minando
(fecha embebida en el ref, precisión por señal con feedback negativo, depósitos↔cobros de ruta) ·
aplicar la migración a prod por el deploy normal.

## Estado (2026-09-25)

- **CS.3.1a Medición** ✅ (prod read-only): contra limpia 99.75%, grano mayor 201/115/103, `cash_ledger`
  vacío, batch 19 ms, frescura por recencia.
- **CS.3.1b Backend** 🧪 EN CÓDIGO: migración `20260925160000_analytics_caja_doc_contracuenta.js`
  (vista) + `cash-ledger.service.ts` (piso de contra-cuenta en `resolverCuentas`, helpers
  `claveDoc`/`tipoPolCompacto`/`contraDeDocumentos`/`conceptosDeCuenta`). Typecheck limpio.
- **CS.3.1b Frontend** 🧪 EN CÓDIGO: `cuentaFuenteDoc` + bloqueo/elección acotada del concepto +
  «corregir» + tipo `MovimientoPendiente` extendido. Gate primeng ✅. **Validación visual con clic
  real: PENDIENTE** (prod es real; los dev servers los levanta Edgar).
- **CS.3.1c CAOS a la bandeja** 🧪 EN CÓDIGO: sección «Caja fuerte (CAOS)» en la página de caja —
  los movimientos de CAOS aparecen SOLOS (carga al entrar + repaso en vivo 60 s + socket), ya no un
  buscador opcional. Un clic abre la captura con el arqueo de la máquina **precargado y BLOQUEADO**
  (billetes 500/200/100/50/20 disabled; morralla y clasificación = «lo faltante»). Gates: build view,
  templates, spec (57, +2 R1: aparece-solo y arqueo-bloqueado-por-DOM) verde. Visual: PENDIENTE.
- **CS.3.1d (propuesta de clasificación por `ref` de CAOS)**: PENDIENTE — CAOS no tiene póliza en
  Kepler para estos movimientos, así que su contra-cuenta sale de regla por `ref` o manual. Declarado.
- **Aplicar migración a prod**: por el flujo normal de deploy (⛔ nunca `migrate.latest()` contra
  prod; es una vista, ligera).

## Abierto / declarado

- **Grano del gasto (a confirmar con el usuario):** la contra fiel del gasto es `201 PASIVO A
  PROVEEDORES` (lo que Kepler postea). Si contabilidad quiere el gasto GRANULAR (601-xxx), eso NO
  está en la póliza del pago de caja y se resuelve con las reglas/`declararCuenta` (aprender una vez).
- **Split**: medido **1** doc split en 180 d — cae a manual, declarado. No se inventa una cuenta.
- % de `ref` de CAOS parseables → pendiente (gate de CS.3.1d).
- CS.0 sigue pendiente: anclar QUÉ caja/sucursal es CAOS y mapear operadores (bloquea CS.4/CS.5).
- Seguridad CAOS: rotar `admin/caos` (login compartido, lo coordina 0Sistemas).
