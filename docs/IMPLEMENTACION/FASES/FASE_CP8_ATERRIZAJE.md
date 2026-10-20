# CP.8 — Aterrizaje del puente Suite ↔ ContPAQi

> **Anexo de [`FASE_CP8_PUENTE_CONTPAQI.md`](FASE_CP8_PUENTE_CONTPAQI.md)**, no fase nueva: no
> consume cupo. Aquel documento es la bitácora cronológica (§1–§39) de cómo se construyó el
> puente; éste es **el plan para que entregue**, con objetivos, entregables y capas.
> Encabeza: **Contabilidad** (dueño del resultado). Escrito el **2026-10-20**.

```
OBJETIVO:  Que la póliza que arma la Suite ENTRE a ContPAQi y se compruebe desde acá,
           y que lo que arma sola deje de recapturarse a mano.
MÉTRICA:   pólizas entregadas y cuadradas (contpaqi.poliza_exports en 'aplicada')
           HOY: 0 (2026-10-20) → META: el mes de enero completo (88 pólizas · $36,718,975.48)
           'aplicada' al centavo — fecha la pone D1 (sin contador asignado no hay fecha honesta)
CAPA TOPE: C3 (las cuatro capas existen; faltan piezas en C2/C3 y la prueba humana)
ÁREA:      Finanzas · Contabilidad
DUEÑO:     Contabilidad — la persona que importa el archivo es D1, sin firmar
ESTADO:    🧪 (CP.8) — este anexo no abre fase
```

**Con qué se midió:** `pg-prod` `192.168.0.222:5434`, `system_identifier 7688376744939610156`,
`SET default_transaction_read_only = on`, 2026-10-20 ~14:55. Lista de alias con
`database/scripts/alias-proveedor-pendientes.js` (sólo lectura). Lo que viene de §39 del doc
padre lleva su fecha (2026-10-12) y se marca **no re-medido hoy**.

---

## 1. En una pantalla

Hoy la contadora **recaptura a mano** en ContPAQi movimientos que la Suite ya tiene. CP.8
construyó el puente para que la póliza salga de acá: formato verificado byte a byte contra una
exportación real, armador por lote, resolvedor de proveedor, bandeja, botón de generar, cuadre con
latido. **Nada de eso se ha usado una sola vez.**

| Hecho | Medido hoy |
|---|---|
| Pólizas entregadas a ContPAQi | **0** (`contpaqi.poliza_exports`) |
| Alias de proveedor confirmados | **0** (`contpaqi.supplier_aliases`) |
| Reglas de cuenta **aprobadas** por contabilidad | **0 de 21** (2 `derivada` → `no_aplica`, 19 `sin_regla`) |
| Cuadre (latido `contpaqi_cuadre`) | `ok` 14:50 — *«sin eventos pendientes de cuadrar»*: corre sano **sobre cero** |
| Vuelta de ContPAQi (`feed_contpaqi`) | viva, último paso 14:54 |
| Quién puede operar la bandeja | `contabilidad`, `finanzas`, `superadmin` gestionan; `direccion`, `auditor_externo` ven |

⭐ **El plan busca tres cosas, en este orden:**

| # | Objetivo | Qué cambia para contabilidad |
|---|---|---|
| **O1** | **Entregar** — la primera póliza entra y la Suite lo comprueba sola | Se sabe si el puente sirve. Hasta entonces, nada de lo construido vale |
| **O2** | **Que lo que arma sola, se use** — alias y reglas firmadas | La contadora **confirma** en vez de capturar |
| **O3** | **Saber qué no vemos** — los pagos de crédito sin pareo y la marca de conciliado | Que nadie prometa un alcance que el puente no ve |

---

## 2. El universo y el trabajo — dos números distintos

**Universo** (§39.1, 8 meses, 15,599 egresos, medido 2026-10-12, no re-medido hoy):

| | movs | % | quién lo destraba |
|---|--:|--:|---|
| arma sola | 958 | 6.1 % | nadie — $217.4M |
| `sin_regla` | 5,858 | 37.6 % | **el contador** — es criterio, no se deriva |
| fuera del puente (Caja General · Factoraje) | 5,281 | 33.9 % | no son bancos |
| `no_aplica` | 1,202 | 7.7 % | ya decidido |
| `sin_centro_costo` | 932 | 6.0 % | negocio |
| `sin_medir` (≈ `pago_credito`) | 695 | 4.5 % | O3 — medir antes de clasificar |
| `proveedor_sin_cuenta` | 673 | 4.3 % | alias |

**El trabajo de este anexo** no es el 100 %: es **O1 sobre enero (88 pólizas, $36.7M)**, luego
mover lo que destraban alias y reglas. ⛔ **Techo honesto con desarrollo solo: ~10 %** (6.1 % +
lo que mueven los alias). Lo demás depende de que el contador firme reglas; **no existe una
versión de esto que automatice el 90 %**.

