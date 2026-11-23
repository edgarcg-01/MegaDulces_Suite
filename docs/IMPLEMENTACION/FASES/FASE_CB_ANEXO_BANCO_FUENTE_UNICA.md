# Fase CB · Anexo BFU — El estado de cuenta de la suite como verdad absoluta del banco

> Anexo de [`FASE_CB_CONCILIACION_BANCARIA.md`](FASE_CB_CONCILIACION_BANCARIA.md). Método:
> [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md). Pedidos de Edgar, 2026-11-19:
> 1. *«Necesito que le demos valor a `/finanzas/bancos?view=cuentas` y sea ahora nuestra fuente 100 % confiable
>    de bancos y dejar el workbook que se carga. Que se cubra todo lo que hace el Excel, y aun le demos un valor
>    agregado. Un trabajo bien hecho y por fases, plan y objetivos.»*
> 2. *«Si el Excel se va a dejar de llenar, ¿qué sentido tiene compararlo?»* → §3.1.
> 3. *«Nuestra hoja será la verdad absoluta. Revisa lo que existe y reestructuremos el plan si es necesario,
>    dándole el valor agregado y la verdad, toda la verdad, a este estado de cuenta.»* → este documento se
>    reestructuró alrededor de **qué tiene que cumplir el estado de cuenta para ser la verdad**; retirar el libro
>    deja de ser el objetivo y pasa a ser una consecuencia.

```
OBJETIVO: Que el estado de cuenta de cada cuenta en Bancos › Cuentas sea la verdad absoluta del banco:
          completo, de la cuenta correcta, exacto al saldo del banco, con cada peso explicado, cruzado
          contra Kepler y ContPAQi, trazable a su archivo y al día. Sin el libro de Tesorería.
MÉTRICA 1 (la verdad):  Cuentas cuyo estado de cuenta cumple las 7 propiedades (§2)
          HOY (2026-11-19): 0 de 18 → META: 17 de 18 (STDR 5565 por D5) para <fecha a firmar>
MÉTRICA 2 (toda la verdad): Pesos del estado de cuenta explicados (§2, propiedad 4)
          HOY (medido con la función real, BFU.2.9): oct-2026 (libro) 93.3 % explicado, 82.2 % con documento de Kepler;
          nov-2026 (descarga, sólo con el texto del banco) 10.9 % — el documento de Kepler llega al pasar la cuenta (E3)
          → META: 100 % explicado o declarado «sin explicar» con dueño, cada mes cerrado
MÉTRICA 3 (al día): Días de atraso del estado de cuenta
          HOY: Cuentas muestra el libro, al 10-nov (9 días) → META: ≤ 1 día hábil en todas
CAPA TOPE: C3
ÁREA:      Finanzas (Tesorería)
DUEÑO:     Edgar (PM) · desarrollo: <por asignar>
ESTADO:    ⬜ propuesta — CB está entregada; reabrirla suma una fase 🔨 con el cupo excedido (8 de 4)
```

**Con qué se midió:** `pg-prod`, `system_identifier` 7688376744939610156, sólo lectura
(`default_transaction_read_only=on`), el 2026-11-19 entre 10:00 y 11:00. Las pantallas, con Playwright
contra prod en sólo lectura (escrituras bloqueadas): Cuentas, Estados de cuenta y Cuadre 3 vías. El código,
en `main` del mismo día, más tres inventarios (importador del libro, lectores de las tablas, descarga).

---

## 1. Lo que existe hoy — revisado

### 1.1 Las pantallas, vistas en vivo (2026-11-19)

| Pantalla | Qué dice | ¿Es verdad? |
|---|---|---|
| **Cuentas** (`view=cuentas`) | «cuadran 16 · 1 sin saldo»; Δ $0.00 en cada cuenta | ⛔ **No.** «Cuadra» sólo comprueba la aritmética del propio libro (inicial + depósitos − retiros = final del libro). Los datos llegan al **10-nov** y la tabla no lo dice: BBVA 6721 muestra **$0 de retiros en noviembre** y su banco trae unos $3.2 M. El único aviso es «libro importado hace 8 d» en el encabezado de la página |
| **Estados de cuenta** (`view=estados`) | Subidas hoy 16 de 18 · **cuadran 14 de 17** · **19 archivos sin testigo** · botón «Usar el banco en las 14 que cuadran» | ✅ Es la única que mira el banco de verdad. Dice de sí misma: *«todavía no alimenta Movimientos ni la conciliación»* |
| **Cuadre 3 vías** | Banco contra Kepler contra ContPAQi | 🟡 El «Banco» es la descarga en 14 cuentas y el libro en 3 (CB.85). Auditado hoy: CB.87–89 corrigen rótulos y una fecha que se generalizaba (sin soltar) |
| **Movimientos** (ventana) | El libro, más la descarga que el libro no tiene, sombreada | 🟡 La descarga se ve pero no se clasifica ni se concilia hasta pasar la cuenta |

