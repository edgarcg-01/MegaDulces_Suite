# Caja General — la supervisión de los cortes (`CGS`)

> Plan por capas de **cómo trabaja la supervisora de Caja General**: qué revisa cada mañana, qué
> la deja firmar y qué no, y qué candados impiden que la caja siga operando sin rendir cuentas.
> Sigue a [`FASE_CG_LEGIBILIDAD_DOS_CABEZAS_2026-10-19.md`](FASE_CG_LEGIBILIDAD_DOS_CABEZAS_2026-10-19.md)
> (que nombró a la supervisora y diseñó el «Modo Supervisión») y a los items `CGS.1`–`CGS.6` ya
> entregados. Método: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
>
> ⚠️ **No es una fase nueva.** Son items de la fase **CG / CGA** (ya 🔨), bajo el prefijo `CGS`
> que ya existe en el tracker. No ocupa cupo nuevo ni pide fila en el roadmap. La numeración
> nueva arranca en `CGS.10` para no chocar con `CGS.7`–`CGS.9`, que otra sesión tiene en curso.

```
OBJETIVO: que ningún día de caja quede sin corte, y que cada corte lo revise y firme
          (o lo devuelva con motivo) alguien que no lo capturó, a la mañana siguiente.
MÉTRICA:  cortes revisados (autorizados u observados) antes de las 12:00 del día siguiente
          HOY (2026-10-21): 0 de 7  → META: 100 % de los días hábiles, sostenido 2 semanas
MÉTRICA 2: jornadas con movimientos y sin corte cerrado al iniciar el día siguiente
          HOY: 1 (20-oct: 30 movimientos, $494,128.13) → META: 0
CAPA TOPE: C3
ÁREA:      Finanzas
DUEÑO:     Edgar (decisiones) · supervisora operativa: María de la Paz Gutiérrez (`maria_gutierrez`)
ESTADO:    🔨 (dentro de CG)
```

---

## 1. Qué problema resuelve — medido en prod el 2026-10-21 (sólo lectura, `dev_ro`)

Todo lo de esta tabla se leyó en `pg-prod` (clúster `7688376744939610156`) con la cuenta de sólo
lectura. No es una estimación.

| Hecho | Cifra | Qué significa |
|---|---|---|
| Cortes cerrados / autorizados | **7 / 0** | La segunda llave nunca se ha usado en producción |
| Quién abrió y cerró los 7 cortes | **`carmen_rodriguez` los 7** | Una sola persona rinde cuentas de su propio cajón |
| Cortes cerrados el mismo día | **3 de 7** | Los otros 4 se cerraron entre 1 y 3 días tarde (43 h a 90 h desde que empezó el día) |
| Jornada del **20-oct** | **30 movimientos, $494,128.13, sin corte** | Y el 21-oct ya se capturaron **5 gastos por $145,906.50** encima |
| Quién capturó el 20-oct | **`maria_gutierrez` 29 de 30** ($492,958.13) | **La supervisora capturó el día que luego tendría que autorizar** |
| Regla de doble llave hoy | `authorized_by ≠ closed_by` | No mira quién capturó los movimientos: María podría autorizar un corte con sus 29 capturas |
| Personas con `FINANCE_CAJA_GESTIONAR` (sin admins) | **20**: contabilidad 4, finanzas_operativo 7, marketing 3, gerente_compras 2, crédito 2, finanzas 1, tesorería 1 | **Capturaron 3.** Marketing y Compras pueden registrar salidas de efectivo |
| Movimientos de un corte cerrado editados **después** del cierre | **28, los 28 con `updated_by` NULL**, en 7 tandas | Fueron migraciones. No queda constancia de quién ni de qué valor había antes |
| Bitácora general de acciones de caja | **No existe** | Sólo `cash_ledger_reclasificaciones` registra una clase de cambio |
| Cadena de fondos | **1 eslabón roto**: CC-00003 se corrigió a $14,128.50 (CGS.5) y CC-00004 sigue abriendo con $24,960.00 | **$10,831.50** de diferencia que el esperado de CC-00004 arrastra sin decirlo |
| Cortes con esperado negativo (`esperado_imposible`) | **4 de 7** | No se pueden juzgar mientras el depósito bancario no exista en el libro (0 movimientos `deposito`, decisión D7 abierta) |
| Movimientos con `fecha` ≠ día de captura | **97, $1,216,214.79** | Captura de días atrasados: normal en la migración, sospechoso si sigue |
| Gastos sin firma del receptor | **149 de 193** ($1.22 M) | ⚠️ **No son gastos sin respaldo**: los 149 tienen documento, vínculo o motivo. La firma no aplica a todo |
| Conteos físicos de la caja fuerte CAOS | **0 en toda la historia** | El saldo de la máquina sólo lo dice la máquina |
| Tolerancia de diferencia | **1 centavo** (`CORTE_EPSILON`) | No hay regla de negocio sobre qué diferencia exige explicación |

### Lo que ya funciona y no se toca

- **El conteo es ciego**: la cajera sella su conteo antes de ver el esperado
  (`cash-cut.service.ts`, `contar`). Un solo reconteo con motivo, y queda el primero.
- **La doble llave existe en la base**: `cut_doble_llave_chk` impide que quien cerró autorice.
- **Un corte cerrado es inmutable** (`cash_cut_guardia`), salvo la corrección de conteo con
  constancia (`CGS.4`, aplicada en prod: `conteo_previo` + motivo en CC-00003 y CC-00007).
- **La supervisora tiene el permiso** desde `CGS.1` (rol `tesoreria`) y una cola en «Mi trabajo»
  (`caja-por-autorizar`, umbral 1 día).
- **El sensor horario** `caja_corte_abierto` avisa de borradores de más de 26 h y de días sin corte.

### Lo que falta, en una frase por hueco

1. **No hay candado de operación.** Se puede capturar con cualquier cantidad de días sin corte
   (`cash-ledger.service.ts` `create()` no mira los cortes). Lo único que se ordena es la apertura.
2. **Autorizar es una firma sin revisión.** No mira el veredicto ni la diferencia: un corte de
   −$209k o con esperado imposible se autoriza igual. No hay campo para observar ni para devolver.
3. **La segregación es de una sola pareja** (cerró ≠ autorizó). Abrir, capturar, contar y cerrar
   pueden ser la misma persona, y quien autoriza puede haber capturado.
4. **El botón de autorizar está donde la supervisora no trabaja**: Captura → «Tu jornada» →
   Historial (plegado) → tabla de cortes. Arqueos, que es donde revisa, es de sólo lectura, y la
   cola de «Mi trabajo» la manda a Captura.
5. **Arqueos muestra los movimientos de Control** (el espejo del Access), no los del libro de la
   Suite, aun para días que ya viven en la Suite. Y no lista los días sin corte.
6. **Nada queda escrito cuando se corrige algo a mano**: ni tabla de bitácora, ni candado de base
   sobre los movimientos de un corte cerrado (sólo el servicio los protege; las migraciones no).