---

## 3. Lo que decía el plan de entrada y no aguantó la medición

El plan llegó como texto de otra sesión. Sus cifras se re-midieron; la dirección aguanta, seis
afirmaciones no:

| # | Lo que decía | Lo que midió prod hoy | Efecto en el plan |
|---|---|---|---|
| 1 | Paso 1: *«generar el archivo, que lo importen y verificar»* | ⛔ **Ningún endpoint escribe `poliza_exports`.** `GET /archivo` responde `X-Entregado: false` a propósito (§36.1). Sin «marcar entregada», el cuadre nunca sabe qué buscar | Falta una pieza C2+C3 **que escribe** → regla 13: prueba contra base real |
| 2 | El paso 1 es *«la primera póliza de verdad»* | El primer paso ya diseñado es **la prueba de $1** (archivos A/B, `Cargar sin Afectar`) con su hoja: [`CONTPAQI_PRUEBA_IMPORTACION.md`](../RUNBOOKS/CONTPAQI_PRUEBA_IMPORTACION.md) | La póliza real va **después** de A/B |
| 3 | *«El contador confirma de un clic en la bandeja (ya construida)»* | La bandeja confirma **alias**, no **reglas**. Aprobar una regla es `[CP.8.14]`, **⬜ sin código**. 0 de 21 reglas aprobadas | El 37.6 % **no tiene hoy dónde firmarse** — es entregable de O2 |
| 4 | *«Los 53 alias»* | Son **de enero** (72 movs, $6,758,575). **Septiembre: 51 nombres, 83 movs, $9,952,490.** La lista es **por mes**; la unión de 8 meses está **NO MEDIDA** | Primero medir la unión, después pedir horas a contabilidad |
| 5 | *«EsConciliado = 0 en los 49,538 movimientos de 2026»* | En `analytics.contpaqi_bank_movements`: **46,541** en 2026 y **162,415** en toda la historia, **todos `false`**, ninguno nulo. La cifra 49,538 no se reprodujo (otro universo, probablemente leído directo de ContPAQi) | La conclusión aguanta (nadie concilia en ContPAQi); la cifra no se cita |
| 6 | *«CP.8 está 🧪; cerrarla libera cupo»* | CP figura 🚀 en el roadmap; las 5 🔨 son **VR · CB · LC · PO · CGA**. Cerrar CP.8 **no baja** ese conteo | No libera cupo; tampoco lo consume. ⚠️ D2 cae en **LC** y D3 en **CB**, que sí están 🔨 |

⚠️ Y uno propio: el carril del derivador (`[CP.8.45]`, commit `cce01beb9`) **no tiene latido**
`contpaqi_derivador` en `analytics.cron_runs` hoy. Agenda mensual (día 3) y el commit es del 12-oct,
así que puede no haber tocado todavía — **NO MEDIDO si está desplegado en `md`**.

---

## 3.1 Lo que midió C0 el mismo día (`[CP.8.46]`–`[CP.8.48]`)

Todo de sólo lectura sobre `pg-prod` (`system_identifier 7688376744939610156`).

### `[CP.8.48]` El techo, con un script que ahora sí queda en el repo

`database/scripts/techo-puente-contpaqi.js` mide con **el mismo `simularLotes` de la bandeja**.
En §39.1 la consulta no quedó versionada, y sin ella no había antes/después.

| | ene–ago (control de §39.1) | **ene–sep (línea base)** |
|---|--:|--:|
| universo | 16,097 | **18,193** |
| arma solo | 968 · 6.0 % · $219.4M | **1,069 · 5.9 % · $244.6M** |
| `sin_regla` | 6,260 · 38.9 % | **7,106 · 39.1 %** |
| fuera del puente | 5,281 · 32.8 % | **5,888 · 32.4 %** |
| `no_aplica` | 1,241 | 1,411 |
| `sin_centro_costo` | 970 | 1,097 |
| `sin_medir` | 700 | 862 |
| `proveedor_sin_cuenta` | 677 | 760 |

⚠️ **El control no reproduce exacto:** 16,097 contra 15,599 (+498). «Fuera del puente» sí coincide
**al movimiento** (5,281), así que la ventana es la misma; casi toda la diferencia está en
`sin_regla` (+402). En la misma ventana hay **893 egresos capturados después del 12-oct**, que
explican la diferencia en dirección y tamaño. **No se atribuyó movimiento por movimiento.**

⭐ **Cruce de dos implementaciones:** «arma solo» (1,069 movs · $244,641,142) y
«proveedor sin cuenta» (760) salen **idénticos** en este script y en `alias-proveedor-pendientes.js`,
que recorren caminos distintos (lote del armador contra resolvedor directo). Y de paso dice algo:
**todo lo que hoy arma solo es `compra_mercancia`**.

