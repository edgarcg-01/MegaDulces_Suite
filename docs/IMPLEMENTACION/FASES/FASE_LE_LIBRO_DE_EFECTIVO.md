# Fase LE — Libro de efectivo de partida doble (Caja General como un banco)

> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Pedido del PM, 2026-10-27: *«rehagamos el motor de caja… debemos pensar que esto es como un
> banco»*, *«por capas y fases, desde la base de datos hasta el backend»* y, en la segunda vuelta,
> *«si necesitamos rehacer todo desde cero hay que hacerlo, pero quiero un trabajo limpio y adecuado
> para un banco»*. Nace de ADR-101 y de la medición de §3; **absorbe** a `CGA-A.50`–`A.57`.

```
OBJETIVO: que cada peso de la Caja General de Oficinas esté en UN lugar a la vez, con una sola
          explicación, y que el libro cuadre todos los días contra un testigo independiente.
MÉTRICA:  (a) depósitos de CAOS explicados más de una vez — HOY: 86 · $1,703,230 (2026-10-27) → META: 0
          (b) cortes cuyo esperado no se puede ir a contar (negativo o con ±$100k de piernas cruzadas)
              — HOY: 7 de 13 cortes (12–26 oct) → META: 0
          (c) cortes y movimientos sobre umbral autorizados por una segunda persona — HOY: 0 de 13 → META: 100 %
          (d) diferencias SIN EXPLICAR en el cierre diario contra testigos — HOY: NO MEDIDO (no existe un
              cierre contra testigos) → META: 0 en 10 cierres hábiles seguidos
          (e) dinero «por rendir» con más de 1 día hábil sin rendir — HOY: NO MEDIDO → META: publicado a
              diario, cada peso con nombre de persona
CAPA TOPE: C3 (la UI, etapa E6, sólo después de 5 cierres limpios en sombra)
ÁREA:      Finanzas
DUEÑO:     Edgar (PM)
ESTADO:    🔨 — D1 y D2 firmadas el 2026-10-27. Plan v2 (este) pendiente de firma: D3 y D6–D14.
```

---

## 0. Cómo leer este plan

- **Etapas (E0…E7) × capas (C0 dato → C1 dominio → C2 API → C3 UI).** Una etapa no empieza hasta
  que la anterior cumplió su **criterio de salida**, y ninguna sube de capa sin la de abajo verificada.
- Cada etapa tiene: **objetivo · entregables · pasos (items `LE.<etapa>.<n>`) · verificación ·
  criterio de salida · reversa**.
- Las **reglas de banco (B1–B46, §2)** son binding. Cada item cita las reglas que cumple; una regla
  sin verificación es una intención (regla 12 del proyecto).
- ⛔ Este repo es **público**. Nada de este documento describe credenciales, versiones de firmware,
  puertos o debilidades concretas de un equipo. Eso vive en el **inventario privado de secretos**
  (fuera del repo) y aquí sólo se nombra.

---

## 1. La decisión de fondo: se rehace el núcleo desde cero

El libro actual es de **entrada simple** y la posición del dinero se reconstruye con cuatro
mecanismos que no se conocen entre sí (§3.2). Ningún parche lo vuelve partida doble. **El núcleo se
rehace desde cero**; lo que ya es verdad (los hechos) se conserva y se lee.

| Pieza | Destino | Por qué |
|---|---|---|
| Feed de CAOS (`analytics.caos_cash_movements`, `caos_cash_denominations`) | **Se conserva** como fuente de hechos de la máquina | es el hecho; se agrega control de huecos y reescrituras (E3) |
| Cobranza y egresos de Kepler (`kepler_ods.*`) | **Se conserva** como fuente y como testigo | sólo se lee (B24) |
| Capturas humanas (`finance.cash_ledger`) | **Se conserva** como registro de lo que la persona tecleó; en E5 alimenta al libro nuevo; en E7 queda en sólo lectura | es dato propio (HITL); no es una copia del libro: el libro guarda el **efecto contable**, la captura guarda **lo que se dijo** |
| Cortes y firmas actuales (`cash_ledger_cuts`, `cg67`) | Operan hasta E7; luego sólo lectura | el corte nuevo se calcula sobre saldos |
| `CG.58` FIFO (`caos_ingreso_atribucion`) | **Se apaga** (E0) y su código se **retira** (E7) | empareja por antigüedad: tapa jineteo (B19) |
| Enlaces a mano (`caos_cash_links`), custodia (`caos_retiro_custodia`), grano (`caos_deposito_grano`) | Se leen para reconstruir la historia (E3); se congelan en E7 | en el libro nuevo un enlace **es un asiento** y una custodia **es una cuenta** |
| Tablas sin escritor (`cash_ledger_cut_vouchers`, `cash_ledger_route_links`, `cash_arqueos`, `caos_conteos_fisicos`) | Se declaran muertas; se congelan | no se borran (regla 5) |
| `*_snapshot_bak` de `analytics` | D5 | violan la regla 2; no se tocan en esta fase |
| El libro (asientos, cuentas, saldos, jornadas, solicitudes, conteos, hallazgos) | **NUEVO**, esquema propio `cashbook` | §4 |

⛔ Nada se borra: el libro nuevo reconstruye su historia a partir de lo viejo (E3) y lo viejo queda
congelado como evidencia (B23).

---

## 2. Las reglas de banco (BINDING)

> Pedido del PM: *«piensa como si estuvieras desarrollando esto para un banco… no dejes nada a la
> duda»*. Las marcadas ⛔HOY se violan hoy, medido. **La numeración B1–B38 no cambia** (la citan
> commits y pruebas); B39–B46 se agregan en v2.

### A · El libro

| # | Regla | Cómo se verifica |
|---|---|---|
| B1 | **Partida doble**: todo asiento suma cero **por moneda**, y en efectivo, por denominación | invariantes I1–I3 + prueba negativa |
| B2 | **Inmutable**: sólo se agrega. Un error se corrige con un asiento de reversa que nombra al original y su motivo. Ni el admin puede UPDATE/DELETE; una alteración por fuera **se detecta** (cadena de hashes) | I6, I8 + prueba como `app_runtime` y como dueño |
| B3 | **Un hecho, un registro**: cada evento externo y cada petición (`request_id`) se registra una sola vez; un reintento idéntico devuelve lo registrado; un reintento **distinto** con el mismo id se rechaza | I11, I12 + prueba de doble envío |
| B4 | **Cada peso, una explicación** ⛔HOY (86 · $1.70 M) | por construcción (B1+B3) + compuerta diaria = 0 |
| B5 | **Saldos derivados**: el saldo es la suma de asientos. La cabecera de saldo existe sólo para bloquear y verificar, y se compara a diario contra la suma | I10 |
| B6 | **Dinero exacto**: en la base, **centavos enteros (`bigint`)**; en código, centavos enteros, nunca `float`; un solo punto de redondeo; moneda explícita | D9 + prueba con montos que el float redondea mal |
| B7 | **Fecha valor ≠ fecha de registro**; hora de la base, nunca del navegador; **un día cerrado no se toca**: el ajuste va al día abierto | I14 + prueba |
| B8 | **Cuentas físicas nunca negativas**, ni por denominación | I9 (CHECK en la cabecera bloqueada) + prueba |

### B · Las personas (controles)

| # | Regla | Cómo se verifica |
|---|---|---|
| B9 | **Segregación**: quien registra ≠ quien autoriza ≠ quien cuenta ≠ quien concilia ⛔HOY (una persona hace 84 % de los retiros y cierra todos los cortes) | I15 en la base, no sólo en pantalla |
| B10 | **Cuatro ojos**: toda reversa, ajuste, faltante y todo movimiento arriba del umbral (D3) lo autoriza una segunda persona ⛔HOY (0 de 13) | I15 + solicitudes (§4.6) |
| B11 | **Arqueo ciego** (quien cuenta no ve el esperado) **y sorpresa** por un tercero, con frecuencia fija (D13) | la API del contador no devuelve esperado (LE.4.6) |
| B12 | **Usuarios nominales**: nadie opera con una cuenta compartida ni con credenciales de fábrica ⛔HOY (usuario compartido de vendedores en la máquina; detalle en el inventario privado) | inventario de usuarios; I16 |
| B13 | **Mínimo privilegio**: permisos por ACCIÓN, revisados cada trimestre | matriz de accesos regenerada y firmada |
| B14 | **Los procesos automáticos tienen identidad propia** y nunca autorizan | I15 |
| B15 | **Límites por persona y por día** (D14) | regla de autorización (LE.2.6) |
| B16 | **Campos libres con tope**: un importe tecleado no reemplaza a un conteo ⛔HOY ($298,484.92 de morralla tecleada el 26-oct) | I2: la cuenta con desglose no acepta importe sin piezas |

### C · Conciliación

| # | Regla | Cómo se verifica |
|---|---|---|
| B17 | **Todo saldo tiene un testigo independiente** y se concilia a diario ⛔HOY (el conteo de la máquina no se guarda) | cierre diario (LE.3.2, LE.5.2) |
| B18 | **Ninguna diferencia se absorbe**: cada una es un hallazgo con monto, dueño, antigüedad y cierre firmado | I17 |
| B19 | **Emparejar por llave, nunca por antigüedad**; lo dudoso a revisión humana; se publica la **precisión** medida con placebo ⛔HOY (`CG.58` FIFO) | LE.2.5 |
| B20 | **Sin cierre de ayer no se opera hoy** (hoy existe como `[CGS.14]`) | I14 |

### D · Auditoría

| # | Regla | Cómo se verifica |
|---|---|---|
| B21 | **Bitácora de todo**: quién, cuándo, desde qué dispositivo, antes/después — datos, configuración, permisos **y DDL** del esquema | `master_data_history` + event trigger de DDL (LE.1.11) |
| B22 | **Toda cifra publicada es reproducible**: datos, secuencia y versión de la regla | `rule_version` + `seq` en cada respuesta |
| B23 | **Retención**: nada se borra; mínimo 5 años (fiscal MX) | I6 |

### E · Datos de fuera

