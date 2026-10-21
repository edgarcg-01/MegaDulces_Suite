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
| V5 | La diferencia está dentro de la tolerancia, o trae explicación de la cajera | tolerancia = **D5** | sin regla |
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
| CGS.12 | **Vista de la lista de verificación**: `finance.v_caja_corte_verificacion`, una fila por corte con V1–V11 y su estado (`cumple`/`no_cumple`/`no_medido`). Derivada, sin tabla nueva | ⬜ | Las cifras de la §1 de este documento: V1 = 3/7, V3 = roto en CC-4, V4 = 3/7 |
| CGS.13 | **Declarar el eslabón roto CC-3 → CC-4** ($10,831.50) en la nota de CC-00004, sin reescribir cifras firmadas (**D9**) | ⬜ | `fondo_inicial(CC-4) − contado(CC-3)` = 10,831.50 antes; nota presente después |

### C1 · Dominio (`libs/finance/src/lib/caja/`)

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| CGS.14 | **Candado 1**: `puedeCapturar(jornadas, llave)` — rechaza la captura si existe una jornada anterior con movimientos y sin corte cerrado, salvo llave de emergencia vigente. Eje del día: `created_at` en hora de México (el canónico, `JORNADA_LIBRO`) | 🔨 | Unitaria + `cash-cut.servicio-real.spec.ts`: 20-oct sin corte → la captura del 21 falla con el motivo literal |
| CGS.3 | **Candado 2** (ya aprobado), con suplente y plazo según **D2** | 🔨 | Dos jornadas cerradas sin revisar → cerrar la tercera falla |
| CGS.15 | **Llave de emergencia**: la da alguien con `AUTORIZAR` distinto de quien la pide, con motivo ≥ 10 caracteres, vence al final del día. Queda en la bitácora | 🔨 | Quien la pide no puede dársela a sí mismo (prueba negativa) |
| CGS.16 | **Segregación ampliada**: quien autoriza o da la llave no puede ser quien cerró **ni quien capturó algún movimiento del corte**. Regla en el motor **y** en la base | 🔨 | María con 29 capturas del 20-oct no puede autorizar el corte del 20-oct |
| CGS.17 | **Autorizar exige la lista de verificación**: rechaza si V4 no cumple; cada «no cumple» exige nota | 🔨 | Autorizar CC-00002 (esperado −$149,915.32) falla con «se observa, no se autoriza» |
| CGS.18 | **Estado `observado`** + respuesta de la cajera + vuelta a «por revisar». Ajustar `cash_cut_guardia` para permitir `cerrado → observado → cerrado` **sin** cambiar cifras | 🔨 | Observar no altera ningún importe (prueba que compara antes/después) |

### C2 · API (`/finance/cash-ledger`)

⛔ Regla 13: un endpoint que escribe no está probado hasta que una prueba lo ejerció contra base
real con el payload de la pantalla. Cada uno de estos va en `cash-ledger.http-real.spec.ts`.

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| CGS.19 | `GET cortes/:id/verificacion` — la lista V1–V11 de un corte | ⬜ | no | Contra la base sembrada de `preparar-base-caja.js` |
| CGS.20 | `POST cortes/:id/autorizar` acepta `notas` por verificación; `POST cortes/:id/observar` {motivo}; `POST cortes/:id/responder` {respuesta} | 🔨 | sí | Payload de la pantalla; 403 para quien cerró o capturó; 409 si cambió la verificación desde que se mostró |
| CGS.21 | `POST caja/llave-emergencia` {motivo, para_usuario} y que `POST /` y `POST lote` devuelvan **423** con el motivo literal cuando el candado aplica | 🔨 | sí | Captura bloqueada → llave → captura pasa → vence → bloqueada otra vez |
| CGS.22 | `POST caos/conteos` — el conteo físico de la caja fuerte, ciego, por denominación | ⬜ | sí | Llena `analytics.caos_cash_counts` (hoy 0 filas) |
| CGS.23 | Traducir `cut_doble_llave_chk` y los errores nuevos en `caja-errores.ts` (hoy un choque directo con la base sale como 500) | 🔨 | no | La violación devuelve la frase, no un 500 |

### C3 · UI

⛔ Cargar la skill `diseno` antes del primer archivo; `npm run check:pantalla` antes y después.

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| CGS.24 | **Arqueos pasa a ser la mesa de la supervisora**: abre con «N cortes esperan tu revisión»; cada corte con su lista V1–V11; botones **Autorizar** y **Observar** ahí (no en Captura); lista los días sin corte. Es la Tanda 4 / O7 del documento de dos cabezas | 🔨 | 0 → 0 fallas (cumple las 10 reglas) |
| CGS.25 | En Arqueos, **los movimientos del día salen del libro de la Suite** para los días que ya viven en la Suite; Control queda como segundo testigo, rotulado | ⬜ | por medir |
| CGS.26 | La cola `caja-por-autorizar` de «Mi trabajo» lleva a `/finanzas/caja-general/arqueos?corte=<folio>`, no a Captura | 🔨 | 0 → 0 fallas (cumple las 10 reglas) |
| CGS.27 | **Captura con candado**: aviso con el motivo literal, la única acción que lo destraba («Cerrar el corte del 20-oct») y «Pedir llave de emergencia». Las observaciones de la supervisora aparecen al entrar | 🔨 | por medir |
| CGS.28 | **Caja Fuerte**: «Conteo físico» deja de ser «sin medir» para siempre — captura ciega del conteo de la máquina | ⬜ | por medir |

### Operación (no es código, pero sin esto el código no sirve)

| # | Item | Estado | Dueño |
|---|---|---|---|
| CGS.29 | **Horario escrito**: la cajera cierra antes de irse; la supervisora revisa de 08:30 a 12:00; a las 12:00 pasa a la suplente | ⬜ | Edgar |
| CGS.30 | **Runbook** `RUNBOOKS/CAJA_GENERAL_OPERACION.md` §5: la revisión de la mañana con la lista V1–V11, observar, llave de emergencia, arqueo sorpresa | ⬜ | — |
| CGS.31 | **Primera semana acompañada**: la supervisora revisa los cortes con alguien del equipo al lado; se mide cuánto tarda y qué verificación no entiende | ⬜ | Edgar + supervisora |
| CGS.32 | **Ligar los operadores de CAOS** (`003`, `006`, `002`) a personas de la Suite | ⬜ | Tesorería |

---

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
| **D4** | FINANCE_CAJA_GESTIONAR: 20 personas, capturaron 3 | ✅ **DECIDIDO (Edgar, 2026-10-21): sólo el equipo de caja** (finanzas, finanzas_operativo, tesorería por D3). Contabilidad, Crédito, Compras y Marketing quedan en VER |
| **D5** | Tolerancia de diferencia | **Toda diferencia ≠ $0 exige explicación de la cajera; más de $500 exige nota de la supervisora.** El monto lo fija Edgar |
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