### `[CP.8.47]` La lista única de alias: 324 nombres, y 14 hacen la mitad

`alias-proveedor-pendientes.js --desde=2026-01 --hasta=2026-09`. Control: `--mes=2026-01`
reproduce **53 nombres · $6,758,575** al peso.

| | |
|--:|---|
| **324** nombres · 760 movs · **$95,553,856** | la lista completa ene–sep |
| **14** nombres | cubren el **50 %** del dinero |
| **74** · **118** | cubren el 80 % · el 90 % |
| 86 recurrentes (≥ 2 meses) | $66.8M — un alias confirmado se reutiliza cada mes |
| 212 con sugerencia por palabras | $59.4M — **pista, nunca se aplica sola** |

Por veredicto: `sin_pareo` 284 ($80.5M) · `ambiguo` 7 ($7.8M) · `veredicto_debil` 31 ($2.7M) ·
`sin_concepto` 2 ($4.5M).

⛔ Dos cosas que **un alias no arregla**, y se dicen para que nadie las cuente como trabajo de
contabilidad:

- **`ambiguo` (7, $7.8M):** el padrón de ContPAQi trae la misma razón social en **dos cuentas**. Se
  arregla **en ContPAQi** (fusionar o dar de baja la duplicada), no acá.
- **`sin_concepto` (2, $4.5M):** uno es un concepto de banco que llega como el **texto literal
  `"null"`** ($2.3M en 16 movs): el dato se rompió antes de llegar a `finance.bank_movements`. Es
  defecto de la ingesta bancaria (Fase CB), no un proveedor por confirmar.

⭐ Y una que **sí** abarata: el mismo proveedor aparece con **varios textos de banco** (uno de los
grandes, con tres variantes, suma $14.1M). Confirmar las variantes juntas es una sola decisión.

La lista con nombres **no se commitea** (repo público): se genera con el comando de arriba y
`--csv=<ruta>`.

### `[CP.8.46]` ⛔⛔ Los «581 pagos de crédito sin pareo» no eran pagos de crédito, y sí estaban en ContPAQi

**1. El 93 % está mal clasificado en la Suite.** Por concepto del banco, ene–ago:

| lo que es | movs | importe |
|---|--:|--:|
| **comisión de BBVA por venta con tarjeta en terminal** (`APLI TASA DE DES CREDITO/… TERMINALES PUNTO DE VENTA`) | **532** | $129,820.97 |
| pago de crédito: capital · intereses · «intereses no reales» | 38 | $1,686,239.21 |
| IVA de esa misma comisión (`IVA TASA DE DESC CREDITO/…`) + una contratación de línea de crédito | 10 + 1 | $44,491.33 juntos |

O sea: por **cuenta** es casi todo comisión; por **dinero** es casi todo crédito. La categoría
`pago_credito` junta dos cosas que contablemente no se parecen. ⚠️ Y la misma comisión está
repartida en **tres** categorías distintas (`pago_credito` 532, `cobranza` 20, `iva_acreditable` 4),
y su IVA en otras tres. El clasificador (Fase CB) la trata distinto según el día.

**2. La hipótesis del doc padre cae: no es el módulo de tesorería.** El decode de la fase CP ya
decía que `Egresos`/`Cheques`/`DocumentosBancarios` **se dejaron de usar en 2019**. Lo que hay es
otra cosa:

- Los dos créditos de Banorte (`…424` y `…050`) pagan capital fijo de **$83,333.33** y
  **$110,611.11** al mes. **Los nueve meses ene–sep están en ContPAQi**: póliza de egresos con cargo
  a la cuenta del crédito (`2140640000` y `2140110004`) y abono al banco `1020080000`. Placebo (un
  centavo corrido): **0**.
- **No pareaban por la FECHA.** Contabilidad mete esos pagos dentro de **una póliza mensual por
  banco**, titulada *«PAGO COMISIONES BANORTE 7744»*, fechada **el último día del mes** (folio 379 →
  31-ene; 337 → 27-feb; …). La ventana de ±3 días contra el día real del banco nunca la iba a encontrar.
- ⭐ En **2024** esos mismos importes se asentaban **el día real** (5-feb, 5-abr…). La práctica
  cambió; dos muestras, no un estudio.
- Comisiones de terminal: **100 de 556** parean a importe exacto y ±3 días (placebo con fecha
  corrida: 2–4). La señal es real pero parcial. Lo más probable es que sean las que caen cerca del
  fin de mes, y el resto va sumado en la póliza mensual. La regla de suma exacta **NO se identificó**
  (×1.16 y suma diaria no explican nada contra su placebo).

**Lo que esto cambia en el plan:**