| # | Regla | Cómo se verifica |
|---|---|---|
| B24 | **Las fuentes externas se leen, nunca se escriben**, y llegan con su frescura; atraso = NO MEDIDO, nunca cero | latidos `cron_runs` + frescura en cada respuesta |
| B25 | **Validación estricta en la frontera**: montos > 0, denominaciones del catálogo, fechas válidas, tipos cerrados | DTO + CHECK |

### F · Seguridad

| # | Regla | Cómo se verifica |
|---|---|---|
| B26 | **Secretos fuera del repo**, rotados, nunca de fábrica; **cifrado en tránsito** para todo lo que toca dinero ⛔HOY (detalle en el inventario privado) | LE.0.1 |
| B27 | **Autorizar pide reautenticación** (clave u OTP) | LE.4.2 |
| B28 | **Nada mueve dinero real desde el sistema** (dispensar CAOS) sin ADR, cuatro ojos y API oficial del fabricante | fuera de alcance (§8) |

### G · Cómo se desarrolla

| # | Regla | Cómo se verifica |
|---|---|---|
| B29 | **Antes de construir: inventario de TODO lo que toca el objeto** ⛔HOY (así nacieron las dobles) | LE.0.3 |
| B30 | **Revisión por otra persona** de todo cambio al módulo de dinero ⛔HOY | D12 |
| B31 | **Cada invariante con prueba negativa y mutación**; base real; **concurrencia**; **reconstrucción** | job `caja-db` |
| B32 | **Nunca se prueba contra prod**; prod sólo se lee | `assert-safe-target` |
| B33 | **Migraciones aditivas y reversibles**, ensayadas, una por una, fuera de horario | runbook |
| B34 | **Lo nuevo corre en paralelo** y se cambia con criterio medido y plan de reversa | E5, E7 |
| B35 | **Concurrencia controlada**: todo lo que toca un saldo bloquea la cabecera en orden fijo | §4.7 + prueba |

### H · Operación

| # | Regla | Cómo se verifica |
|---|---|---|
| B36 | **Alertas el mismo día** a un responsable con nombre | LE.5.2 |
| B37 | **Un descuadre es un incidente**: dueño, causa, corrección, qué cambió | bitácora §13 |
| B38 | **Respaldos probados restaurando** | LE.5.5 |

### I · Agregadas en v2 (revisión «como banco», 2026-10-27)

| # | Regla | Cómo se verifica |
|---|---|---|
| B39 | **Un solo camino de escritura**: el libro sólo se escribe por funciones de la base (`cashbook.post_entry`, `reverse_entry`, `authorize_request`); la app no tiene INSERT sobre ninguna tabla del libro | privilegios + prueba que intenta INSERT directo |
| B40 | **Consecutivo sin huecos** por tenant; el corte y el cierre dicen **hasta qué asiento** cuentan, no «hasta qué hora» | I7 |
| B41 | **Los hechos externos nunca se rechazan ni se pierden**: se registran en el orden de su fuente; si hay hueco, esperan; si siguen sin cuadrar, van a la cola de excepciones con hallazgo crítico | §4.8 |
| B42 | **Un hecho externo que cambia** (Kepler cancela, CAOS reescribe) produce reversa + asiento nuevo con la versión nueva; nunca edición | I11 |
| B43 | **La persona es el EMPLEADO, no el usuario**: la segregación se compara por empleado (dos usuarios de la misma persona no se autorizan entre sí) | I15 |
| B44 | **Cada moneda en sus cuentas**: la conversión sólo pasa por una cuenta puente por moneda con el tipo de cambio guardado, su fuente y quién lo fijó | I18 |
| B45 | **Toda solicitud vence**: una pendiente de autorizar más allá de su plazo se cierra como vencida, nunca se autoriza tarde en silencio | máquina de estados (§4.6) |
| B46 | **Cuenta de suspenso vigilada**: lo que aún no tiene explicación vive en Suspenso con antigüedad; Suspenso ≠ 0 al cierre es un hallazgo | cierre diario |

---

## 3. Qué problema resuelve (medido en `pg-prod`, sólo lectura, `7688376744939610156`)

| Hecho | Cifra | Dónde se ve |
|---|---|---|
| Depósitos de CAOS con DOS explicaciones (libro + `CG.58`) | **86 · $1.70 M** | ej. depósito #1723 «ruta 27 261026»: en el libro es la ruta 27 del 26-oct; en `CG.58`, las rutas 21 y 22 del **28-jul** |
| Depósitos explicados sólo por `CG.58`, por antigüedad | 741 · $18.77 M | el FIFO siempre llega al «100 % conciliado» y **tapa jineteo** |
| Cortes con esperado negativo | 5 de 9 (12–22 oct) | el libro resta gastos que no salieron del cajón |
| Retiro y gasto en jornadas distintas | 19-oct «falta» −$188,885 · 21-oct esperado −$221,512 | el mismo dinero en la jornada equivocada (ADR-101) |
| Retiros de CAOS enlazados a algún gasto | 30 de 409 · 7 % del dinero | `ux_caos_link_vivo` sólo permitía 1 a 1 |
| Cortes autorizados | **0 de 13** | la misma persona abre y cierra todos |
| Arqueo completo desde que se jubiló Control (22-oct) | **0** | la caja fuerte se proyecta del arqueo del 21-oct |
| Morralla tecleada en el corte del 26-oct | **$298,484.92** de $342,095.42 «contados» | sólo $43,610.50 se contaron por pieza |
| `CG.58` corre cada hora y no tiene interruptor | sigue escribiendo | `caos-ingreso-cron.service.ts:76` |

### 3.1 El caso diario (el PM, 2026-10-27)

> *«Las rutas venden, llegan y hacen su cobro: vendió 21 mil, mete sólo 19 a CAOS y la diferencia
> se queda en la caja general chica.»*

```
Asiento 1 · Kepler reconoce la cobranza (hecho externo E-01)
  Por rendir · Ruta 27 (vendedor con nombre)   + $21,000
  Cobranza reconocida (contrapartida Kepler)   − $21,000
Asiento 2 · Depósito en CAOS «ruta 27 261026» (hecho externo E-02, emparejado por llave)
  Bóveda CAOS (por denominación)               + $19,000
  Por rendir · Ruta 27                         − $19,000
Asiento 3 · Entrega al cajón, contada por pieza (E-04)
  Caja General · pesos (por denominación)      +  $2,000
  Por rendir · Ruta 27                         −  $2,000
                                   Por rendir · Ruta 27 = $0  → la ruta rindió completo
```

Si sólo entrega $1,900, «Por rendir · Ruta 27» queda en +$100 y al vencer el plazo (D3) pasa a
**Faltante · vendedor** con su nombre, con autorización (E-05). Nunca se absorbe (B18).

### 3.2 La causa

El libro es de **entrada simple**: dice «entró» o «salió», no **de dónde a dónde**. La posición se
reconstruye con mecanismos que no se conocen entre sí:

| Mecanismo | Tabla | Filas | Qué explica |
|---|---|---:|---|
| Enlace a mano gasto/ingreso ↔ movimiento CAOS | `finance.caos_cash_links` | 119 | qué movimiento de la máquina financió una captura |
| Conciliador automático `CG.58` (FIFO) | `finance.caos_ingreso_atribucion` | 1,766 | qué cobros de Kepler son un depósito |
| Captura de un movimiento CAOS como fila del libro | `finance.cash_ledger` (`origen_tipo='caos'`) | — | el movimiento entero |
| Custodia de un retiro (`CGA-A.50`) | `finance.caos_retiro_custodia` | 0 | a cargo de quién quedó |
| Grano del depósito (`CG.58.6`) | `finance.caos_deposito_grano` | 827 | de qué ruta viene |

Inventario completo (2026-10-27): **71 objetos** de caja en `finance.*` y `analytics.*` para 504
movimientos y 13 cortes; tres tablas de conteo físico **vacías**; tablas sin escritor en el código;
tres copias `*_bak` (regla 2). `cash_ledger` lo escriben 3 servicios.

---

## 4. El modelo del libro (el diseño que se construye en E1–E2)

### 4.1 Hechos → reglas → asientos

```
HECHO (lo que pasó, con su fuente e identidad)          ──►  REGLA DE REGISTRO (pura, versionada)  ──►  ASIENTO (efecto, inmutable)
  · máquina CAOS (device, external_id, versión)                 libs/finance/cashbook                       cashbook.entries + lines + pieces
  · Kepler (documento, versión)
  · persona (solicitud con request_id, empleado)
  · conteo (arqueo ciego)  ──►  no es asiento: se compara contra el saldo a una secuencia → hallazgo → (autorizado) asiento de ajuste
```

Un asiento **siempre** nombra su hecho (`event_kind` + `event_ref` + `event_version`) y su regla
(`rule_version`). Sin hecho, no hay asiento.

### 4.2 Plan de cuentas (las «bolsas»)

| Clase | Cuenta | Lleva desglose | Moneda | Puede ser negativa | Testigo |
|---|---|:-:|---|:-:|---|
| Física | Caja General · pesos | ✔ billetes y monedas | MXN | ✘ | arqueo ciego |
| Física | Caja General · dólares | ✔ | USD | ✘ | arqueo ciego |
| Física | Caja General · documentos | por pieza con folio (cheque) | MXN | ✘ | arqueo de documentos |
| Física | Bóveda CAOS | ✔ (el feed trae `caos_cash_denominations`) | MXN | ✘ | conteo de la máquina |
| Custodia | En custodia · {empleado} | ✘ | MXN | ✘ | rendición con comprobantes |
| Control | Por rendir · {ruta / cobrador} | ✘ | MXN | ✔ (sobrante) | cobranza de Kepler |
| Control | Valores en tránsito · banco | ✘ | MXN | ✘ | estado de cuenta (fase CB) |
| Contrapartida | Cobranza reconocida (Kepler) | ✘ | MXN | ✔ | total de cobranza de Kepler del día |
| Contrapartida | Egresos · {concepto} | ✘ | MXN | ✔ | egresos de Kepler / comprobante |
| Contrapartida | Otros ingresos · {concepto} | ✘ | MXN | ✔ | documento soporte |
| Diferencias | Faltantes · {empleado} / Sobrantes · {empleado} | ✘ | MXN | ✔ | cierre firmado |
| Puente | Cambio de divisas · MXN / · USD | ✘ | por moneda | ✔ | tipo de cambio guardado |
| Sistema | Apertura (saldos iniciales de la reconstrucción) | ✘ | por moneda | ✔ | conteos de la fecha de apertura |
| Sistema | Suspenso (pendiente de explicar) | ✘ | por moneda | ✔ | **debe ser 0 al cierre** (B46) |