⭐ **Lo que dice:** la pantalla que Edgar quiere como verdad es hoy la menos cierta de las cuatro, y la más
cierta (Estados de cuenta) está escondida detrás de una pestaña de carga.

### 1.2 El dato, medido

| Hecho (2026-11-19) | Valor |
|---|---|
| Último día del libro | 10-nov (última carga ese día) |
| Cuentas cuya fuente ya es la descarga (`statement_source_since`) | **0 de 18** |
| Archivos de descarga cuyo saldo se encadena solo (`balance_ok`) | **100 de 100** |
| Archivos cuya **cuenta** está comprobada | 81 de 100 (17 por número en el archivo, 64 por saldo); **19 sin testigo** (BBVA y BanBajío no traen el número de cuenta) |
| Renglones de descarga de noviembre | 3,162; con referencia del banco **94 %**; con contraparte **< 1 %** |
| Oct-2026 (libro, $157.1 M de flujo bancario): pesos con documento de Kepler | **82.2 %** |
| … con categoría | 97.8 % |
| … con sucursal | **59.1 %** |
| … sin documento y sin categoría | 1.35 % |
| Renglones del libro que «Usar el banco» reemplazaría hoy | 1,591: **0** con trabajo manual, **34** con un pago del calendario ligado, 1,269 con pareo del motor |
| Conciliación por evento (`bank_recon_aviso`) | **encendida** (último latido hoy 10:32) |

### 1.3 La maquinaria que ya está en prod (y nadie ha usado)

CB.56 (la descarga y sus lectores por banco) · CB.60b («Usar el banco», cuenta por cuenta) · CB.63 (lo que falta
subir hoy) · CB.64 (la descarga dentro de Movimientos) · CB.65 (categoría por el texto del banco: **94.2 %**,
placebo 62.2 %) · CB.73 (cuadre por saldos) · CB.75 (el encabezado del mes se deriva de los movimientos) · CB.53
(conciliación por evento). **El trabajo no es construir otra fuente: es terminar el cambio, probarlo y hacer que la
pantalla diga la verdad.**

---

## 2. Qué significa «verdad absoluta» para un estado de cuenta

Siete propiedades. **Cada una tiene un testigo independiente** (ADR-059: la cifra se arbitra contra un
testigo, nunca contra sí misma) y una forma de declararse cuando no se cumple (ADR-056). Una cuenta es
«verdad» sólo si cumple las siete; si no, la pantalla dice **cuál le falta**, no «cuadra».

| # | Propiedad | Qué exige | Testigo | HOY (2026-11-19) | Cómo se declara si falla |
|---|---|---|---|---|---|
| **1** | **Completo** | Todos los días de la cuenta, sin hueco: cada archivo abre en el saldo con que cerró el anterior | El **banco** (su propio saldo encadenado) | 14 de 18 cuentas | «falta del dd/mm al dd/mm: baja ese archivo» |
| **2** | **De la cuenta correcta** | Cada archivo probado de qué cuenta es | Número de cuenta en el archivo, o continuidad de saldo con la cuenta | **19 archivos sin testigo** | «sin comprobar la cuenta», y no cuenta para la propiedad 1 |
| **3** | **Exacto** | El saldo de la suite, al cierre de cada día, es el del banco | El saldo de la última línea del banco de ese día | Cuentas muestra el libro (al 10-nov) | «saldo del libro al dd/mm», nunca «cuadra» |
| **4** | **Explicado** — *toda la verdad* | Cada peso con su porqué: documento de Kepler, categoría con evidencia, sucursal, contraparte | El documento de Kepler casado; si no hay, la regla y el texto del banco que la disparó | 82.2 % de los pesos con documento (oct, libro) | El renglón cae en «sin explicar», con dueño, y suma a la cifra de lo que falta |
| **5** | **Cruzado** | Banco, Kepler y ContPAQi comparados por cuenta y día; cada diferencia con su motivo | Kepler (`kdm1`) y ContPAQi (pólizas) | Existe en el Cuadre 3 vías, no en la cuenta | La diferencia con su motivo (captura pendiente, cheque en tránsito, sin pareja) |
| **6** | **Trazable** | De cada renglón: archivo, línea cruda, quién lo subió y cuándo; nada se borra | `bank_statement_files` (huella `file_sha1`) y `raw_line`; sin permiso de borrar | Existe para la descarga | — |
| **7** | **Al día** | Hasta el día hábil anterior | El calendario de días hábiles | 9 días de atraso en Cuentas | «al dd/mm, faltan N días» |

**Lo que el estado de cuenta NO puede afirmar** y por eso se declara en pantalla: dos renglones que falten y
se anulen entre sí (una entrada y una salida iguales) no rompen la cadena de saldos. Es el mismo límite del
estado de cuenta del banco.

⭐ **El valor agregado está en la propiedad 4.** El estado de cuenta del banco dice cuánto entró y salió; el
de la suite dice además **de quién, por qué, de qué sucursal, con qué documento y qué póliza**, y dice qué
todavía no sabe. Eso no lo da ni el banco ni el libro.