7. **La caja fuerte nunca se arquea a mano**, y sus operadores (`003`, `006`, `002`) no están
   ligados a personas de la Suite.

---

## 2. Cómo debe trabajar la supervisión — el ciclo de un día

Esto es el **proceso**; las capas de la §4 son lo que hay que construir para que el proceso no
dependa de que alguien se acuerde.

```
DÍA D                                          DÍA D+1
─────────────────────────────────────          ───────────────────────────────────────────
Cajera: captura → al final del día              08:30–12:00  Supervisora revisa el corte D
  cuenta a ciegas → sella → cierra el            en Arqueos, con la lista de verificación:
  corte D (antes de irse)                         ├─ todo en verde → AUTORIZA
                                                  └─ algo falla    → OBSERVA (con motivo)
  ⛔ Si NO cierra D, en D+1 la captura                → la cajera responde/corrige
     está bloqueada hasta que lo cierre          12:00  sin revisar → aviso a la suplente
     (salvo llave de emergencia)                 Captura de D+1: abierta sólo si D está cerrado
```

### 2.1 Candado 1 — sin corte de ayer, hoy no se captura

La idea de Edgar, precisada: **si una jornada con movimientos no tiene corte cerrado, la caja no
registra movimientos nuevos hasta que lo cierre.** La salida siempre está a mano de la cajera:
cerrar el corte pendiente toma minutos (contar, sellar, cerrar), así que el candado no deja a
nadie sin poder trabajar; sólo cambia el orden.

- **Qué se bloquea:** `POST /finance/cash-ledger` y `POST /lote` (capturar y confirmar).
- **Qué NO se bloquea:** consultar, contar y cerrar el corte pendiente, firmar desde el teléfono.
- **La excepción, porque una caja no puede dejar de pagar:** una **llave de emergencia** que da
  quien tiene `FINANCE_CAJA_AUTORIZAR` (nunca quien la pide), con motivo escrito, por un plazo
  corto (propuesta: hasta el final del día). Queda en la bitácora y en el reporte de la mañana.
- **Medido hoy:** el 21-oct se capturaron 5 gastos ($145,906.50) con el 20-oct sin corte. Con el
  candado, esa captura habría pedido primero cerrar el 20 o una llave de emergencia firmada.

### 2.2 Candado 2 — `CGS.3`, ya aprobado: sin revisión, no se acumula

`CGS.3` (aprobado por Edgar, sin escribir): *no se abre una jornada nueva si la anterior cerró sin
autorización.* Aplicado tal cual, junto con el candado 1, encadena la caja a la agenda de una sola
persona: si la supervisora falta, nadie captura. La propuesta es **conservar la regla y darle
suplente y plazo** (decisión **D2**):

- Hasta las 12:00 de D+1, la jornada D puede seguir «por revisar» sin frenar nada.
- A las 12:00 sin revisión, el aviso pasa a la **suplente** (propuesta: Dirección, que ya tiene
  `AUTORIZAR`).
- Si se juntan **dos jornadas cerradas sin revisar**, la caja **no puede cerrar** la tercera
  (puede capturar; no puede rendir otro corte sobre una pila que nadie miró).

### 2.3 Qué revisa la supervisora cada mañana — la lista de verificación del corte

Cada punto se calcula en el servidor y llega con uno de tres estados: **cumple**, **no cumple**,
**no medido** (ADR-056: lo que no se pudo medir se dice, no se pinta de verde).

| # | Verificación | Cómo se mide | Hoy |
|---|---|---|---|
| V1 | El corte se cerró el mismo día | `closed_at` en hora de México ≤ fin de `fecha` | 3 de 7 |
| V2 | El conteo pieza por pieza suma lo contado | la base ya lo exige (`cut_desglose_cuadra_chk`) | 7 de 7 |
| V3 | El fondo con el que abrió = lo que contó el corte anterior | `fondo_inicial(D) = contado(D−1)` | 6 de 7 (roto CC-3→CC-4, $10,831.50) |
| V4 | El veredicto tiene respuesta | veredicto ∉ `sin_contar`, `sin_base`, `sin_medir`, `esperado_imposible` | 3 de 7 |
| V5 | Toda diferencia trae explicación de la caja (D5: sin tolerancia) | nota del corte o respuesta a la observación | 0 de 7 |
| V6 | Ningún gasto sin firma **ni** comprobante **ni** motivo | `firma_estado`, `declared_doc_ref`, `origen_tipo`, `sin_documento_motivo` | 0 casos ✔ |
| V7 | Los movimientos con fecha de otro día traen motivo | `fecha` ≠ día de `created_at` | 97 sin regla |
| V8 | No hay movimientos sueltos de días ya cerrados | los «sueltos anteriores» de `saldo()` | por medir |
| V9 | Lo que entró y salió de CAOS ese día está registrado en el libro | movimientos CAOS «sin registrar» del día | por medir |
| V10 | Nadie que capturó en el corte es quien autoriza | `created_by` de los movimientos ∌ quien firma | regla nueva |
| V11 | Ningún movimiento del corte se editó después de cerrarlo sin constancia | bitácora (C0) | 28 sin autor |

**Regla de firma:** se **autoriza** sólo si todo cumple, o si cada «no cumple» trae una nota de la
supervisora. Un veredicto sin respuesta (V4) **no se autoriza nunca**: se **observa**. Firmar un
corte de esperado imposible es dar por bueno un número que no significa nada.

### 2.4 Observar: el corte vuelve a la cajera con motivo

Estado nuevo **`observado`**. La supervisora escribe qué falla; la cajera ve la observación al
entrar y responde. **Lo firmado no se reescribe**:

- Si el error es **del conteo**, se corrige con la constancia de `CGS.4` (valor anterior, motivo,
  quién corrigió ≠ quien cerró).
- Si el error es **de un movimiento** (cuenta equivocada, importe, día), se corrige con un
  **movimiento de ajuste en la jornada abierta** que nombra al original. El corte cerrado queda
  como se firmó y el ajuste deja rastro. Es el mismo principio de la nota de CC-00007 (CGA-A.42):
  *«las cifras firmadas no se modificaron»*.
- Con la respuesta, el corte vuelve a «por revisar» y la supervisora autoriza u observa de nuevo.

### 2.5 Arqueos sorpresa — lo que la revisión del corte no ve

El corte lo cuenta la misma persona que lo cuida. La supervisión necesita **un conteo que no
dependa de ella**:

- **Cajón:** un arqueo sorpresa por semana, contado por la supervisora, a ciegas, a media jornada.
  Se compara contra el esperado de ese momento.
- **Caja fuerte CAOS:** un conteo físico al mes (hoy: **0 en la historia**). Llena
  `analytics.caos_cash_counts`, que ya existe y está vacía, y por fin da el árbitro que pide
  `CGA-A.33`.

---

## 3. Qué NO incluye

- **La pierna del depósito bancario** (`CGA-A.25`, en pausa por decisión de Edgar, **D7**). Sin
  ella, 4 de 7 cortes seguirán con esperado imposible; este plan los hace **observables**, no
  cuadrables.