Convención de signo: **+ = entra a la cuenta**. Las físicas, custodias y por rendir tienen saldo
positivo; las contrapartidas acumulan negativo. Todo asiento suma 0 por moneda.

### 4.3 Objetos en la base (esquema `cashbook`, todo con `tenant_id` + audit + RLS)

| Objeto | Qué guarda | Llaves y restricciones |
|---|---|---|
| `accounts` | catálogo de cuentas (§4.2): clase, moneda, titular (empleado/ruta/concepto), lleva desglose, admite negativo, testigo, alta/baja | único (tenant, code) |
| `account_balances` | **cabecera** por cuenta: `balance_minor`, `last_seq` | `CHECK (allows_negative OR balance_minor >= 0)` — bloqueada con `FOR UPDATE` |
| `account_denom_balances` | cabecera por cuenta × denominación: piezas | `CHECK (pieces >= 0)` en físicas |
| `entries` | asiento: `seq` (consecutivo por tenant), `business_date`, `value_at`, `recorded_at` (`clock_timestamp()` de la base), `event_kind`, `event_ref`, `event_version`, `event_hash`, `request_id`, `request_hash`, `rule_version`, `created_by` (usuario + **empleado**), `authorized_by`, `authorized_at`, `reverses_entry_id`, `reason`, `prev_hash`, `hash` | único (tenant, seq) · único (tenant, event_kind, event_ref, event_version) · único (tenant, request_id) · único (reverses_entry_id) |
| `entry_lines` | cuenta, `amount_minor` con signo, moneda | `amount_minor <> 0` |
| `entry_pieces` | línea × `denom_key` × piezas con signo | sólo en cuentas con desglose |
| `seq_counters` | el contador del consecutivo por tenant | fila bloqueada en la transacción |
| `business_days` | jornada: `abierta → en_cierre → cerrada`; `closing_seq`, `closing_hash`, quién cerró y quién autorizó | una sola abierta por tenant |
| `requests` | solicitudes de persona: `pendiente → autorizada / rechazada / vencida`; payload, registrante, plazo | §4.6 |
| `counts` + `count_pieces` | arqueos: cuenta, contador (empleado), tipo (`cierre`/`sorpresa`/`relevo`), `upto_seq`, ciego sí/no, testigo presente | inmutable |
| `findings` | hallazgos: origen (conteo, cierre, feed, reconstrucción), monto, dueño, antigüedad, estado, asiento que lo cierra o explicación firmada | I17 |
| `external_queue` | hechos externos en espera (hueco de secuencia) o en excepción | B41 |
| `ddl_audit` | todo DDL sobre el esquema (event trigger) | B21 |

**Roles** (D10): `cashbook_owner` (NOLOGIN, dueño de todo), `app_runtime` con **sólo** `EXECUTE`
sobre las funciones y `SELECT` sobre las vistas; ningún `INSERT/UPDATE/DELETE/TRUNCATE` sobre
tablas (B39). Las funciones son `SECURITY DEFINER` con `search_path` fijo y **fallan** si
`app.tenant_id` no está fijado (nunca leen cero filas en silencio).

### 4.4 Invariantes (cada uno: dónde vive + prueba negativa + mutación)

| # | Invariante | Dónde vive |
|---|---|---|
| I1 | El asiento suma 0 **por moneda** | `post_entry` + constraint trigger diferido (defensa doble) |
| I2 | En una cuenta con desglose: monto de la línea = Σ(piezas × denominación); sin piezas no hay línea. En cuenta sin desglose no hay piezas | `post_entry` + trigger |
| I3 | Si **todas** las líneas llevan desglose, por denominación las piezas suman 0 (cubre el «Cambio») | `post_entry` |
| I4 | Moneda de la línea = moneda de la cuenta | FK compuesta |
| I5 | ≥ 2 líneas; ninguna en 0; cuentas activas | `post_entry` |
| I6 | **Sólo se agrega**: sin privilegios de UPDATE/DELETE/TRUNCATE para nadie más que el dueño, y trigger que rechaza UPDATE/DELETE **también al dueño** | privilegios + trigger |
| I7 | Consecutivo sin huecos por tenant | `seq_counters` bloqueado |
| I8 | `hash = sha256(prev_hash ‖ forma canónica del asiento)`; `cashbook.verify_chain()` lo recorre | `post_entry` + verificador |
| I9 | Físicas no negativas, por monto y por denominación | CHECK en las cabeceras, bajo bloqueo |
| I10 | Cabecera = Σ líneas, por cuenta y denominación | vista `v_descuadre_interno` (debe dar 0 filas) en el cierre diario |
| I11 | Un hecho externo, una versión vigente; versión nueva = reversa + asiento nuevo | único + `post_entry` |
| I12 | `request_id` repetido con el mismo `request_hash` devuelve el asiento; con otro hash → error `CASHBOOK_REQUEST_REUSED` | único + `post_entry` |
| I13 | Reversa: única, total, nunca de una reversa, con motivo y autorización | único + `reverse_entry` |
| I14 | `business_date` = la jornada abierta; jornada cerrada no admite asientos; no se abre hoy sin cerrar ayer | `post_entry` + `business_days` |
| I15 | Autoriza ≠ registra **por empleado**; una identidad de servicio nunca autoriza; arriba del umbral la autorización es obligatoria | `authorize_request` |
| I16 | Asiento de persona = empleado nominal vigente; cuentas genéricas bloqueadas | `post_entry` |
| I17 | Toda diferencia de conteo o cierre crea un hallazgo; un hallazgo se cierra sólo con asiento autorizado o explicación firmada | `close_day` + `findings` |
| I18 | Conversión de moneda sólo por las cuentas puente, con tipo de cambio, fuente y quién lo fijó | `post_entry` |

### 4.5 Camino único de escritura (B39)

```
cashbook.post_entry(payload jsonb) RETURNS entries
  1. exige app.tenant_id y la identidad (usuario + empleado o servicio)
  2. valida forma: moneda, montos, denominaciones del catálogo, cuentas activas         (B25)
  3. idempotencia: request_id / event_ref+versión ya registrados → devuelve o rechaza  (I11, I12)
  4. jornada abierta y fecha valor válida                                              (I14)
  5. bloquea seq_counters y las cabeceras de las cuentas tocadas EN ORDEN DE id        (B35: sin deadlocks)
  6. aplica deltas a las cabeceras → los CHECK de no-negativo actúan aquí              (I9)
  7. asigna seq, encadena hash, inserta asiento + líneas + piezas                       (I7, I8)
  8. bitácora                                                                           (B21)
```

Las reglas de **qué** asiento produce cada hecho viven en TypeScript (C1, puras y probadas); la base
garantiza que **ningún** asiento, venga de donde venga, rompa los invariantes.

### 4.6 Solicitudes y cuatro ojos

```
pendiente ──autorizar (otro empleado, reautenticado, dentro del plazo)──► autorizada ──► post_entry
    │ └──rechazar (con motivo)──► rechazada
    └──vence el plazo (D3)──► vencida
```

Lo pendiente **no mueve saldo**. Debajo del umbral (D3) y en eventos de bajo riesgo la solicitud se
autoriza sola por regla, y aun así queda registrada como solicitud.

### 4.7 Concurrencia

Dos cajeros a la vez: ambos bloquean las mismas cabeceras en el mismo orden; el segundo espera al
primero y ve su saldo. El retiro que dejaría el cajón negativo **falla con error exacto**, nunca
deja el saldo en negativo. Prueba: 2 conexiones × 200 iteraciones; saldo final = suma esperada;
cero deadlocks.

### 4.8 Hechos externos (máquina y Kepler)

- **Orden**: la máquina numera sus movimientos (`external_id` contiguo por equipo). Se registran en
  ese orden. Un hueco detiene el registro de ese equipo en `external_queue` y dispara alerta
  después de N minutos (D-op).
- **Nunca se rechazan** (B41): si un hecho sin hueco dejaría la bóveda negativa, el libro está mal
  (falta algo antes): el hecho va a excepción con **hallazgo crítico**; no se postea a la fuerza ni
  se pierde.
- **Cambios** (B42): cada hecho guarda su `event_hash`. Si la fuente lo reescribe, se registra la
  versión nueva (reversa + asiento) y un hallazgo «la fuente cambió un hecho asentado».
- **Frescura** (B24): cada lectura del libro dice hasta qué movimiento de cada fuente llegó.

---

## 5. Catálogo de movimientos (cada hecho y su asiento)

⚠️ Los efectos de los tipos de CAOS marcados «a medir» **no se adivinan**: LE.0.2 los mide en prod y
con quien opera la máquina antes de escribir su regla.