- El 4.7 % de `sin_medir` **no es un hueco de ContPAQi**. Es (a) una clasificación equivocada en la
  Suite y (b) una **cuarta forma de armado** que el puente no tiene: el lote **cuenta × mes**, no
  cuenta × día. Se abre como **D6**.
- La comisión de terminal es dinero chico ($130K en 8 meses) y mucho volumen (532 renglones). Es el
  caso perfecto para que el puente lo arme, **si** se arma como lo arma contabilidad.

## 3.2 ⛔⛔ `[CP.8.58]` Visto como lo ve la API, el puente estaba vacío — por tercera vez, el rol equivocado

Al ir a escribir la primera entrega apareció algo que tumbaba todo lo de arriba:

- Las **siete** tablas que lee el puente (`finance.bank_movements`, `bank_accounts`,
  `movement_categories`, `contpaqi.account_rules`, `supplier_accounts`, `supplier_aliases`,
  `poliza_exports`) tienen **RLS forzado**: `tenant_id = current_tenant_id()`.
- La API corre como **`app_runtime`** — verificado en los pods `api` **y** `worker`:
  `DATABASE_URL_NEW_RUNTIME` (el de `KNEX_NEW_DB`) es `app_runtime`; sólo el pool admin es
  `postgres`. (Corrige una lectura del 2026-10-09 que daba el RLS por inerte mirando sólo el
  admin.) `app_runtime` **no** trae `app.tenant_id` por default. Los roles
  personales (`edgar`, `david`, `francisco`, `sistemas`) **sí** lo traen (`pg_db_role_setting`).
- `ContpaqiArmadoService` y `ContpaqiCuadreService` inyectaban `KNEX_NEW_DB` pelado: un
  `knex(config)` sin `SET LOCAL`. Sólo los servicios nuevos (`cierre`, `mi-cierre`) usan
  `TenantKnexService`.

**Consecuencia, reproducida en rojo** (candado nuevo, sesión con el tenant borrado para quedar
como `app_runtime`): `simularLotes('2026-01')` → **0 lotes**; `proveedoresPendientes` → **0
nombres**. En prod eso es bandeja vacía, «ningún lote produce asiento» al generar, el alias
rechazado por la política al guardar, y **un cuadre que juzga cero entregas para siempre** y
late `ok` — *«sin eventos pendientes»* —, indistinguible de que no hubiera nada.

⭐ Nadie lo vio por la razón de `[CP.8.44]`: **todo se midió como `edgar`**, que ve los datos
porque trae el tenant puesto. Los logs de la API de los últimos 10 días no muestran ni una
apertura de la bandeja, así que **no se ejerció en prod** — se deriva del código y del mecanismo,
que sí se probó.

**Arreglo:** `alcance-tenant.ts`. Cada método público corre en una transacción con
`set_config('app.tenant_id', MEGA, true)`, y `db` **lanza** fuera de ese alcance en vez de caer al
pool (un acceso olvidado se ve en el primer candado, no como una pantalla vacía). Sin tocar los
constructores, que es lo que tiró la API en #414. El `try/catch` sobre `supplier_aliases` va ahora
en SAVEPOINT (si no, un error envenena la transacción: 25P02), y el latido del cuadre se escribe
por el pool, fuera de la transacción, para que un fallo no se lleve su propio registro.

| candado | antes | después |
|---|---|---|
| `test-newdb-contpaqi-tenant.js` (nuevo) | 3 ✓ / **3 ✗** | **6 ✓ / 0 ✗** |
| bandeja · proveedor · puente · lote · cuadre | — | 34 · 30 · 43 · 38 · 35 ✓, 0 ✗ |

⚠️ **¿Caso aislado o clase?** Otros **20 servicios** inyectan `KNEX_NEW_DB` sin ningún mecanismo
de tenant en el archivo (lista en el tracker, `[CP.8.58]`). Son **candidatos, no defectos
medidos**: varios pueden leer sólo tablas sin RLS. Medirlos es de Plataforma, no de este anexo.

---

## 3.3 F1b — «Marcar como entregado» (`[CP.8.50]` · `[CP.8.52]` · `[CP.8.54]`)

- **C1 `entrega.ts`** (puro): huella SHA-256 de los bytes, comparación byte a byte con el motivo
  de dónde difiere, y las filas de `poliza_exports` (token, guid, autor y huella en el `asiento`).
- **C2 `POST /finance/contpaqi/entregas`** `{ mes, archivo_base64 }`, `_GESTIONAR`. Regenera el
  mes con el **mismo** `armarArchivo` que la descarga; si el archivo subido no es idéntico →
  **409** con el motivo. `ON CONFLICT DO NOTHING`: marcar dos veces no duplica, **no toca
  `updated_at`** (el reloj del cuadre) y no degrada una `aplicada`. (El `registrar()` viejo hace
  `merge` y habría hecho las tres cosas mal; por eso éste no lo usa.)