---

## 3. Qué hace el libro hoy y quién lo reemplaza

| # | Lo que hace el libro | ¿Copia o trabajo humano? | Lo reemplaza | Propiedad |
|---|---|---|---|---|
| L1 | Fecha, concepto, retiro, depósito, saldo | Copia transcrita | La descarga (CB.56, CB.73) | 1, 3, 6 |
| L2 | Saldo inicial y final del mes (lo que pinta Cuentas) | Copia | Encabezado derivado (CB.75, en prod) | 3 |
| L3 | **M** — tipo de flujo (I, G, C, TI, TE, DS…) | **Humano** | Se deriva (BFU.2.1) | 4 |
| L4 | **C** — código propio de Tesorería | **Humano** (no es cuenta contable, VERDAD §37.2) | La categoría con evidencia (BFU.2.2–2.3) | 4 |
| L5 | **S** — sucursal | **Humano** | Documento de Kepler → catálogo de llaves → bandeja (BFU.2.4) | 4 |
| L6 | Hoja CAJA GENERAL | Humano, no es banco | **Fuera**: fase LE | — |
| L7 | Hoja FACTORAJE | Humano | D4 (sin renglones desde agosto) | — |
| L8 | Hojas derivadas: CONCENTRADO, RESUMEN DE SALDOS, MOVIMIENTOS GENERAL, POR IDENTIFICAR | Derivado | Concentrado, Cuentas, Movimientos, la bandeja «sin explicar» | a verificar con Tesorería (BFU.1.5) |

### 3.1 El libro no es testigo: se usa una vez y se suelta

Edgar, 2026-11-19: *«si el Excel se va a dejar de llenar, ¿qué sentido tiene compararlo?»*. Ninguno, en
adelante. El libro se usa **una sola vez**, en tres papeles que terminan al pasar la cuenta:

| Papel | Para qué | Cuándo termina |
|---|---|---|
| Hoja de respuestas | Medir si el motor acierta tipo y sucursal en los días con libro y descarga (1–10 nov). La categoría ya se midió así (CB.65) | Al publicar el acierto de BFU.2.1 y BFU.2.4 |
| Semilla | Sembrar el catálogo de sucursales con diez meses de asignaciones de Tesorería | Al sembrar |
| Saldo de arranque | El primer archivo de la descarga abre en el saldo con que cerró el libro (CB.73) | Al pasar la cuenta |

Los testigos permanentes son los de §2: **el banco, Kepler y ContPAQi**. Ningún item compara contra el
libro después de E3.

---

## 4. Lo que creíamos y cayó

| # | Lo que se decía | Lo que midió prod |
|---|---|---|
| 1 | «Cuentas cuadra» | Cuadra la aritmética del libro consigo mismo, con datos al 10-nov |
| 2 | «Para dejar el libro hay que construir la otra fuente» | Ya está en prod desde el 11–17 de noviembre; falta usarla |
| 3 | «Cambiar de fuente pierde conciliación» | 0 renglones con trabajo manual; 1,269 pareos del motor se re-hacen solos; se rompen **34 pagos ligados** (BFU.2.5) |
| 4 | «La conciliación por evento está apagada» | Encendida |
| 5 | «Un archivo cuadrado es de la cuenta que se eligió» | 19 de 100 archivos no tienen cómo probarlo |

---