| # | Hecho | Fuente | Asiento (+ entra / − sale) | Autorización | Testigo |
|---|---|---|---|---|---|
| E-01 | Cobranza de ruta reconocida | Kepler | + Por rendir · ruta / − Cobranza reconocida | automática (servicio) | total de cobranza Kepler |
| E-02 | Depósito en CAOS de una ruta (referencia `ruta NN ddmmyy`) | CAOS tipo Depósito | + Bóveda (piezas) / − Por rendir · ruta | automática si la llave empareja (E-03); si no, a Suspenso | conteo de la máquina |
| E-03 | Emparejamiento de un depósito en Suspenso | persona o regla por llave | + Suspenso / − Por rendir · ruta | persona: cuatro ojos sobre umbral | — |
| E-04 | Entrega de efectivo de ruta al cajón | persona, contado por pieza | + Caja · pesos (piezas) / − Por rendir · ruta | registra uno, cuenta otro | arqueo |
| E-05 | Faltante de ruta al vencer el plazo | regla + persona | + Faltante · vendedor / − Por rendir · ruta | **siempre** cuatro ojos | cierre firmado |
| E-06 | Sobrante de ruta | persona | + Por rendir · ruta / − Sobrante · vendedor | cuatro ojos | cierre firmado |
| E-07 | Retiro de CAOS al cajón | CAOS tipo Dispensar + clasificación de persona | + Caja · pesos (piezas) / − Bóveda (piezas) | clasificación sobre umbral: cuatro ojos | conteo de máquina + arqueo |
| E-08 | Retiro de CAOS en custodia de una persona | CAOS Dispensar + clasificación | + En custodia · empleado / − Bóveda (piezas) | cuatro ojos | rendición |
| E-09 | Gasto pagado del cajón | persona + comprobante | + Egresos · concepto / − Caja · pesos (piezas) | sobre umbral: cuatro ojos | egreso Kepler / comprobante |
| E-10 | Gasto pagado desde custodia (rendición) | persona + comprobante | + Egresos · concepto / − En custodia · empleado | cuatro ojos | comprobante |
| E-11 | Regreso de custodia | persona (cajón) o CAOS (depósito) | + Caja o Bóveda / − En custodia · empleado | registra uno, cuenta otro | arqueo / máquina |
| E-12 | Custodia vencida sin rendir | regla al vencer D3 | + Faltante · empleado / − En custodia · empleado | cuatro ojos | cierre firmado |
| E-13 | Depósito del cajón a CAOS | CAOS Depósito + clasificación «del cajón» | + Bóveda / − Caja · pesos (piezas) | — | máquina + arqueo |
| E-14 | Dotar casetes | CAOS tipo Dotar — **origen a medir** (LE.0.2) | + Bóveda / − (origen medido) | — | máquina |
| E-15 | Vaciar casetes / envío a banco | CAOS tipo Vaciar Stocks — **destino a medir** | + Valores en tránsito / − Bóveda | — | estado de cuenta |
| E-16 | Llega el depósito al banco | estado de cuenta (fase CB) | + Banco (fuera del libro) / − Valores en tránsito | automática | estado de cuenta |
| E-17 | Cambio de billetes (máquina o cajón) | CAOS tipo Cambio / persona | piezas entran y salen, suma 0 (I3) | — | conteos |
| E-18 | Otros tipos de CAOS (Fin de día, Contenido modificado…) | CAOS — **a medir** | sin efecto, o hallazgo si cambian contenido | — | — |
| E-19 | Arqueo (conteo ciego) | persona | **no es asiento**: diferencia vs saldo a `upto_seq` → hallazgo | contador ≠ custodio | — |
| E-20 | Ajuste por arqueo | hallazgo autorizado | + / − Caja contra Faltante o Sobrante · responsable | **siempre** cuatro ojos | arqueo |
| E-21 | Cobro en dólares | persona | + Caja · USD / − Cambio divisas USD; + Cambio divisas MXN / − Por rendir · ruta (con tipo de cambio) | cuatro ojos | arqueo USD |
| E-22 | Cheque recibido / depositado / devuelto | persona / estado de cuenta | + Documentos (folio) / − Por rendir; + Tránsito / − Documentos; + Por rendir / − Tránsito | cuatro ojos en devolución | arqueo de documentos / banco |
| E-23 | Otros ingresos (no ruta) | persona + soporte | + Caja / − Otros ingresos · concepto | cuatro ojos | soporte |
| E-24 | Pago a proveedor en efectivo | persona (`pago_proveedor`) | + Egresos · proveedor / − Caja | cuatro ojos sobre umbral | X-D-26 de Kepler |
| E-25 | Cobro o hecho de Kepler cancelado o corregido | Kepler | reversa del asiento + asiento de la versión nueva + hallazgo | automática | Kepler |
| E-26 | Reversa | persona | espejo exacto del original | **siempre** cuatro ojos | — |
| E-27 | Apertura | reconstrucción (E3) | + cuentas físicas / − Apertura | PM + segunda firma | conteos de la fecha de apertura |

---

## 6. Modelo de amenazas (qué puede salir mal y qué lo para)

| Escenario | Control | Prueba |
|---|---|---|
| Doble clic / reintento de red registra dos veces | I12 (`request_id`) | doble envío idéntico → 1 asiento; mismo id con otro monto → error |
| Dos cajeros sacan del mismo cajón a la vez | §4.7 bloqueo de cabecera | 2 conexiones × 200 iteraciones |
| El feed trae el mismo movimiento dos veces | I11 | reproceso del día → 0 asientos nuevos |
| Jineteo: el depósito de hoy tapa la ruta de ayer | emparejar por llave (B19) + antigüedad de «por rendir» visible (métrica e) | placebo ±días ≈ 0 aciertos |
| Cajero registra un gasto falso | cuatro ojos sobre umbral + comprobante + límite diario (B15) | autorizar con el mismo empleado → error |
| Una persona con dos usuarios se autoriza a sí misma | I15 por **empleado** (B43) | usuario A y B del mismo empleado → error |
| Esconder un faltante con importe tecleado | I2: sin piezas no hay línea en la caja | línea con monto y sin piezas → error |
| Esconder un faltante con una reversa | reversa siempre con cuatro ojos y motivo; reporte de reversas | reversa sin autorizar → error |
| Borrar o editar un asiento desde la base | I6 + I8 + `ddl_audit` | UPDATE como app y como dueño → error; alterar un byte → `verify_chain` lo marca |
| Fechar hacia atrás un movimiento | I14 jornada cerrada | asiento con fecha de jornada cerrada → error |
| Reloj del navegador o del servidor de app mal | `recorded_at` lo pone la base | payload con fecha de registro → se ignora |
| Redondeo por `float` | `bigint` centavos (B6) | 0.1 + 0.2, 1,234,567.89 × 3 |
| CAOS reescribe un movimiento ya asentado | B42 `event_hash` | cambiar el hash en sombra → reversa + hallazgo |
| Feed atrasado o caído | B24 frescura + alerta (B36) | latido viejo → cierre dice NO MEDIDO |
| Hueco en la numeración de la máquina | B41 cola + alerta | omitir un `external_id` → espera + alerta |
| Token robado autoriza | reautenticación al autorizar (B27) | autorizar sin paso extra → 401 |
| Escalada: alguien se da el permiso de autorizar | bitácora de permisos + alerta en cambios a permisos de caja | dar el permiso → alerta |
| Proceso automático «autoriza» | I15 | servicio autoriza → error |
| Restauración de respaldo deja el libro inconsistente | `verify_chain` + I10 tras restaurar (B38) | simulacro trimestral |
| Migración toma candados en horario | B33 fuera de horario + `lock_timeout` | runbook |
| Suspenso usado como «cajón de sastre» | B46: Suspenso ≠ 0 al cierre = hallazgo con antigüedad | cierre con Suspenso → hallazgo |
| Credencial de la máquina expuesta | B26 rotación + inventario privado | LE.0.1 |

---

## 7. Las etapas

### E0 · Contención y línea base — capa C0, casi todo sólo lectura

**Objetivo**: que deje de nacer dinero doble hoy, y saber con exactitud de qué se parte.
**Entregables**: LE.0.0 en prod con antes/después; catálogo de tipos de CAOS medido; inventario de
escritores; script de métricas; secretos rotados.

| # | Paso | Reglas | Estado | Verificación |
|---|---|---|---|---|
| LE.0.0 | **Contención de `CG.58`** (en código, sin desplegar): reparto apagado por default; migración `20261027101810` con la regla B4 en la base y baja lógica de 162 atribuciones · $1,703,230 | B4 | 🔨 | la consulta de §3 da 0 después de aplicar |
| LE.0.0a | **Corregir la carrera** de LE.0.0: los tres caminos que explican un movimiento (atribución, enlace, captura `origen_tipo='caos'`) toman **el mismo** candado por movimiento que ya usaban el enlace y la custodia (`hashtextextended(tenant\|device\|external_id, 50)`, de `[CGA-A.50]`). Migración `20261027105608` | B35 | 🧪 | `test-newdb-caja-una-explicacion.js` §7, 2 conexiones × 4 órdenes. **Rojo visto** sin la corrección (4 de 4 casos con «repartos vivos: 1») y **verde** con ella (21 ✓ / 0 ✗), base local armada desde cero con `preparar-base-caja.js`; `up` ×2 (idempotente) y `down`→`up` (reversible) |
| LE.0.0b | ~~Silencio por RLS~~ **DESCARTADO con evidencia**: las tres tablas tienen la misma política `tenant_isolation` con `USING` **y** `WITH CHECK`; quien puede insertar la atribución ve las filas del libro. La sospecha de la revisión era falsa | B4 | ✅ | lectura de `20261007330000`, `20260925170000`, `20260918150000` |
| LE.0.0c | El trigger de `cash_ledger` también en `UPDATE OF origen_tipo, origen_ref, estado, deleted_at`; el de enlaces también en cambio de movimiento o de captura (misma migración) | B4 | 🧪 | §6 + mutación (con el trigger sólo en INSERT la doble queda viva) |
| LE.0.0e | **`finance.caos_denom_valor()` rota en prod** desde el 26-oct 12:37 (`[CGA-A.55]`): knex convirtió los `?` de la regex en `$1`/`$2`, devuelve NULL para toda denominación y la regla rechaza **todo** enlace con billetes. Dormido (0 de 121 enlaces traen billetes: la pantalla aún no los manda), pero tiene **rojo el job `caja-db` de `main`** (custodia 19 ✓ / 2 ✗). Migración `20261027110325` con autocomprobación de las 12 llaves del catálogo | B25 | 🧪 | custodia 28 ✓ / 0 ✗; las 5 suites del job: 151 ✓ / 0 ✗ / 4 NO MEDIDO (previos) |
| LE.0.0d | Aplicar en prod, en orden y fuera de horario: `20261027101810` → `20261027105608` → `20261027110325`; desplegar el código con `CG.58` apagado | B33 | ⬜ | métrica (a) = 0. Medido hoy: 1,766 atribuciones vivas; **la última creada el 26-oct 17:05** (el reparto ya no escribe desde entonces) |
| LE.0.1 | **Secretos**: rotar la credencial de la máquina, quitar usuarios genéricos donde se pueda, cifrado en tránsito; todo en el inventario privado. ⚠️ El detalle ya quedó en el historial de git del repo público: **la rotación es el arreglo, no borrar el texto** | B12, B26 | ⬜ | la credencial anterior ya no entra |
| LE.0.2 | **Catálogo de tipos de CAOS medido** (ver «Resultados de E0»). Falta lo que el dato no dice: **de dónde viene el efectivo de Dotar y a dónde va el de Vaciar Stocks**, y qué es «Contenido Modificado»: se confirma con quien opera la máquina | B29, regla 10 | 🔨 | Σ efectos = conteo de la máquina en 2 fechas |
| LE.0.3 | **Inventario de escritores** (ver «Resultados de E0») | B29 | 🧪 | falta la revisión por otra persona |
| LE.0.4 | **Congelar lo viejo**: ninguna funcionalidad nueva sobre las tablas viejas de caja mientras dure la fase; ningún escritor nuevo | B29 | ⬜ | revisión de PR (D12) |
| LE.0.5 | **Script de métricas** `database/scripts/le-metricas.js` (sólo lectura, una conexión, verifica `system_identifier`). Línea base 2026-10-27 11:14: (a) **86 · 162 atribuciones · $1,703,230** · (b) **6 de 13** con su definición (esperado < 0 o diferencia de más de $100k en valor absoluto; el «7» del plan v1 era otra definición) · (c) **0** de 13 (por usuario, no empleado) · (d) NO MEDIDO · (e) 0 custodias abiertas; cobros por rendir NO MEDIDO · morralla tecleada: 87.3 % del contado el 26-oct | regla 15 | ✅ | dos corridas, misma huella de resultado |
| LE.0.6 | **Huecos y reescrituras del feed** (ver «Resultados de E0») | B41, B42 | ✅ | 0 huecos, 0 reescrituras al 2026-10-27 |