- **Decidir qué conteo representa el 12-oct** (`CGP-0.3`) ni **qué hacer con el 13 y el 14-oct**
  (`CGP-0.6`). Son de Edgar y siguen abiertas.
- **Rotar la credencial de fábrica de CAOS** (`admin`/`caos`) ni tocar su red: es credencial y es
  de TI (regla 7). Se deja como decisión **D8**.
- **El rediseño de legibilidad** (Tanda 1 del documento de dos cabezas). Corre en paralelo.
- **Cortes de sucursales** (`CSU`). Este plan es la Caja General de Oficinas, sucursal `00`.

---

## 4. Las capas

Orden obligatorio: ninguna capa sube hasta que la de abajo está verificada. Seguridad primero
(regla de Edgar: dinero en juego × esfuerzo, y la seguridad antes que todo).

### C0 · Dato

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| CGS.10 | **Bitácora de caja, sólo-agregar**. ⭐ **Sin tabla nueva**: se cuelga el historial genérico que ya existía (`analytics.master_data_history` + `analytics.log_master_data_change`, VP.3.1) de `cash_ledger` y `cash_ledger_cuts`. Registra todo UPDATE/DELETE de las columnas que importan con su valor antes/después y el `current_user` (distingue la app de una migración). `app_runtime` sólo INSERT/SELECT. ⚠️ Deuda con nombre: el actor PERSONA (`app.actor`) no lo setea la API todavía; hoy la persona sale de `updated_by`/`closed_by`/`authorized_by` dentro del diff | 🔨 | Migración `20261021110252` + `test-newdb-caja-supervision.js` §3 |
| CGS.11 | **Candado de base sobre los movimientos de un corte cerrado**: disparador que rechaza cambiar importe, cuenta, tipo, fecha o `corte_id` de un movimiento cuyo corte está `cerrado`/`autorizado`. Antes: clasificar las 28 ediciones post-cierre medidas para saber qué columnas sí se escriben tarde con razón (p. ej. la firma que llega del teléfono, CG.196) | 🔨 | Prueba negativa: editar el importe de un movimiento en un corte cerrado da el error exacto |
| CGS.12 | **Vista de la lista de verificación**: `finance.v_caja_corte_verificacion`, una fila por corte con V1–V11 y su estado (`cumple`/`no_cumple`/`no_medido`). Derivada, sin tabla nueva | 🔨 | Las cifras de la §1 de este documento: V1 = 3/7, V3 = roto en CC-4, V4 = 3/7 |
| CGS.13 | **Declarar el eslabón roto CC-3 → CC-4** ($10,831.50) en la nota de CC-00004, sin reescribir cifras firmadas (**D9**) | ✅ cubierto por V3 | `fondo_inicial(CC-4) − contado(CC-3)` = 10,831.50 antes; nota presente después |

### C1 · Dominio (`libs/finance/src/lib/caja/`)

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| CGS.14 | **Candado 1**: `puedeCapturar(jornadas, llave)` — rechaza la captura si existe una jornada anterior con movimientos y sin corte cerrado, salvo llave de emergencia vigente. Eje del día: `created_at` en hora de México (el canónico, `JORNADA_LIBRO`) | 🔨 | Unitaria + `cash-cut.servicio-real.spec.ts`: 20-oct sin corte → la captura del 21 falla con el motivo literal |
| CGS.3 | **Candado 2** (ya aprobado), con suplente y plazo según **D2** | 🔨 | Dos jornadas cerradas sin revisar → cerrar la tercera falla |
| CGS.15 | **Llave de emergencia**: la da alguien con `AUTORIZAR` distinto de quien la pide, con motivo ≥ 10 caracteres, vence al final del día. Queda en la bitácora | 🔨 | Quien la pide no puede dársela a sí mismo (prueba negativa) |
| CGS.16 | **Segregación ampliada**: quien autoriza o da la llave no puede ser quien cerró **ni quien capturó algún movimiento del corte**. Regla en el motor **y** en la base | 🔨 | María con 29 capturas del 20-oct no puede autorizar el corte del 20-oct |
| CGS.17 | **Autorizar exige la lista de verificación**: rechaza si V4 no cumple; cada «no cumple» exige nota | 🔨 | Autorizar CC-00002 (esperado −$149,915.32) falla con «se observa, no se autoriza» |
| CGS.36 | ⭐ **La verdad de cada diferencia** (`caja-verdad-diferencia.engine.ts` + `.query.ts`): cada entrada de la cuenta contra un testigo que no tecleó la misma persona — el conteo contra el arqueo físico de Control del mismo día, el fondo contra el arqueo de Control del día anterior, el libro contra lo sellado, la caja fuerte contra la máquina entre dos arqueos. Publica la diferencia **verdadera** al lado de la sellada (sin reescribir lo firmado), y las **pistas**: movimientos de Control sin contraparte en el libro (casan 20 de 59 el mismo día; placebo ±3/±7 días: 0), cheques/vales y vaciado/dotación de la máquina. Nueva verificación **V12**: corregida o contradicha no cumple y exige nota para autorizar | 🔨 | 10 unitarias con los 8 cortes de prod (4 negativas, una con mutación verificada en rojo) + `cash-cut.servicio-real.spec.ts` exige que `verdad` llegue (si el SAVEPOINT tapara un error, falla) |
| CGS.51 | **El árbitro mira la caja entera**: entre dos arqueos completos (cajón + caja fuerte + cheques y vales + dólares) contra el libro del mismo tramo. Separa el dinero que cambió de rubro del que apareció o se fue sin registro | 🧪 | Prod (sólo lectura): reproduce el panorama — 10→14 +$22,715.68, 15 +$80,485.16, 16 −$60,764.00, 17 −$22,476.03, 19 −$204,333.29, 21 +$245,268.64 — y destapa CC-8: el cajón +$1,201.63, la caja entera **−$199,998.37** (lo de la caja de ahorro contado en el arqueo de las 09:56 que se fue sin registro). 3 pruebas nuevas, una negativa |
| CGS.50 | **V13 «Todo lo de la jornada entró al corte»**: movimientos de la jornada capturados ANTES de cerrar que no quedaron en ningún corte (V8 sólo ve los de después). Nadie los revisa ni los firma | 🧪 | Prod (sólo lectura): CC-1 1 movimiento $5,000.00, CC-2 5 movimientos $121,130.53, el resto 0. Prueba negativa en el motor |
| CGS.18 | **Estado `observado`** + respuesta de la cajera + vuelta a «por revisar». Ajustar `cash_cut_guardia` para permitir `cerrado → observado → cerrado` **sin** cambiar cifras | 🔨 | Observar no altera ningún importe (prueba que compara antes/después) |

### C2 · API (`/finance/cash-ledger`)