## 5. Decisiones a firmar

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **D1** ✅ firmada por Edgar, 2026-11-19 («hagámoslo») | Desde cuándo manda el banco en cada cuenta | (a) desde el primer día de su descarga, si cumple las propiedades 1 y 2 · (b) desde el 1-dic | **(a)**: noviembre queda del banco. Las que cumplen pasan juntas, fuera de horario |
| **D2** | La historia enero–octubre | (a) se queda del libro, congelada y **rotulada «libro»** · (b) se reemplaza con descargas | **(a)**: reemplazar re-hace conciliaciones y pagos cerrados; compararla no cambia ninguna decisión. Cuentas la muestra como «libro», nunca como banco |
| **D3** | M y C dejan de capturarse | (a) se derivan · (b) Tesorería los pone en la suite | **(a)**; lo que el motor no identifica va a «sin explicar», no se inventa |
| **D4** | Caja General y Factoraje | Caja General → LE. Factoraje: (a) captura en la suite · (b) se inactiva | Caja General fuera. Factoraje: **preguntar a Tesorería** |
| **D5** | STDR 5565 (sin descarga; libro al 3-ago) | (a) se baja su descarga · (b) se inactiva | Preguntar a Tesorería; si no se mueve, **(b)** |
| **D6** | Quién sube la descarga cada día y a qué hora | Persona y hora límite | Edgar con Tesorería |
| **D7** | Descarga automática del banco | Contrato por banco | **Fuera de esta fase** |
| **D8** | Qué cuenta como «explicado» (propiedad 4) | (a) documento de Kepler, o categoría con evidencia (regla o texto del banco que la disparó) · (b) sólo documento de Kepler | **(a)**, pero «depósito sin otra señal = cobranza» **no** cuenta como explicado hasta identificar al cliente: es el piso del placebo (62 %) |
| **D9** | Un archivo sin testigo de cuenta (19 hoy) | (a) no cuenta para «completo» hasta comprobarse por saldo · (b) se acepta con confirmación de quien sube | **(a)**: hoy se aceptan con un clic; una cuenta equivocada contamina dos estados de cuenta |
| **D11** (Claude, 2026-11-20; Edgar: «sigue con lo tuyo», sin firma explícita) | De dónde sale la categoría de un movimiento del banco | (a) de la cuenta contable de Kepler del documento que liquida · (b) se pregunta por acreedor | **(a)**: es la contabilidad real y Kepler es el árbitro; el catálogo se completa con los mayores de Kepler (15 categorías nuevas). Control 93.6 % contra el libro, placebo 36.4 % |
| **D12** (ídem) | Kepler registró el pago en otra cuenta de banco | (a) la categoría sale del documento igual · (b) motivo para Tesorería | **(b)** en el motor de hoy (no se casa por cuenta ajena); BFU.7.5 decide si además da la categoría |
| **D13** (ídem) | Plazo para «Kepler todavía no lo tiene» | días hábiles | **5** (mediana de captura 2–5, CB.53); después el motivo pasa al área dueña |
| **D10** ✅ Edgar, 2026-11-19 («ya no se vuelve a usar workbook») | El libro CUENTAS ¿se sigue cargando mientras pasan las cuentas? | — | **No se vuelve a cargar.** La subida y la sincronización de Sheets se niegan desde ya (BFU.5.1); las cuentas que todavía no cuadran quedan con su libro al 10-nov hasta que su descarga se complete y pasen |

---

## 6. Qué NO incluye

Caja General (fase LE) · reescribir enero–octubre (D2) · la conexión automática con los bancos (D7) ·
escribir en Kepler o ContPAQi · borrar el importador o sus tablas (se **apagan**; regla 5) · guardar
credenciales de banca en línea.

---

## 7. Las etapas

| Etapa | Objetivo | Propiedades | Sale cuando |
|---|---|---|---|
| **E0 · Que Cuentas deje de afirmar lo que no es** (C3, días) | La pantalla dice de dónde sale cada saldo y hasta qué día; «cuadra» desaparece donde sólo cuadra el libro | 3, 7 (declaradas) | Ninguna cuenta dice «cuadra» sin decir «libro al dd/mm» o «banco al dd/mm» |
| **E1 · La verdad definida y la descarga completa** (C0) | VERDAD §39 escrita; las cuentas completas y de la cuenta correcta | 1, 2, 6 | 17 de 18 cumplen 1 y 2 |
| **E2 · Toda la verdad: cada peso explicado** (C1) | Tipo, categoría, sucursal y contraparte derivados con evidencia; lo demás, declarado | 4 | Acierto publicado con control placebo; los 34 pagos re-ligados en prueba |
| **E3 · Pasar las cuentas** (C2) | El banco manda en `bank_movements` | 3, 7 | Antes/después publicado; conciliación re-hecha en 48 h |
| **E4 · El estado de cuenta de la suite** (C3) | La pantalla que es la verdad: día por día, cada peso con su porqué, las 7 propiedades a la vista | 1–7 | Cumple §2 en las cuentas pasadas, en la pantalla viva |
| **E5 · Apagar el libro** (C2–C3) | Sin carga, sin sincronización, sin respaldo «libro» en el Cuadre | — | Ninguna cuenta lo usa |
| **E6 · Valor agregado** (C1–C3) | Lo que ni el banco ni el libro daban | 4, 5 | Cada item con su medición |

---

## 8. Los items

### E0 · C3 — Que Cuentas deje de afirmar lo que no es

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| BFU.0.1 | 🔴 **Cada fila de Cuentas dice su fuente y su último día**: «Banco al dd/mm» o «Libro al dd/mm», en texto. «Cuadra» se cambia por lo que de verdad se comprobó: «el libro cierra consigo mismo» (libro) o «el saldo del banco sigue» (banco) | ⬜ | Pantalla viva: BBVA 6721 dice «Libro al 10/11», ninguna fila dice «cuadra» a secas |
| BFU.0.2 | Cuentas enlaza a Estados de cuenta cuando una cuenta ya puede usar el banco («14 pueden usar el banco») | ⬜ | Pantalla viva |