**Criterio de salida**: (a) = 0 en prod, catálogo de CAOS firmado por quien opera la máquina,
inventario revisado, línea base publicada, credencial rotada.
**Reversa**: la migración no revive atribuciones (`down` quita reglas); `CAOS_INGRESO_CONCILIAR=on`
reenciende el reparto si hiciera falta.

#### Resultados de E0 (medidos en `pg-prod`, sólo lectura, `7688376744939610156`, 2026-10-27 11:02)

**LE.0.2 — tipos de movimiento de la máquina** (un solo equipo, `AST700-19758`):

| type_id | Tipo | Movs | Total | Desde → hasta | Con desglose | Σ desglose | Quién |
|---:|---|---:|---:|---|---:|---:|---|
| 0 | Depósito | 827 | $20,476,940 | 27-may → 26-oct | 827 | = total | usuario compartido de vendedores 613 ($13.31 M) · cajera 168 · 2 personas más 46 |
| 4 | Dispensar | 418 | $20,182,510 | 27-may → 27-oct | 418 | = total | cajera 343 (82 %) · otra persona 75 |
| 8 | Dotar | 16 | $1,701,890 | 17-jun → 15-oct | 16 | = total | sólo la cajera |
| 5 | Vaciar Stocks | 13 | $2,915,150 | 17-jun → 15-oct | 13 | **$3,001,350 (≠ total: $86,200 de diferencia)** | sólo la cajera |
| 7 | Cambio | 5 | $0 | 21-ago → 26-oct | 5 | $0 | sólo la cajera |
| 2 | Fin de Día | 1 | $279,110 | 15-oct | 1 | = total | sólo la cajera |
| 13 | Contenido Modificado | 3 | −$25,420 | 8-sep → 30-sep | **0** | — | usuario del sistema de la máquina |

- Dotar, Vaciar Stocks, Cambio y Fin de Día los hace **una sola persona**: B9 hoy no se cumple
  tampoco en la máquina.
- «Vaciar Stocks» declara un total distinto de su propio desglose (ya conocido: el #1478 dice $20 y
  desglosa $86,220). La regla de E2 no puede elegir cuál vale sin confirmarlo con la máquina.
- «Contenido Modificado» cambia el contenido **sin desglose y con un usuario del sistema**: en el
  libro nuevo es un hallazgo, nunca un asiento automático (E-18).

**LE.0.6 — el feed**: `external_id` 449 → 1,731, 1,283 movimientos, **0 huecos**, **0 reescritos**
(`updated_at` > `created_at` + 1 min). Último movimiento 10:16. ⚠️ Los movimientos anteriores al
449 no están en el feed: la reconstrucción (LE.3.4) arranca en el 449 y lo declara.

**LE.0.3 — inventario de escritores** (barrido de código, 2026-10-27; falta la revisión por otra persona):

| Objeto | Quién escribe |
|---|---|
| `cash_ledger` | alta (`POST /finance/cash-ledger`, `/lote`), cierre de corte, reclasificar, cancelar, el escáner de fecha futura (cron 07:15, `ENABLE_CAJA_FECHA_SCAN`), el autollenado por aviso de Postgres (`ENABLE_CAJA_AUTOLLENADO`, **apagado** en el worker) y un SQL a mano (`ops/prod/paso-a-mano/CGA-A24`) |
| `cash_ledger_denominations`, `_sequences` | el alta (y la apertura de corte para el folio) |
| `cash_ledger_cuts`, `_cut_denominations` | abrir, contar, recontar, cerrar, observar, responder, autorizar; el desglose se **borra y reinserta** por momento |
| `caos_cash_links` | sólo el alta del libro (+ SQL a mano CGA-A24) |
| `caos_ingreso_atribucion` | `CG.58` (cron :05 cada hora, `CAOS_INGRESO_CONCILIAR`, apagado por default) y el trigger de LE.0.0 |
| `caos_deposito_grano` | el mismo cron, **sin interruptor propio** (corre aunque el reparto esté apagado) |
| `caos_retiro_custodia` | clasificar y cerrar custodia |
| `cash_arqueos`, `caos_conteos_fisicos` | sólo INSERT (la base bloquea UPDATE/DELETE) |
| `analytics.caos_cash_movements`, `_denominations` | el feed `caos-live` (k3s, cada 1 s; UPSERT por `_row_hash`; el desglose se borra y reinserta) |
| `analytics.caos_cash_counts` | el mismo feed (`capturarConteo`, cada 300 s) — ⛔ **pero en prod tiene 0 filas**: el escritor existe y nunca dejó nada. Es el punto de partida de LE.3.1 |
| `cash_ledger_cut_custody`, `_cut_vouchers`, `_route_links` | **nadie** |

Fuera de la lista, los mismos servicios escriben `cash_ledger_llaves` y `cash_ledger_reclasificaciones`:
entran al alcance del reemplazo.

**Hallazgos de la prueba, fuera de LE pero en su camino** (deuda con nombre):
- El paso «Servicio real del corte» del job `caja-db` está rojo en `main` por causas del armado de
  la base **en el CI** (`permission denied for schema identity`, `identity.users` ausente al
  sembrar). En la base local armada con el mismo script, `cash-cut.servicio-real` pasa 23/23.
- `caos-ingreso-recon.libro-real.spec.ts` (de LE.0.0) **no puede correr** en `caja-db`: lee
  `finance.v_caja_movimientos_pendientes`, que cuelga de la cadena de vistas materializadas de
  Kepler. NO MEDIDO; se retira con `CG.58` en LE.7.3.
- ⚠️ El `.env` local define `DATABASE_URL_NEW_RUNTIME` contra **prod**, y el guardián de las pruebas lee
  esa variable primero: correr una prueba con sólo `DATABASE_URL_NEW` local **aborta** (bien). Para
  la base local hay que fijar las dos.

### E1 · Fundación del libro — capa C0

**Objetivo**: un libro vacío en el que **es imposible** escribir algo que rompa un invariante.
**Entregables**: ADR-102 y ADR-103; esquema `cashbook` con roles, tablas, funciones e invariantes;
suite de pruebas en `caja-db`. Ninguna consumidora todavía.

| # | Paso | Reglas | Estado | Verificación |
|---|---|---|---|---|
| LE.1.1 | **ADR-102** (partida doble) y **ADR-103** (esquema propio, función única, centavos, cadena) escritos en `02_DECISIONES_ARQUITECTURA.md` | D4, D9, D10 | 🧪 | falta la lectura del PM de ADR-102 (D4) |
| LE.1.2 | Esquema `cashbook`, rol `cashbook_owner`, `app_runtime` sólo SELECT/EXECUTE, event trigger de DDL. Migración `20261027111930` | B2, B21, B39 | 🧪 | INSERT/UPDATE/TRUNCATE y `_post` como app → 42501; quitar un candado queda en `ddl_audit` |
| LE.1.3 | Cuentas + cabeceras de saldo y de piezas con CHECK; 19 denominaciones; 12 cuentas base sembradas; `open_account` idempotente (la misma forma devuelve la cuenta, otra forma es error `cashbook_cuenta_distinta`). ⚠️ Falta la función de **cierre de cuenta** (deuda) | B8 | 🧪 | física que admite negativo, custodia negativa, billetes de más → rechazados con su nombre |
| LE.1.4 | Asientos + líneas + piezas + contador, únicos y triggers de inmutabilidad (también para el dueño) | B1, B2, B3, B40 | 🧪 | UPDATE, DELETE, TRUNCATE y línea en asiento sellado → `cashbook_inmutable` |
| LE.1.5 | Jornadas: una abierta, en orden, cierre con cuatro ojos y `closing_seq`/`closing_hash` | B7, B20 | 🧪 | día cerrado, día anterior, misma persona → rechazados |
| LE.1.6 | **`_post`** (§4.5) con I1–I5, I7–I9, I11, I12, I14, I16; la huella de idempotencia la calcula la base | B1–B8, B35, B39 | 🧪 | 12 negativas de forma + fecha futura, otro día, actor, evento |
| LE.1.7 | Reversa (por solicitud autorizada) con I13 | B2, B10 | 🧪 | sin motivo, doble, de reversa → rechazadas; la reversa devuelve cada pieza |
| LE.1.8 | Solicitudes: crear, autorizar, rechazar, vencer; I15 por usuario y empleado | B9, B10, B14, B43, B45 | 🧪 | mismo usuario, otro usuario del mismo empleado, vencida, sin motivo → rechazados |
| LE.1.9 | `counts` + `count_pieces` + `findings` + `external_queue` (migración `20261027120749`): un conteo es inmutable y se compara contra el saldo HASTA un asiento; la diferencia la calcula la base (arqueo ciego); toda diferencia abre un hallazgo con monto y denominación; un hallazgo se cierra sólo con un asiento o con la nota firmada por OTRA persona; la excepción externa se guarda una vez y se resuelve con algo. `close_day` ya no cierra con descuadre interno (I10) y abre un hallazgo por cada Suspenso ≠ 0 (B46) | B11, B17, B18, B41, B46 | 🧪 | `test-newdb-cashbook-conteos.js` 29 ✓ / 0 ✗ (con mutación) |
| LE.1.10 | Vistas `v_saldos`, `v_saldos_piezas`, `v_mayor`, `v_descuadre_interno` y `balances_at(seq)` | B5, I10 | 🧪 | descuadre interno vacío; saldo a la secuencia de apertura = apertura; RLS: otro tenant ve 0 |
| LE.1.11 | `verify_chain()` | B2 | 🧪 | una línea alterada por el dueño (con el trigger apagado) → la detecta |
| LE.1.12 | **`test-newdb-cashbook-libro.js`** en `caja-db`: **77 ✓ / 0 ✗** (79 con `--rendimiento`); 4 mutaciones (CHECK de saldo, trigger de inmutabilidad, chequeo diferido, privilegio); dos cajeros a la vez; 40 asientos desde 8 conexiones sin huecos. Rendimiento medido con **2,000** asientos (no 500k): p95 8.3 ms, saldos 2.8 ms. La prueba encontró y se corrigieron 4 defectos del propio libro (lógica de NULL ×3, huella del cliente) | B31, B35 | 🧪 | base local armada desde cero; las 6 suites de caja 228 ✓ / 0 ✗ |
| LE.1.13 | Aplicar en prod **inerte** (sin escritores), fuera de horario | B33 | ⬜ | espera autorización de push y ventana |