⛔ Regla 13: un endpoint que escribe no está probado hasta que una prueba lo ejerció contra base
real con el payload de la pantalla. Cada uno de estos va en `cash-ledger.http-real.spec.ts`.

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| CGS.19 | `GET cortes/:id/verificacion` — la lista V1–V11 de un corte | 🔨 | no | Contra la base sembrada de `preparar-base-caja.js` |
| CGS.20 | `POST cortes/:id/autorizar` acepta `notas` por verificación; `POST cortes/:id/observar` {motivo}; `POST cortes/:id/responder` {respuesta} | 🔨 | sí | Payload de la pantalla; 403 para quien cerró o capturó; 409 si cambió la verificación desde que se mostró |
| CGS.21 | `POST caja/llave-emergencia` {motivo, para_usuario} y que `POST /` y `POST lote` devuelvan **423** con el motivo literal cuando el candado aplica | 🔨 | sí | Captura bloqueada → llave → captura pasa → vence → bloqueada otra vez |
| CGS.22 | `POST caos/conteos` — el conteo físico de la caja fuerte, ciego, por denominación | 🔨 | sí | Llena `analytics.caos_cash_counts` (hoy 0 filas) |
| CGS.23 | Traducir `cut_doble_llave_chk` y los errores nuevos en `caja-errores.ts` (hoy un choque directo con la base sale como 500) | 🔨 | no | La violación devuelve la frase, no un 500 |

### C3 · UI

⛔ Cargar la skill `diseno` antes del primer archivo; `npm run check:pantalla` antes y después.

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| CGS.24 | **Arqueos pasa a ser la mesa de la supervisora**: abre con «N cortes esperan tu revisión»; cada corte con su lista V1–V11; botones **Autorizar** y **Observar** ahí (no en Captura); lista los días sin corte. Es la Tanda 4 / O7 del documento de dos cabezas | 🔨 | 0 → 0 fallas (cumple las 10 reglas) |
| CGS.25 | En Arqueos, **los movimientos del día salen del libro de la Suite** para los días que ya viven en la Suite; Control queda como segundo testigo, rotulado | 🔨 | 0 → 0 fallas |
| CGS.26 | La cola `caja-por-autorizar` de «Mi trabajo» lleva a `/finanzas/caja-general/arqueos?corte=<folio>`, no a Captura | 🔨 | 0 → 0 fallas (cumple las 10 reglas) |
| CGS.27 | **Captura con candado**: aviso con el motivo literal, la única acción que lo destraba («Cerrar el corte del 20-oct») y «Pedir llave de emergencia». Las observaciones de la supervisora aparecen al entrar | 🔨 | por medir |
| CGS.35 | **«¿Qué hay en caja ahora?»** en Arqueos: un renglón por rubro (cajón, caja fuerte, dólares, cheques, papeles) con lo último contado, lo movido desde entonces y lo que debería haber; lo imposible o no medido se declara y no entra al total | 🔨 | 0 → 0 fallas |
| CGS.36 | En Arqueos, **«La diferencia, contra sus testigos»** en el panel del corte (estado, publicada → verdadera, los 4 testigos y las pistas); la lista y el KPI publican la verdadera cuando un testigo la corrige, con la sellada al lado; la cola marca «Diferencia corregida» | 🔨 | 0 → 0 fallas (cumple las 10 reglas) |
| CGS.28 | **Caja Fuerte**: «Conteo físico» deja de ser «sin medir» para siempre — captura ciega del conteo de la máquina | 🔨 | 0 → 0 fallas |

### Operación (no es código, pero sin esto el código no sirve)

| # | Item | Estado | Dueño |
|---|---|---|---|
| CGS.29 | **Horario escrito**: la cajera cierra antes de irse; la supervisora revisa de 08:30 a 12:00; a las 12:00 pasa a la suplente | 🔨 | Edgar |
| CGS.30 | **Runbook** `RUNBOOKS/CAJA_GENERAL_OPERACION.md` §5: la revisión de la mañana con la lista V1–V11, observar, llave de emergencia, arqueo sorpresa | 🔨 | — |
| CGS.31 | **Primera semana acompañada**: la supervisora revisa los cortes con alguien del equipo al lado; se mide cuánto tarda y qué verificación no entiende | ⬜ | Edgar + supervisora |
| CGS.32 | **Ligar los operadores de CAOS** (`003`, `006`, `002`) a personas de la Suite | ⬜ | Tesorería |

---

## 4b. Jubilar el Control de arqueos — de por vida

> Pedido de Edgar, 2026-10-22: *«migremos todos los arqueos de Control y lo jubilemos de por
> vida»*. CG.126 (13-oct) ya jubiló a Control como **libro**; lo que sigue vivo es su aplicación
> de **arqueos** (`Movimientos Cajas`, `BMovimientosCajas.mdb`, caja 20), que la caja usa todos los
> días y de la que la Suite todavía depende.

### Medido hoy (prod, sólo lectura, 2026-10-22)

- **30,268 registros, del 2013-09-13 a hoy**, en `caja_general_ods.arqueo_movimientos` (réplica viva:
  última sincronización hoy 10:39). En 2026: 2,752, de los que **329 son arqueos completos** (traen
  los cinco rubros; se distinguen por `dolares <> 0`, CG.126). Capturan los códigos `10` (354 desde
  septiembre), `00` (33), `36` (28), `82` (15).
- **La Suite lo lee en siete lugares:** la posición (CGS.35), el árbitro de la diferencia (CGS.36),
  el segundo testigo y el último conteo en Arqueos (CGS.2, CGA-A.48), el fondo sugerido al abrir
  (CG.125), el Cuadre contra Control (`caja-control.service.ts`), la salud de la base (`db-health`)
  y el feed que lo replica (`run-prod-feeds.js`).
- **Lo que Control hace y la Suite no:**
  1. **Contar los cinco rubros**: efectivo por pieza (la Suite sí), caja fuerte, cheques, vales y
     papeles, y dólares (USD × tipo de cambio). La tabla existe desde CG.100
     (`finance.cash_ledger_cut_custody`) pero **nadie la captura: 4 filas, sembradas a mano**.
  2. **Registrar paquetes de efectivo con nota.** Del 12 al 21-oct, **39 de 59 paquetes no tienen
     movimiento en el libro**: GNF de Morelia, tarjetas del dueño ($209,133), caja de ahorro,
     devolución doble de Morelia, «guillermo lopez gutierrez» $170,000. Ese dinero hoy existe sólo
     en Control, y es exactamente lo que hace que las diferencias no cierren (revisión del 22-oct).
  3. **Un segundo conteo del día** (el «CORTE 19/10/2026» del 20-oct a las 09:56 es eso: alguien
     que vuelve a contar a la mañana siguiente).

### Decisiones (Edgar, 2026-10-22)

| # | Pregunta | Decisión |
|---|---|---|
| D10 | ¿Qué pasa con el histórico de Control? | **Se congela donde está** (`caja_general_ods`) y se lee por vista. Nada se copia |
| D11 | Sin Control, ¿quién hace el segundo conteo? | **María recuenta cada mañana, a ciegas, en la Suite**, antes de mover dinero. El recuento es el testigo del árbitro (CGS.36) |
| D12 | ¿Cuándo se apaga Control? | **Ya** — sin semana en paralelo. CGS.47 no se hace |
| D13 | Los movimientos del 12 y 13-oct fuera de todo corte | **Se ligan al corte de su día** (Edgar, 22-oct). Se ligan 5 a CC-2 ($121,130.53, sus depósitos a CAOS ya estaban ahí). ⚠️ CG-2026-00018 ($5,000, Canales) NO: se pagó el 10-oct con el retiro #1560 de ese día, antes del primer corte; pegarlo a CC-1 sin su retiro inventaría un faltante. Queda fuera, y V13 de CC-1 se autoriza con esa nota |