### E1 · C0 — La verdad definida y la descarga completa

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| BFU.1.1 | **VERDAD_ABSOLUTA §39 «El estado de cuenta del banco»**: las 7 propiedades, su testigo, qué se declara, qué NO se puede afirmar, y el papel único del libro (§3.1) | ⬜ | Revisado por un escéptico antes de publicarse |
| BFU.1.2 | **Cerrar los huecos**: STDR 1604 (3–10 nov), STDR 2169 (11–18 nov), BB 3660 (abre en otro saldo; el libro quedó en el 31-jul), STDR 1621 (un solo día) | ⬜ | `GET statement-files/cuadre` dice «cuadra»; testigo: el saldo del banco |
| BFU.1.3 | **Comprobar la cuenta de los 19 archivos sin testigo** por continuidad de saldo con otros archivos ya probados; si no se puede, no cuentan para «completo» (D9) | ⬜ | Por archivo: «por saldo» o «sin comprobar»; prueba con un archivo asignado a la cuenta equivocada → rojo |
| BFU.1.4 | **D4, D5**: Factoraje y STDR 5565, vivas o inactivas | ⬜ | Respuesta de Tesorería escrita en la nota de la cuenta |
| BFU.1.5 | **Verificar con Tesorería el inventario §3** (qué hoja derivada usan y para qué) | ⬜ | Respuestas escritas aquí; lo que no tenga equivalente se vuelve item |
| BFU.1.6 | **Ritmo de subida**: por cuenta, días hábiles con archivo al día siguiente; calendario de días festivos para «falta subir» | ⬜ | `bank_statement_files.created_at` contra `date_to`; meta ≥ 95 % |

### E2 · C1 — Toda la verdad: cada peso explicado

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| BFU.2.1 | **El tipo (M) se deriva**: dirección; **traspaso propio** cuando otra cuenta propia tiene el movimiento contrario del mismo importe y día; devolución SPEI por concepto | ⬜ | Acierto contra el M del libro (1–10 nov, una vez), con control placebo; mutantes |
| BFU.2.2 | **El control de traspasos (TI = TE) no depende de `raw_type`** (`finance-bank.service.ts:1345-1349`: hoy los renglones del banco se caen en silencio) | ⬜ | Prueba con una cuenta que usa el banco y un traspaso propio |
| BFU.2.3 | **Los lectores de `raw_code`/`raw_type` pasan a la categoría**: `contpaqi/beneficiario.ts`, `contracts/.../salida-proveedor.contract.ts`, `payment-calendar/fuera-de-programa.sql.ts` | ⬜ | Por lector, el mismo resultado sobre octubre (antes/después) |
| BFU.2.4 | **La sucursal**: la del documento de Kepler; si no, el catálogo de llaves **sembrado con el libro** (sólo llaves que no se contradicen); si no, vacía y a «sin explicar» | ⬜ | Acierto contra la S del libro (una vez), con placebo; llave contradictoria no entra |
| BFU.2.5 | **Re-ligar al pasar la cuenta** lo que apunta al renglón del libro: `payment_allocations.paid_bank_movement_id` (34 hoy) y, por las dudas, `pago_confirmaciones`, `customer_*`, categoría manual, `bank_capture_inbox` | ⬜ | Base real: un pago ligado queda ligado al renglón del banco; mutante sin re-ligar → rojo |
| BFU.2.6 | **El motor no borra pareos de personas** (`recon-escritura.ts:94-95`, `planEscritura`) | ⬜ | Base real con un pareo humano que el motor no reproduce |
| BFU.2.7 | **Categoría por documento, por evento** (CB.66): al casar un movimiento del banco sin categoría, toma la del documento; nunca pisa una manual | ⬜ | Los «sin categoría» bajan al llegar los documentos |
| BFU.2.8 | **La explicación de cada renglón, en un solo lugar** (función pura en `libs/finance`): documento de Kepler, categoría y su evidencia, sucursal y su origen, contraparte y referencia, póliza de ContPAQi, pago del calendario, comprobante; y si no hay, «sin explicar» con el porqué | ⬜ | Spec con un caso por fuente de explicación + el caso vacío; es lo que leen E4 y la cifra de la métrica 2 |
| BFU.2.9 | **Medir la métrica 2 sobre la descarga** (hoy NO MEDIDA): pesos explicados por cuenta y mes con BFU.2.8 | ⬜ | Cruce contra el 82.2 % del libro de octubre (mismo criterio D8) |
| BFU.2.10 | 🧪 2026-11-20 **Al casar con Kepler, la categoría sale del documento** (el motor, en su transacción; `classified_by = 'documento'`, sigue al pareo). Corrige «GN… = nómina»: la nómina sale del nombre congelado (NOMINA), no del prefijo | 🧪 | Bloque [15] de `test-newdb-bank-estado-de-cuenta.js` + antes/después en prod |
| BFU.2.11 | ⬜ La categoría de un acreedor de gasto (G…) y de un pago del Calendario, como parámetro que se contesta una vez (28 + 40 en noviembre) | ⬜ | Antes/después en prod |
| BFU.2.12 | ⬜ El motor no casa los cheques de nómina que Kepler sí tiene (10 en noviembre) | ⬜ | Prueba del pase |