- **C3** en `/contabilidad/contpaqi-puente`: «¿Ya lo cargaste en ContPAQi?» → elegir el archivo
  → resultado (nuevas / ya registradas) o el motivo del 409. Separado de «Generar».
  `check:pantalla` **2 → 2 fallas, 0 nuevas**; tipa sin errores. **Sin validación visual**: lo más
  probable de ajustar es el espaciado entre las dos cajas del archivo.

**Lo medido, y lo que no:**

| | |
|---|---|
| determinismo: enero generado dos veces | **idéntico**, 88 pólizas, 80,024 bytes (contra prod, sólo lectura) |
| un byte alterado | rechazado **antes** de escribir, 0 → 0 filas |
| `aBase64` (pantalla) | 2 pruebas; mutada a rojo una vez |
| ⛔ **el registro de la entrega** | **NO MEDIDO.** `test-newdb-contpaqi-entrega.js` lo ejerce completo **sólo** contra destino local (job `pruebas-db` del CI) como `app_runtime`, con el payload de la pantalla. No hay base local en esta máquina y contra prod no se escribe desde una prueba. **Hasta que ese job corra en verde, el endpoint no está probado (regla 13).** |
| typecheck del backend | **NO MEDIDO** en local (regla 3); lo mide `Build & typecheck` del CI |

Deuda con nombre: el autor y la huella viajan en el `asiento` (JSON) y no en columnas, para no
pedir una migración; `AlcanceTenant` vive en `contpaqi/` y va a `platform-core` si aparece un
tercer consumidor.

---

## 3.4 F4 — Firmar reglas en pantalla (`[CP.8.51]` · `[CP.8.53]` · `[CP.8.14]`), y lo que destapó

**Lo que hay, medido** (prod, sólo lectura, ene–sep): de 21 reglas, **6 se firman con una cuenta**
(`por_categoria`); las otras 15 no tienen una cuenta que elegir y la pantalla dice por qué. Las 6
traban **9,757 movimientos** — más de la mitad del universo por cuenta — pero sólo **$16.6M**:
gasto chico y frecuente (tarjeta 3,877 · comisión bancaria 4,404 · gasto administrativo 1,241…).
Es un **techo**: no está medido cuántos arman de verdad una vez firmados.

| categoría | movs ene–sep | importe | indicio del derivador |
|---|--:|--:|---|
| compra con tarjeta | 3,877 | $6.77M | 5200600000 gasolina (73.8 %) |
| servicios | 190 | $2.60M | — |
| IMSS / SUA | 17 | $2.51M | — (se reparte por sucursal: probablemente no es una cuenta) |
| gasto administrativo | 1,241 | $2.42M | — (cajón de sastre: probablemente partirlo) |
| comisión bancaria | 4,404 | $1.45M | 5200650000 comisiones (94.4 %, sobre 18 pareos) |
| impuestos | 28 | $0.88M | — (mezcla impuestos distintos) |

**C1 `firma-regla.ts`** (pura): sólo `por_categoria` se firma; la cuenta tiene que ser **gasto
`52*`, afectable, viva y del catálogo** de ContPAQi (173 cuentas). Banco, proveedor, mayor, baja,
inexistente o sin autor → rechazo con el motivo exacto. Revocar sólo lo firmado.

**C2**: `GET /reglas?mes` y `GET /cuentas-gasto` (`_VER`) · `POST /reglas/:categoria/firma` y
`/revocar` (`_GESTIONAR`, 409 con motivo). Escriben `estado`, `cuenta_gasto`, `cuenta_nombre`,
`aprobada_por`, `aprobada_en` — columnas que ya existían, sin migración. Revocar vuelve a
`sin_regla` y **conserva la última firma** para que se lea qué se revocó; quién revocó **no
queda** (deuda con nombre).

**C3** en `/contabilidad/contpaqi-puente`, antes de proveedores: abre con la respuesta (*«firmar
las N destraba X movimientos ($Y) del mes»*), tabla de firmables con evidencia e indicio, selector
filtrable de las 173 cuentas **sin nada preseleccionado** («usar el indicio» llena el selector sólo
si la cuenta está en el catálogo, y firmar sigue siendo un clic aparte), y abajo las no firmables
con su motivo. Si la lectura falla, **se dice** (una sección de firmas que desaparece se lee como
«no hay nada que firmar»). `check:pantalla` 2 → 2, 0 nuevas; tipa; 4 pruebas nuevas, mutada a rojo.
**Sin validación visual.**

### ⛔⛔ `[CP.8.59]` Lo que destapó: el archivo habría reenviado lo ya entregado