### ⛔ Lo que NO se hace

- **No se copia el histórico a otra tabla** (regla 2). Los 30,268 arqueos **ya están en nuestra
  base**; se congelan donde están, con fecha de jubilación declarada, y se leen por vista. «Migrar»
  es que la serie siga sin hueco: Control hasta el día del corte, la Suite desde ahí.
- **No se suman las dos fuentes** después del corte (CG.126: se compone en la frontera medida).
- **No se pierde el segundo conteo**: si Control se va sin reemplazo, el árbitro (CGS.36) se queda
  sin testigo y cada diferencia vuelve a ser «sin confirmar».

### Las capas

| # | Capa | Item | Estado |
|---|---|---|---|
| CGS.40 | C0 | **Vista única de arqueos** `analytics.v_caja_arqueos`: Control (hasta la fecha de jubilación, congelado) ∪ Suite (desde). Misma forma: cinco rubros + piezas + quién + cuándo. Sin copiar | 🔨 en la migración `20261022112834`, sin aplicar en prod. Probada en sólo lectura: la mitad de Control trae 909 arqueos completos (2022-09-12 → 2026-10-21) |
| CGS.41 | C0 | **El arqueo de la Suite cuenta los cinco rubros**: al cerrar y en cualquier momento del día (arqueo intermedio / recuento). Tabla nueva para el arqueo que no es cierre, con `tenant_id` + auditoría; los rubros reusan `cash_ledger_cut_custody` | 🔨 `finance.cash_arqueos`, misma migración, sin aplicar. Sólo se agrega; NULL = no se contó |
| CGS.42 | C1 | Motor del arqueo completo: total por rubro, **dólares con tipo de cambio y fuente obligatoria**, vales con detalle por papel, comparación a ciegas | 🧪 `caja-arqueo.engine.ts`, 11 pruebas (6 negativas). Detectó su propio defecto: redondeaba el tipo de cambio a centavos (−$12.06 en A23706) |
| CGS.43 | C1 | **Todo paquete pasa al libro, con sentido**: entra / sale / se mueve entre rubros. Tipos para lo que no viene de Kepler: aportación o retiro del dueño, préstamo y caja de ahorro, devolución | ✅ **Sin código, a propósito.** Desde CG.120 (Edgar, 19-oct) la Suite no captura dinero sin documento de Kepler. Regla: todo lo que Control anotaba como paquete se documenta primero en Kepler (X-D-26 sale / U-A-5 entra) y la caja lo confirma desde la cola. Tipos propios en la Suite romperían esa decisión. ⚠️ Para contabilidad, medido el 22-oct: las tarjetas de crédito del dueño ($209,256) entraron como «201 PASIVO A PROVEEDORES» y la caja de ahorro ($471,700) como «115 ABONO A CLIENTES»; y GNF Morelia, la devolución doble de Morelia y los $170,000 de «guillermo lopez gutierrez» no tienen documento en Kepler |
| CGS.44 | C1 | **El árbitro cambia de testigo**: el recuento de otra persona en la Suite + la máquina. Control sólo para fechas anteriores al corte | 🧪 el árbitro toma el recuento del corte como testigo (y el del corte anterior para el fondo); Control sólo antes del 22-oct. La posición lee el último arqueo completo de la vista única. 3 pruebas nuevas |
| CGS.45 | C2 | API del arqueo (escribe: prueba contra base real con el payload de la pantalla) | 🧪 `GET/POST /finance/cash-ledger/arqueos-caja`, controlador propio. `design:paramtypes` probado con mutación en rojo. Prueba contra base real en `cash-cut.servicio-real.spec.ts` (403 a quien cerró, 400 sin fuente del tipo de cambio, sin UPDATE): corre en `caja-db` del CI |
| CGS.46 | C3 | Pantalla del arqueo con los cinco rubros; Arqueos, posición y Cuadre leen la vista única | 🧪 Arqueos: «Contar la caja» (recontar el corte / arqueo a media jornada), diálogo de cinco rubros, últimos arqueos, y la píldora mide el último arqueo. `check:pantalla` 0 → 0. SIN validación visual |
| CGS.47 | Op. | **Semana en paralelo**: la caja cuenta en Control y en la Suite; cada día la diferencia entre los dos tiene que ser $0.00, o se explica | ❌ no se hace (D12: «ya») |
| CGS.48 | Op. | **El día del corte**: el archivo de Control queda de sólo lectura en `.245`, se quita el acceso de la caja, el feed hace una última sincronización (conteo de filas igual en origen y réplica) y se apaga; `db-health` lo declara **jubilado**, no atrasado | 🔨 código: los dos carriles salen de `CRON_JOBS`. ⚠️ Corregido el 22-oct: los carriles NO corrían en `.249` sino en la máquina de trabajo `SISTEMAS` (latido `host=SISTEMAS`). Edgar los detuvo (`pm2 delete`) a las 12:17; falta la última pasada `--once` y `pm2 save --force` (el `dump.pm2` del 01-oct todavía los revive al reiniciar), y el `.mdb` de sólo lectura en `.245` |
| CGS.49 | Op. | **De por vida**: ninguna lectura viva de `v_caja_control_*` fuera de la vista histórica (compuerta que lo verifica), el feed fuera del cron, y la nota en el runbook | 🧪 compuerta `check:caja-sin-control` (en el CI): ningún `.ts` nuevo lee `v_caja_control_*` ni `caja_general_ods`; 4 lectores del histórico permitidos con motivo. Autoprueba 6 casos + negativa en vivo (un lector nuevo → rojo). Falta: apagar en `SISTEMAS` (no `.245`/`.249`: los carriles corrían en la máquina de trabajo) y la nota del runbook |
| CGS.59 | C0–C3 | **Cheques y papeles, uno por uno** (Edgar, 30-oct: «cuando hay un cheque, crédito o papel… cómo agregar esos apartados» → «agreguémoslo»). Completa lo que CGS.42 prometía («vales con detalle por papel»): cada cheque (banco, número, de quién) y cada papel (vale o crédito, quién debe, por qué) es un renglón del arqueo; lo que había se marca sigue o salió, con su salida; el importe del rubro es la suma, y la base lo exige. «Crédito» va como clase de papel: en Control vivían en la misma columna | 🧪 migración `20261030095100` (`finance.cash_arqueo_documentos` + trigger diferido de la suma), **sin aplicar en prod**. API `GET /arqueos-caja/documentos` + `POST` con `documentos` (409 si otro arqueo se guardó mientras tanto). Prueba contra base real (`cash-cut.servicio-real.spec.ts`, base local de `preparar-base-caja.js`): 24 ✓; 4 mutaciones rojas. Pantalla: los dos apartados en «Contar la caja» y la posición abre cheques y papeles documento por documento. `check:pantalla` 0 nuevas. SIN validación visual |
| CGS.60 | C0–C3 | **Un movimiento con cheque o papel (crédito)** (Edgar, 30-oct: «y si un movimiento se quiere hacer con cheque, o papel (crédito)» → «sí, hazlo»). Un cobro entra en cheque o en papel; un pago sale con un cheque que está en la caja (con papel no se paga). Cada documento queda ligado al movimiento con la MISMA identidad que en el arqueo, y la lista de la caja pasa a ser último arqueo + lo que entró − lo que salió. Sustituye a «Venta a crédito» (CS.3.13): el papel dice quién debe | 🧪 migración `20261030105836` (`finance.cash_ledger_documentos` + trigger diferido: documentos + CAOS ≤ monto; un cheque sale una vez y sólo si entró; el reparto gana `en_documentos`), **sin aplicar en prod**. Excepción declarada a LE.0.4 (aprobada por Edgar). El esperado del corte, el resumen del día, la posición y el reparto restan los documentos; un pago entero en cheque no pide origen. Prueba contra base real (`cash-ledger.documentos-real.spec.ts`, en el CI): 4 ✓, más el corte 24 ✓; 5 mutaciones rojas en el servidor y 1 en la pantalla. ⚠️ El árbitro (CGS.36) sigue comparando el libro en bruto, como ya hacía con CAOS: declarado. SIN validación visual |