### E3 · C2 — Pasar las cuentas

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| BFU.3.1 | **Ensayo en seco** para las que cumplen 1 y 2: qué se reemplaza, qué se re-liga, qué queda sin explicar, por cuenta | ✅ 2026-11-19 | no | Sólo lectura, con la función real |
| BFU.3.2 | **Pasar las cuentas**, fuera de horario, con antes/después de Cuentas, Cuadre 3 vías, Conciliación y Cierre. Hecho el 2026-11-19 19:02: 15 cuentas, 1,541 renglones del libro reemplazados, 0 ligas colgando; BB 3660, STDR 1604 y STDR 5565 no cuadran y siguen con el libro | ✅ 2026-11-19 | **sí** (`POST statement-files/usar-el-banco`, existente) | Su prueba existe (CB.60b/73) + la de BFU.2.5 |
| BFU.3.4 | 🧪 **El mismo renglón no entra dos veces aunque el banco le cambie el concepto** (hallazgo de BFU.3.2: 18 depósitos repetidos en BBVA 4176 y 6586, BBVA completó su referencia en la descarga siguiente). Huella día+cargo+abono+saldo, el cuadre no cuadra con repetidos, el saldo inicial sale de los dos primeros días (BBVA 5712); migración que quita los 18, ensayada en prod con ROLLBACK | 🧪 | **sí** (migración de datos) | Bloque [14] de `test-newdb-bank-estado-de-cuenta.js` + ensayo ROLLBACK en prod |
| BFU.3.3 | **48 h después**: la conciliación re-casó, los saldos son los del banco, nada quedó en cero por defecto | ⬜ | no | Comparación publicada aquí |

### E4 · C3 — El estado de cuenta de la suite

Cargar la skill `diseno` antes del primer archivo; las 🔴 de §11 son criterios de este bloque.

| # | Item | Estado | `check:pantalla` |
|---|---|---|---|
| BFU.4.1 | **Cuentas: una fila por cuenta con las 7 propiedades** — saldo del banco al último día, «al dd/mm», completo o qué falta subir, cuenta comprobada, % explicado, diferencia contra Kepler y ContPAQi. Cada número abre su lista | ⬜ | sin fallas nuevas |
| BFU.4.2 | **El estado de cuenta de una cuenta**, día por día: saldo de apertura y cierre del banco, cada movimiento con su explicación (BFU.2.8) y su fuente (archivo, línea, quién lo subió), y lo que falta explicar arriba | ⬜ | |
| BFU.4.3 | **«Sin explicar» como bandeja con dueño**: por cuenta, lo que no tiene documento, categoría con evidencia o sucursal; se resuelve ahí | ⬜ | |
| BFU.4.4 | **Exportar el estado de cuenta explicado** (Excel y PDF): el del banco más el porqué de cada peso, con las propiedades del mes en el encabezado | ⬜ | |
| BFU.4.5 | **Aviso a quien sube** (D6): a la hora límite, qué cuenta no tiene el archivo de ayer y desde qué día bajarlo | ⬜ | |
| BFU.4.5 | ⬜ **Cada área ve y reconoce sus movimientos del banco para conciliarlos en Kepler** (Edgar, 2026-11-20). Lo que no tiene documento le llega al área dueña (del Calendario, del acreedor, o asignada por Tesorería con un clic); el área lo captura en Kepler y el motor casa solo. Primero Compras, RH y Tesorería; falta quién en cada una | ⬜ | Permiso repartido en prod + pantalla viva |

### E5 · C2–C3 — Apagar el libro

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| BFU.5.1 | ✅ en prod 2026-11-19 (D10) **El libro ya no entra**: `POST finance/bank/import` y `POST sheet-sync/run` se niegan con «súbela en Estados de cuenta» (`libro-retirado.ts`); el cron de Sheets no corre aunque se encienda la variable; los botones «Subir libro» y «Sincronizar» se fueron de Estados de cuenta; el pendiente «sin movimientos» del Cierre lleva a Estados de cuenta. El importador del servicio queda (las pruebas contra base real lo usan) | 🧪 | Prueba: subir y sincronizar se niegan (mutante sin la negativa → rojo) |
| BFU.5.2 | Se apaga `sheet-sync` y se retira el importador de línea de comandos | ⬜ | Sin lectores; regla principal del repo |
| BFU.5.3 | El Cuadre 3 vías deja el respaldo «libro» (CB.85) | ⬜ | Cuadre de noviembre idéntico antes/después |
| BFU.5.4 | ADR: «el banco es la fuente de `bank_movements`; el libro queda como historia hasta oct-2026» | ⬜ | ADR escrito |

### E6 · Valor agregado

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| BFU.6.1 | **Identificar depósitos por referencia y RFC** (los trae la descarga) contra clientes de Kepler, como propuesta que alguien confirma | ⬜ | Acierto contra depósitos ya identificados, con placebo |
| BFU.6.2 | **Saldo diario consolidado** de todas las cuentas, del banco, para flujo de efectivo | ⬜ | Contra la suma de cierres del banco |
| BFU.6.3 | **Reporte equivalente al CONCENTRADO / RESUMEN DE SALDOS**, para que Tesorería no extrañe su hoja | ⬜ | Lo valida Tesorería |
| BFU.6.4 | **Alertas de la verdad**: un saldo que salta, un archivo de otra cuenta, un retiro grande sin explicar en 24 h | ⬜ | Cada alerta con su prueba negativa |

