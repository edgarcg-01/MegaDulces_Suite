# Caja General: plan de estabilización por capas (`CGP`)

> **2026-10-14 · propuesto · dueño: Edgar.**
>
> Este plan se armó desde una máquina **sin acceso a producción**. Lo único que se midió de prod es el
> `GET /api/health` público; todo lo demás sale del repo, de la doc de la fase y de tres auditorías de
> código (negocio, datos+lógica, pantalla). Lo que exige leer prod va marcado **NO MEDIDO**, con la
> consulta que lo mide.
>
> Usa el prefijo **`CGP-*`** a propósito: la numeración `CG.*` ya tiene números repetidos (`CG.98`,
> `CG.130` y `CG.160` significan dos cosas cada uno) y este plan no puede sumar más confusión.

---

## 0. Por qué hace falta este plan

- **Medido el 14-oct (~20:45):** producción sirve el commit **`303a4a632`**. El arreglo del corte trabado
  (**CG.160**: `e5a438abc` + `9e77b3ba5`) está en `main` y sellado por el CI (`ci-green` = `main`), pero
  **no está en `prod-release`**. Por eso las dos actualizaciones de hoy no destrabaron el corte.
  CG.160 no trae migraciones ni permisos.
- **El patrón:** entre el 12 y el 14-oct entraron **86 commits** de Caja General. Del 13 al 14 fueron
  **33 arreglos, 26 funciones nuevas y 2 pruebas**. Cada arreglo encontró el defecto siguiente:
  1. CG.152: el `INSERT` no mandaba `denom_key`.
  2. CG.155: eran *tres* caminos de escritura, no uno.
  3. CG.156: el veredicto no se guardaba.
  4. CG.157–159: el corte no se podía cerrar.
  5. CG.160: la pantalla no ofrecía cerrar, y el cierre medía otro universo que el conteo.
- **La causa común:** **ninguna prueba ejerce `abrir`/`contar`/`cerrar`/`autorizar` contra una base de
  datos.** Los arreglos se validaron con lógica pura y con servicios simulados (mocks), y los defectos
  vivían *entre* capas. Mientras eso siga así, cada arreglo destapa el siguiente en producción.
- **Objetivo del plan:** romper ese ciclo. Cada capa tiene un contrato y una prueba que lo ejerce, y
  **ninguna fase empieza sin la evidencia de la anterior**.

---

## 1. Qué hace Caja General

### 1.1 El negocio

- **Qué es:** la tesorería en efectivo del corporativo, de unos **$82M al año**. Recibe la cobranza de
  las rutas (95.5% de lo que entra) y paga mercancía a proveedores (66% de lo que sale), nómina y
  gastos, casi sin pasar por el banco (`FASE_CG_CIRCUITO_DEL_EFECTIVO.md`).
- **Decisión de fondo (ADR-070):** la Suite pasa a ser el sistema de registro y el Access «Control» se
  retira. Hasta el **sábado 10-oct** el libro era Control; **desde el 12-oct** es la Suite (`CG.126`).
- **Son dos cajas, no una:**
  - **El cajón:** el efectivo de oficina. Se cuenta a mano.
  - **La bóveda CAOS:** una máquina que recibe los depósitos y dispensa billetes. Publica los flujos,
    **nunca el saldo** (VERDAD_ABSOLUTA §28).

### 1.2 Actores

| Actor | Qué hace | Permiso |
|---|---|---|
| Capturista (27 personas) | Registra ingresos y gastos, conciliándolos contra un documento Kepler o un movimiento de CAOS | `FINANCE_CAJA_GESTIONAR` |
| Quien cuenta y cierra | Hace el arqueo **ciego** y cierra la jornada | `FINANCE_CAJA_GESTIONAR` |
| Quien autoriza | Segunda llave. La base exige `authorized_by ≠ closed_by` | `FINANCE_CAJA_AUTORIZAR` (dirección y superadmin) |
| Receptor de un gasto | Firma de conformidad en su teléfono por QR | ruta pública `/firmar` |

### 1.3 La jornada

```
abrir corte (borrador) ── fondo = contado del último corte cerrado
        │                  (si no hay: arqueo de Control → lo tecleado → null = sin_base)
        ▼
registrar movimientos ──── ingreso: el monto sale del conteo por denominación
        │                  gasto: el monto lo manda el documento Kepler
        │                  todos: par (cuenta, concepto) de Kepler + glosa + conciliación
        ▼
contar (CIEGO) ─────────── se sella el conteo por denominación; recién ahí se revela
        │                  el esperado y la diferencia
        ▼
cerrar ─────────────────── se atan a este corte los movimientos de SU jornada
        ▼
autorizar ──────────────── la firma otra persona
        ▼
la jornada siguiente hereda como fondo el contado de ésta
```

- **Esperado del cajón:** `fondo + ingresos − gastos + dispensado(CAOS) − depositado(CAOS)`.
- **Estados del corte:** `borrador` → `cerrado` → `autorizado`. **No existen** reabrir, anular, rechazar
  la autorización ni corregir el fondo de un corte abierto.

### 1.4 Reglas que no se negocian

1. **El cajón es UNO y ve todas las plazas.** `cash_ledger.sucursal` es la plaza del *documento*, no
   dónde estaba el efectivo (`CG.98`, `CG.160`).
2. **El corte cubre sólo su jornada.** Para el libro, la jornada se mide por `created_at`; para CAOS, por
   `accounting_date`.
3. **El arqueo es ciego:** primero se cuenta, después se ve el esperado. Un conteo sellado sólo cambia
   con `recontar()`, que exige motivo.
4. **Doble llave:** quien cierra no autoriza.
5. **La custodia que no es efectivo se arrastra, no se cuenta.** Los dólares (12,059 USD desde el
   2-abr) y los papeles ($20,782 desde el 2025-10-06) se repiten sin recontarse y no entran al fondo.
6. **No se inventa un conteo ni se dibuja un cero donde no se midió.**

### 1.5 Dónde vive

| Capa | Archivos |
|---|---|
| Datos | `finance.cash_ledger`, `_denominations`, `_sequences`, `cash_ledger_cuts`, `_cut_denominations`, `caos_cash_links`, `caos_ingreso_atribucion`, `caos_deposito_grano` (todas con RLS forzado) |
| Lógica | `libs/finance/src/lib/caja/`: `cash-cut.service.ts` (abrir 454 · contar 652 · recontar 689 · cerrar 746 · autorizar 895), `cash-cut.engine.ts` (puro), `cash-ledger.service.ts`, `cash-ledger.controller.ts` (`/finance/cash-ledger`) |
| Visual | `apps/view/src/app/modules/finanzas/pages/caja-general/finanzas-caja-general.component.ts` (~6,500 líneas), `caja-captura.util.ts`, `cash-ledger.service.ts` |

---

## 2. Diagnóstico por capa

Severidad:
- **P0:** dinero o control. Puede firmar un número falso.
- **P1:** bloquea la operación.
- **P2:** calidad.

### 2.1 Datos

| # | Hallazgo | Sev. |
|---|---|---|
| D1 | `cut_cerrado_completo_chk` sólo exige que los campos no sean `NULL`. No comprueba que `diferencia = contado − esperado` ni que `contado` sea la suma del desglose | P0 |
| D2 | `cash_cut_fondo_coherente_chk` deja pasar un fondo sin `fondo_origen`: la lógica de tres valores de SQL convierte el `NULL` en «pasa» | P2 |
| D3 | `ux_caos_atrib_cobro_vivo` es único por cobro, pero el motor reparte un cobro entre varios depósitos. El `23505` tumba toda la conciliación | P1 |
| D4 | `caos_atrib_orden_chk` compara `timestamptz::date`, así que depende de la zona horaria de la sesión | P2 |
| D5 | **NO MEDIDO:** `CC-2026-00001` nació con `fondo_inicial = 617,505.50` (el total de Control metido donde va el efectivo). Ningún camino del repo lo corrige; hay que leer prod | P0 |
| D6 | Nada impide dos cortes de la misma sucursal y fecha en momentos distintos: `abrir` no valida la fecha | P1 |
| D7 | `cash_ledger_cut_custody`, `_cut_vouchers` y `_route_links` existen y **ningún código escribe en ellas** | P2 |

### 2.2 Lógica

| # | Hallazgo | Sev. |
|---|---|---|
| L1 | **`cerrar()` usa el conteo tecleado en lugar del sellado y reescribe el desglose sellado, sin compararlos** (`cash-cut.service.ts:840-889`). El arqueo ciego se puede saltar sin `recontar()` y sin motivo | **P0** |
| L2 | **Lo firmado no es lo revelado.** `cerrar()` recalcula el esperado con el universo de ese momento y pisa el esperado y la diferencia que `contar()` reveló | **P0** |
| L3 | `recontar()` lee el desglose sin filtrar `momento` y no exige que exista un conteo sellado | P1 |
| L4 | `abrir`, `contar` y `cerrar` no son idempotentes. Un `23505` sale como 500 sin traducir | P1 |
| L5 | Fechas: `diaDe` usa `toISOString`, y `String(fecha_valor)` da «Tue Oct 13» en `crearLote` (rechaza la fila como futura) y en la conciliación de CAOS (no atribuye nada) | P1 |
| L6 | `catch {}` dentro de transacciones (`cash-ledger.service.ts:1575`, `:1638`) → `25P02`. `clasificarGranos` escribe sin fijar el tenant sobre una tabla con RLS forzado y se traga el error | P1 |
| L7 | `listar`, `abrir`, `cerrar` y `autorizar` devuelven filas crudas: el dinero llega como string y la fecha como `Date` | P2 |
| L8 | `evaluarArqueo` y `detail()` ignoran `flujo`: el cambio devuelto se **suma** en vez de restarse | P1 |
| L9 | La sucursal `'00'` está escrita a mano en 6 lugares | P2 |
| L10 | **Ningún sensor vigila un corte en borrador viejo.** Tres jornadas trabadas no dispararon ninguna alarma | P1 |

### 2.3 Visual