## 5. El orden, y por qué ése

```
Hoy, sin código:  cerrar el 20-oct · decidir D1–D4
Tanda 1 (seguridad, C0):   CGS.10 bitácora ─┬─ CGS.11 candado de base
                                            └─ CGS.12 vista de verificación ── CGS.13
Tanda 2 (reglas, C1+C2):   CGS.16 segregación · CGS.17 autorizar con lista · CGS.18 observar
                           → CGS.19, CGS.20, CGS.23
Tanda 3 (candados):        CGS.14 + CGS.15 + CGS.3 → CGS.21
Tanda 4 (pantallas):       CGS.24 → CGS.25, CGS.26, CGS.27
Tanda 5 (caja fuerte):     CGS.22 → CGS.28 · CGS.32
Operación:                 CGS.29–31 arrancan con la Tanda 2
```

- **La bitácora va primero** porque todo lo demás produce cambios que hay que poder auditar, y
  porque hoy ya hay 28 ediciones sin autor. Es poco esfuerzo y cierra un hueco real.
- **La segregación y el «observar» van antes que los candados**: un candado que obliga a cerrar
  cortes que nadie puede revisar con sentido sólo produce más cortes sin firma.
- **Los candados van antes que la pantalla**, porque el candado vive en el servidor; la pantalla
  sólo explica lo que el servidor ya hace (C2 antes que C3, como ordenó el documento de dos cabezas).
- **La caja fuerte va al final**: es valiosa, pero depende de un conteo físico que nadie ha hecho
  y de ligar operadores, que no es código.

---

## 6. Decisiones que necesitan a Edgar

| # | Decisión | Recomendación |
|---|---|---|
| **D1** | Candado 1: duro con llave de emergencia o sólo aviso | ✅ **DECIDIDO (Edgar, 2026-10-21): duro con llave de emergencia.** |
| **D2** | CGS.3 tal como se aprobó o con suplente y plazo | ✅ **DECIDIDO (Edgar, 2026-10-21): suplente (Dirección) y plazo 12:00**; con dos jornadas sin revisar la caja no puede *cerrar* la tercera (sí capturar) |
| **D3** | ¿La supervisora captura? (María capturó 29 movimientos el 20-oct) | ✅ **DECIDIDO (Edgar, 2026-10-21): captura, pero no firma lo suyo.** Los cortes donde capturó los firma la suplente. Implementado en CGS.16 (base + servicio) |
| **D4** | ¿Quién entra a la caja? (32 personas con acceso efectivo, capturaron 3) | ✅ **DECIDIDO (Edgar, 2026-10-21): sólo Carmen, Mayra y María Gutiérrez** (supervisora y encargada de finanzas); **Dirección se queda de suplente**; a Carmen se le quita su override personal de AUTORIZAR. Migración `20261021124708` (CGS.33). ⚠️ Los superadmins pasan cualquier permiso, también por complemento y por encima de un override en false (`roles.guard.ts`): **14 cuentas**. ✅ **Edgar, 2026-10-21: se les deja el acceso** (CGS.34 cerrado sin cambio) |
| **D5** | Tolerancia de diferencia | ✅ **DECIDIDO (Edgar, 2026-10-21): sin tolerancia.** Toda diferencia ≠ $0 (más allá del centavo de redondeo) exige explicación de la caja (V5) y nota de quien autoriza (CGS.17). Ya es lo que hace el código |
| **D6** | Los 7 cortes ya cerrados | **No autorizarlos a ciegas.** Los 4 de esperado imposible se observan con «falta la pierna del depósito (D7)»; los otros 3 se revisan con la lista |
| **D7** | Dónde entra el depósito bancario (ya abierta, `CGA-A.25` en pausa) | Sin cambio: sigue siendo de Edgar. Este plan no la necesita para arrancar |
| **D8** | CAOS sigue con la credencial de fábrica `admin`/`caos` sobre HTTP | Rotarla. Es de TI y no la toca esta fase |
| **D9** | Eslabón roto CC-3 → CC-4 ($10,831.50) | **Declararlo en la nota de CC-00004**, como se hizo en CC-00007. No reescribir lo firmado |

---

## 7. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Un candado duro detiene un pago urgente | Edgar | D1 | La llave de emergencia (CGS.15), que existe antes de prender el candado |
| La supervisora no revisa | Edgar | D2 / persona única | Suplente y plazo; la métrica de la cabecera lo hace visible cada lunes |
| 4 cortes nunca podrán autorizarse | Edgar | D7 (depósito) | Mientras tanto se **observan**; no se dibujan como verdes |
| El «observar» choca con la inmutabilidad | dev | `cash_cut_guardia` | CGS.18 cambia el disparador sólo para el estado, con prueba de que ninguna cifra se mueve |
| Una migración vuelve a editar el libro sin rastro | dev | no hay bitácora | CGS.10, primero de la lista |

---

## 8. Definición de Terminado