---

### E7 · C0–C3 — El motor de categoría (Edgar, 2026-11-20: «no necesito parches, necesito un motor que cubra el 100 %, y lo que no podamos cubrir, revisar por qué»)

Cada movimiento de la descarga tiene **categoría con su evidencia, o un motivo de lista cerrada con responsable**: cobertura = categorizados + con motivo = 100 %. Las fuentes, en orden: manual > IVA/comisión por el texto del banco > documento de Kepler (su cuenta contable, por el pareo o por el Calendario; pases débiles no deciden) > texto del banco y reglas > depósito. Corre dentro de la conciliación, por evento. Sustituye a BFU.2.10–2.12.

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| BFU.7.1 | C0 · Mapeo cuenta de Kepler → categoría (`finance.category_kepler_accounts`, prefijo más largo; 15 categorías nuevas con el nombre del mayor en `kdc126`) | ✅ | Libro ago–oct: 93.6 % de 3,994; placebo 36.4 % |
| BFU.7.2 | C0 · La evidencia de cada retiro: pareo → `kdxf` → documento, o Calendario → `kepler_payable` → documento; compra = 511, gasto = renglones `kdm6` con cuenta y departamento | ✅ | Noviembre entero en 362 ms |
| BFU.7.3 | C1 · El motor puro y los motivos (`motor-de-categoria.ts`) | ✅ | 13 pruebas, una por fuente y por motivo; mutantes |
| BFU.7.4 | C1 · El motor en la conciliación, dueño de la categoría de la descarga, escribe sólo lo que cambió | ✅ | Bloque [15] contra base real; antes/después de noviembre en prod |
| BFU.7.5 | C1 · Lo que la conciliación no casa y Kepler sí tiene: el candado anti doble-cobro sólo aparta lo que la corrida que reclamó alcanzaba (mes ±45 días) | 🧪 | 100 % de 50,993 pareos dentro de la ventana; se liberan 465 documentos de octubre y 206 de noviembre, 0 con sucursal |
| BFU.7.6 | C2 · La cobertura en `diagnostico`: con categoría + por motivo y responsable = total | 🧪 | Suma igual al total del mes |
| BFU.7.7 | C3 · Bancos: «N por resolver», por qué y de quién (con BFU.4.5) | ⬜ | Pantalla viva + `diseno` §0b |
| BFU.7.8 | C1 · El vocabulario del banco: las abreviaturas de comisión de BBVA | ✅ | Su IVA del 16 % el mismo día, al centavo |

## 9. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Cuatro cuentas incompletas o sin descarga | Tesorería (persona: **por confirmar**; hoy sube carmen_rodriguez) | Faltan archivos de días puntuales; 5565 nunca se bajó | BFU.1.2 |
| Cuentas muestra el libro como si fuera el banco | Desarrollo | Diseño previo a la descarga | BFU.0.1 (días) |
| Nadie pasa las cuentas | Edgar | Requiere `FINANCE_BANK_GESTIONAR` y la firma de D1 | D1 |
| Cupo de fases (8 de 4) | Edgar | Política del método | Pausar una fase o abrir ésta por encima del cupo, por escrito |

**Riesgos técnicos:** los 34 pagos ligados (BFU.2.5); el control de traspasos que depende de `raw_type`
(BFU.2.2); Santander, cuyo texto dice poco (STDR 2169 tenía la mitad sin categoría); los 19 archivos sin testigo
(BFU.1.3); el límite de dos renglones que se anulan (declarado).

---

## 10. Definición de Terminado

- [ ] 1. Las tres métricas remedidas, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA**
- [ ] 3. Todo endpoint que escribe ejercido contra base real con el payload de la pantalla
- [ ] 4. Toda compuerta nueva rota a propósito una vez
- [ ] 5. La explicación de un renglón (BFU.2.8) en `libs/` y usada por pantalla, export y métrica
- [ ] 6. Tracker, `03_LOG_REVISIONES.md`, roadmap de `CLAUDE.md` y VERDAD §39 al día
- [ ] 7. En prod, o escrito qué falta

---

## 11. Observaciones de diseño UI — revisión del plan (2026-11-19)

Nivel A en lo que existe (Cuentas, Estados de cuenta y Cuadre 3 vías vistos en vivo); nivel C en lo que se
propone. Severidad: 🔴 bloquea pasar C3 a 🚀 · 🟠 dentro de la fase · 🟡 mejora.

**La prueba de la frase:** *«¿El saldo de cada cuenta es el del banco, está completo y sé de dónde viene
cada peso?»* — una pregunta (las tres partes son la misma: ¿puedo creerle?).
**Jerarquía:** primario = el saldo del banco y si es verdad (las propiedades); secundario = hasta qué día y qué
falta; terciario = el detalle de cada movimiento.