**Criterio de salida**: todas las pruebas verdes en CI con su rojo documentado; esquema en prod
vacío; ADRs firmados.
**Reversa**: el esquema es nuevo y nadie lo usa: `down` lo quita entero sin tocar nada viejo.

### E2 · Reglas de registro — capa C1

**Objetivo**: cada hecho del catálogo (§5) produce exactamente un asiento correcto, en código puro y
probado.
**Entregables**: `libs/finance/src/lib/cashbook/` (reglas puras), primitivo de dinero en `libs/`,
contratos tipados en `libs/contracts`, emparejador con precisión publicada.

| # | Paso | Reglas | Estado | Verificación |
|---|---|---|---|---|
| LE.2.1 | **`libs/contracts/src/money/centavos.ts`**: pesos en texto → centavos `bigint`, formateo sin `number`, un solo redondeo (conversión de moneda, mitad lejos del cero), piezas contra el catálogo (MXN + `BILLETES_USD` nuevo) | B6, regla 16 | 🧪 | `centavos.spec.ts` 15 ✓ (0.1+0.2, mil centavos, 9 entradas inválidas, redondeo de negativos) |
| LE.2.2 | **`libro-efectivo.contract.ts`**: asiento, líneas, actor, meta, cuentas con titular y catálogo de eventos. **Paridad** base ↔ código (denominaciones, cuentas fijas, eventos con cuatro ojos) | B25 | 🧪 | `paridad-catalogos.spec.ts` 3 ✓; rojo visto al alterar un valor de la siembra |
| LE.2.3 | **`libs/finance/src/lib/cashbook/reglas.ts`** (`le2-2026-10-27.1`): los 27 movimientos menos los que no mueven efectivo comprobable. Lo que hace la máquina se asienta SIEMPRE (la bóveda = la máquina); la contraparte desconocida va a Suspenso. Por rendir es POR RUTA. **Cruzado con la base**: el día del PM entra entero por `post_entry`/`authorize_request` | B1, B19, B22 | 🧪 | `reglas.spec.ts` 25 ✓ + `reglas.libro-real.spec.ts` 1 ✓ (ruta 27 en $0.00, bóveda 180×500 + 20×200, cadena íntegra, relectura del feed sin segundo asiento, payload alterado → `cashbook_piezas_no_suman` igual que la regla) |
| LE.2.4 | **`identidad.ts`**: `caos:<equipo>:<id>` y `kepler:<origen_ref>` con huella `sha256` de JSON con llaves ordenadas; dirección de cada tipo desde `efectoDeTipo` (medido), no supuesta | B3, B42 | 🧪 | la huella no cambia con el orden y sí con el contenido |
| LE.2.5 | **La llave es la ruta que DECLARA el texto** (`atribuirDeposito`, CG.58.6), sin antigüedad. Medido contra el testigo independiente (el cobro de Kepler al que una persona ligó el depósito, `route_collections.truck`): **precisión 46/48 (96 %)**, placebo 8.5/48. Los 2 desacuerdos son un cruce simétrico 22↔26. ⚠️ **40 % del dinero depositado no declara ruta**: plaza 82 dep. · $5.69 M, sin declarar 76 · $2.42 M → Suspenso hasta que una persona lo clasifique (ver D15) | B19 | 🧪 | sonda de sólo lectura con el parser REAL (esbuild), 2026-10-27 |
| LE.2.6 | Matriz de autorización: los eventos que SIEMPRE piden cuatro ojos viven en la base y en el contrato (con paridad); el umbral por evento espera D3 | B10, B15 | 🔨 | falta el umbral (D3) y los límites por persona (D14) |
| LE.2.7 | **Propiedad**: 5,000 hechos al azar de 12 tipos (semilla fija) → todo asiento cuadra por moneda y conserva cada pieza, revisado por un verificador escrito APARTE de `armar()` | B1, B31 | 🧪 | mutación del verificador: un asiento descuadrado a mano lo detecta |

**Criterio de salida**: cada evento del catálogo con regla y prueba; ningún tipo de CAOS «a medir»
sin resolver; precisión del emparejador publicada.
**Reversa**: código sin consumidores; se revierte el commit.

### E3 · Testigos y reconstrucción — capas C0 + C1

**Objetivo**: cada cuenta física con su testigo guardado, y la historia desde el 27-may pasada por
las mismas reglas, con lo que no cuadre declarado por monto.
**Entregables**: conteo de la máquina guardándose; lectores de testigos con frescura; informe de
reconstrucción; asiento de apertura; historia cargada.

| # | Paso | Reglas | Estado | Verificación |
|---|---|---|---|---|
| LE.3.1 | **Guardar el conteo de la máquina**. Medido el 2026-10-27: el código del importer SÍ lo captura (`capturarConteo`, cada 300 s) pero en prod **no existe ni un latido `caos_conteo`** en `cron_runs` — el `caos-live` desplegado es anterior a ese código. Arreglo: redesplegar `caos-live` (operación en `md`), y que cada lectura entre al libro como `register_count` de la máquina | B17 | 🔨 | latido `caos_conteo` ok + conteo guardado = pantalla de la máquina |
| LE.3.2 | **Lectores de testigos** con frescura: máquina, estado de cuenta (fase CB), cobranza y egresos de Kepler (vistas sobre `kepler_ods`), arqueos | B17, B24 | ⬜ | fuente atrasada → NO MEDIDO |
| LE.3.3 | **Detector de huecos** (`carril-caos.ts`, `planDeCaos`): toma la máquina en orden y se detiene en el primer número que falta; el hueco va a `external_queue`. La reescritura de un hecho ya asentado la rechaza la base (`cashbook_evento_cambio`) | B41, B42 | 🧪 | `carril-caos.spec.ts` 4 ✓ |
| LE.3.4 | **Reconstrucción en seco** (`database/scripts/le-reconstruccion-en-seco.ts` + `libs/finance/src/lib/cashbook/reconstruccion.ts`, el código REAL de las reglas, sólo lectura). Medido el 2026-10-27: (1) desde la máquina en cero tras el vaciado #1607 (15-oct), 46 movimientos → **$360,020 = el inventario de casetes del 20-oct 10:04, en las 5 denominaciones**; (2) desde el vaciado del 17-jun: tramos al 7-jul y al 18-ago **en cero**; entre el 8 y el 30-sep queda un residuo de **$49,860** ($20×8, $50×116, $200×212, $500×3) que nace de 3 «Contenido Modificado» sin piezas (#1291, #1473, #1474) y del vaciado #1478 (declara $20, desglosa $86,220): **hallazgo con monto**, no una regla. (3) La dirección del «Cambio» quedó **probada**: aplicando el signo de cada denominación desaparecen los 17 eventos con billetes de $500 en negativo | B31, B32 | 🧪 | testigo independiente y absoluto (inventario de casetes); `reconstruccion.spec.ts` 5 ✓ |
| LE.3.5 | **Decisión de apertura** (D11). Recomendación con evidencia de LE.3.4: **abrir el libro el 15-oct después del vaciado #1607**: la bóveda en cero la dicen dos testigos (el «Fin de Día» #1606 leyó lo mismo que vació el #1607) y el libro desde ahí reproduce el inventario del 20-oct exacto. Lo anterior queda en el libro viejo, DECLARADO, con el residuo de $49,860 como hallazgo. Falta el testigo del cajón a esa fecha (el conteo por denominación del corte CC-2026-00004 del 15-oct, por verificar) | B18 | 🔨 | firma del PM |
| LE.3.6 | **Cargar la historia aceptada** al libro real: fuera de horario, idempotente por `event_ref`, con asiento de apertura y cada diferencia como hallazgo con dueño | B18, B33 | ⬜ | saldos = testigos o diferencia en hallazgos |

**Criterio de salida**: libro real con historia; cada cuenta física igual a su testigo o con la
diferencia como hallazgo con dueño y monto; Suspenso explicado.
**Reversa**: los asientos de carga se revierten con asientos de reversa (nunca DELETE), marcados con
su lote.

### E4 · API — capa C2