| # | Hallazgo | Sev. |
|---|---|---|
| V1 | La reja de denominaciones sigue editable después de revelar, y «Cerrar corte» manda lo tecleado: es la otra mitad de L1. Además se ven dos «Contado» que se contradicen | **P0** |
| V2 | El callejón de CG.160 sigue siendo posible **sin recargar**: después de sellar no se vuelve a pedir el saldo. Si se cierra el diálogo y se reabre, vuelve «Guardar conteo» y el servidor responde 400 | P1 |
| V3 | **No se puede abrir ni cerrar el corte de un día atrasado:** la pantalla siempre abre con `todayMx()`. El 13 y el 14-oct no tienen camino desde la pantalla | P1 |
| V4 | `saldo` no tiene estado de carga: mientras carga, o si recibe un 429, el botón de cierre desaparece. Al entrar se lanzan 9 GET a la vez contra un límite de 10 peticiones por segundo | P1 |
| V5 | Errores tragados: un 403 muestra un texto genérico (se pierde el de la doble llave), el aviso es un toast de 7 s, y el diálogo de cierre no conserva ningún error | P1 |
| V6 | La pantalla no revisa permisos: quien sólo tiene VER ve «Cerrar», y «Autorizar» aparece a quien no puede autorizar | P2 |
| V7 | `money(null)` pinta `$0.00`; hay fechas ISO sin formato; el diálogo no muestra el folio ni la fecha del corte que se va a cerrar | P1 |
| V8 | El menú «Caja General» lleva al espejo de sólo lectura (`/finanzas/caja`); la captura se llama «Caja (captura)» | P2 |
| V9 | Con la caja en $0, «Guardar conteo» queda deshabilitado sin explicación, y ese corte no se puede cerrar | P2 |
| V10 | `crypto.randomUUID()` sin alternativa: por http en la LAN falla y «Confirmar N» se queda cargando para siempre | P1 |

### 2.4 Pruebas

| # | Hallazgo |
|---|---|
| T1 | **Ninguna prueba ejerce `abrir`/`contar`/`cerrar`/`autorizar` contra una base de datos** |
| T2 | `test-newdb-cash-ledger.js` y `test-newdb-cash-ledger-cuts.js` (registradas en `run-all-tests.js`) insertan **sin `denom_key`** y hoy fallarían con `23502` |
| T3 | `http-cash-ledger-test.js`, la única que llama a un endpoint, no toca cortes, y CG.124 hoy la rechazaría (le faltan `origen_ref` y motivo) |
| T4 | La 4ª aserción de `cash-cut.alcance.spec.ts` compara `universo('00')` consigo misma. **Si `cerrar()` vuelve al filtro viejo, ninguna prueba se pone roja** |
| T5 | El spec del componente no simula `contar`/`recontar`/`cerrar`/`autorizar`: esas acciones **nunca se ejecutan en una prueba** |
| T6 | Ningún job del CI levanta Postgres: la suite de regresión no corre en ningún lado (deuda **VP.5**) |

### 2.5 Proceso

- **«Desplegado» se dijo sin medirlo.** Dos actualizaciones salieron sin el arreglo, y la doc de la fase
  afirma tres estados de despliegue distintos (`62fb99896`, `48ced77df`, el `crontab` comentado).
- **La doc se contradice en las cifras del dinero:**
  - El conteo del 12-oct: $3,340.00 según VERDAD_ABSOLUTA §28.6 y $3,653.50 según FASE_CG §CG.160.
  - La causa del 13-oct: §28.5 midió hora por hora que los $165,410 dispensados el 10-oct tenían dueño;
    el doc de CG.160 lo volvió a afirmar sumando por día, que es el método que §28.10 marca como trampa.
  - El saldo del 13-oct aparece como −$11,938.37, −$28,784.79 y −$29,110.79.
- El tracker no registra nada de Caja General después de CG.42, y el CHANGELOG no tiene CG.115 ni
  CG.152–160.

### 2.6 Lo que NO está medido (se mide en la Fase 0)

1. El `fondo_inicial` actual de `CC-2026-00001` (D5).
2. **Qué instante mide el conteo sellado.** Se selló el **14-oct a las 09:40:25** (commit `9a66d74ae`),
   dos días después de la jornada.
3. El esperado que calcularía `cerrar()` hoy contra los datos de prod.
4. La causa del esperado imposible del 13-oct.

---

## 3. Reglas de ejecución (para no repetir el ciclo)

1. **Se congelan las funciones nuevas de Caja General** (CG.58.x, CG.18x y pantallas nuevas) hasta cerrar
   la Fase 2. Sólo entran arreglos del flujo del corte. Mientras el corte no cerraba entraron 26.
2. **Un defecto se arregla en este orden:** la prueba que lo reproduce **en rojo**, en la capa donde
   vive; el arreglo; y una prueba en la capa de arriba que lo ejerza.
3. **Una escritura no está probada hasta ejercerla contra Postgres real con el payload de la pantalla**
   (regla de `CLAUDE.md`, 2026-10-14). Nunca contra la laptop apuntando a prod.
4. **Desplegado se dice con el SHA que devuelve `/api/health`**, no con «ya se soltó».
5. **Antes de cerrar un corte real, el esperado de la pantalla tiene que coincidir con una medición
   independiente** (VERDAD_ABSOLUTA §28.6). Si no coincide, no se cierra: el cierre no tiene vuelta
   atrás.
6. **La fuente de estado es este plan más el tracker**, con el prefijo `CGP-*`.

---

## 4. Fase 0: destrabar (hoy)

**Objetivo:** `CC-2026-00001` cerrado y autorizado con números verdaderos, y un camino decidido para el
13 y el 14-oct.

| Item | Qué | Aceptación | Quién |
|---|---|---|---|
| CGP-0.1 | Soltar CG.160: `ssh superoot@192.168.0.222 'ops/prod/soltar.sh --ver'` y después sin `--ver` (o desde tu máquina, según la cabecera de `soltar.sh`) | `/api/health` devuelve `07665276b` | Edgar |
| CGP-0.2 | Lectura en prod, en una transacción `READ ONLY` y **con el rol `app_runtime`** (GOTCHAS §80): `fondo_inicial`, `contado`, `morralla`, el desglose sellado con su `updated_at`, y los movimientos sueltos de la jornada del 12 | El esperado reproducido da **$3,402.45** | Edgar o una sesión con acceso a prod |
| CGP-0.3 | **Decidir qué conteo representa el cierre del 12-oct:** los $3,340.00 que registró Control (falta $62.45) o los $3,653.50 sellados el 14-oct (+$251.05). Si es el del 12, `recontar` con motivo | Decisión escrita con quien contó | Edgar + quien contó |
| CGP-0.4 | Cerrar desde la pantalla **sin teclear nada en la reja** (L1/V1), y autorizar con otra persona | Estado `autorizado`; esperado $3,402.45; diferencia según CGP-0.3 | Cajera + autorizador |
| CGP-0.5 | **13-oct: medir la causa antes de decidir.** Parear hora por hora, con el método de §28.5. Hipótesis: **H1** falta captura del 7 al 10-oct; **H2** depósitos de ruta en CAOS sin su ingreso capturado (sólo 18 de 749 están capturados); **H3** dispensaciones del 13 sin dueño ($53,573) | Una causa medida con su monto, y el residuo declarado | Sesión con acceso a prod |
| CGP-0.6 | Decidir qué se hace con el 13 y el 14: capturar lo que falta o declarar esos días fuera del libro. **Abrirlos hoy sólo se puede por API** (`POST /finance/cash-ledger/cortes` con `fecha`; el backend la acepta y la pantalla no) | Decisión escrita; los cortes del 13 y 14 abiertos o declarados | Edgar |
| CGP-0.7 | Hasta que exista el sensor (CGP-L.10): una consulta diaria a mano de los cortes en `borrador` con más de 26 h | Se corre cada mañana | Finanzas |

---

## 5. Fase 1: capa de datos

**Objetivo:** que la base haga cumplir las invariantes del dinero aunque la lógica falle, y tener un
lugar donde probarlo que no sea producción.

| Item | Qué |
|---|---|
| **CGP-D.1** | **Base de pruebas en CI:** job `caja-db` con Postgres de servicio + `npm run dev:bootstrap-vacia`, que corre las suites de caja. Medir el tiempo (presupuesto: 10 min). Si no cabe, una base de pruebas dedicada en `md` que no sea prod. Es la llave de todo lo demás y abona a la deuda VP.5 |
| CGP-D.2 | Reparar T2 (agregar `denom_key`), registrar o retirar las suites que sólo leen prod (declarándolo), y actualizar al universo nuevo la que filtra `sucursal = $1` |
| CGP-D.3 | **Invariantes en la base** (migraciones aditivas e idempotentes, `NOT VALID` y después `VALIDATE`): en `cerrado`/`autorizado`, `diferencia = contado − esperado` (D1); `contado = Σ desglose de cierre + morralla` (trigger de validación al pasar a `cerrado`); un solo corte vivo por (sucursal, fecha) (D6); `fondo_coherente_chk` con `IS NOT NULL` explícitos (D2); `caos_atrib_orden_chk` con `AT TIME ZONE 'America/Mexico_City'` (D4) |
| CGP-D.4 | Resolver D3: decidir si el índice pasa a ser por (cobro, depósito) o si el motor deja de repartir. Es una decisión de negocio y se documenta |
| CGP-D.5 | Permisos verificados **con el rol que ejecuta**: `USAGE` del schema y los `GRANT` de cada tabla, vista y matview de caja para `app_runtime` (la lección de CG.158 y CP.8.44) |
| CGP-D.6 | D7: declarar dueño y fecha para las tres tablas sin escritor, o sacarlas del alcance. No se borran sin autorización |

**Pruebas de la capa:** `test-newdb-caja-invariantes.js`.
- Cada invariante tiene un `INSERT` o `UPDATE` que la viola y espera **el código de error exacto**
  (`23514`, `23505`, `P0001`).
- RLS: sin tenant, 0 filas; con un tenant falso, 0 filas; todo corre como `app_runtime`.
- Prueba de mutación: apagar un CHECK tiene que poner el job en rojo.

**Salida:** el job `caja-db` verde en CI, con sus negativas, y una mutación verificada.

### 5.1 Estado al 2026-10-14 (🧪 probado en local contra Postgres 18.4)