| # | Sev | Observación y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| BFU.UI.1 | 🔴 | Cuentas dice «cuadran 16» con el libro al 10-nov; BBVA 6721 muestra $0 de retiros cuando el banco trae $3.2 M | Veracidad (ley 0) | Ninguna fila dice «cuadra» sin su fuente y su día |
| BFU.UI.2 | 🔴 | Una cuenta sin archivo de ayer se ve igual que una al día | Datos añejos (§10) | «falta subir desde el dd/mm», en texto |
| BFU.UI.3 | 🔴 | Un archivo sin testigo de cuenta se acepta con un clic y nada lo vuelve a mirar | Veracidad | La fila de la cuenta dice «N archivos sin comprobar» y no se da por completa |
| BFU.UI.4 | 🟠 | Lo que falta subir vive en Estados de cuenta y el Cierre; lo que falta explicar, en Movimientos | Una sola interfaz por flujo | Las dos cuentas de pendientes en la fila de Cuentas; cada número abre su lista |
| BFU.UI.5 | 🟠 | En el Cuadre 3 vías el rojo contradice el veredicto (51 rojos con «captura pendiente») | Color al servicio del entendimiento | En Cuentas el rojo sólo para lo que rompe una propiedad |
| BFU.UI.6 | 🟠 | «Explicado» es un porcentaje que puede inflarse con el piso de «depósito = cobranza» (62 % al azar) | Veracidad (D8) | La cifra excluye esos renglones y lo dice |
| BFU.UI.7 | 🟡 | Caja General y Factoraje salen en Cuentas como «sin saldo» | Qué NO debe ver | Fuera de la tabla de bancos |

---

## 12. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-19 | Pedido de Edgar; inventario del libro, de sus lectores y de la descarga; medición en prod; plan propuesto (⬜) | Claude, para Edgar |
| 2026-11-19 | «¿Qué sentido tiene compararlo?»: el libro deja de ser testigo (§3.1); se retira la verificación de octubre | Edgar / Claude |
| 2026-11-19 | E0 (BFU.0.1–0.2), E1 (BFU.1.1 VERDAD §39, BFU.1.3 la cadena) y E2 (BFU.2.5 religar, BFU.2.8–2.9 la explicación y su cifra) en código, sin soltar. Medido: «explicado» oct 93.3 % (libro), nov 10.9 % sólo con el texto del banco: lo que mueve la cifra es pasar las cuentas (E3) | Claude |
| 2026-11-19 | «Nuestra hoja será la verdad absoluta»: se revisaron en vivo Cuentas, Estados de cuenta y el Cuadre; el plan se reestructura alrededor de las 7 propiedades (§2); entra E0 (Cuentas deja de afirmar lo que no es) y E4 (el estado de cuenta explicado) | Edgar / Claude |
| 2026-11-19 | BFU.5.1 en prod (el libro ya no entra). E3: 15 cuentas pasadas al banco a las 19:02; 0 ligas colgando; 3 cuentas no cuadran y siguen con el libro | Edgar (autorizó) / Claude |
| 2026-11-20 | Hallazgo tras E3: 18 depósitos repetidos (BBVA completó la referencia entre descargas) y el saldo inicial de BBVA 5712 mal derivado → BFU.3.4 (código + migración ensayada con ROLLBACK). Edgar autorizó corregir los datos | Edgar / Claude |
| 2026-11-20 | «¿Por qué no podemos clasificar estos 265?»: todos retiros; 145 ya casados con Kepler sin categoría (el motor no la escribía), 40 del Calendario, 65 sin documento. BFU.2.10 en código; BFU.2.11, 2.12 y 4.5 (cada área reconoce sus movimientos) planeados. Edgar: «hagámoslo» | Edgar / Claude |
| 2026-11-20 | «No necesito parches, necesito un motor que cubra el 100 %»: E7. La cuenta contable de Kepler (pareo o Calendario → documento → `kdm6`) da la categoría (93.6 % contra el libro, placebo 36.4 %) y el departamento; lo que no, un motivo con responsable. BFU.7.1–7.4 en código; BFU.2.11 y 2.12 sustituidos | Edgar / Claude |
| 2026-11-20 | El motor (BFU.7.1–7.4) en prod y medido: en noviembre, sin categoría 143 → 78, todos con motivo y responsable; 1,639 renglones con la categoría de su documento de Kepler. BFU.7.8: las comisiones abreviadas de BBVA, con su IVA como testigo | Claude |
| 2026-11-23 | BFU.7.5: los cheques de nómina SÍ están en Kepler; los apartaba el candado anti doble-cobro con pareos de enero sin sucursal (los folios se reiniciaron con el corte del 1-oct). Una reclamación ya sólo aparta lo que su corrida alcanzaba: se liberan 465 documentos de octubre y 206 de noviembre | Claude |
| 2026-11-23 | BFU.7.6: el diagnóstico de Bancos da la cobertura del motor (con categoría + por motivo y responsable + sin motivo), «todavía no» recalculado al leer y la suma contrastada contra un conteo aparte. Falta la pantalla (BFU.7.7) | Claude |