**Objetivo**: que una persona y un proceso puedan registrar, autorizar, contar, cerrar y consultar
sólo por la API, con todos los controles.
**Entregables**: controladores en `libs/finance` sobre las funciones de la base; permisos por acción
repartidos; pruebas contra base real con el payload de la pantalla.

| # | Paso | Reglas | Estado | Verificación |
|---|---|---|---|---|
| LE.4.1 | Permisos. **Hoy**: las claves de Caja General que YA están repartidas en prod (`FINANCE_CAJA_VER` lee, `_GESTIONAR` registra y cuenta, `_AUTORIZAR` firma, cierra y ve el desglose por pieza). ⚠️ Los permisos finos por acción (registrar, autorizar, revertir, contar, conciliar, cerrar) son **deuda con nombre antes del cambio (E7)**, con su reparto y `MATRIZ_ACCESOS.md` | B13 | 🔨 | — |
| LE.4.2 | **Reautenticación al autorizar, revertir y cerrar** (clave u OTP) | B27 | ⬜ | **deuda con nombre antes del cambio (E7)**: hoy la firma es la sesión |
| LE.4.3 | **`finance/libro-efectivo`** (`cashbook.controller.ts` + `cashbook.service.ts`): POST hechos (Idempotency-Key obligatoria), autorizar, rechazar, reversa, conteos, abrir/cerrar jornada, cerrar hallazgo. La pantalla dice QUÉ pasó (`HechoDePersona`); la regla del servidor arma el asiento. Lo que pide cuatro ojos queda como solicitud (vence a las 72 h). Quién cierra la jornada o firma una nota **sale de la base**, nunca del cliente. Cada rechazo con su `codigo` y frase (`errores.ts`), nunca un 500 | B3, B9–B11 | 🧪 | `cashbook.servicio-real.spec.ts`: un día completo contra base real, cada rechazo con su HTTP y `codigo` exactos |
| LE.4.4 | **Carril máquina → libro** (`cashbook-caos.carril.ts`, cron cada minuto en el worker): identidad de servicio `libro-caos`; ⛔ apagado por default (`LE_LIBRO_CAOS=on`) y sin punto de apertura no hace nada (`LE_LIBRO_CAOS_DESDE=AST700-19758:1607`); en orden; sin regla → cola y sigue; hueco o bóveda en negativo → cola y SE DETIENE; idempotente; latido `libro_caos`. ⚠️ La mitad de **Kepler** (cobranza por ruta → «por rendir») falta: su fuente (`analytics.route_collections` u otra) se investiga y se verifica contra un testigo antes de usarla (regla 10) | B14, B41 | 🔨 | `cashbook-caos.carril.servicio-real.spec.ts` 1 ✓ contra Postgres (orden, cola, hueco, negativo, relectura) |
| LE.4.5 | Lectura: saldos (con la integridad de la cadena), mayor, hallazgos abiertos, solicitudes pendientes | B22, B24 | 🧪 | ⚠️ el tiempo con el volumen de prod NO MEDIDO (base de prueba) |
| LE.4.6 | **Arqueo ciego**: en un arqueo SORPRESA la respuesta no trae ni esperado ni diferencia; el desglose por pieza de los saldos sólo con `_AUTORIZAR` | B11 | 🧪 | prueba de forma en el spec de servicio real |
| LE.4.7 | Pruebas de API: servicio real contra Postgres (idempotencia, cuatro ojos, cierre por otra persona, arqueo ciego, reversa) + **composición** (`apps/api/src/composition/finance-libro-efectivo.metadata.spec.ts`: el módulo registra controlador y servicio, `design:paramtypes` correctos — punto 30) | B31 | 🧪 | 1 ✓ + 3 ✓. Encontró un defecto real: el reintento idéntico se rechazaba porque la huella incluía la hora que pone el servidor (corregido) |
| LE.4.8 | Alerta en cada cambio a permisos de caja | B21 | ⬜ | dar el permiso → alerta |

**Criterio de salida**: todo endpoint que escribe ejercido contra base real; matriz de accesos
firmada; arranque verificado (`design:paramtypes`, punto 30 del protocolo).
**Reversa**: endpoints nuevos detrás de permiso; quitar el permiso los apaga.

### E5 · Operación en sombra — operación sobre C0–C2

**Objetivo**: el libro nuevo vive los mismos días que el viejo y demuestra cuadrar **contra los
testigos**.
**Entregables**: cierre diario automático; alertas; informe de diferencias contra el libro viejo,
cada una explicada.

| # | Paso | Reglas | Estado | Verificación |
|---|---|---|---|---|
| LE.5.1 | **Alimentar el libro nuevo** con los hechos del día: externos por el trabajador (LE.4.4); humanos leyendo `cash_ledger` (la captura de la pantalla actual) y pasándolos por las mismas reglas, sin doble captura | B34 | ⬜ | cada captura del día con su asiento o su motivo |
| LE.5.2 | **Cierre diario** contra testigos con alertas a un responsable con nombre | B17, B36 | ⬜ | día sembrado con faltante → exactamente ese hallazgo |
| LE.5.3 | **Diferencias contra el libro viejo**: cada una catalogada («el viejo dobla», «el viejo cruza jornadas», …). ⛔ El criterio de cambio **no** es «igual al viejo»: el viejo está mal por diseño | B34, B37 | ⬜ | informe diario |
| LE.5.4 | Al menos 2 **arqueos sorpresa** por un tercero durante la sombra | B11 | ⬜ | registro del arqueo |
| LE.5.5 | **Simulacro de restauración**: restaurar el respaldo en base de prueba, `verify_chain` + `v_descuadre_interno` | B38 | ⬜ | ambos limpios |

**Criterio de salida**: **10 cierres hábiles seguidos con cero diferencias sin explicar contra los
testigos**; toda diferencia contra el viejo explicada; simulacro limpio; firma del PM.
**Reversa**: la sombra no toca la operación; se apaga el trabajador.

### E6 · Interfaz — capa C3 (no arranca antes de 5 cierres limpios en E5)

**Objetivo**: que la operación diaria se haga en pantallas que no pueden afirmar lo que no es.
**Entregables**: observaciones de diseño al plan (`auditoria-diseno` §9) **antes** del primer
archivo; pantallas sobre la API de E4.

| # | Paso | Estado | Verificación |
|---|---|---|---|
| LE.6.0 | Observaciones de diseño al plan; sus 🔴 se vuelven items aquí | ⬜ | sección agregada a este doc |
| LE.6.1 | Captura (crea solicitud; piezas obligatorias en la caja) | ⬜ | `check:pantalla` antes → después |
| LE.6.2 | Bandeja de autorización (con reautenticación) | ⬜ | ídem |
| LE.6.3 | Arqueo ciego y sorpresa | ⬜ | ídem; sin esperado visible |
| LE.6.4 | Cierre de jornada (por cuenta, testigo, diferencia, hallazgo) | ⬜ | ídem |
| LE.6.5 | Por rendir y custodias con antigüedad y nombre | ⬜ | ídem |
| LE.6.6 | Hallazgos y mayor (todo total desglosable hasta el asiento) | ⬜ | ídem; < 500 ms |

### E7 · Cambio y retiro — operación

**Objetivo**: el libro nuevo es el oficial y lo viejo queda como evidencia congelada.

| # | Paso | Estado | Verificación |
|---|---|---|---|
| LE.7.1 | **Plan de reversa escrito y ensayado** en base de prueba | ⬜ | ensayo documentado |
| LE.7.2 | Día de cambio: la jornada X abre en el libro nuevo; pantallas viejas en sólo consulta; `app_runtime` sin INSERT/UPDATE en las tablas viejas de caja | ⬜ | intento de escritura vieja → error |
| LE.7.3 | Retirar el código de `CG.58`, custodia y enlaces; vistas que otras pantallas leían redirigidas al libro (inventario LE.0.3) | ⬜ | `grep` sin consumidores |
| LE.7.4 | Remedir (a)–(e); DoD; tracker, log, ADRs, `CLAUDE.md` | ⬜ | antes/después publicado |

### Controles de organización (corren en paralelo, sin código — dueño: PM / Dirección)

| # | Control | Por qué no lo resuelve el código |
|---|---|---|
| LE.X.1 | Usuarios nominales en la máquina (un usuario por vendedor) | es configuración del equipo y del proveedor |
| LE.X.2 | Nombrar la **segunda persona** que autoriza y la tercera que arquea (D6) | sin gente, B9 y B10 no tienen con quién cumplirse |
| LE.X.3 | Calendario de arqueos sorpresa (D13) | decisión de Dirección |
| LE.X.4 | Revisión trimestral de accesos firmada | decisión de Dirección |
| LE.X.5 | Protección de rama con revisión obligatoria para el código de caja (D12) | hoy el admin la evita (`enforce_admins: false`) |

---

## 8. Qué NO incluye

- **Contabilidad.** ContPAQi sigue siendo el SoR contable (ADR-040). Éste es el libro **operativo**
  del efectivo físico; no emite pólizas.
- **Escribir en Kepler ni en la máquina.** Ambos sólo se leen (B24); dispensar desde el sistema
  queda fuera (B28).
- **Las cajas de las sucursales** (`analytics.cash_cuts`, Wincaja). Sólo la Caja General de Oficinas.
- **El banco por dentro**: el libro llega hasta «valores en tránsito»; la conciliación bancaria es
  la fase CB.
- **Borrar** tablas viejas, ni las `*_bak` (D5).

---

## 9. Decisiones (→ ADR)