**Primera corrida del CI (38678099685, PR #413): ❌ en el arranque de la base.**
`dev:bootstrap-vacia` se detuvo en `20261007180000` (una migración de rutas que lee
`runner.existencias_ruta`) por su tope de 120 migraciones saltadas: desde su frontera analítica
entraron 815. Las suites no llegaron a correr. Decisión de Edgar: **no arreglar ese script, hacer
una base propia para caja desde cero** (`[CGP-D.1.1]`).

**`database/tests/caja/preparar-base-caja.js`** arma la base del corte:
- aplica las migraciones REALES que **crean o alteran** el corte (12), más la del tenant y la que
  crea el schema `finance` (donde vive su `GRANT USAGE`);
- crea vacías, con la forma del snapshot de prod, las tablas ajenas que pidan (hoy una:
  `analytics.erp_collections`);
- **nunca salta una migración**: si algo no se resuelve, se detiene y lo dice.

Medido en local (PostgreSQL 18.4 portátil en `C:/tmp`, `knex`/`pg` del lockfile):

| Qué | Resultado |
|---|---|
| Preparador | 14 migraciones, **0 saltadas**, 1 tabla ajena vacía |
| `test-newdb-caja-invariantes.js` | **28 ✓ / 0 ✗**, como `app_runtime`, con las mutaciones en rojo cuando se apaga cada regla |
| `test-newdb-cash-ledger-cuts.js` | **43 ✓ / 0 ✗ / 4 NO MEDIDO** (los 4 piden datos reales o HTTP; ya venían declarados) |
| Prevuelo de la migración (negativas) | aborta y nombra el folio si un corte ya viola una regla; aborta como NO MEDIDO si el rol no salta RLS; no deja nada a medias |
| Preparador (negativas) | se niega a un destino no local (clasificó `192.168.0.222` como prod) y a una base con historia |
| **Servicio REAL** (`cash-cut.servicio-real.spec.ts`, `[CGP-L.0]`) | **6/6**, el código de prod conectado como `app_runtime`. En **rojo** al apagar la guardia de la base |
| Todo `libs/finance/src/lib/caja` | **19 archivos, 394 pruebas en verde** |

**`[CGP-L.0]` — el servicio real, no una imitación.** La suite de invariantes imita el orden de
escritura del servicio; ésta EJECUTA `CashCutService` (con el `TenantKnexService` real) con el
payload de la pantalla:
1. abrir → contar → cerrar sin teclear (lo que manda la pantalla al recargar) → autorizar con
   doble llave;
2. cerrar con el mismo conteo sellado en la reja (lo que manda sin recargar);
3. ⛔ **cerrar con otra cifra en la reja lo frena la base** y el corte queda intacto. Con la
   guardia apagada esta prueba se pone roja, o sea que **el código de `cerrar()` de hoy sí deja
   pasar la cifra tecleada**: lo único que lo frena es la regla nueva de la base. Hoy sale como
   error crudo (un 500); `[CGP-L.1]` lo vuelve un 400 con frase;
4. recontar con dos `UPDATE` en la misma transacción y después cerrar;
5. el cajón de la `00` ata y suma el gasto que otra plaza pagó desde él (el caso del 12-oct);
6. un segundo corte de la misma sucursal y fecha lo frena la base.

Sin `CAJA_TEST_DB_URL` se salta y lo declara, así no rompe el job de pruebas del CI (sin Postgres).

⚠️ **`[CGP-D.2c]` Fragilidad encontrada en `test-newdb-cash-ledger-cuts.js`:** mide el saldo corrido
de la `00` en ABSOLUTO, o sea que da por hecho que la sucursal está vacía. Corrida después de la
prueba del servicio (que confirma sus datos) da **41 ✓ / 2 ✗** (esperaba 500, vio 7,500). En el CI
se resuelve por orden (las suites que deshacen primero, el servicio al final); el arreglo de fondo
es medir el saldo como diferencia contra lo que había antes.
✅ **Resuelto el 2026-10-15:** el saldo se mide como diferencia contra el saldo corrido previo, con la
misma columna. Sobre una base donde ya corrió el servicio: **43 ✓ / 0 ✗** (sin el arreglo, 41 ✓ / 2 ✗).

⚠️ **Lo mismo que trabó prod tres días, visto en la prueba:** un corte en borrador bloquea **todo**
corte nuevo de su sucursal, de cualquier fecha (`ux_cash_cut_abierto`). La primera versión de la
prueba lo pisó al repetirse sobre la misma base.

⭐ **La suite encontró algo en el camino:** la primera base armada no tenía el `USAGE` de
`finance` para `app_runtime` (en prod lo da la migración de Maat que creó el schema). Todas las
escrituras del rol de prod fallaban. Sin la sección de permisos se habría probado como superusuario
y pasado en verde.

⚠️ **Lo que esta base NO prueba:** si prod tiene cambios aplicados a mano fuera de las migraciones.
El snapshot de columnas de prod **no trae las tablas del corte** (comparar contra él daba un verde
falso: un lado vacío no prueba nada). La comprobación de que el criterio no dejó fuera una
migración que altere el corte se hizo por otro camino: las 11 excluidas solo crean tablas satélite
con llave foránea hacia el corte.

| Item | Estado | Qué quedó |
|---|---|---|
| CGP-D.1 | 🧪 | Job `caja-db` con el preparador propio + las dos suites del corte. **No** entra al `needs` de `sellar`. Falta su primera corrida verde en el CI |
| CGP-D.2 | 🧪 | `test-newdb-cash-ledger-cuts.js` reparada y en verde. `test-newdb-cash-ledger.js` reparada (`denom_key`) pero **fuera de esta base** (`[CGP-D.2b]`): prueba el autollenado y el mapa de conceptos de Kepler, que piden ocho vistas de analytics ajenas al corte |
| CGP-D.3 | 🧪 | Migración `20261014212702` + suite + frases en `caja-errores.ts`. **En `main` (PR #413) y SIN aplicar en prod** |
| CGP-D.5 | 🧪 | Cada privilegio de `app_runtime` se verifica por separado, y el `USAGE` del schema aparte |
| CGP-D.4, D.6 | ⬜ | Decisiones pendientes (índice de CAOS; tablas sin escritor). La regla del fondo (D2 de §2.1) va en su propia migración, porque corregirla puede volver intocable un corte viejo y eso se mide antes |

**Las reglas que la base hace cumplir desde la migración `20261014212702`:**
1. `cut_conteo_sellado_chk`: el contado sellado solo cambia en la misma transacción que registró el
   reconteo. **Cierra el hueco del arqueo ciego (L1) desde la base**, aunque el servicio siga
   aceptando la reja tecleada: un cierre con otro conteo ahora se rechaza.
2. `cut_reconteo_constancia_chk`: el reconteo conserva exactamente el contado que reemplaza, y no
   existe sin un conteo previo (cubre L3).
3. `cut_desglose_cuadra_chk`, diferida: contado = desglose de cierre + morralla, al terminar la
   transacción.
4. `cut_aritmetica_chk`: diferencia = contado − esperado, exacta (cubre D1).
5. `cut_firmado_inmutable_chk`: un corte cerrado o autorizado no se reabre ni cambia sus cifras.
6. `ux_cash_cut_sucursal_fecha`: un corte por sucursal y fecha (D6).

**Lo que la migración NO cubre** está en su cabecera: un desglose recompuesto con la misma suma,
un corte invisible por RLS para quien escribe, columnas futuras del corte, y la regla del fondo.

**⛔ Orden para llevarlo a producción, y por qué importa:**
1. **El CI tiene que correrlo primero.** Es la primera vez que un job levanta Postgres; si falla,
   lo más probable es la infraestructura (el arranque de la base vacía), no las reglas.
2. **La migración se aplica en prod ANTES de soltar el código que la nombra.** La compuerta del
   despliegue frena un soltado cuyo código menciona objetos de una migración pendiente, y
   `caja-errores.ts` nombra `ux_cash_cut_sucursal_fecha`. Aplicarla exige acceso a `md`.
3. **Su prevuelo aborta si un corte de hoy ya viola una regla**, y lista los folios. Si
   `CC-2026-00001` tiene un desglose que no suma su contado, la migración lo va a decir antes de
   dejarlo imposible de cerrar.
4. Mientras el servicio no traduzca estos errores en `cerrar()` (CGP-L.6), un cierre con la reja
   tecleada va a dar un 500 en vez de una frase. **Es un error ruidoso a cambio de un cierre falso
   silencioso**, y es intencional.

---

## 6. Fase 2: capa lógica

**Objetivo:** cada transición del corte pasa por una sola puerta, el motor es puro, y cada camino de
escritura se ejerce contra una base real.

| Item | Qué | Prueba que lo cierra |
|---|---|---|
| **CGP-L.1** | **El sellado es inmutable en `cerrar()`.** Si hay un conteo sellado, un cuerpo distinto se rechaza con 400 y la frase «el conteo ya está sellado; para cambiarlo, recontar con motivo». Un cuerpo vacío o igual usa el sellado | Integración: sellar $3,653.50 → cerrar con otro conteo → 400; cerrar vacío → firma $3,653.50. Mutación |
| **CGP-L.2** | **Lo firmado = lo revelado.** `contar()` guarda la huella del universo (los ids atados y el esperado). Si al cerrar cambió, se pide revelar de nuevo en vez de pisar en silencio | Integración: contar → insertar un movimiento de la jornada → cerrar → 409 con frase |
| CGP-L.3 | `recontar()` filtra `momento='cierre'` y exige un conteo sellado previo | Unitaria + integración |
| CGP-L.4 | `abrir` con fecha validada (no futura, no anterior al arranque del libro, una por día) e idempotente: un `23505` se traduce a 409 con frase | Integración: doble apertura → 409 |
| CGP-L.5 | Un solo helper de fechas MX: `diaDe`, `esFechaFutura` y `to_char` en lugar de `String(date)` | Unitarias corridas con `TZ=UTC` **y** `TZ=America/Mexico_City` |
| CGP-L.6 | Fuera los `catch {}` dentro de transacciones (`SAVEPOINT`); `clasificarGranos` con tenant y sin tragar errores. Una regla violada es 400 con frase, nunca 500 con SQL | Integración que fuerza el error |
| CGP-L.7 | Respuestas tipadas en `libs/contracts`: `numeric` → `number`, `date` → `'YYYY-MM-DD'` | Typecheck + spec |
| CGP-L.8 | `evaluarArqueo` y `detail()` respetan `flujo`: el cambio devuelto resta | Unitaria con cambio |
| CGP-L.9 | La sucursal `'00'` pasa a una constante de dominio con su porqué | grep = 1 |
| **CGP-L.10** | **Sensor `caja_corte_abierto`** con latido y umbral en `CRON_JOBS`: aviso a las 26 h de borrador, crítico a las 50 h | Prueba negativa: un corte viejo pone el sensor en rojo |
| CGP-L.11 | Candado de alcance real: se reemplaza la aserción tautológica (T4) | Mutación: devolver `cerrar()` a `.where({sucursal})` pone la prueba en rojo |

**Pruebas de la capa:**

- **Unitarias (vitest) del motor** con tabla de casos:
  - Los seis veredictos: cuadra, sobra, falta, `sin_contar`, `sin_base`, `sin_medir`.
  - `puedeCerrar`, `puedeAutorizar` y `puedeRecontar`, con cada motivo de rechazo.
- **Integración contra Postgres** (job `caja-db`), llamando al servicio con el payload que manda la
  pantalla.
  - Flujo completo: abrir → ingreso con denominaciones → gasto con documento → gasto de otra plaza desde
    el cajón → dispensación y depósito de CAOS → contar → cerrar → autorizar.
  - Negativas:
    - doble apertura del mismo día;
    - contar dos veces;
    - cerrar con otro conteo;
    - autorizar la misma persona que cerró (403 con su frase);
    - cerrar sin conteo;
    - un movimiento de otro día no se ata al corte;
    - un movimiento de la plaza 05 **sí** se ata.

**Salida:** cada camino de escritura de las tablas de caja tiene una prueba que lo ejerce, y las
mutaciones de L.1, L.2 y L.11 están verificadas en rojo.

### 6.1 Estado al 2026-10-14 (🧪 probado en local contra Postgres 18.4)

| Item | Estado | Qué quedó |
|---|---|---|
| **CGP-L.1** | 🧪 | `decidirConteoDelCierre()` (motor puro): con conteo sellado, una reja vacía o con el mismo desglose usa el sellado; cualquier otra cosa —aunque sume lo mismo, o cambie sólo la morralla— es **400** con lo sellado, lo tecleado y cómo se corrige. Se decide **antes de atar un solo movimiento** |
| **CGP-L.2** | 🧪 | `esperadoCambio()`: si el esperado cambió desde el conteo, `cerrar()` responde **409** con `motivo`, `esperado_mostrado` y `esperado_actual`, y revierte lo atado. Quien ya vio el nuevo lo confirma con `esperado_visto`. Un corte sellado antes de que el esperado se guardara (CG.156) se **declara** (`contra: null`), no se bloquea |
| **CGP-L.3** | 🧪 | `recontar()` exige un conteo previo (400 con frase) y lee sólo el desglose de **cierre** (el de apertura inflaba la constancia del primer conteo) |
| **CGP-L.4** | 🧪 | `puedeAbrirCorte()` (motor puro) rechaza con frase la fecha que no es fecha, la que todavía no pasa (el hoy lo da la **base**, en hora de México), el día que ya tiene corte (nombra el folio) y el día **anterior** a un corte que ya existe: las jornadas se cierran en orden, porque el posterior heredó su fondo sin ese día y un corte firmado no se corrige. La fecha se valida antes de consultar con ella. El fondo heredado sale del último cierre **anterior** a la fecha. `GET cortes/jornadas-pendientes` lista los días del cajón con movimientos y sin corte (la consulta la comparte el sensor). `saldo()` publica la fecha del corte abierto. ⚠️ La regla de orden choca con `[CGP-0.6]`: si se decide capturar en la Suite el 7–10 oct, se relaja con una excepción explícita |
| **CGP-L.6** | 🧪 (corte) | `abrir`, `contar`, `recontar`, `cerrar` y `autorizar` pasan por `conFrase()`: una regla de la base violada llega como frase; lo desconocido sigue siendo un 500 ruidoso. Frase nueva para `ux_cash_cut_abierto`. Falta el resto del módulo (CLS, CAOS) |
| **CGP-L.10** | 🧪 | **El sensor del corte abierto** (`caja_corte_abierto`, cada hora a los :20). Dos señales: cortes en **borrador** de más de 26 h (crítico a las 50 h) y **jornadas con movimientos y sin corte** del cajón (crítico con 2 o más: el 13 y el 14-oct). Una jornada cuenta recién cuando terminó hace más de 26 h, para no avisar cada madrugada. Deja su latido (universo en 0 = rojo) con umbral en `CRON_JOBS` (2 h / 6 h) y avisa por la campana con enlace a la pantalla. **No repite**: avisa cuando la situación cambia y la recuerda cada 6 h (el canal no agrupa). Se apaga con `ENABLE_CAJA_CORTE_SCAN=false` |

**`[CGP-L.10]` pruebas:** 12 puras (umbrales, mensajes, la regla de no repetir) + 3 contra la base
real (siembra un corte trabado de 75 h y dos jornadas sin corte; latido; no repite y recuerda),
probadas en **rojo con dos mutaciones**. Una de ellas destapó que mi aserción «el día con corte no
aparece» era **vacía** (ese día no tenía movimientos): se corrigió y ahora la mutación la pone roja.

⚠️ **Al hacerlo se corrigió un contrato:** `FinanceNotice.severity` decía `'info' | 'warn'`, pero la
campana ya admite `'critical'` y `caja_fecha_futura` ya lo mandaba; compilaba sólo porque `.bind()`
devuelve `any` con el tsconfig no estricto. Se amplió a `'critical'` (aditivo; su único consumidor,
el adaptador, lo pasa tal cual). `libs/contracts`: 661 pruebas en verde.

**Pruebas:** `cash-cut.cierre.spec.ts` (13, puras) + el servicio real (8/8) + todo
`libs/finance/src/lib/caja` en **20 archivos, 409 pruebas en verde**. Cada capa de defensa del
arqueo ciego se probó **sola**:
- con la regla de la **base** apagada, el servicio sigue rechazando la reja tecleada (8/8);
- con la decisión del **servicio** desactivada, 4 pruebas se ponen rojas (3 unitarias + la del servicio).

✅ **Restricción para desplegar L.2 — LEVANTADA por `[CGP-V.12]` (mismo lote).** Sin la pantalla,
un movimiento capturado después de contar dejaba el 409 en un aviso de 7 s **sin forma de
confirmar**: un callejón nuevo. Ahora el diálogo de cierre:
- muestra la frase del servidor con las dos cifras en un `p-message` **dentro del diálogo**, que no
  se va solo;
- cambia el botón a «Confirmar $Y y cerrar», que reenvía `esperado_visto`;
- manda cualquier otro error al aviso de siempre, y limpia el conflicto al reabrir.

La lectura del 409 es una función pura (`conflictoDeEsperado`, en `caja-captura.util.ts`): sin las
dos cifras numéricas devuelve `null` y **no ofrece confirmar un número que no llegó**.

**Pruebas:** 5 puras + 4 del componente (contra el servicio simulado del spec), y en **rojo 3 de 4**
al desactivar la lectura (la cuarta cuida la mutación contraria). Directorio `caja-general`: 4
archivos, 320 pruebas. `check:pantalla -- caja-general`: **igual a la línea base** (tipa sin errores,
cero fallas nuevas). `check:templates`: verde.

⚠️ **Sin validación visual** (no se levanta la app). Lo más probable de ajustar: el rótulo largo
«Confirmar $1,800.00 y cerrar» en el pie del diálogo de 40rem en pantalla angosta, y si el aviso
queda mejor arriba del bloque de la revelación que abajo.

### 6.2 Estado al 2026-10-15: L.11 y L.9 (🧪 probado en local)

**`[CGP-L.11]` — el candado del alcance de `cerrar()` es contra la base, no una tautología.** La
cuarta prueba de `cash-cut.alcance.spec.ts` comparaba `universo('00')` consigo misma (T4).
Medido devolviendo `cerrar()` al filtro viejo (`.where('sucursal', c.sucursal)`): **las cuatro de
ese archivo siguieron verdes**, y la de la base («el cajón de la 00 ata y suma lo que otras plazas
pagaron desde él», en el job `caja-db`) se puso **roja**. Se quita la tautología y el archivo dice
dónde vive el candado.

⚠️ **Esa mutación dejó un corte abierto en la 00 de la base local**: con `cerrar()` roto, el cierre
falló a propósito y el borrador quedó vivo, y como la 00 admite uno solo, trabó las corridas
siguientes —el mismo mecanismo que trabó producción—. Se limpió (el corte y sus dos movimientos de
prueba, con baja lógica). En el CI no pasa porque la base nace cada vez; en local, **una mutación
sobre una prueba que usa la 00 compartida se limpia después**.

**`[CGP-L.9]` — la sucursal del cajón es una sola constante.** `SUCURSAL_CAJA_GENERAL = '00'` en
`libs/contracts`, con su porqué: el cajón físico es uno y paga a todas las plazas (`[CG.98]`), y
CAOS es un solo dispositivo ahí. Reemplaza los `'00'` escritos a mano en el alcance del corte, el
cajero, los valores por defecto del controlador, el libro, el nombre de Kepler y la pantalla: **una
definición, y ningún `'00'` fuera de comentarios en el código de caja**. Una prueba lo vigila
(con su negativa; con el servicio anterior marca `cash-cut.service.ts`). De paso, el respaldo del
selector de sucursal decía «00 · CEDIS»: Kepler `'00'` es Oficinas (`ERP_KEPLER` §2.3), y el propio
servidor ya lo corregía.

**Pruebas:** `libs/finance/src/lib/caja` 25 archivos, **443**, dos corridas seguidas;
`caja-general` 383; `libs/contracts` 665.

### 6.3 Estado al 2026-10-15: L.8 (🧪 probado en local)

**`[CGP-L.8]` — el cambio devuelto resta.** La pantalla manda las dos pilas del arqueo con su `flujo`
(`recibido` / `devuelto`) y cuadra `recibido − devuelto = monto`. El servidor las **sumaba**, en dos
lugares:

- **`evaluarArqueo`**, el candado de `create()`: un cobro de $380 pagado con $500 y $120 de cambio
  daba $620 contra $380. **Toda captura con cambio se rechazaba por «no cuadra».**
- **`detail()`**, que alimenta el comprobante impreso: medido contra la base, ese mismo cobro salía
  «desglosado $620, diferencia +$240» —un descuadre que no existe— y, como no devolvía el `flujo`, el
  ticket listaba el cambio como recibido.

`desgloseNeto()` (motor, puro) es la única cuenta para los dos: recibido − devuelto + morralla; un
renglón sin `flujo` es lo recibido. `detail()` devuelve el `flujo`; la pantalla separa las dos pilas
(`separarPorFlujo`, `comprobanteDeDetalle`) y el ticket imprime **CAMBIO** aparte.

**Pruebas:** 4 del motor, 1 **contra la base** (`cash-ledger.detalle-real.spec.ts`, agregada al job
`caja-db` del CI), 2 de la separación, 2 del ticket y 1 del componente. **3 mutaciones atrapadas**
(el cambio vuelve a sumarse, el ticket no lo imprime, la pantalla mezcla las pilas).
`libs/finance/src/lib/caja`: 26 archivos, **448**; `caja-general`: **388**.

### 6.4 Estado al 2026-10-15: L.5 (🧪 probado en local, en tres zonas horarias)

**`[CGP-L.5]` — un solo helper de fechas, y las dos preguntas separadas.** La caja se hace dos
preguntas de fecha que no son la misma, y mezclarlas era el defecto:

- **¿Qué día es esta columna `date`?** → `diaDeFecha`. node-pg arma un `date` como medianoche LOCAL
  del proceso (el repo no fija `setTypeParser`). **Medido con el propio parser de pg en tres zonas:**
  `toISOString().slice(0,10)` da el día correcto en UTC y en México, y **el anterior en Tokio**; los
  componentes locales dan el correcto en las tres. `String(Date).slice(0,10)` da «Tue Oct 13».
- **¿Qué día de NEGOCIO fue este instante?** → `diaMxDeInstante` (zona de México).

Los dos viven en `libs/contracts` (sin dependencias: los comparten servidor y pantalla). Se aplican:

- **El defecto vivo:** la conciliación de ingresos de CAOS (`occurred_at` es `timestamptz`) tomaba el
  día del depósito en UTC. Un depósito a las 19:00 del 12-oct «era» del 13 y **consumía un cobro del
  13**, dinero que todavía no existía. Prueba en rojo antes del arreglo.
- `diaDe` del corte (su nota decía que el `date` llega a medianoche UTC: era falso, y funcionaba de
  casualidad), el `ymd` y el mes por omisión de la caja general (con `toISOString` el último día
  después de las 18:00 ya era el mes siguiente), y la ventana del autollenado.

**Pruebas:** 6 del helper y 2 del motor de CAOS. **La suite de caja completa (450, con las de la base)
pasa con el proceso en UTC, México y Tokio.** 2 mutaciones atrapadas: `diaDe` con `toISOString`
rompe 6 pruebas en Tokio, y el depósito con el día UTC rompe la suya. Paso nuevo en el job `caja-db`:
la suite en México y en Tokio.

⚠️ **Lo que encontré midiendo:** en Git Bash, `TZ=Asia/Tokyo` **no llega a Node** (se queda en la zona
de la máquina): la primera corrida «en tres zonas» en realidad cubrió dos. Se repitió desde PowerShell,
preguntándole a Node qué zona usaba. Y las mutaciones sobre la prueba de la 00 vuelven a dejar un
borrador abierto en la base local: hay un limpiador para eso.

⛔ **Declarado, no tocado:** `ymd()` del emparejador de CAOS (`caja-caos-match.engine`) sirve a la vez a
columnas `date` y `timestamptz`, y usa `toISOString`. Cuál de las dos preguntas corresponde depende de
cada llamador; ninguna prueba lo ejerce en Tokio.

### 6.5 Estado al 2026-10-15: L.7 (🧪 probado en local)

**`[CGP-L.7]` — las respuestas del corte, tipadas por contrato.** `abrir`, `cerrar`, `autorizar` y
`listar` devolvían la fila cruda de Postgres. Medido contra la base: `abrir` respondía
`fondo_inicial: '500.00'` (texto: el repo no fija `setTypeParser`) y la fecha como `Date`, que por
JSON viaja con hora. La pantalla declaraba `number` y recibía texto.

- `CorteCajaDto` y `aCorteCajaDto()` en `libs/contracts`: dinero como número, fecha como día
  (`diaDeFecha`, de L.5), instantes en ISO. `null` sigue siendo «no se midió», nunca 0. No sale lo que
  no es del contrato (`tenant_id`, `conteo_previo`).
- Las cuatro respuestas pasan por ahí; la pantalla usa el mismo tipo en vez de su copia (que además
  decía `fondo_inicial: number` cuando el servidor manda `null` si no se midió).

**Pruebas:** 4 del contrato y 1 contra la base (en rojo antes: `'500.00'`). Caja: 26 archivos, **451**,
dos corridas seguidas; `caja-general` 388; compuertas de tipos y de frontera en verde.

⚠️ **De paso:** el rango de años libres de las pruebas contra la base (30 años) **se agotó en un día de
corridas** sobre la misma base local, y la prueba nueva de L.7 chocaba con la sucursal de la de L.3
(con las jornadas en orden, L.3 ya no podía abrir un día anterior). Rango ampliado (1100–2019 para el
servicio, 1200–1989 para el sensor, sin tocar las anclas de 100–1019) y sucursal propia.

### 6.6 Estado al 2026-10-15: el resto de L.6 (🧪 probado en local)

**`[CGP-L.6]` en el libro y en CAOS.** Lo del corte ya estaba (`conFrase`); faltaban los dos puntos que
el diagnóstico nombraba fuera de él, y el segundo resultó más grave que lo escrito.

- **`clasificarGranos` nunca escribió un grano.** Medido contra la base como `app_runtime` (el rol de
  prod): escribía con la conexión cruda en `finance.caos_deposito_grano`, que tiene **RLS forzado**,
  sin fijar el tenant. La política rechazaba cada fila («new row violates row-level security
  policy»), el `catch` se lo tragaba con un `warn` y **el latido publicaba «0 clasificados»**: un
  carril que no escribe nada se veía igual que uno sin trabajo. ⚠️ **Hipótesis sin medir en prod**:
  lleva escribiendo cero desde que se desplegó. Se confirma leyendo `finance.caos_deposito_grano`.
- **Y su lectura tampoco veía nada.** El `NOT EXISTS` contra la tabla de granos, por la conexión cruda,
  la veía vacía: una vez arreglada la escritura, la segunda corrida volvía a elegir depósitos ya
  clasificados y chocaba contra `cdg_un_deposito`. **Lo destapó correr la prueba dos veces.** Ahora lee
  y escribe en UNA transacción con el tenant fijado; el día del depósito es el de México (L.5); y el
  error ya no se traga: va al latido, con estado `error`, sin tumbar la atribución de cobros.
- **Los dos `catch` vacíos del libro** (leer `analytics.v_caos_link_patterns` «a ver si existe»): dentro
  de una transacción, el error la deja **abortada (`25P02`)** y la consulta siguiente revienta
  —`frescuraCaos` en una ruta, `marcarClientesCredito` en la bandeja—. Probado contra Postgres real.
  Ahora se pregunta antes con `relacionExiste()` (`to_regclass`, el patrón que el repo ya usaba), y
  cualquier otro error se ve.
- **La base de prueba**: el preparador suma la tabla de granos y la vista de patrones (lo que el
  servicio lee y escribe), crea el rol `dev_ro` (sin login; las migraciones le dan GRANT) y ahora
  encuentra las migraciones que escriben `CREATE TABLE finance.${TABLA}`. Probado armando una base
  **desde cero** (19 migraciones, ninguna saltada) y corriendo encima caja y CAOS: **512 pruebas**.

**Pruebas:** 2 del grano contra la base (en rojo antes, con el mensaje del RLS; la segunda, la de
correrlo dos veces) y 3 del mecanismo de la transacción abortada. Las tres entran al job `caja-db`.

⛔ **No tocado:** los demás `catch` del libro (avisos, hallazgos, `caos_cash_links`) no dejan una
consulta después dentro de la misma transacción, o son escrituras de observabilidad que no deben
tumbar la captura. Quedan como están.

⚠️ Verificación de tipos: `tsc --noEmit` sobre `libs/finance` da errores `TS1272`, **todos en
archivos que no se tocaron** (re-medido con V.3: **62**, idénticos con y sin los cambios; el «21» que
decía acá no se pudo reproducir) (forma de importar tipos en firmas con decoradores) y ninguno en los
cinco tocados. No es como tipa el CI; lo confirma `Build & typecheck`.

### 6.7 Estado al 2026-10-15: `[CGP-L.12]`, la jornada del corte (🧪 probado contra base real)

**`[CGP-L.12]` — el corte mide el libro por el día del EFECTIVO.** Ítem nuevo, nacido del review de
este plan. **Decisión de Edgar:** *«el día en que se movió el efectivo»*; y sobre el sobrante de una
dispensación, *«depende, se puede devolver a CAOS o se queda en caja; **es por eso que se carga a
Caja General**»*.

⭐ **El motor ya estaba bien** (`[CG.95]`/`[CG.96]`): la dispensación (+) y su gasto (−) se cancelan y
al cajón sólo le llega la morralla o el sobrante. **Lo que estaba mal era el reloj**, y §1.4 regla 2
de este plan ya declaraba el correcto (`created_at`) sin que nadie lo comparara con el código: el
corte filtraba por `cash_ledger.fecha` —la del **documento**, con mediana de **3 días** de rezago
(`[CG.82]`)— mientras la bóveda se agrupa por `accounting_date`, el día físico.

```text
corte del 12 : + dispensado $X sin su gasto   ->  pide contar lo que ya se gastó  = FALTANTE
corte del  9 : − gasto $X sin su pierna       ->  esperado $X más bajo            = SOBRANTE
```

Es `[CG.160]` otra vez, en el eje **TIEMPO** en vez del eje **PLAZA**. Y `arqueoDelDia` ya usaba el
reloj correcto: **dos implementaciones del mismo cuadre divergieron, y la que FIRMA fue la que se
apartó**.

**El arreglo:** una sola definición (`JORNADA_LIBRO` + `enJornadaLibro`, en `caja-jornadas.query.ts`)
que comparten los **tres** lectores: el universo del corte (`sueltosDe` → contar/recontar/cerrar/
saldo), los sueltos de otras jornadas (`sueltosFuera`) y las jornadas sin corte (`jornadasSinCorte`,
que alimenta al sensor y a la pantalla). Predicado como **rango sobre la columna**, nunca
`(created_at AT TIME ZONE …)::date =`, que la saca del índice (`[LC.9]`).

⭐⭐ **Y al probarlo apareció un defecto PREEXISTENTE que ninguna prueba podía ver.**
`conciliacionCajero` —la que lee las dos piernas de la bóveda— sacaba el día con `toISOString()`,
exactamente lo que `[CGP-L.5]` refutó (da el día **anterior** en Tokio) y que la línea 281 del mismo
archivo ya llamaba *«funcionaba de casualidad»*. Con el proceso en cualquier zona al este de UTC, el
corte sumaba el dispensado y el depositado **de otra jornada**. En prod no se veía porque el
contenedor corre en hora de México, y **ninguna prueba lo ejercía: la suite no sembraba un solo
movimiento de CAOS**. *El helper compartido de L.5 no sirvió en el único sitio que no lo llamaba.*

**Medido** contra PostgreSQL 18.4 real, como `app_runtime`:

| Qué | Resultado |
|---|---|
| Prueba nueva (`cash-cut.servicio-real.spec.ts`) | Gasto con `fecha` = D−3 y efectivo en D + su dispensación en `accounting_date` = D. **Es la primera prueba del repo que ejerce las piernas de la bóveda contra la base** |
| **Mutación 1** (`sueltosDe` vuelve a `.where('fecha', dia)`) | **roja con el número exacto**: esperado **2,500** en vez de 500 — el faltante fantasma de **$2,000**. Sólo cae esa; las otras 17 siguen verdes |
| **Mutación 2** (vuelve el `toISOString`) | **2 rojas en Tokio** |
| `libs/finance/src/lib/caja` | **456/456** en **México, Tokio y UTC**, con `--no-file-parallelism` como lo corre el CI, y verificando que Node **reciba** la zona (en Git Bash `TZ=Asia/Tokyo` no llega — `[CGP-L.5]`) |
| Base limpia, dos corridas seguidas | verdes las dos |
| `npm run lint:boundary` | verde |

El candado de alcance conserva sus dientes: comprueba **las dos fronteras** del rango y que **no
vuelva** un `"fecha" =`, así que «simplificarlo» a un `::date =` lo pone rojo.

⛔ **NO MEDIDO en local:** `test-newdb-caja-invariantes` y `test-newdb-cash-ledger-cuts`. El `.env`
del repo apunta `DATABASE_URL_NEW` a **prod** y el candado de destino seguro aborta, con razón. Las
corre el job `caja-db`.

⚠️ **Declarado, no resuelto:** `created_at` es **cuándo se tecleó**. Coincide con el día del efectivo
cuando la captura es del mismo día; una captura tardía vuelve a separar las piernas. El libro **no
tiene columna para el día del efectivo** (`fecha` = documento, `created_at` = captura; `occurred_at`
es de la máquina). **Deuda con nombre:** una columna propia, por omisión la de captura.

⚠️ **Y una trampa del andamio, para el próximo:** el preparador de la base de prueba reconoce qué
remediar **leyendo el mensaje de error de Postgres en inglés**. En un servidor en español se detiene
en la primera tabla ajena. Se destraba con `ALTER DATABASE <base> SET lc_messages='C'`.

---

## 7. Fase 3: capa visual

**Objetivo:** la pantalla siempre dice en qué paso está el corte, qué sigue y por qué algo está
bloqueado. No queda ningún callejón.

Antes de editar: cargar la skill `diseno` y correr `npm run check:pantalla -- caja-general`; volver a
correrlo al terminar (ninguna falla nueva).

| Item | Qué |
|---|---|
| **CGP-V.1** | **Pasos visibles del corte:** abrir → contar (ciego) → revisar la diferencia → cerrar → autorizar. El estado sale **sólo del servidor** y se vuelve a pedir después de cada acción (mata V2) |
| **CGP-V.2** | La reja queda de sólo lectura en cuanto se revela; la única vía para cambiarla es «Recontar», que pide motivo. Un solo «Contado» (V1) |
| **CGP-V.3** | **Jornadas pendientes:** la lista de días sin corte desde el arranque del libro, y abrir o cerrar por fecha. El diálogo muestra el folio y la fecha del corte (V3, V7) |
| CGP-V.4 | `saldo` con `app-load-state`: el botón de cierre no desaparece por una lectura fallida. Las 9 lecturas iniciales se escalonan para no pegarle al 429 (V4) |
| CGP-V.5 | El error del servidor, con su frase, queda **dentro del diálogo** y no se va en 7 s (V5) |
| CGP-V.6 | Los botones dependen de GESTIONAR o AUTORIZAR, y la pantalla explica por qué no (V6) |
| CGP-V.7 | `NULL` se muestra como «sin medir», nunca como `$0.00`; fechas con un solo formato (V7) |
| CGP-V.8 | Menú: un nombre claro para la captura y otro para el espejo de Control. Lo decide Edgar (V8) |
| CGP-V.9 | Contar cero con confirmación explícita («conté y no hay efectivo») (V9) |
| CGP-V.10 | `crypto.randomUUID()` con la alternativa que el componente ya documenta (V10) |
| CGP-V.11 | Deuda de diseño: clases `fin-*` que no existen, `app-side-peek`, `comm-num` |

**Pruebas de la capa:** el spec del componente pasa a usar un servicio de prueba que **sí** incluye
`contar`, `recontar`, `cerrar` y `autorizar` (T5), con una prueba por estado y por transición:
- sellar → cerrar el diálogo → reabrir (V2);
- la reja bloqueada después de revelar;
- un 429 en `saldo` no esconde el cierre;
- quien sólo tiene VER no ve «Cerrar»;
- el error queda en el diálogo.

**Salida:** `check:pantalla` sin fallas nuevas, specs verdes y validación visual con la cajera, con
checklist. Si no se pudo ver la pantalla, se declara.

### 7.1 Estado al 2026-10-14 (🧪 probado en local)

**`[CGP-V.12]`** está en §6.1, junto a L.2, porque son un solo lote.

**`[CGP-V.3]` — las jornadas atrasadas se cierran desde la pantalla.** El 13 y el 14-oct no tenían
camino: la pantalla abría **siempre** el corte de hoy, y abrir hoy primero los deja huérfanos (L.4
rechaza abrir un día anterior a un corte que ya existe).

- **Un solo botón, no dos.** «Rendir cuentas» abre la atrasada **más vieja** y lo dice en su
  etiqueta («Rendir cuentas del 12-oct»). Un segundo botón «abrir hoy» al lado habría ofrecido
  justo el gesto que deja huérfanas a las de atrás.
- **Las dos puertas comparten la decisión.** «Declarar con cuánto arrancó la caja» abre el corte
  desde su propio diálogo; si abriera hoy, rompía lo mismo. La fecha se decide dentro de
  `abrirCorte()`, adonde llegan las dos, y ese diálogo también la nombra.
- **Cuatro estados de la lista, no dos.** `medido` (vacía = al día), `midiendo` (el botón espera),
  `sin_medir` (no se abre nada a ciegas: «Reintentar» re-mide el saldo y la lista) y `no_informa`
  (404: un API anterior a L.4 no lista jornadas, pero tampoco tiene la regla que las deja
  huérfanas, así que abrir hoy es lo que ya pasaba; trabar el cierre de caja por un 404 sería peor).
- **El hoy es el del servidor**, que es el reloj con el que rechaza una fecha futura.
- Se vuelve a medir después de abrir y de cerrar: así aparece la siguiente.
- El subtítulo de «Tu jornada» las nombra («2 jornadas sin corte desde el 12-oct»): es lo único que
  se ve sin abrir la ventana. El diálogo de cierre dice «Corte CC-… · jornada del 12-oct», y avisa
  si es de un día que ya pasó.
- `diaCorto` pasa a `libs/contracts`: la campana del sensor y la pantalla nombran el día igual.

**Pruebas:** 10 del componente (contra el servicio simulado) + 4 del formateador. **5 mutaciones,
las 5 atrapadas**, cada una por la prueba hecha para ella: ignorar las atrasadas, abrir hoy sin
saber, no re-medir al cerrar, tratar el 404 como falla y usar el hoy del navegador. Directorio
`caja-general`: 4 archivos, **330 pruebas**. `check:pantalla -- caja-general`: **igual a la línea
base** (tipa sin errores). `check:templates` y `reactividad`: verdes.

⚠️ `primeng` (306 contra techo 305) y `sin emojis` (142 contra techo 75) fallan en esta rama **con
y sin estos cambios**, y ninguna línea es de caja: deuda de la base de la rama, no de V.3.

⛔ **Declarado, no decidido:** qué efectivo se cuenta para cerrar una jornada que ya pasó (el cajón
de hoy no es el del 12-oct). La pantalla sólo dice que el corte es de otro día; el procedimiento es
de Edgar y Contabilidad, igual que `[CGP-0.2]`–`[CGP-0.7]`.

⚠️ **Sin validación visual.** Lo más probable de ajustar: el largo del aviso de atrasadas en el bloque
de cierre, y si el aviso «Este corte es de una jornada que ya pasó» sobra junto al rótulo con la
fecha.

### 7.2 Estado al 2026-10-15: V.1 y V.2 (🧪 probado en local)

**`[CGP-V.2]` — la reja deja de teclearse en cuanto se revela, y reabrir el diálogo ya no vuelve
atrás.** Los dos defectos del diagnóstico tenían la misma raíz: el estado del diálogo era una foto
local.

- **V2, el callejón sin recargar.** Después de sellar no se volvía a pedir el saldo y
  `abrirCierre()` borraba lo sellado en la sesión: cerrar el diálogo y reabrirlo volvía a ofrecer
  «Guardar conteo», y el servidor respondía 400. Ahora lo sellado en la sesión va atado a su corte,
  la revelación se deriva (de la respuesta a sellar o del saldo) y el saldo se vuelve a pedir
  después de sellar y de recontar.
- **V1, la reja abierta.** Revelado el conteo, la reja muestra lo sellado pieza por pieza, de sólo
  lectura, y «Cerrar corte» manda la reja vacía: lo que se firma es lo sellado (`[CGP-L.1]` lo usa
  cuando el cuerpo no trae piezas). Un solo «Contado»: revelado, el de la línea del veredicto;
  mientras se cuenta, el total de la reja.
- **Recontar es un modo, no un campo.** Abre la reja vacía (se cuenta de nuevo, no se corrige un
  renglón), pide motivo y esconde «Cerrar» hasta guardar el reconteo o volver al sellado: cerrar a
  mitad firmaría el primero.
- **Servidor, aditivo:** `saldo()` publica `conteo_sellado.desglose` y `morralla`. `cerrar()` y
  `saldo()` leen lo sellado con la misma función (`leerSellado`): lo que se muestra y lo que se
  firma no pueden divergir.
- **Lo que no se puede mostrar se declara.** Un API anterior sin desglose, o un desglose con una
  pieza que la reja de caja no tiene (el billete de $1,000: el servidor acepta todo el catálogo),
  dice «no se puede mostrar pieza por pieza» en vez de pintar la reja a medias.
- **El diálogo guarda el corte que tiene en la mano.** Si la relectura del saldo falla después de
  sellar, se puede cerrar igual. Al abrir desde «rendir cuentas» el corte sale de la respuesta de
  abrir, porque el saldo todavía no volvió.

**`[CGP-V.1]` — los pasos a la vista.** Abrir → Contar a ciegas → Revisar la diferencia → Cerrar →
Autorizar, debajo de la cabecera del cierre de la jornada (con la frase de qué sigue) y arriba del
diálogo. El paso se deriva del servidor con una función pura (`pasoDelCorte`): sin saldo medido no
se afirma ninguno; «revisar» sólo con diferencia y el reconteo sin usar, o con el esperado cambiado;
«autorizar» nombra el folio del último corte cerrado. La pieza `app-caja-pasos` vive en
`modules/finanzas/components/` (no hay stepper compartido: `DESIGN.md` lo lista como hueco), es de
sólo lectura y el estado no depende sólo del color (icono, negrita y `aria-current="step"`).

**Pruebas:** servidor contra Postgres real **13/13** (+1: el desglose sellado, el del reconteo, y que
sin conteo no se publica nada); `libs/finance/src/lib/caja` 23 archivos, **435**. Front: 11 puras
del paso + 16 del componente; directorio `caja-general` 4 archivos, **357**. **10 mutaciones, las 10
atrapadas**: 9 del front (reabrir borra lo sellado, no volver a pedir el saldo, cerrar con lo
tecleado, el permiso de cerrar atado al último saldo, la reja editable tras revelar, cerrar a mitad
del reconteo, pintar a medias una pieza ajena, abrir sin el corte de la respuesta, «por autorizar»
tomando el primero) y 1 del servidor (`saldo()` sin desglose). `check:pantalla -- caja-general`
igual a la línea base; `templates`, `reactividad`, `tokens`, `estilos`, `motion` y
`templates-types` verdes; `primeng` (306/305) y `sin emojis` (142/75) iguales con y sin los cambios.

⚠️ Dos cosas que destaparon las pruebas: una prueba de V.3 atrapó que el texto del paso «abrir»
invitaba a «rendir cuentas» justo cuando la pantalla bloquea abrir y ofrece «Reintentar»; y la
primera versión de las pruebas usaba un billete de $1,000, que la reja de caja no tiene, de donde
salió el caso de la pieza ajena.

⛔ **Decidido acá, revisable:** el reconteo arranca con la reja vacía, no con lo sellado. Precargarla
invitaría a corregir el renglón que «no cuadra» después de ver el esperado.

⚠️ **Sin validación visual.** Lo más probable de ajustar: la tira de pasos en el diálogo de 40rem
(cinco rótulos, se parte en dos renglones) y el pie con tres botones durante el reconteo.

### 7.3 Estado al 2026-10-15: V.4 y V.10 (🧪 probado en local)

**`[CGP-V.4]` — una lectura frenada por el límite ya no deja la pantalla «sin medir».** Medido antes
de cambiar nada: el límite es de **10 lecturas por segundo por IP** (`ThrottlerModule`, tramo
`short`), y al entrar la pantalla lanza **10 GET** más los del marco de la app. El diagnóstico decía
9: **V.3 sumó la lista de jornadas**, y con eso el undécimo cae seguro en el 429.

- **Se reintenta en vez de escalonar.** Escalonar en dos olas obligaba a pintar «midiendo» en cada
  bloque que espera, y el riesgo era dibujar «sin medir» durante ese segundo. Toda lectura del
  servicio de caja (16 GET) pasa por `leer()`, que reintenta sola un 429 hasta dos veces, con la
  espera que dice el servidor (`Retry-After-<tramo>`, el mayor) o un segundo por intento. Si el
  tramo bloqueado pide más de 10 s, no se reintenta a ciegas: el bloque se declara. **Las escrituras
  no pasan por ahí.**
- **Midiendo no es «sin medir».** Mientras el saldo está en vuelo no sale la etiqueta «Corte sin
  medir» ni «Reintentar» (reintentar mandaba más lecturas contra el mismo límite): el botón espera,
  el saldo dice «midiendo» y el subtítulo también. Si falla de verdad, entonces sí.
- **Ninguna de las dos puertas abre un corte sin saldo medido.** «Declarar con cuánto arrancó la
  caja» no pasaba por ningún freno de saldo.

**`[CGP-V.10]`** `uuidV4()` en `core/utils/uuid.ts`: `randomUUID` con contexto seguro,
`getRandomValues` sin él (sí existe por http://), `Math.random` sólo sin `crypto`. `confirmarLote`
llamaba `crypto.randomUUID()` directo: por http:// en la LAN la petición reventaba antes de salir y
«Confirmar N» se quedaba cargando. La copia privada del componente se retira. ⚠️ Fuera de caja
quedan la copia de andén (`nuevaLlave`) y `offline-database.service`, que llama `randomUUID` directo:
deuda declarada.

**Pruebas:** 9 del operador y del servicio (un 429 y después la respuesta; tres seguidos se rinde;
un 500 no se reintenta; `Retry-After` de cualquier tramo; el de un minuto se declara; el saldo
reintentado llega; abrir el corte **no** se repite) + 4 de `uuidV4` + 4 del componente. **6
mutaciones atrapadas.** Directorios `caja-general` + `core/utils`: 8 archivos, **410**.

**De paso, dos defectos míos de L.4 que destapó esto:**

- **La compuerta de frontera** (`lint-boundary-gate`, la que corre el CI) marcó
  `jornadasPendientes()` sin tipo de retorno. El retorno pasa a un contrato de `libs/contracts`
  (`JornadasPendientes`, ADR-052), y la pantalla deja su copia.
- **Las pruebas contra la base chocaban entre corridas.** Elegían el año al azar entre 30 y escriben
  sin deshacer: el 2013 se repitió y `ux_cash_cut_sucursal_fecha` rechazó la siembra. Ahora eligen
  un año sin cortes en la 00 ni movimientos, y marcan sus sucursales y folios por corrida. Y al
  variar el año apareció otro: la prueba de L.4 sembraba `995-05-11` y el servidor responde
  `0995-05-11`, así que **fallaba una de cada tres corridas** (con el año antes de 2000). Año
  rellenado; 4 corridas seguidas en verde, 435 pruebas.

### 7.4 Estado al 2026-10-15: V.5 (🧪 probado en local)

**`[CGP-V.5]` — el error se queda donde se hizo la acción, con su frase.** Antes todo salía en un
aviso de 7 s, el diálogo de cierre no conservaba ningún error, y **un 403 se pintaba siempre «No
tenés permiso»**: la frase de la doble llave («Quien cerró el corte no puede autorizarlo») se perdía
y la persona creía que le faltaba un permiso.

- `textoDeError()` (puro): un 403 con frase del servidor se dice tal cual; sólo el genérico del
  guardia (sin frase, o «Forbidden resource») se traduce. Las frases de validación en lista se juntan.
  Un 429 se dice como «el servidor pidió esperar».
- Sellar, recontar y cerrar: el error queda **en el diálogo de cierre**. Abrir: en su diálogo, o junto
  al botón del cierre cuando se abre desde «rendir cuentas» (que no pasa por diálogo); los dos frenos
  de abrir (saldo sin medir, jornadas sin medir) también van ahí en vez de a un aviso. Autorizar: **en
  la fila de ese corte**. Cada uno se limpia al volver a intentar.

**Pruebas:** 5 puras + 4 del componente; **4 mutaciones atrapadas**. Directorio `caja-general`: **370**.
⛔ **Corregido después:** acá decía que la compuerta `primeng` había atrapado tres `severity="error"`
míos en `p-message` y que en v22 iba `danger`. **Era un falso positivo de la compuerta**:
`MessageSeverity` (primeng 22.0.0) admite `error` y no `danger`, y seguir su sugerencia rompía el
tipado — lo frenó `check-template-types` en V.7. Ver §7.5.

### 7.5 Estado al 2026-10-15: V.7, y una compuerta que empujaba a un error (🧪 probado en local)

**`[CGP-V.7]` — lo no medido se dice, y las fechas no salen crudas.**

- `money()` es compartida (Finanzas y Compras) y convierte `null` en `$0.00`. Cambiarla en el
  origen movería decenas de pantallas fuera de caja, así que se extendió **aditiva**:
  `moneyOSinMedir()` dice «sin medir» ante `null`, vacío o algo que no es número; un cero medido
  sigue siendo cero.
- **Dónde hacía falta se midió, no se adivinó.** Hay 82 `money()` en la pantalla. Se estrechó el tipo
  de `money` a `number` en una copia temporal y se pasaron las dos compuertas de tipos: un solo sitio
  sin guarda (el aviso de «Movimiento registrado»). A mano se revisaron los dos patrones que el tipo
  no ve, `!` y `?? 0`: el monto cancelado (`?? 0`) era el otro.
- **Fechas:** lo suelto de otras jornadas va en frase («desde el 25-sep», con guarda de `null`) y la
  fecha valor de los pagables con `dmy`. La regla de la pantalla queda: **frase con `diaCorto`,
  celda con `dmy`**, ninguna ISO cruda.

**La compuerta `primeng` empujaba a un error.** Su regla de severidad marcaba `severity="error"` en
cualquier etiqueta y mandaba a `danger`; en `p-message` es al revés. La única ocurrencia que contaba
bajo su techo (`portal-login`) era ese mismo falso positivo. Ahora juzga **por componente**, con
`--self-test` de 5 casos (rompiendo la excepción da *CONTROL fallido*) y techo 1 → 0.

⚠️ **Un error mío en el camino:** para restaurar la compuerta tras su prueba negativa usé
`git checkout` sobre el archivo con cambios sin commitear, y se llevó el arreglo. Se rehízo desde el
script; desde ahí las mutaciones se restauran con copia de bytes, no con git.

**Pruebas:** 5 de la variante + 2 del componente; la de CG.115 pasa a la fecha en palabras.
`caja-general` + `shared/util` + `core/utils`: 9 archivos, **426**.

### 7.6 Estado al 2026-10-15: V.6 (🧪 probado en local)

**`[CGP-V.6]` — cada botón pide el permiso de su endpoint, y la pantalla dice cuál falta.** Quien
sólo tenía VER veía «Rendir cuentas», «Registrar movimiento» y «Confirmar N», y la fila del corte
ofrecía «Autorizar» a quien no podía: el clic terminaba en un 403.

- **El permiso de cada botón se leyó del controlador, no se supuso:** todas las escrituras de
  captura y del corte piden GESTIONAR (`crear`, `lote`, `reglas`, `cortes`, `contar`,
  `recontar`, `cerrar`, `cancelar`, `reclasificar`); sólo `autorizar` pide AUTORIZAR.
- Sin GESTIONAR, la barra dice una vez «Sólo lectura: capturar, confirmar y rendir cuentas necesitan
  el permiso «Capturar en Caja General»», y los botones de registrar, confirmar y rendir cuentas no
  se ofrecen. Sin AUTORIZAR, la fila del corte dice qué permiso falta.
- Los métodos también frenan (`abrirCaptura`, `pedirConfirmacion`, `guardar`, `confirmarLote`,
  `cerrarJornada`, `abrirCorte`): un atajo nuevo no puede saltarse el permiso.
- ⚠️ **Sin permisos cargados no se bloquea nada.** «Todavía no sé» no es «no tiene», y el candado de
  verdad es el servidor.

**Pruebas:** 6 del componente (con la bandeja de dos filas marcadas, para que el freno del lote sea
el permiso y no una bandeja vacía); **6 mutaciones atrapadas**. Directorio `caja-general`: **378**.

### 7.7 Estado al 2026-10-15: V.9 (🧪 probado en local)

**`[CGP-V.9]` — contar cero con confirmación explícita.** Con la caja en $0, «Guardar conteo» quedaba
deshabilitado sin explicación y ese corte no se podía cerrar nunca. Medido antes de tocar la
pantalla: **el servidor también lo rechazaba**, porque una reja vacía es `sin_contar` para el motor.
«No se contó» y «se contó y no hay efectivo» son dos hechos distintos (ADR-056): el segundo se
**declara**.

- **Motor y servicio (aditivo):** `cero_declarado` en `contar`, `recontar` y `cerrar`. Con la
  reja vacía y sin morralla, es un conteo en $0 con su veredicto (cuadra, o falta lo esperado).
  Declarar cero **con piezas** es una contradicción: 400 con frase, nada se sella.
- **El cero sellado era invisible, y se arregló antes de que pudiera pasar.** `conteoSellado()`
  devolvía `null` con `contado <= 0`, y el freno de re-sellado de `contar()` miraba `contado > 0`.
  Con un cero sellado, la pantalla habría vuelto a ofrecer «Guardar conteo» (el callejón de CG.160) y
  se podía re-sellar **sin reconteo ni motivo**. Ahora «sellado» es `contado != null`: `abrir()` no
  escribe `contado` y la base no tiene ningún borrador con `contado = 0` (medido).
- **Pantalla:** con la reja en cero aparece «Conté y no hay efectivo en la caja», con el porqué del
  botón apagado. Marcada, el botón dice «Sellar en $0.00». Si después se teclea una pieza, la
  declaración deja de valer; al reabrir el diálogo se olvida (se confirma cada vez).

**Pruebas:** 4 puras del motor, 2 contra la base real (sella, se publica, no se re-sella, se cierra;
la contradicción da 400 y no sella) y 4 del componente. **8 mutaciones atrapadas** (4 del servidor,
4 de la pantalla). `libs/finance/src/lib/caja`: 24 archivos, **441**.

### 7.8 Estado al 2026-10-15: V.11, y lo que queda de la capa visual

**`[CGP-V.11]` — deuda de diseño, medida.**

- **Clases que no existen:** de 19 clases `fin-*` que usa la pantalla, tres no están definidas en
  ningún lado: `fin-field`, `fin-label` y `fin-input`, todas en el motivo de «sin documento», que
  encima era un `<textarea>` sin la directiva de PrimeNG (se pintaba sin estilo). Ahora es
  `pTextarea` con su `<label for>` y el patrón `fin-row fin-row-col` de la pantalla. ⚠️ La primera
  medición, con un script por `node -e`, dijo **cero**: el escape de la expresión regular lo hizo
  mentir. La de `grep` encontró las tres.
- **`comm-num`:** 20 celdas y encabezados numéricos con `ta-r mono` pasan a `comm-num`, que es lo
  mismo (derecha, mono y cifras tabulares) con el vocabulario del sistema; la regla local `.ta-r`
  queda sin uso y se retira.
- **`app-side-peek`: no aplica hoy.** La pantalla no abre ningún detalle de varios campos:
  `detalle()` sólo se usa para imprimir el comprobante. Se declara en vez de inventar un panel.

**Pruebas:** 1 de DOM (el campo es `p-textarea` y tiene su etiqueta), en rojo al quitar la directiva.

**Lo que queda de la capa visual:** `[CGP-V.8]`, los nombres del menú (la captura y el espejo de
Control), que **decide Edgar**. Todo lo demás de V.1–V.12 está 🧪 en local, **sin validación visual**.

---

## 8. Fase 4: E2E del proceso y operación

| Item | Qué |
|---|---|
| **CGP-E.1** | **E2E del proceso, no de la pantalla.** Escenario de tres jornadas: (1) se abre con el fondo de Control, se registran los cinco tipos de movimiento, se cuenta a ciegas, se cierra y autoriza otra persona; (2) el fondo se hereda del contado anterior; (3) un día atrasado se abre por fecha. El esperado lo calcula un **oráculo independiente**, la fórmula escrita aparte (un árbitro que repite al motor es un espejo, R5). Nivel API (HTTP) sobre `caja-db` + la API levantada **en el CI** |
| CGP-E.2 | Playwright (la dependencia ya está en el repo; falta su config) con el mismo escenario sobre la pantalla, en el mismo stack del CI |
| CGP-E.3 | Todo registrado en `run-all-tests.js` y en el job del CI |
| CGP-E.4 | Checklist de liberación: `soltar.sh --ver` (migraciones pendientes) → soltar → `/api/health` → lectura del saldo de humo |
| CGP-E.5 | Runbook para cajera y supervisor: qué hacer si no puedo cerrar, cómo leer el motivo, a quién llamar |
| CGP-E.6 | Métricas: cortes cerrados por día hábil, horas en borrador, % de movimientos conciliados, % de depósitos de ruta capturados (hoy 18 de 749) |

### 8.1 Estado al 2026-10-15

| Item | Estado | Qué quedó |
|---|---|---|
| **CGP-E.1** | 🧪 | El proceso de tres jornadas contra la base, con un **oráculo independiente** escrito en la prueba (`cash-cut.servicio-real.spec.ts`, describe `[CGP-E.1]`): fondo declarado, tres tipos de movimiento, conteo ciego que cuadra al centavo, cierre y doble llave; fondo heredado del contado; faltante y reconteo con motivo; jornadas 3 y 4 cerradas en orden, cada una atando sólo lo suyo, y un día anterior que ya no se abre. **Probado en rojo**: si el depósito suma en vez de restar, el oráculo lo atrapa. ⚠️ Va a nivel de servicio, no de HTTP: levantar la API en local está prohibido (CLAUDE.md). ⚠️ El fondo del primer día se declara: el arqueo de Control no existe en la base de prueba |
| CGP-E.1b / E.2 | ⬜ | El mismo escenario por HTTP y con Playwright: necesitan la API y la pantalla levantadas **en el CI**. No se escribieron sin poder correrlos |
| CGP-E.3 | ✅ | Las suites de caja corren en el job `caja-db`: servicio real, sensor, detalle (L.8) y «Fechas de caja en tres zonas» (L.5). `run-all-tests.js` sólo corre scripts de Node: no se duplicó |
| CGP-E.4 | 🧪 | [`CAJA_GENERAL_LIBERACION`](../RUNBOOKS/CAJA_GENERAL_LIBERACION.md): fusionar `main` (la rama va 1 atrás), CI, migraciones (la rama no trae; verificar `20261014212702` con `soltar.sh --ver`), humo con las rutas verificadas en el controlador, cambios a avisar y vuelta atrás |
| CGP-E.5 | 🧪 | [`CAJA_GENERAL_OPERACION`](../RUNBOOKS/CAJA_GENERAL_OPERACION.md): para la cajera y el supervisor, con los textos que muestra la pantalla. ⬜ Falta el contacto de soporte y revisarla con una cajera frente a la pantalla |
| CGP-E.6 | 🧪 | Tres consultas (cortes cerrados y autorizados el mismo día, horas en borrador, movimientos anclados) en el runbook de liberación, probadas contra la base local. La de depósitos de ruta cita el método de `FASE_CG` |

---

## 9. Decisiones de negocio pendientes

No son de software, y sin ellas ninguna fase cierra el problema:

1. Qué conteo representa el cierre del 12-oct (CGP-0.3).
2. Qué se hace con el 13 y el 14-oct (CGP-0.6).
3. ¿Se puede cerrar un corte `sin_base`?
4. Quién captura los depósitos de ruta en CAOS: hoy no los captura nadie.
5. Recontar los dólares y los papeles, que no se cuentan desde abril y desde 2025-10.
6. Quién cierra y quién autoriza: el plan de la fase dice una cosa y lo construido hace otra.
7. Los nombres del menú (CGP-V.8).

⭐ **2026-10-15: Edgar tiene capturas del corte de cada día.** Son el testigo independiente que faltaba
para 1 y 2, y para decidir qué efectivo se cuenta al cerrar una jornada que ya pasó. Por pedido suyo
se revisan **al terminar los ítems de código del plan**, como evidencia, no para teclear un conteo
como si hubiera sido ciego.

---

## 10. Orden y criterio de «módulo profesional»

```
Fase 0 ──► D.1 (base de pruebas en CI) ──► D.2–D.6
                    │
                    └──► L.1, L.2, L.10, L.11 (P0 y sensor) ──► resto de L
                                                   │
                                                   └──► V.1–V.3 ──► resto de V ──► E.1–E.6
```

Las estimaciones son **supuestos sin medir**: Fase 0 medio día (depende de personas); Fase 1 de 2 a 3
días; Fase 2 de 3 a 4; Fase 3 de 3 a 4; Fase 4 de 2 a 3. Las capas se solapan una vez fijado el
contrato de la capa de abajo.

**El módulo está listo cuando:**
- **cinco días hábiles seguidos** tienen su corte cerrado y autorizado el mismo día;
- `/finance/cash-ledger/*` no da ningún 500;
- cada camino de escritura está ejercido por una prueba que corre sola en el CI;
- el sensor de corte abierto tiene su prueba negativa;
- y la doc deja de contradecirse (§11).

---

## 11. Documentación a corregir

1. FASE_CG §CG.160: la causa del 13-oct (los $165,410) contradice VERDAD_ABSOLUTA §28.5 y §28.10.
2. El conteo del 12-oct: VERDAD_ABSOLUTA §28.6 ($3,340.00) contra FASE_CG ($3,653.50 sellado el 14).
3. Tres saldos distintos del 13-oct.
4. Tres estados de despliegue distintos en FASE_CG §37.5 y en FASE_CG_PATRONES.
5. Números de item duplicados (CG.98, CG.130 y CG.160) y SHAs citados que no existen en el repo.
6. El tracker sin CG > 42, y el CHANGELOG sin CG.115 ni CG.152–160.
7. `CAOS_CASH_SYSTEM.md` dice que CAOS *es* la Caja General; el modelo vigente son dos cajas.