Firmar cambia lo que arma un mes que quizá **ya se cargó** en ContPAQi. El archivo traía **todos**
los lotes del mes, así que regenerarlo e importarlo habría **duplicado** en ContPAQi lo ya
entregado — y «Marcar entregado» lo habría contado como «ya registradas» sin avisar. Defecto mío
de F1b, cazado antes de que hubiera una sola entrega.

Arreglo: `armarArchivo` deja fuera los lotes con entrega registrada (`armada`/`entregada`/
`aplicada`; una `rechazada` —el cuadre dijo que nunca apareció— sí puede volver a mandarse). Un lote
entregado cuyo total cambió **no se reenvía y se declara** (`cambiados`, y en el encabezado
`X-Cambiados-Tras-Entrega`). Si no queda nada nuevo, el error lo dice. Ejercido sólo en el modo
local del candado (`test-newdb-contpaqi-firma.js` [C]) — **NO MEDIDO** hasta `pruebas-db`.

| candado | resultado |
|---|---|
| `test-newdb-contpaqi-firma.js` (nuevo) | **25 ✓ / 0 ✗ · 1 NO MEDIDO** (la escritura, como siempre) |
| tenant · entrega · bandeja · puente · proveedor | 6 · 4 · 34 · 43 · 30 ✓, 0 ✗ |
| spec de la pantalla | 19 ✓ |

---

## 4. Decisiones a firmar

| # | Decisión | Opciones | Recomendación | Firma |
|---|---|---|---|---|
| **D1** | **¿Quién importa el archivo?** | una persona con acceso a ContPAQi (`192.168.0.35`) y 30 min | **Una persona con nombre**, no «contabilidad». Sin nombre, O1 no arranca y no hay fecha | Edgar / Dirección |
| **D2** | **¿Por dónde va la primera entrega?** | (a) póliza de bancos · (b) Libro de Compras (LC) | **(a) bancos.** El cuadre ya está escrito para egresos. ⭐ Y la prueba **B** contesta de paso lo que LC necesita (si ContPAQi honra los `AD`, `[CP.8.30]`), así que LC no queda esperando: **una sesión desbloquea las dos** | Edgar |
| **D3** | **¿Dónde vive la marca de conciliado?** | Suite · ContPAQi · las dos | **En la Suite, dentro de la Fase CB** (ya 🔨). Escribirla en ContPAQi choca con ADR-040 (*nunca escribimos directo*) y el layout de importación **no se ha medido** que la lleve. **Fuera de este anexo** | Contabilidad + Edgar |
| **D4** | **¿Cómo se firma una regla?** | por categoría · por categoría × sucursal · por proveedor | **La forma que dicta el dato** (`tipo_regla`): §24.3 midió que 3 categorías **no pueden** tener una sola cuenta. La pantalla no deja aprobar una regla `por_categoria` donde el dato dice otra cosa | Contabilidad |
| **D5** | **¿Qué deja de capturar la contadora?** | nada (el puente sólo «ayuda») · lo que entra y cuadra | **Lo que entra y cuadra.** Si la contadora sigue capturando igual, el puente **suma** trabajo en vez de quitarlo y aparecen pólizas duplicadas. Es cambio de proceso, no de código | Contabilidad + Dirección |
| **D7** | **¿Quién puede firmar una regla de cuenta?** (sale de `[CP.8.53]`) | (a) quien tiene `FISCAL_CONTPAQI_BRIDGE_GESTIONAR` hoy: `contabilidad`, `finanzas`, `superadmin` · (b) un permiso propio, sólo contabilidad | Hoy rige **(a)**, y la firma deja nombre. **Recomiendo (b)** si finanzas no debe elegir cuentas contables: es un permiso nuevo, migración y **reparto en prod** (regla 20), no un cambio de pantalla | Edgar + Contabilidad |
| **D6** | **Comisiones y pagos de crédito: ¿póliza diaria o mensual?** (sale de `[CP.8.46]`) | (a) el puente las arma **mensuales por banco**, como hoy contabilidad · (b) **diarias**, como el banco | **(a) mensual**, para no cambiarle a contabilidad dos cosas a la vez. El cuadre tiene que saber que esa forma se busca por **mes**, no a ±3 días. Y antes, la Suite tiene que **clasificar bien** la comisión de terminal (hoy cae en tres categorías) — eso es de CB | Contabilidad |

⭐ **Qué NO depende de las firmas:** F2 y F3a ya se midieron (§3.1). El código de F1b puede
arrancar hoy. **D1 bloquea sólo la prueba humana.**

---

## 5. Qué NO incluye