| # | Decisión | Recomendación | Estado |
|---|---|---|---|
| D1 | LE reemplaza a CGA (A.50–A.57 absorbidos). ⚠️ Quedan 5 fases 🔨 contra el tope de 4 | — | ✅ firmada 2026-10-27 |
| D2 | Una sola caja física: pesos, **dólares** y **documentos**; el grueso en CAOS | — | ✅ firmada 2026-10-27 |
| D3 | **Plazo** para rendir lo que está por rendir o en custodia, y **umbral** de cuatro ojos | — | ✅ **plazo: NO hay** (PM, 2026-10-27: *«no podemos poner un plazo para rendir el dinero si el sistema anterior tenía fallas»*). Ningún saldo pasa solo a faltante: el faltante nace **sólo** de una decisión de persona con cuatro ojos (E-05, E-12 sin disparo automático). La antigüedad se publica (métrica e) pero no castiga. **Umbral: pendiente** |
| D4 | Partida doble como modelo del efectivo (refina ADR-101) | ADR-102 | ⬜ |
| D5 | Destino de las `*_snapshot_bak` | fuera de esta fase | ⬜ |
| D6 | **Quién autoriza** (segunda persona) y **quién arquea** (tercera, sorpresa) | — | ✅ **autorizan `mariaz` y Luis Francisco López (superusuario)** (PM, 2026-10-27). ⚠️ El superusuario **no** se salta I15: autoriza como cualquier empleado y nunca lo suyo. **Quién arquea: pendiente** |
| D7 | ¿La **nota de crédito** entra a este libro? | — | ✅ **no entra** (PM, 2026-10-27): se considera en la revisión (conciliación), no como pieza de la caja. La cuenta «Caja General · documentos» queda sólo para cheques |
| D8 | Cómo se cierra un **faltante** a nombre de un empleado (descuento de nómina —topado por el art. 110 de la LFT— o cuenta por cobrar al empleado en RH) | con RH, antes de E4 | ⬜ |
| D9 | Dinero en la base como **centavos `bigint`** (las vistas lo exponen en pesos) | sí | ✅ PM, 2026-10-27 |
| D10 | Esquema propio `cashbook` con dueño aparte y **función única de escritura** | sí | ✅ PM, 2026-10-27 |
| D11 | **Apertura**: reconstruir desde el 27-may o abrir con un conteo físico completo y declarar lo anterior | **15-oct tras el vaciado #1607** (LE.3.4: bóveda en cero con dos testigos, y desde ahí el inventario del 20-oct cuadra exacto); el cajón, con el conteo del corte del 15-oct | ⬜ recomendación lista, falta firma |
| D12 | Revisión obligatoria por otra persona para el código de caja (`enforce_admins` en esas rutas) | sí | ✅ PM, 2026-10-27 (falta configurarla: LE.X.5) |
| D13 | Frecuencia del arqueo sorpresa | al menos 2 al mes | ✅ PM, 2026-10-27 |
| D14 | Límites por persona y por día (registrar y autorizar) | con el umbral de D3 | ⬜ |
| D15 | **Depósitos que sólo declaran PLAZA** (Canindo, Morelia: 82 · $5.69 M): ¿por rendir por plaza (la cobranza de las rutas 501–505 abona a la plaza) o Suspenso hasta que una persona diga la ruta? | **por plaza**: el texto es exacto a ese nivel (CG.58.6: Canindo cierra 95.2 %) y elegir ruta sería inventar | ⬜ |

---

## 10. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| `CG.58` sigue escribiendo atribuciones FIFO cada hora | Edgar | LE.0.0 sin desplegar | LE.0.0a–d |
| Credencial de la máquina expuesta (historial público) | Edgar | B26 | LE.0.1 |
| La bóveda no tiene testigo guardado | Edgar | `caos_cash_counts` en 0 filas | LE.3.1 |
| Segregación imposible con una sola persona en caja | PM / Dirección | plantilla | D6 |
| Tipos de CAOS con efecto desconocido (Dotar, Vaciar, Contenido modificado) | Edgar + operador de la máquina | nunca se midió de dónde viene y a dónde va | LE.0.2 |
| Gastos que sólo están en Kepler antes del 25-sep | Edgar | el libro de la suite empieza ese día | D11 + LE.3.4 los declara por mes, con monto |
| Cupo de fases (5 🔨 contra 4) | PM | FC abierta el 26-oct | decisión del PM en el tablero |

---

## 11. Métricas: cómo se miden

Todas con el script de LE.0.5, sólo lectura, contra `pg-prod` verificado por `system_identifier`:
(a) depósitos con más de una explicación viva; (b) cortes con esperado negativo o piernas cruzadas
de más de $100k; (c) % de cortes y movimientos sobre umbral con `authorized_by` ≠ `created_by` por
empleado; (d) diferencias sin hallazgo explicado en el cierre diario; (e) saldo de «por rendir» y
«en custodia» con antigüedad > 1 día hábil, por persona. Cada corrida publica fecha, fuente y
frescura.

---

## 12. Definición de Terminado

- [ ] 1. Métricas (a)–(e) **remedidas**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Cada invariante I1–I18 **roto a propósito una vez**, rojo verificado y anotado
- [ ] 5. `Money` y el libro en `libs/` compartido, **o** deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod** (E7 cerrada), o escrito por qué no y qué falta

---

## 13. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-27 | Plan v1: medición, inventario de 71 objetos y 38 reglas de banco | Claude, por pedido del PM |
| 2026-10-27 | PM firma D1 y D2 y da el caso diario. LE.0.0 en código (sin desplegar) | PM + Claude |
| 2026-10-27 | **Plan v2**: revisión «como banco». Se decide **rehacer el núcleo desde cero** (§1) en un esquema propio con función única de escritura; se agregan B39–B46, el modelo (§4), 18 invariantes, el catálogo de 27 movimientos (§5), el modelo de amenazas (§6) y las etapas E0–E7. Se encuentran 3 defectos en LE.0.0 (carrera entre transacciones, silencio por RLS, trigger sólo en INSERT) → LE.0.0a–c. El criterio de cambio pasa de «igual al libro viejo» a «cuadra contra los testigos». Se quitan de este doc los detalles de seguridad de la máquina (repo público). **Renumeración**: los items v1 LE.0.1–LE.2.4 (todos ⬜) pasan a E1–E5 (bolsas → LE.1.3, asientos → LE.1.4, invariantes → LE.1.6, saldos → LE.1.10, testigo de la máquina → LE.3.1, reglas → LE.2.3, emparejador → LE.2.5, reconstrucción → LE.3.4, cierre diario → LE.5.2, API → E4, paralelo → E5) | Claude, por pedido del PM |
| 2026-10-27 | PM firma D3 (**sin plazo** para rendir: el sistema anterior tenía fallas), D6 (autorizan `mariaz` y Luis Francisco López), D7 (notas de crédito fuera: se ven en la revisión), D9, D10, D12, D13; D11 en su método. **E0 arranca** | PM |
| 2026-10-27 | E0: LE.0.0a y LE.0.0c (🧪, rojo→verde en base local con 2 conexiones), LE.0.0b descartado con evidencia, **LE.0.0e** (función de denominaciones de A.55 rota en prod, deja rojo `caja-db`) 🧪, LE.0.2 medido (falta confirmar Dotar/Vaciar con quien opera), LE.0.3 inventario, LE.0.6 ✅. Sin desplegar: LE.0.0d espera autorización de push y la ventana fuera de horario | Claude |
| 2026-10-27 | LE.0.5 ✅ (`le-metricas.js`, línea base). **E1 en código** (🧪): migración `20261027111930` (esquema `cashbook`, función única de escritura, centavos, cadena de hashes, cuatro ojos, jornadas) y `test-newdb-cashbook-libro.js` 77 ✓ / 0 ✗ en base local desde cero; ADR-102 y ADR-103. La prueba encontró 4 defectos del propio libro antes de que existiera un solo asiento real (corregidos). Pendiente: LE.1.9 (va con E3), cierre de cuenta, LE.1.13 (aplicar inerte en prod) | Claude |
| 2026-10-27 | **E2 en código** (🧪): primitivo de centavos y contrato del libro en `libs/contracts`; reglas, identidad y emparejador por ruta declarada en `libs/finance/src/lib/cashbook`; cruce TS ↔ SQL contra la base real; paridad de catálogos; propiedad con 5,000 hechos. LE.2.5 medido: 96 % de precisión contra lo ligado por personas, y 40 % del dinero sin ruta declarada (D15). Ajustes a la migración de E1 aún sin empujar: `meta` firmada en la cadena, I18 (divisas sólo por puente con tipo de cambio) y `open_account` idempotente | Claude |
| 2026-10-27 | **E3 · LE.3.4 medido**: con las reglas nuevas y desde la máquina en cero del 15-oct, el libro reproduce el inventario de casetes del 20-oct ($360,020) **exacto en las 5 denominaciones**. La dirección del «Cambio» quedó probada por los datos (el «Cambio» se asienta siempre; su contraparte la clasifica una persona). Residuo histórico de $49,860 localizado en sep (3 «Contenido Modificado» + vaciado #1478). Recomendación de apertura (D11): 15-oct tras el #1607 | Claude |
| 2026-10-27 | **LE.1.9** 🧪 (conteos, hallazgos, excepciones; cierre que no deja pasar descuadres ni Suspenso sin explicar). **LE.3.1**: el conteo de la máquina no se guarda porque el `caos-live` desplegado no trae ese código (sin latido `caos_conteo`): se arregla redesplegando. ⚠️ Una sonda mía quedó «idle in transaction» 5 min en prod tras un error de columna (sólo lectura, sin candados); las sondas ya cierran en `finally` | Claude |
| 2026-10-27 | **E4 en código** (🧪): API `finance/libro-efectivo` sobre el libro, con las claves de permiso de Caja General ya repartidas (las finas y la reautenticación quedan como deuda antes de E7). Servicio real contra Postgres + composición de Nest. La prueba de servicio encontró que el reintento idéntico se rechazaba (la huella incluía la hora del servidor) — corregido en la migración aún sin empujar. Pendiente de E4: el trabajador de hechos externos (LE.4.4) y la alerta de cambios de permisos (LE.4.8) | Claude |
| 2026-10-27 | **LE.4.4 (mitad CAOS) y LE.3.3** 🧪: el carril que pasa la máquina al libro, apagado por default y atado a un punto de apertura. **Para encender la sombra (E5)**: (1) aplicar en prod, en orden y fuera de horario, `…101810` → `…105608` → `…110325` → `…111930` → `…120749`; (2) firmar D11; (3) abrir la jornada y registrar la apertura del cajón (conteo del 15-oct) con la bóveda en cero; (4) en el worker `LE_LIBRO_CAOS_DESDE=AST700-19758:1607` y `LE_LIBRO_CAOS=on`; (5) redesplegar `caos-live` (LE.3.1). Falta la mitad Kepler de LE.4.4 | Claude |
