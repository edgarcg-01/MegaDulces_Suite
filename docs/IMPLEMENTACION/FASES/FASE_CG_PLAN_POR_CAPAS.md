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