- **Ampliar flujos**: ingresos, Caja General y Factoraje (el 33.9 % que no es banco) — E5 del padre.
- **La ida automática por SDK** (E4) — terminal ContPAQi + agente. Sólo si el archivo funciona.
- **Escribir directo en ContPAQi**, ni la marca de conciliado ni nada (ADR-040).
- **Conciliación bancaria** (D3 vive en CB) y **cobertura total** (CP.9).
- **El Libro de Compras** más allá de decidir el interruptor `AD` con lo que diga la prueba B.
- Credenciales y CORS (diferidos por regla del repo).

---

## 6. El orden

| Orden | Frente | Por qué va ahí |
|---|---|---|
| **1** | **F1 — Entregar** (A/B → marcar entregada → enero real) | Clase 3: cerrar lo que está a un paso. Sin esto nada de lo construido vale |
| **2** | **F2 — Medir los 581 pagos de crédito** | Barato (horas, sólo lectura) y **acota el alcance** antes de prometer nada. Paralelo a F1 |
| **3** | **F3 — Alias** (medir la unión → contabilidad confirma) | La pantalla existe; el costo es tiempo de contabilidad, no de desarrollo |
| **4** | **F4 — Reglas firmadas** (`[CP.8.14]`) | La palanca grande (37.6 %), pero cuesta código y una firma; va cuando F1 probó que vale la pena |
| **5** | **F5 — Divergencias** (`[CP.8.11]`) | Sólo tiene sentido cuando haya entregas que cuadrar |

---

## 7. Las capas y sus entregables

Los códigos siguen la numeración de CP.8 (el último usado es `[CP.8.45]`).

### C0 · Dato

| # | Entregable | Estado | Verificado contra |
|---|---|---|---|
| `CP.8.46` | **Los 581 `pago_credito` sin pareo**: buscarlos en el módulo de tesorería de ContPAQi (`EG`/`IN`/`DE`, decodificados en §25.3), sólo lectura en `192.168.0.35`. Resultado: % que parea por importe+fecha, **con control placebo** (fechas corridas) | ✅ 2026-10-20 (§3.1) | el placebo; si el pareo real no supera al corrido, se declara «no parean» |
| `CP.8.47` | **Unión de alias pendientes ene–sep**: nombres distintos, movimientos y $; cuánto del 4.3 % mueve cada alias. Se extiende el script existente con `--desde/--hasta`; sigue de sólo lectura | ✅ 2026-10-20 (§3.1) | la suma por mes (ene $6.76M, sep $9.95M) debe reproducirse |
| `CP.8.48` | **Re-medir el techo de §39.1 hoy**, misma consulta, para el antes/después de este anexo | ✅ 2026-10-20 (§3.1) | §39.1 (2026-10-12) |
| `CP.8.49` | **¿Vuelve una póliza cargada «sin afectar»?** El importer de pólizas no filtra por afectación (verificado en código); falta ver en la base de ContPAQi que la póliza de la prueba A aparece con su `Guid` en `analytics.gl_polizas` | ⬜ | el `Guid` determinista que mandamos (`guidDe`) |

### C1 · Dominio (`libs/finance/src/lib/contpaqi/`)

| # | Entregable | Estado | Prueba que lo ejerce |
|---|---|---|---|
| `CP.8.50` | **`registrarEntrega`**: de los mismos `construirLotes` del archivo (un solo camino, §36.2) salen las filas de `poliza_exports` en `entregada`, con token y `guid`. **Idempotente**: re-entregar el mismo mes no duplica (el token es determinista) | 🧪 2026-10-20 (§3.3) | candado puro; mutar la idempotencia a rojo una vez |
| `CP.8.51` | **Firma de regla**: transición `derivada → aprobada` con quién y cuándo; se niega sin `cuenta_gasto` y se niega si la forma no coincide con `tipo_regla` (D4) | 🧪 2026-10-20 (§3.4) | candado puro con los dos rechazos |

### C2 · API (`contpaqi-bridge.controller.ts`, hoy 5 endpoints, ninguno escribe `poliza_exports`)

| # | Entregable | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| `CP.8.52` | `POST /finance/contpaqi/entregas` `{ mes, archivo_base64 }` — marca entregado el archivo que se cargó (idéntico al que genera hoy, si no 409); arranca el reloj de 5 días del cuadre. `GESTIONAR` | 🧪 2026-10-20 (§3.3) | **sí** | ⛔ obligatoria, con el payload de la pantalla: 0 → N filas, y N → N al repetir |
| `CP.8.53` | `GET /finance/contpaqi/reglas` (con su evidencia) + `POST /reglas/:id/aprobar` | 🧪 2026-10-20 (§3.4) | **sí** | ⛔ obligatoria; incluir el rechazo de D4 |
| `[CP.8.11]` | `GET /finance/contpaqi/divergencias` — lo entregado que no aparece, o aparece con otro importe | ⬜ (existente) | no | contra las entregas reales de F1 |