- [ ] 1. Métricas de la cabecera **remedidas**: cortes revisados antes de las 12:00 y jornadas sin corte, antes/después
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. CGS.20, CGS.21 y CGS.22 **ejercidos contra base real** con el payload de la pantalla
- [ ] 4. Cada candado (CGS.11, CGS.14, CGS.16, CGS.17) **roto a propósito una vez**, rojo verificado
- [ ] 5. La bitácora (CGS.10) va a `libs/` como primitivo compartido **o** queda como deuda con nombre (ADR-056; hoy ya hay historiales sueltos en `purchase_book_history` y `goods_receipt_proof_history`)
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` al día
- [ ] 7. **En prod**, con el permiso repartido y la supervisora usándolo

---

## 9. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-21 | Plan escrito: entender → auditar (código + prod en sólo lectura) → planear. Línea base de la §1 medida con `dev_ro` | sesión de seguridad de Caja General |
| 2026-10-21 | D1–D4 decididos por Edgar. CGS.10/11/16/23 en código: migración 20261021110252 (bitácora reusando master_data_history, candado de base sobre lo firmado, quien autoriza ajeno al corte) + servicio + suite test-newdb-caja-supervision.js en el job caja-db. **Sin aplicar en prod** | sesión de seguridad de Caja General |
| 2026-10-21 | CGS.17/18/20 en código: estado `observado` (migración 20261021111319), observar/responder por API, autorizar rechaza veredictos sin respuesta y pide nota con diferencia. ⚠️ D5 (tolerancia) sigue abierta: mientras, **toda** diferencia ≠ 0 exige nota. **Sin aplicar en prod**; hasta que Arqueos tenga los botones (CGS.24), el «Autorizar» de Captura devuelve la frase «escribe una nota» en cortes con diferencia | sesión de seguridad de Caja General |
| 2026-10-21 | CGS.24 (parcial) y CGS.26 en código: Arqueos abre con «N cortes esperan tu revisión» (sólo para quien tiene AUTORIZAR, del más viejo al más nuevo, excluye los suyos por D3), cada día abre con «La revisión» —Autorizar / Observar con su texto y el motivo de cada botón apagado—, la tabla distingue Sin revisar / Observado / Respondido / Autorizó. La cola de «Mi trabajo» lleva a Arqueos. Falta de CGS.24: la lista V1–V11 (espera CGS.12) y los días sin corte. **Sin validación visual** (no se levanta la app en local): lo más probable de ajustar es el ancho del textarea en el panel y el orden de los dos botones | sesión de seguridad de Caja General |
| 2026-10-21 | CGS.14/15/3/21/27 en código. **Candado 1 PRENDIDO por omisión** (D1): con una jornada anterior con movimientos y sin corte cerrado (o un corte de un día anterior abierto), `POST /` y `POST /lote` responden 423 con la frase; interruptor de emergencia `CAJA_CANDADO_CAPTURA=off`. **Llave de emergencia** (`finance.cash_ledger_llaves`, migración 20261021112928): la da alguien con AUTORIZAR a OTRA persona, con motivo, vence al terminar el día, sólo se agrega. **Candado 2 (CGS.3) APAGADO** hasta fijar `CAJA_CANDADO_REVISION_DESDE=YYYY-MM-DD`: con 2 cortes cerrados sin revisar desde esa fecha no se cierra el tercero. Captura muestra el aviso antes de teclear; Arqueos permite dar la llave. ⚠️ Falta de D2: el aviso a la suplente a las 12:00 (sensor) | sesión de seguridad de Caja General |
| 2026-10-21 | CGS.33 en código: migración 20261021124708 deja el acceso efectivo a caja en Carmen, Mayra (por override personal: comparte rol con 6) y María, más Dirección de suplente; Carmen pierde AUTORIZAR. Simulado en prod en sólo lectura: 3 personas sin superadmin. ⚠️ Corregido el mismo día: con superadmin entran **14** cuentas, no 13 — el guard da god-mode por complemento aunque haya override en false (`luis_hernandez`, almacenista, lo tiene). **Sin aplicar** | sesión de seguridad de Caja General |
| 2026-10-21 | CGS.12/19 en código. ⚠️ **Desvío del plan, a propósito:** la lista no es una vista de base sino el motor puro `caja-verificacion.engine.ts`, porque la misma lista decide la firma (`autorizar`) y la publica la pantalla (`arqueos`): dos copias divergen. Viaja dentro de `ArqueoDia.verificacion` (no hay GET aparte). Los hechos salen en 3 consultas agrupadas, validadas en prod en sólo lectura: V1 3/7, V3 roto sólo en CC-4 (0,831.50), V11 28 ediciones. V9 (CAOS) se declara NO MEDIDO hasta CGA-A.33; V10 lo resuelve la pantalla. Autorizar exige nota si **cualquier** verificación no cumple | sesión de seguridad de Caja General |
| 2026-10-21 | CGS.3b (D2, aviso a la suplente) en código: el sensor horario escala por persona a tesorería y Dirección cada corte cerrado que pasó las 12:00 del día siguiente sin revisar (repite cada 6 h). Simulado en prod en sólo lectura: hoy avisaría los 7 cortes a maria_gutierrez, guillermo_lopez y superuser; fijando `CAJA_CANDADO_REVISION_DESDE` cuenta desde esa fecha | sesión de seguridad de Caja General |
| 2026-10-21 | CGS.25 en código: el panel del día de Arqueos muestra primero «Lo que el libro registró esa jornada» (`arqueo-dia`, por el día en que se movió el efectivo) y Control queda como «Segundo testigo». Si el servidor no publica la lista se declara, no se pinta «sin movimientos» | sesión de seguridad de Caja General |
| 2026-10-21 | CGS.27 completo (la caja responde la observación desde Captura). CGS.30: runbook reescrito para Carmen, Mayra y María (candado, revisión de la mañana con la lista, observar/responder, llave, horario 8:30–12:00 y suplente). CGS.13 **no se hace**: V3 declara el eslabón roto CC-3→CC-4 cada vez que se lee el corte, y una migración sólo para escribir una nota frenaría el despliegue sin aportar nada. ⚠️ Corregido: 944cde5ad no compilaba (`$event` borrado por el shell), arreglado en el commit siguiente | sesión de seguridad de Caja General |
| 2026-10-21 | CGS.22/28 en código: el conteo físico de la caja fuerte. ⚠️ **No usa `analytics.caos_cash_counts`**: ésa es la LECTURA de la máquina (la llena `caos-live`); el conteo de una persona es un hecho propio y va a `finance.caos_conteos_fisicos` (migración 20261021135209, sólo-agregar, diferencia exacta o NULL sin referencia). Lo cuenta quien tiene AUTORIZAR, a ciegas: la referencia (el saldo que publica la pantalla en ese instante) se revela al guardar. Servicio aparte de `CaosService` porque ése tiene cambios pendientes de otra sesión. Regla 30: `design:paramtypes` del controlador probado en `apps/api`, rojo verificado con `import type` | sesión de seguridad de Caja General |
| 2026-10-21 | Edgar: **los superadmins conservan el acceso a caja** (14 cuentas; CGS.34 se cierra sin cambio) y **D5 sin tolerancia** confirmada (toda diferencia exige explicación y nota). Sin cambio de código: ya era el comportamiento | sesión de seguridad de Caja General |
| 2026-10-21 | CGS.35 y CGS.36 en código. **CGS.36, medido en prod (dev_ro):** de 8 cortes, **3 publican una diferencia que no es la verdadera** — CC-4 +$80,019.86 → **+$136,602.36** (conteo tecleado el 16-oct, $11,820, contra el arqueo físico de Control del 15, $57,571; y el fondo arrastraba $10,831.50), CC-5 +$94,830.30 → **+$49,079.30** (heredó ese conteo como fondo), CC-7 −$209,094.59 → **−$188,884.59** (CI-2026-00063 pasó de ingreso a gasto después de sellar) —; **2 se confirman al centavo** (CC-6 +$81,845.77, CC-8 +$1,201.63) y **3 no tienen testigo** (CC-1 y CC-2: Control no arqueó; CC-3: la máquina no explica $5,000 de la caja fuerte). Control del instrumento: el balance de caja completa entre arqueos consecutivos reproduce las mismas cifras por otro camino, y la caja fuerte de Control coincide con la máquina al peso en 5 de 6 tramos. ⚠️ Lo que NO hace: decir **qué** causó una diferencia confirmada (las pistas no traen signo y no se suman). ⚠️ Pendiente con nombre: la base de `caja-db` no trae `caja_general_ods.arqueo_movimientos` (no está en el snapshot), así que el camino CON Control sólo se ejerció leyendo prod | sesión de seguridad de Caja General |
| 2026-10-21 | **CGS.37 (datos, prod):** «todo ingreso debe estar vinculado a CAOS» medido: 48 de 112 ingresos desde el 12-oct ($871,810.86) sin vínculo ni origen CAOS; el 20-oct, con 12 de 12 vinculados, el corte casi cuadra (+$1,201.63). Se vincularon por `kubectl exec` en md (Edgar pegó el bloque) los **7 ingresos nacidos de un depósito de CAOS que no tenían su vínculo** — CI-2026-00009/20/22 ↔ #1582/1585/1588, CI-2026-00034/37 ↔ #1600/1603, CI-2026-00001 ↔ #1557, CI-2026-00049 ↔ #1619 —, `senales.origen = CGS.37`, monto = el menor entre depósito e ingreso. Verificado leyendo prod: 0 nacidos de CAOS sin vínculo. No mueve cifras (el reparto ya los contaba en la bóveda): impide reusar esos depósitos. ⚠️ CI-49: el depósito trae **$75 más** que el ingreso. ⚠️ Pendiente: 14 depósitos sin ingreso desde el 15-oct (agrupan cobros de varios días: «rd canindo», «rd morelia»…) — necesitan el vínculo uno-a-varios, que no existe; y que el servidor vincule solo al capturar desde un depósito | sesión de seguridad de Caja General |
| 2026-10-22 | **Control se jubila (CGS.40–49).** Edgar: «migremos todos los arqueos de Control y lo jubilemos de por vida» y, al preguntarle cuándo, «ya». Decisiones D10–D12. En código: migración `20261022112834` (tabla `finance.cash_arqueos` + vista `analytics.v_caja_arqueos`, sin aplicar), motor, API, pantalla, árbitro y posición leyendo la vista única, sondas de los carriles retiradas. Antes de apagar: Control seguía en uso (último registro A23707, 22-oct 10:18). ⚠️ Sin validación visual. ⚠️ La migración se aplica antes que el código que escribe, y requiere el archivo en `origin/main` | sesión de seguridad de Caja General |
| 2026-10-22 | CGS.50 (V13, movimientos fuera de todo corte) y CGS.49 (compuerta `check:caja-sin-control`) en código. Medido: el hueco de corte es histórico —el 21-oct entró completo a CC-9; lo del 22-oct es la jornada abierta— pero nada lo vigilaba. Corregido el lugar de los carriles de Control: `SISTEMAS`, no `.249` | sesión de seguridad de Caja General |
| 2026-10-22 | CGS.51 en código: el árbitro publica la caja entera al lado del cajón, en el resumen y en el panel. Medido en prod: CC-8 pasa de «+$1,201.63 es real» a mostrar también −$199,998.37 en la caja entera — la caja de ahorro deja de esconderse en el 19-oct | sesión de seguridad de Caja General |
| 2026-10-22 | D13 aplicado en prod por `kubectl exec` (Edgar pegó el bloque): CI-2026-00010/26/27/28/29 ($121,130.53) ligados a CC-2, `en_corte`. Verificado leyendo prod: V13 de CC-2 en verde; el árbitro muestra el libro crecido después de firmar y la verdadera pasa de +$207,486.32 a **+$86,355.79** (el resto es el conteo copiado del 15-oct). CC-1 sigue con CG-2026-00018 ($5,000) fuera, a propósito | sesión de seguridad de Caja General |
| 2026-10-23 | **CGS.52 en código, sin aplicar** (migración `20261023095246`). Decisión del PM: «re actualicemos todas las cifras; diferencia vs lo que quedó en caja es diferente, no confundir al supervisor». Los 10 cortes 12–22-oct se recalculan con constancia (`recalculo_previo`): fondo = lo que quedó en caja el corte anterior, totales = lo atado hoy (CC-2 +$121,130.53 por D13; CC-7 la reclasificación de CI-63), contado = el arqueo físico del día. ⛔ **Corrige a CGS.5:** el arqueo A23655 de Control es del **15-oct 17:55** y CC-2 se cerró el 15-oct 18:02 con esa misma reja — el 13-oct **no tiene conteo físico** (queda `sin_medir_motivo`), el 15-oct pasa de $11,820 a $57,571, y el 13+14 juntos dan +$12,702.63. Medido y comprobado por la migración: CC-4 +$136,602.36, CC-5 +$49,079.30, CC-7 −$188,884.59; CC-6/9 sin cambio. Siguen esperados NEGATIVOS el 15, 16, 17 y 21 (libro incompleto; el PM confirmó que Abastos/Morelia se pagan desde esta caja). Pantallas: «Quedó en caja» primero, y un «debería haber» negativo dice «no calculable» en vez de un sobrante (`leerCorte()` en contracts, una regla para las dos). `abrir()` ya no hereda el fondo de un corte más viejo cuando el último no tuvo conteo | sesión de cortes 23-oct |
| 2026-10-30 | **CGS.59 en código, sin aplicar** (migración `20261030095100`). Edgar pidió agregar cheque, crédito y papel como apartados. Medido antes en prod: la reposición nunca los usa (todas las de 2026 en efectivo; CAOS nunca trajo cheques ni tickets); la caja sí, y desde que se jubiló Control nadie registra cuáles entran ni salen. El arqueo los cuenta uno por uno y la base exige que el importe sea la suma de sus renglones | sesión de reposición 30-oct |
| 2026-10-30 | **CGS.60 en código, sin aplicar** (migración `20261030105836`). Edgar: «y si un movimiento se quiere hacer con cheque, o papel (crédito)» → «sí, hazlo». Medido antes en prod: el libro sólo conocía efectivo y la «venta a crédito» se usó en 1 de 184 cobros; Kepler no distingue la forma del cobro. Un cobro entra en cheque o papel, un pago sale con un cheque de la caja; el corte sólo pide el efectivo. La prueba contra base real cazó un `knex.raw` devuelto desde una función `async`, que se ejecutaba como consulta suelta | sesión de reposición 30-oct |