### C3 · UI (`/contabilidad/contpaqi-puente`)

| # | Entregable | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| `CP.8.54` | **«Marcar como entregado»**, separado de «Generar», con confirmación que dice qué arranca (*«a los 5 días la Suite empieza a preguntar por qué no aparece»*) | 🧪 2026-10-20 (§3.3) | medir antes de tocar |
| `[CP.8.14]` | **Reglas con su evidencia y botón de aprobar** — la pantalla que el 37.6 % necesita | 🧪 2026-10-20 (§3.4) | ídem |
| `[CP.8.11]` | **Bandeja de divergencias** | ⬜ (existente) | ídem |

⛔ Skill `diseno` antes del primer archivo. El permiso ya está repartido (§1 de este doc); no hace
falta uno nuevo.

### Fuera de capa · la sesión con contabilidad (necesita D1)

| # | Entregable | Criterio |
|---|---|---|
| `CP.8.55` | **Prueba A y B** según la hoja existente, con `Cargar sin Afectar` | Se anota cuál de los cuatro caminos de §27.3 ocurrió. **Cualquiera de los cuatro cierra el item**; sólo no cierra «no se hizo» |
| `CP.8.56` | **Enero real**: generar → importar sin afectar → marcar entregado → el cuadre lo encuentra | 88 pólizas en `aplicada`, importe al centavo contra `analytics.gl_polizas`, por token |
| `CP.8.57` | **Alias**: contabilidad confirma la lista de `CP.8.47` en la pantalla | `supplier_aliases` > 0, y el techo re-medido (`CP.8.48`) sube lo que la lista prometía |

---

## 8. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Sin persona que importe | Edgar / Dirección | D1 sin firmar | un nombre y 30 minutos |
| La prueba B falla por los `AD` | Desarrollo | el importador puede no honrarlos (§27.2, **NO MEDIDO**) | la bitácora `.xls` del importador; LC conserva `[LC.15]` |
| Pólizas duplicadas | Contabilidad | la contadora captura y además importa | D5 antes de `CP.8.56` |
| El 37.6 % no se mueve | Contabilidad | aprobar reglas es criterio contable | `[CP.8.14]` + tiempo del contador; no se automatiza |
| La imagen en prod no trae lo nuevo | Edgar | el despliegue automático está apagado (renglón del `crontab` comentado) | confirmar el mecanismo vigente antes de prometer una fecha |

---

## 9. Definición de Terminado

- [ ] 1. `poliza_exports` en `aplicada` **re-medido**: 0 → enero completo, antes/después publicado
- [ ] 2. Cada capa verificada o declarada NO MEDIDA (incluye `CP.8.46` con su placebo)
- [ ] 3. `CP.8.52` y `CP.8.53` ejercidos contra base real con el payload de la pantalla
- [ ] 4. Los candados nuevos rotos a propósito una vez
- [ ] 5. Ningún primitivo nuevo fuera de `libs/finance/src/lib/contpaqi/`
- [ ] 6. Tracker, `03_LOG_REVISIONES.md` y roadmap al día
- [ ] 7. En prod, o escrito qué falta

---

## 10. Bitácora

- **2026-10-20** — Escrito. Seis afirmaciones del plan de entrada re-medidas (§3). Ningún código
  tocado. Pendiente: D1–D5.
- **2026-10-20** — C0 medido (§3.1): `[CP.8.46]` ✅ los 581 son 93 % comisión de terminal mal
  clasificada, y los pagos de crédito **sí** están en ContPAQi, en una póliza mensual a fin de mes →
  D6 · `[CP.8.47]` ✅ 324 nombres, 14 hacen el 50 % · `[CP.8.48]` ✅ línea base ene–sep 5.9 %
  arma solo, con script versionado. `[CP.8.49]` sigue esperando la prueba A.
- **2026-10-20** — `[CP.8.58]` 🧪 el puente leía con un pool sin tenant: visto como `app_runtime`,
  bandeja con 0 lotes y cuadre ciego (reproducido en rojo, arreglado, 6 ✓). F1b en código:
  `[CP.8.50]` · `[CP.8.52]` · `[CP.8.54]` 🧪 — ⛔ la escritura sigue **NO MEDIDA** hasta que
  `test-newdb-contpaqi-entrega.js` corra en el job `pruebas-db`. §3.2 y §3.3.
- **2026-10-20** — F4 en código (§3.4): `[CP.8.51]` · `[CP.8.53]` · `[CP.8.14]` 🧪 — 6 reglas
  firmables que traban 9,757 movs ene–sep ($16.6M). Destapó `[CP.8.59]`: el archivo habría
  reenviado lo ya entregado; ahora sólo lleva lo pendiente. Escritura NO MEDIDA hasta `pruebas-db`.
