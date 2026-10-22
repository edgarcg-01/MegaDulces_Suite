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

## 3.5 ⛔⛔ `[CP.8.60]` El catálogo de asientos: el pago a proveedor que arma el puente es el 1.7 % de los reales

Medido sobre las **4,813 pólizas de egreso de ContPAQi de 2026** con abono a banco: 4,216 (87.6 %)
se ligan a su movimiento del banco por cuenta, ±3 días e importe exacto; placebo (fecha +45)
**2.2 %**. Los impuestos de cada pago se compararon contra el XML del CFDI: el traspaso es
**exactamente** el impuesto de la factura, y en pagos parciales va en proporción.

**Pago a proveedor** (1,853 pólizas, $349.0M = 81 % del dinero de egresos): 166 formas, 4 reglas
cubren el 64 %:

| | forma real | evidencia |
|---|---|---|
| R1 | factura ya provisionada → cargo `2120` + traspaso IEPS `1470100000`/`1470110000` e IVA `1060000000`/`1470040000` + abono banco | 99.6 % de las pagadas contra 2120 son de un mes anterior (1,416/1,421) |
| R2 | factura del mismo mes → cargo `5010`/`5020` del proveedor + IEPS/IVA acreditable directo | 817 facturas del mismo mes |
| R3 | nota de crédito en el pago → abono `5050`/`5060`/`5070` + reversa del impuesto | ejemplos con CFDI de egreso |
| R4 | cada renglón lleva el UUID de su CFDI | 98 % |

⛔ **El puente arma sólo «2120 / banco», sin traspaso ni UUID: 32 de 1,853 (1.7 %).** O sea que
los 958 pagos que «arman solos» (§39.1) **salen incompletos**. El armador ya lo declaraba
(`iva_traspaso: 'no_emitido'`), pero nadie había medido que es la norma y no la excepción. Hasta
que contabilidad apruebe R1–R4 y el armador las implemente, **no se entregan pagos a proveedor**.
Caso concreto: la póliza de prueba de 52,339.34 del 19-oct corresponde a una factura del 26-ago con
IEPS 3,876.99 → R1 → le faltaban dos renglones. No se importó.

~~⚠️ Sin explicar: 709 facturas de mes anterior se pagaron por R2.~~ ⭐⭐ **Explicado el mismo día —
lo propuso el usuario: el monto.** Sólo se provisionan (y se pagan contra `2120`) las facturas de
**$20 mil o más**. Medido sobre 4,508 facturas pagadas en 2026:

| factura | contra 2120 | compra directa 501/502 |
|---|--:|--:|
| ≥ 20 mil, mes anterior (2,382) | **98 %** | 2 % |
| < 20 mil, mes anterior (1,410) | 0 % | **100 %** |
| ≥ 20 mil, mismo mes (426) | 2 % | **98 %** |
| < 20 mil, mismo mes (290) | 0 % | **100 %** |

Y **501 vs 502 = la tasa de IVA del concepto**: de las facturas que sólo usan 501, 98.7 % son
100 % IVA 0 %; de las que sólo usan 502, 97.8 % son 100 % IVA 16 %; cuando usan las dos, 85 % se
reparten como las bases 0 %/16 % del CFDI. Con eso la regla del armador queda determinista desde
el CFDI (monto, mes, tasas), salvo lo que contabilidad corrija. La hipótesis anterior —«depende del
proveedor»— explicaba ~70 % y era un efecto: hay proveedores que facturan siempre poco.

**Los demás egresos:** cinco tipos con cuenta fija (seguros `5200530000`, caja de ahorro
`2140290000`, comisión bancaria `5200650000`, renta `5200510002`, traslado de valores
`5200680000`), dos con pasivo + intereses (factoraje, crédito), y el resto por sucursal (nómina,
IMSS), por concepto del CFDI (tarjeta) o mal clasificado en la Suite (servicios, impuestos, 676
sin categoría). ⚠️ **Caja de ahorro carga a pasivo `2140`**: `firma-regla.ts` hoy sólo acepta
gasto `52*` y la rechazaría — si contabilidad la aprueba, hay que ampliar la regla de firma.

### Respuestas de contabilidad (2026-10-21), contrastadas con el dato

| respuesta | el dato | efecto en el armador |
|---|---|---|
| el límite de $20 mil es regla, sobre el **total con impuestos** | corte exacto: 19,500–19,999 → 0 % a 2120; 20,000–20,499 → 100 %; 12 de esas 19 con subtotal < 20 mil van a 2120 | R1/R2 por `cfdi.total >= 20000` y mes de la factura |
| descuento vs devolución lo dice el uso del CFDI; si no, a mano o en Kepler | ⛔ **no alcanza**: 905 de 915 renglones de nota son G02 en las cuatro cuentas | la nota de crédito **no se arma sola** hasta medirlo en Kepler |
| Otros ingresos `4200010000` = diferencia de centavos pago vs factura | 304 de 334 < $1 (mediana 0.06); 30 ≥ $1, máx 118.18 | redondeo automático < $1; arriba, revisión |
| gasto sin factura → No deducibles, salvo créditos | 97 % de No deducibles sin CFDI | `5201000000` si no hay CFDI y no es crédito |
| nómina: póliza por registro patronal y sucursal, desglosada desde el auxiliar; IMSS mensual, Infonavit bimestral | el banco sólo trae el total | ⛔ **no derivable del banco**: necesita el auxiliar de nómina (ContPAQi Nóminas, `ctLFLG`, hoy sin leer — CP.9) |

Sigue sin respuesta **D5** (¿deja de capturarse a mano lo que entre por la Suite?).

### `[CP.8.61]` C0 de R1/R2: qué factura paga cada movimiento — medido con árbitro

R1/R2 necesitan la factura (total, mes, impuestos, UUID). El pago de Kepler no la trae; los REP
cubren 466 ligas y sólo desde julio. Método medido contra los UUID que la contadora asoció
(`database/scripts/liga-pago-factura-contpaqi.js`): **RFC + total ±$1**, factura de hasta 180 días
antes y **30 después** del pago, sin las ya pagadas, y si hay más de un candidato **no se elige**.

| pagos de proveedor 2026 (1,837 con UUID) | exacto | **error** | ambiguo | sin candidato |
|---|--:|--:|--:|--:|
| una factura (705) | **82.8 %** | **0.1 %** (1) | 6.5 % | 10.5 % |
| varias facturas (419), combinación única | 48.4 % | **1.7 %** (7) | 14.8 % | 35.1 % |
| con nota de crédito (713) | — no se arman solas — |||

Placebo (importe +$137): 0.0 %. ⛔ Lo que costó llegar ahí: la primera versión buscaba sólo
facturas **anteriores** al pago y erraba 1.7 %: en 8 de 10 la contadora asoció una factura emitida
**días después** del pago, de importe recurrente (p. ej. $128,222.22 mensuales). Abrir la ventana a
+30 días bajó el error a 0.1 %.

### `[CP.8.62]` ~~Por qué no se llega al 100 %: ningún sistema guarda qué facturas paga cada pago~~ ⛔ **REFUTADO el mismo día por `[CP.8.63]`: Kepler SÍ lo guarda (`kdxf`)**

> ⛔⛔ **Lo que esta sección concluyó está mal, y se deja escrito para que nadie lo reconstruya.** Se
> buscó en `kdm1`, `kdm2`, `kduf` y `kdfe*` y no en **`kdxe`/`kdxf`**, que la Fase ECA ya había
> decodificado el 2026-10-07 y que el propio comentario de `armarPagoProveedor` citaba. *El dato
> estaba en el repo; la búsqueda lo saltó.* Las filas del banco, REP y Tesorería siguen siendo
> ciertas; la de Kepler no. Ver `[CP.8.63]` abajo.

Pregunta del usuario: *«¿no podemos generar un 100 %?»*. Se buscó el dato en todas las fuentes,
re-medido hoy y no copiado de memorias:

| fuente | ¿dice qué facturas paga el pago? | medido 2026-10-21 |
|---|---|---|
| **Kepler, pago** (`kdm1` X-D-26/25/60) | **no** | 5,181 transferencias 2026: `c37`/`c39` (referencias) vacíos al 100 %; **0** renglones en `kdm2` |
| **Kepler, cartera** (`kduf`) | **no** — es de clientes | 34,698 de 34,942 filas con código de cliente; 27 con forma de proveedor |
| **Kepler, complementos** (`kdfe4pagm0`, `kdfe33pagm*`) | **no** — los emite Kepler por cobranza (`UA0701`) | lado clientes |
| **Banco** (`finance.bank_movements.concept`) | **no** | 6 de 4,858 pagos de compra mencionan una factura; el concepto es el nombre corto del proveedor |
| **REP del proveedor** (`fiscal.cfdi_payment_links`) | **sí, pero casi no existe** | 466 ligas, sólo desde julio |
| **Programa de Pagos de Tesorería** (`finance.payment_program.invoice_folios`) | **a medias** | 95 % con folios en agosto (339/358), pero texto libre (`f-484-486-487`): sólo **15.6 %** de jul–ago resuelve a sus CFDI; **0** ligados al banco; llegó a la Suite sólo hasta agosto |
| **ContPAQi** (la póliza de la contadora) | **sí** | es lo que se quiere automatizar: el dato lo pone ella **a mano**, leyendo las facturas que vienen con la solicitud de pago («PAGO FACT 3512») |

⭐ **Conclusión:** la decisión «este pago liquida estas facturas» la toma una persona y **sólo queda
escrita en papel o en el Excel de Tesorería**. Todo lo que hace el puente es **reconstruirla por
importe**, y esa reconstrucción tiene techo.

**Dónde cae cada pago** (1,837 pólizas de pago a proveedor 2026 con UUID y un solo banco):

| caso | pólizas | % | por qué no se arma solo |
|---|--:|--:|---|
| una factura, candidato único y correcto | **584** | **31.8 %** | — **se arma solo** |
| una factura, ambiguo | 46 | 2.5 % | el mismo proveedor tiene varias facturas abiertas con el mismo importe (recurrentes) |
| una factura, sin candidato | 74 | 4.0 % | lo pagado ≠ total de la factura (pago parcial, descuento sin nota, diferencia > $1) |
| una factura, equivocada | 1 | 0.1 % | pago parcial que coincidió con otra factura exacta |
| varias facturas, combinación única y correcta | 203 | 11.1 % | se puede **proponer**; no armar solo porque la combinación erra 1.7 % |
| varias, combinación equivocada | 7 | 0.4 % | dos combinaciones distintas suman lo mismo y sólo una existe abierta en la ventana |
| varias, más de una combinación | 62 | 3.4 % | ídem, sin forma de elegir |
| varias, ninguna combinación | 147 | 8.0 % | pago parcial, más de 6 facturas, o factura fuera de la ventana |
| **con nota de crédito** | **713** | **38.8 %** | pago = facturas − notas, y si la nota es descuento o devolución no lo dice el CFDI (905/915 son G02) |

Los pagos de **remisión** («rem cueritos», «rem piñatas») no aparecen en estas cifras: salen de
Caja General, no de banco, y no tienen CFDI.

**Lo que lleva al 100 %, de más barato a más caro:**
1. **Armar solo lo seguro (31.8 %) y proponer el resto** con un clic de la contadora → el 100 % de
   los pagos pasa por la Suite, pero no el 100 % sin manos.
2. **Que la decisión quede registrada donde nace**: cuando Tesorería programa el pago, elige las
   facturas **de la lista de CFDI** (no folios en texto libre). El módulo existe
   (`finance.payment_allocations`, 13 registros) y Tesorería ya lo hace en Excel en el 95 % de los
   casos: es mover ese paso, no inventarlo. Con eso la liga es **exacta por construcción**.
3. **Notas de crédito**: medir en Kepler (`X-D-55` nota, `X-D-40` devolución de compra) si se
   distingue descuento de devolución; si sí, entran a la combinación.

### ⭐⭐ `[CP.8.63]` La cadena estructural: banco → pago Kepler → entradas (`kdxf`) → CFDI

`database/scripts/cadena-pago-kepler-contpaqi.js`. El UUID sale **sólo** de Kepler y del CFDI; la
asociación de la contadora se usa para calificar, nunca para resolver.

```
banco (Banorte 3041 · 19-oct · 52,339.34)
  │ L1  c45 del pago = últimos dígitos de la cuenta · importe ±$1 · fecha Kepler −2…+7 días
pago Kepler X-D-26 0023458 (20-oct · 52,339.13)
  │ L2  kdxf: «el cargo (pago) se aplicó al abono (documento) por c10» — estructural
entrada X-A-20 0009546 (4-sep · 52,339.13 · referencia «0-F-2734»)
  │ L3  RFC del acreedor + total ±$1; si no, el folio de la referencia (≤ 3 % de diferencia)
CFDI folio 262734 (26-ago · 52,339.34) → UUID
```

| eslabón | resultado (1,837 pólizas de pago a proveedor 2026) |
|---|---|
| L1 banco → UN pago Kepler | **89.5 %** · placebo (+$137) **0.0 %** |
| L2 pago → entradas (`kdxf`) | **89.0 %** |
| L3 entrada → CFDI | el cuello: 45 % de las entradas tienen el acreedor **sin RFC** en `kdxd` (149 acreedores se recuperan por el nombre de su CFDI); el folio de la referencia liga 1,186 entradas que el importe no |
| **cadena completa** | **911 correctas (49.6 %) · 55 con otras facturas (3.0 %)** |
| **+ compuerta «Σ facturas − Σ notas = pagado»** (no mira la respuesta) | se armarían solas **712**: 700 correctas y **12 con otras facturas = 1.7 % de lo armado** (0.7 % del universo) · 254 a revisión, de las que 211 eran correctas · 871 con la cadena cortada |

De los 55 errores sin compuerta, **37 son desacuerdos entre Kepler y la contadora**, no del método:
21 pagos en que Kepler aplicó **más** facturas de las que ella asoció y 16 en que aplicó **menos**.

**Por qué todavía no es 100 %, ahora sí con causa:**

| dónde se corta | magnitud | qué lo destraba |
|---|---|---|
| la nota de crédito no encuentra su CFDI de egreso | 211 cadenas correctas frenadas por la compuerta; sólo 83 de 667 notas casan | ligar `kdxe` 55/40 → CFDI `E` igual que las facturas (RFC + importe + referencia); y Kepler ya distingue **nota (X-D-55)** de **devolución (X-D-40)** — lo que contabilidad pidió revisar |
| entrada sin CFDI que cuadre | ~1,500 entradas | descuento al facturar, varias facturas por entrada, o el proveedor no factura (remisión) |
| acreedor sin RFC en Kepler | 97 pólizas | dar de alta el RFC en `kdxd` (es un dato de catálogo, una vez por proveedor) |
| pago del banco sin pago en Kepler | 183 pólizas (10 %) | se capturó tarde, en otra cuenta de tesorería, o no se capturó |
| Kepler y la contadora no coinciden | 37 pólizas | revisión: una de las dos está mal, y hoy nadie lo ve |

**Lo que cambia del plan:** la propuesta a Tesorería (`[CP.8.62]`, paso 2) **deja de ser necesaria**:
la decisión «qué facturas paga» ya queda registrada en Kepler cuando Mayra aplica el pago. Lo que
falta es leerla bien. Siguiente medición: notas de crédito por la misma cadena, y la unión con
`[CP.8.61]` (dos métodos independientes: si coinciden se arma, si discrepan a revisión).

**Decisión de diseño que se propone:** armar sola sólo «una factura, candidato único»
(**584 pagos, 32 %**); las combinaciones van como **propuesta a confirmar** en pantalla; nota de
crédito, ambiguo y sin candidato, a revisión.

El documento con el detalle y las aprobaciones (privado, con nombres de proveedores) es el doc
«Catálogo de asientos de egresos de banco». Script de la medición: no versionado, en el scratchpad
de la sesión (`catalogo-formas.js`); se versiona cuando se implemente R1–R4.

### ⭐⭐ `[CP.8.64]` El ADD de ContPAQi ya trae las dos ligas: REP del proveedor y nota → factura

`database/scripts/rep-add-pago-factura-contpaqi.js` (sólo lectura; cruza con la salida de la cadena).
Buscando cómo ligar la nota de crédito apareció que el **ADD** (la base de metadatos de CFDI de
ContPAQi, de donde ya sale `fiscal.cfdis`) tiene dos tablas que la Suite **no lee**:

| tabla del ADD | qué es | volumen | por qué no la vimos |
|---|---|---|---|
| `Pagos` + `Pagos_Doc_Rel` | el **complemento de pago (REP) que emite el proveedor** al cobrarnos una factura PPD: UUID de cada factura liquidada, `ImpPagado`, `ImpSaldoAnt`, parcialidad | 3,293 pagos desde dic-2025, 266 RFC | el feed del ADD sólo trae tipos `I,E`; los 176 `P` de `fiscal.cfdis` son de descarga masiva, de julio. ⛔ La cifra «466 ligas REP» de `[CP.8.61]` medía **esa** fuente, no ésta |
| `CfdiRelacionados` | la nota de crédito relaciona **por SAT** la factura que afecta (tipo 01 / 03) | 52,158 renglones; 97 % de las notas 2026 lo traen | `fiscal.cfdis.xml` sólo está en 129 de 2,995 notas — por el XML no se llega |

**Contra la contadora (1,837 pólizas de pago a proveedor 2026):**

| | resultado |
|---|---|
| banco → **un** REP (mismo RFC, monto ±$1, fecha de pago ±5 días) | **1,467 (79.9 %)** · placebo +$137 **0** |
| facturas del REP = facturas de la contadora | **1,424 de 1,467 (97.1 %)** |
| notas de la contadora relacionadas a una factura de la **misma** póliza | **728 de 739 (98.5 %)** |
| **póliza completa** (facturas + la única combinación de notas que cuadra con lo pagado) | **1,257 correctas (68.4 %)** · **18 distintas = 1.4 % de lo armado** |
| no cuadra con lo pagado | 186 — **174 son pagos parciales** (142 con las facturas correctas), 8 notas aplicadas en un pago anterior, 4 otros |

⚠️ **La nota se califica por IMPORTE, no por UUID.** La contadora junta varias notas en un renglón y
le pone el UUID de **una** (o de ninguna): en la póliza 1|109 las seis notas del método suman
$23,784.74, exactamente sus renglones 505/507 más la reversa de 1060/1470100, y ella asoció un UUID.
Calificar por UUID daba 205 «errores» que eran 18. **Consecuencia para el puente:** nuestro asiento
llevará el UUID de **cada** nota; es más completo que el de hoy, y eso hay que decírselo a contabilidad
antes de que lo lea como diferencia.

**Los dos métodos son independientes y casi nunca se contradicen** (facturas):

| | pólizas | contra la contadora |
|---|---|---|
| REP y cadena Kepler completos y **coinciden** | 670 | 667 iguales · **3 distintas (0.4 %)** |
| completos y **difieren** | 16 | el REP acierta **16 de 16** |
| sólo el REP | 589 | 585 · 4 distintas |
| sólo la cadena Kepler | 280 | 244 · **36 distintas (13 %)** → la cadena sola **no** se arma sin confirmar |
| ninguno | 282 | — |

**El costo: el REP llega después del pago.** Timbrado respecto de la fecha de pago (3,293 REP):
mismo día 9 % · 1–3 días 42 % · 4–7 días 20 % · 8–15 días 14 % · 16–31 días 11 % · más de 31 días 5 %.
El SAT lo exige a más tardar el día 5 del mes siguiente, y el archivo del puente es **mensual**
(`generarArchivoMes`). Medido sobre los 3,187 REP de pagos hasta septiembre: timbrados **al día 5 del
mes siguiente 88.5 %**, al día 10 **91.8 %**, después 8.2 %. Armar el mes el día 10 deja fuera ~8 %
(a confirmar, o al archivo del mes siguiente). Para un armado **diario** la fuente sería la cadena
Kepler, con confirmación.

**Por qué no es 100 %, con este método:**

| dónde se corta | pólizas | qué lo destraba |
|---|---|---|
| pago parcial | 174 | asentar la parte pagada (`ImpPagado` del REP, proporcional, como la póliza 1\|122): medir antes de armar — 32 de 174 traen otras facturas |
| el proveedor no emite REP (factura PUE, de contado) | 121 pólizas de RFC que no emiten nunca | la cadena Kepler o `[CP.8.61]` por importe, **con confirmación** |
| REP ambiguo o sin REP en la ventana | 249 (55 ambiguos) | REP tardío o pagos iguales del mismo proveedor — NO MEDIDO por separado |
| nota aplicada en un pago anterior | 8 | `ImpSaldoAnt` < total de la factura ya lo marca |

⛔ **Lo que este hallazgo NO resuelve todavía:** el ADD es SQL Server de ContPAQi, **no** `kepler_ods`.
Hoy llega a la Suite por `import-contpaqi-cfdis.js`, que es un importer (regla 1: se están retirando).
Traer `Pagos_Doc_Rel` y `CfdiRelacionados` a Postgres es **D8** — no se arma nada con esto hasta firmarla.

## 3.6 ⭐⭐ `[CP.8.65]` El expediente: todo lo que hace falta para asentar un pago a proveedor, medido

Pedido del PM el 2026-10-21: *«antes de que armemos algo, tener a la mano toda la información»*. La
prueba no es una lista de fuentes sino **reconstruir las pólizas reales**:
`database/scripts/reproduce-asiento-proveedor-contpaqi.js` asienta las 1,907 pólizas de pago a proveedor
de 2026 desde las fuentes y las compara renglón por renglón con las de la contadora. Para separar la
**regla** de la **liga**, las facturas son las que ella asoció; la liga se midió aparte (§3.5, `[CP.8.63]`,
`[CP.8.64]`).

**Resultado: 1,435 de 1,907 pólizas (75.2 %) salen iguales** (renglón ±$0.02, o Σ por cuenta cuando
ella juntó notas). Cómo se llegó: v1 72.5 % → v2 89.1 % del pago completo al corregir la base del
16 % y el redondeo → v3 suma notas juntadas y pagos parciales.

### Pieza por pieza

| pieza del asiento | fuente | medido | lo que falta |
|---|---|---|---|
| qué facturas paga | REP del proveedor (ADD) · cadena Kepler `kdxf` · importe | REP 97.1 % · coinciden REP y Kepler 670/686 | D8 (traer el ADD) · los proveedores que no emiten REP |
| **2120 o compra directa** | CFDI: total ≥ $20 mil y mes anterior | coincide con la provisión real de ContPAQi en **2,771 de 2,807 facturas (98.7 %)** | 36 facturas de frontera (40 pólizas) |
| traspaso IEPS `1470100/1470110` e IVA `1060/1470040` | CFDI `impuestos` | exacto donde aplica R1 | — |
| **5020 vs 5010** | base al 16 % del CFDI (`subtotal_iva_16`) · el residuo < $1 **no** abre renglón 5010 | exacto salvo 8 pólizas | 8 en que ella puso todo a 5020 con factura mixta |
| cuenta del proveedor | `finance.gl_supplier_accounts` por RFC | 33 pólizas **sin cuenta** en el mapa · 15–17 con cuenta **distinta** | corregir el mapa: es dato, una vez por proveedor |
| **nota: descuento o devolución** | ADD `CfdiRelacionados.TipoRelacion` (`[CP.8.66]`) | **03 = devolución: 704 de 768 (91.7 %)**. El uso del CFDI no sirve (casi todas G02); Kepler liga 90 de 768; el historial del proveedor da 87.1 % | 64 notas que ella clasificó distinto: **pregunta para contabilidad** |
| nota: tasa 0 % / 16 % | CFDI de la nota | 5050/5060 = 0 %, 5070/5080 = con IVA; las mixtas se parten | — |
| notas que ella junta sin UUID | ADD: notas relacionadas a las facturas del pago | 192 de 236 se reconstruyen | nuestro asiento llevará **el UUID de cada nota**: avisarle que no es diferencia |
| pago parcial | REP: `ImpPagado` de cada factura, proporcional | 47 de 85 | 29 sin REP (de contado o tardío) |
| parcial con nota | REP: nota = total − pagado de cada factura (H3) | 24 de 83 | **59 sin regla**: proveedores de mucho volumen (uno tuvo 62 notas en dos meses) |
| redondeo | diferencia a favor → abono `4200010000`; en contra → cargo `5201000000` | exacto | — |
| tarjeta de crédito `2140800000` | — | 8 pólizas con cargo y abono iguales | regla sin medir |
| varios bancos en una póliza | — | 76 pólizas | se arman por banco; sin medir |

### Las cinco preguntas, contestadas con el dato donde se pudo (`[CP.8.69]`, 2026-10-21)

Pedido del PM: *«revisa si podemos responder esas preguntas nosotros»*. Cuatro de cinco sí.

| # | pregunta | respuesta | evidencia | queda para contabilidad |
|---|---|---|---|---|
| 1 | ¿devolución o descuento? | **regla «relación 03 = devolución»**, y no importa para impuestos | coincide en 704 de 769 (91.7 %). De las 64 que difieren: 24 son producto (tenía razón ella), 29 bonificación (la regla), 11 sin evidencia. Agregar «conceptos de producto» **empeora** (662): 73 descuentos de ella listan producto. Sus devoluciones 2026 suman $0.92 M y las devoluciones de compra de Kepler (X-D-40) $1.16 M: su criterio se parece a la salida física, pero Kepler no liga 1 a 1 (sus X-D-55 suman $59.5 M contra $23.3 M de notas CFDI: registra notas internas sin CFDI). **La reversa de IVA/IEPS es idéntica en las dos familias**: el error posible es de reparto dentro de compras netas, no fiscal | sólo confirmar que el reparto 5050/5060 no se usa para nada fuera de la balanza |
| 2 | factura mixta 0 %/16 % | **siempre partir** por la base del CFDI | es lo que ella hace en 98 de 102; las cuentas se llaman «compras al 0 %» y «compras c/IVA»; la DIOT separa por tasa | — |
| 3 | parcial con nota: ¿qué notas entran? | **no se pudo del todo** | Kepler explica el importe de notas en **326 de 638** pólizas con nota (51 %): son las que Mayra aplicó en `kdxf` a las mismas entradas del pago; el REP por factura explica 23 de 82 parciales. «Todas las notas desde el pago anterior»: 0 | ¿siguen lo que se aplicó en Kepler? Si sí, Kepler es la fuente y lo que no coincide es diferencia a revisar |
| 4 | tarjeta de crédito `2140800000` | **pago de tarjeta: cargo 2140800000 / abono banco**; si se conocen las facturas pagadas con la tarjeta, además cargo compra / abono 2140800000 (de ahí el «par neutro») | en 69 de 90 pólizas el banco dice «TDC AMEX» / «TDC BANORTE»; el concepto es «PAGO TARJETA DE CRÉDITO (…)» o «PAGO FACT … (TARJETA)» | — |
| 5 | UUID de cada nota | **decisión nuestra, no pregunta**: un renglón por nota con su UUID | ella junta varias en uno; el resultado contable es el mismo | **avisarles**, para que no lo lean como diferencia |

**Efecto en el armador:** se arma lo que tiene respuesta (1, 2, 4, 5); lo de la 3 va a «confirmar en
pantalla» mostrando lo que Kepler aplicó.

### `[CP.8.67]` Lo que dice el histórico (2025 + 2026 previo, calificado en 2026)

`database/scripts/patrones-historicos-contpaqi.js`. Cada predicción usa **sólo** lo anterior a la póliza
que se califica. Pedido del PM: *«busquemos o hagamos un patrón de los históricos»*.

| hueco | regla sin historia | con el histórico | qué se adopta |
|---|---|---|---|
| **cuenta del proveedor** | mapa `gl_supplier_accounts`: 98.4 % | **la cuenta ya usada con ese RFC: 5,549/5,563 (99.7 %)**; cubre 56 de 67 sin mapa con 0 errores y corrige 76 de 91 errores del mapa | **histórico primero, mapa de respaldo** (es la vía B de `[CP.8.20]`, `contpaqi.supplier_accounts`) |
| descuento o devolución | relación 03: 91.6 % | proveedor con ≥ 3 notas y 90 % de pureza: **90.3 %** — peor | la regla |
| 2120 o compra directa | 20 mil + mes anterior: 98.6 % (68 errores) | ningún proveedor se desvía de forma consistente: 0 correcciones | **la provisión real del mes** (abajo) |
| factura mixta 0 %/16 % | partir por base: 98 de 102 | sin cambio | la regla |
| parcial con nota | — | por factura con el REP (H5): 23 de 82 con umbral 30 % elegido **sobre los mismos datos** (sobreajuste posible); «todas las notas desde el pago anterior»: 0 de 143 | **a confirmar en pantalla**; ~59 sin regla |
| sin banco | — | las 44 abonan a Financiera Bajío `2140420000`: es **factoraje**, otro flujo | fuera de pago a proveedor |
| tarjeta de crédito | — | par neutro: cargo y abono a `2140800000` por el mismo importe, junto a la compra normal | preguntar cuándo lo agrega |

### ⛔ `[CP.8.68]` Hallazgo para contabilidad: compras provisionadas que se volvieron a registrar al pagarse

Cada mes hay **una** póliza de provisión (diario, abono 2120 por factura). Al buscar por qué 68 facturas
no siguen la regla de 20 mil apareció otra cosa (`database/scripts/doble-registro-provision-contpaqi.js`):

| pagos desde feb-2025 | facturas |
|---|--:|
| pagadas como compra directa (cargo 501/502 contra banco) | 5,394 |
| … que ya estaban en la provisión de su mes | 61 |
| … cuya provisión **nunca** se canceló (ningún cargo a esa cuenta 2120 por ese importe) | **54 · $8,204,062.77** |

Concentradas en **abril de 2026 (33)** y **junio de 2025 (9)**: los pagos que siguen al cierre con
provisión. En las 31 cuentas 2120 de esos proveedores no hay **ningún** cargo en diario en 2026, así que
no hubo una reversa global; dos cuentas quedan abiertas **exactamente** por el importe de una de esas
facturas ($83,682.18 y $25,921.80). Si se confirma, la compra quedó registrada dos veces y el 2120 quedó
abierto. ⚠️ La provisión no trae UUID: el cruce es por cuenta + importe exacto en el mes, fuerte pero no
estructural. **Lo verifica contabilidad; nada se corrige desde la Suite (ADR-040).**

**Consecuencia para el armador:** la regla R1/R2 se decide por **«¿la factura está en la provisión de su
mes en ContPAQi?»** (y la regla de 20 mil sólo si esa provisión todavía no existe). Así el puente no repite
el doble registro: lo que esté provisionado se paga contra 2120, siempre.

### ⭐⭐ `[CP.8.70]` El número real: de punta a punta, sin oráculo

Todo lo anterior separaba liga de asiento y, en el método REP, tomaba el RFC de las facturas de la
contadora. `database/scripts/punta-a-punta-proveedor-contpaqi.js` parte **sólo** del movimiento de banco
(cuenta, importe, fecha) y arma la póliza completa con las reglas adoptadas arriba; la de la contadora
sólo califica.

| 1,831 pólizas de pago a proveedor 2026 con un banco | pólizas | |
|---|--:|---|
| **se arman solas** | **948 (51.8 %)** | iguales 868 · distintas 80 = **8.4 % de lo armado** |
| a confirmar en pantalla (parcial o notas juntadas, por factura con el REP) | 443 | la propuesta ya acierta en 246 |
| sin REP y con la cadena Kepler incompleta | 298 | proveedores de contado o que no emiten REP; acreedor sin RFC en Kepler |
| sin proveedor (ni Kepler ni un REP único) | 74 | |
| no cuadran con lo pagado | 51 | |
| sin cuenta (ni historia ni mapa) · REP ambiguo | 9 · 8 | |

**Las 80 distintas no son 80 errores nuestros:**

| causa | pólizas | quién está bien |
|---|--:|---|
| estaba en la provisión del mes y ella la pagó como compra directa (`[CP.8.68]`) | 11 | **el puente**: no repite el doble registro |
| par neutro de tarjeta `2140800000` | 5 | igual en saldos; falta agregar el par cuando el banco dice TDC |
| factura mixta que ella no partió | 4 | **el puente** (lo que ella hace en 98 de 102) |
| descuento vs devolución | 16 | discutible y **sin efecto fiscal** |
| otros, casi todos centavos de la base al 16 % (≤ $0.10) | 18 | sin efecto material |
| **error del puente**: otras facturas (8), frontera 2120 (11), cuenta (3), anticipo 1050 (4) | **26** | **2.7 % de lo armado** |

Dos reglas salieron de esta corrida: (1) **2120 = regla de 20 mil O provisión del mes** — empata con la
regla sola contra la contadora (743 iguales en pago completo) y además evita el doble registro; la
provisión sola daba 728; (2) **el camino «REP por factura» no se arma solo**: armado, acertaba 237 de
443 (53 %).

**Lo que esto le da a D5** (¿qué deja de capturar la contadora?): hoy, la mitad de los pagos a
proveedor saldría armada con 2.7 % de error nuestro, y otra cuarta parte como propuesta para confirmar.
El techo lo ponen el REP (D8) y el RFC de los acreedores en Kepler.

### ⭐ `[CP.8.71]` Lo que no se armaba: el RFC de Kepler está mal capturado

Al abrir los 298 «sin REP y cadena incompleta», **249 tenían el proveedor identificado con otro RFC**:
el de `kdxd.c10` no existe como emisor de CFDI. No es otra empresa: es captura — dedazos (PCP920**5**23**H**QA
por PCP920**4**23**K**QA, DC**9** por DC**P**, CF**0** por CF**C**), guiones y cortado («CCO-820507-BV»), o el RFC de
una persona física en el acreedor de un proveedor grande. Con ese RFC el paso L3 de la cadena no encontraba
el CFDI: era el grueso de las 1,545 «factura sin CFDI».

**Reparación** (en `cadena-pago-kepler-contpaqi.js`, sólo si el resultado es único): RFC tal cual → sin
guiones → a ≤ 2 ediciones de un emisor → por el nombre del acreedor. De 795 acreedores: 242 tal cual, 1 por
formato, 23 por parecido, 160 por nombre, **369 sin resolver** (un dato de catálogo para Compras).

Y dos respaldos en el simulador: el **proveedor por el nombre** que tesorería escribe en el concepto del
banco («Grupo Confitero de Dulces de Occidente»; acierta 46 de 50 — `contpaqi.supplier_aliases` está
**vacía**, nadie confirmó alias) y las **facturas por importe** (`[CP.8.61]`) cuando no hay REP ni cadena.

| de punta a punta (1,831) | antes | con `[CP.8.71]` |
|---|--:|--:|
| cadena Kepler completa e igual a la contadora | 701 | **855** (errores 12 → 14) |
| **se arman solas** | 948 (51.8 %) | **1,142 (62.4 %)** |
| iguales a la contadora | 868 | **1,051** |
| error del puente | 26 (2.7 %) | **29 (2.5 %)** |
| a confirmar (parcial / notas juntadas) | 443 | 505 (279 ya correctas) |
| sin armar | 440 | 184 |

⛔ Probado y descartado: armar el parcial cuando «la nota que propone el REP = la que aplicó Kepler» —
de 182 así, 107 iguales (59 %). Coincidir en el importe de la nota no asegura el asiento.

**Qué sube el techo ahora:** (1) D8 (el REP en la Suite), (2) **corregir el RFC de 369 acreedores en Kepler**
— una vez por proveedor —, (3) que Tesorería escriba el nombre del proveedor en el concepto (ya lo hace).

**De los 369, sólo 125 recibieron pagos en 2026 ($69.8 M)**, y no todos son problema de RFC (lista privada
para Compras, con nombres, fuera del repo):

| grupo | acreedores | pagado 2026 | qué es |
|---|--:|--:|---|
| RFC correcto confirmado por las facturas de la contadora | 14 | $29.98 M | capturarlo en Kepler (2 traen el RFC de **otra razón social**) |
| candidato por nombre (parecido 50–60 %) | 7 | $4.02 M | confirmar; varios parecen otra persona |
| **sin CFDI, pagados en efectivo desde Caja General** (`c45 = 0011`) | **103** | **$35.67 M** (2,725 pagos) | proveedores de **remisión**: no facturan (confirmado por el PM) |
| sin CFDI, pagado por banco | 1 | $0.12 M | revisar |

⛔ **Hallazgo para contabilidad:** ninguno de esos 2,725 pagos en efectivo tiene póliza en ContPAQi por su
importe, y la cuenta `1010000000 CAJA` registra sólo **$471,739** de salidas en todo 2026. Las compras en
efectivo con remisión **no llegan a la contabilidad**. Si es a propósito o falta registrarlas lo decide
contabilidad; el puente (bancos) no las toca — son del flujo de Caja General (fase CGA).

### `[CP.8.72]` Lo que se arma hoy, sin D8 — y el armador en `libs/`

Sin nada del ADD (ni REP, ni nota → factura, ni tipo de relación), sólo con Kepler, `fiscal.cfdis` y la
historia de ContPAQi que ya están en Postgres:

| fuente de las facturas | iguales | distintas | ¿se arma solo? |
|---|--:|--:|---|
| cadena Kepler (`kdxf`, RFC reparado) | 770 | 92 | sí |
| importe, una factura (+ proveedor por nombre) | 107 | 7 (6 %) | sí |
| importe, combinación | 46 | 27 (**37 %**) | **no**: a confirmar |
| **total que se arma sin D8** | **877** | **99** | 976 pólizas (53.3 % de 1,831) |

Con D8 serían 1,142 (62.4 %) con 2.5 % de error del puente: el REP aporta las facturas de 940 de ellas y
la nota → factura de las que llevan nota. **Sin D8 se puede empezar; con D8 se termina.**

**El armador (C1, en código):** `libs/finance/src/lib/contpaqi/pago-proveedor.ts` (el asiento completo: R1/R2,
notas, redondeo, compuerta «no cuadra → a confirmar», UUID por factura y nota para los renglones `AD`) y
`rfc-acreedor.ts` (la escalera de `[CP.8.71]`). Puros, como `poliza-egreso.ts`. 23 casos en
`pago-proveedor.spec.ts`, dos mutados a rojo (provisión, residuo de centavos). ⭐ **Cruzado contra el
simulador: 1,143 de 1,143 pólizas idénticas renglón por renglón**, todas cuadran.

**Integrado (C1→C3, 2026-10-21):** `pago-proveedor.fuente.ts` resuelve cada movimiento sin el ADD (cruzado
contra el simulador `SIN_ADD`: 976 de 977 armadas idénticas) y `construirLotes` saca el pago a proveedor del
lote del día: **una póliza por pago** (`bank_pago_proveedor`, con sus `AD`), y lo que no se arma queda contado
en su lote con motivo — ya no sale nunca «2120 / banco». Ejercido contra prod con conexión de sólo lectura:
septiembre **91 pagos completos ($12.76 M)** de 184 (55 a confirmar, 30 no cuadran, 8 sin identificar), enero
**108 ($18.29 M)**; cero lotes con la forma incompleta, mismo resultado dos veces, `poliza_exports` sin escribir.
⚠️ Deudas con nombre: la carga del mes tarda 4.4 s (1.5 s con la caché de 10 min) medido desde la laptop, en el
clúster **NO MEDIDO**; el job `pruebas-db` no ejerce la fuente (sus siembras son `por_categoria`).

### `[CP.8.73]` Confirmar qué facturas paga un pago (2026-10-21)

Los pagos que no se arman solos se confirman en la pantalla («Pagos a proveedor por confirmar»). **Medido
antes de construirla**, sobre 761 pagos «a confirmar» con la respuesta de la contadora: sus facturas están
**todas** entre las candidatas en **697 (91.6 %)**; la sugerencia acierta exacta en **297 (39 %)** (Kepler 65 %,
importe 54 %) y hay **19 candidatas por pago en la mediana** (p90 98). Por eso: lo sugerido primero, la
sugerencia **no se preselecciona** (botón «usar la sugerencia»), la cuenta *facturas − notas = pagado* a la
vista, y «Confirmar» sólo se habilita si cuadra; el servidor lo vuelve a exigir (409 con motivo).

Se guarda en `contpaqi.pago_confirmaciones` (migración `20261021181119`, **sin aplicar en prod**: el armado
degrada con aviso mientras no exista), con autor y el importe al confirmar; el armado usa la vigente y no la
aplica si el movimiento cambió de importe. ⛔ Una verificación encontró que la sugerencia de Kepler podía
quedar **fuera** de las candidatas (factura vieja o ya pagada): corregido, lo sugerido siempre se lista y lo
ya pagado se advierte. Prueba `test-newdb-contpaqi-confirmacion.js`: el modo que escribe corre en `pruebas-db`
(**NO MEDIDO** aquí); prod sólo lectura, septiembre 93 por confirmar.

### `[CP.8.75]` La pantalla tardaba más de 500 ms — medido en el servidor (2026-10-22)

Reporte del PM: «la pantalla tarda más de 500 ms». **Confirmado, y no por la red.** Al abrir, la pantalla pide
lotes, proveedores pendientes, reglas, cuadre y pagos a la vez; **cuatro** de esas llamadas leían los egresos
del mes con `to_char(movement_date) = ?` en el WHERE, que anula el índice. Tiempo de **servidor**
(`EXPLAIN ANALYZE`, `TIMING OFF`, pg-prod, sólo lectura): **915–1,043 ms cada una** → con rango sargable y el IVA
hermano por `DISTINCT ON`, **45–87 ms** (mediana 974 → 58, 6 corridas alternadas). Filas idénticas en 12 meses.

| Pieza | Antes | Después | Cómo |
|---|---|---|---|
| Egresos del mes (×4 por carga) | 974 ms servidor | 58 ms | rango + `DISTINCT ON` (`f057f2bcf`) |
| Fuente de pagos (lotes y pagos) | ~1.1 s servidor, ×2 si llegan juntas | 0 al abrir | carga compartida + precalentado cada 9 min por pod (`2ae8f53cb`) |
| Sugerencias de proveedor | 335–441 ms de JS | una pasada | palabras del padrón calculadas una vez |

⚠️ **Lo que NO se midió: el tiempo dentro del pod.** La lectura dentro del pod no se autorizó. Desde la laptop
domina el traslado (8,826 filas: 8 ms de servidor, 658 ms en llegar), así que esos tiempos no describen al
usuario. Se mide en el navegador tras desplegar (pestaña Red, las 5 llamadas de la carga).

### `[CP.8.76]` La pantalla era muy complicada: asistente de cuatro pasos (2026-10-22)

Reporte del PM: «la interfaz es muy complicada de entender». Diagnóstico: **conflación** — contestaba siete
preguntas en un scroll (diez bloques, seis tablas) — y **ruido**: prosa para quien la programó, códigos internos,
símbolos de alerta en el texto. El PM eligió un asistente por pasos. Arriba la respuesta (pólizas listas e
importe, y qué falta en una frase); luego **1 reglas · 2 proveedores · 3 pagos · 4 revisar y entregar**, cada paso
con lo que le queda; abre en el primero con trabajo. `check:pantalla`: de 2 fallas en deuda (§2, §9) a 0.
Commit `70ff5b1d7`. **Sin validación visual.**

### Fuera de este expediente

Los egresos que **no** son pago a proveedor (19 % del dinero) siguen al nivel del catálogo (§3.5):
cinco con cuenta fija, factoraje y crédito con pasivo e intereses, y nómina/IMSS **no derivables del
banco** (necesitan el auxiliar de nómina, CP.9).

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

| **D8** | **¿Cómo llegan a la Suite el REP del proveedor y la relación nota → factura del ADD?** (sale de `[CP.8.64]`) | (a) sumar `Pagos`/`Pagos_Doc_Rel`/`CfdiRelacionados` al feed del ADD que ya llena `fiscal.cfdis` · (b) leerlas en vivo por `tds_fdw` como **vista** (derivar, no copiar) · (c) no usarlas y quedarse con la cadena Kepler | **(b) si el servidor de ContPAQi lo aguanta; si no, (a)** como extensión del feed que ya existe, declarada como deuda del mismo importer — no uno nuevo. **(c) deja sin armar las 589 pólizas de 2026 (~60 al mes) que sólo resuelve el REP, y la cadena sola trae 13 % de error donde no hay REP.** Cualquiera de las dos primeras rompe la letra de la regla 1 (no es ODS): por eso va a firma | Edgar |

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
| `[CP.8.76]` | **Asistente de cuatro pasos** (reglas · proveedores · pagos · entregar) | 🧪 2026-10-22 (§3.6) | 2 en deuda → 0 |

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
- **2026-10-21** — `[CP.8.64]` C0: el ADD de ContPAQi trae el REP del proveedor (`Pagos_Doc_Rel`)
  y la relación nota → factura (`CfdiRelacionados`). Póliza completa igual a la contadora en
  1,257 de 1,837 (68.4 %), 1.4 % de error sobre lo armado; cruzado con la cadena Kepler coinciden
  670 de 686. Abre **D8** (cómo entran esas tablas sin importer nuevo). Nada se arma hasta firmarla.
- **2026-10-21** — `[CP.8.65]` expediente del pago a proveedor (§3.6): 1,435 de 1,907 pólizas se
  reconstruyen igual que la contadora desde las fuentes (75.2 %). `[CP.8.66]` devolución vs descuento
  = `TipoRelacion` 03 del CFDI (91.7 %). Cinco preguntas para contabilidad antes de armar.
- **2026-10-21** — `[CP.8.67]` patrones del histórico: la cuenta del proveedor sale del uso previo con
  ese RFC (99.7 %); para lo demás el histórico no mejora la regla. `[CP.8.68]` hallazgo para contabilidad:
  54 facturas ($8.2M) provisionadas y vueltas a registrar como compra directa, sin cancelar la provisión.
  El armador decide 2120 por la provisión real del mes.
- **2026-10-21** — `[CP.8.69]` las cinco preguntas, contestadas con el dato: devolución/descuento por
  relación 03 (sin efecto fiscal), factura mixta se parte, tarjeta = pago TDC del banco, UUID por nota es
  decisión nuestra. Queda para contabilidad sólo el parcial con notas (Kepler explica 51 %).
- **2026-10-21** — `[CP.8.70]` de punta a punta, sin oráculo: del banco a la póliza completa se arman
  solas 948 de 1,831 (51.8 %), 2.7 % de error del puente; 443 a confirmar (246 ya correctas). 2120 =
  regla o provisión; el parcial por REP no se arma solo.
- **2026-10-21** — `[CP.8.71]` el RFC de 249 proveedores en Kepler estaba mal capturado; reparado por
  formato, parecido y nombre. De punta a punta se arman solas 1,142 de 1,831 (62.4 %), error del puente
  2.5 %. Quedan 369 acreedores sin RFC resoluble (dato de catálogo).
- **2026-10-21** — lista de RFC por corregir para Compras (doc privado): 21 acreedores ($34.0 M). Los 104
  sin CFDI: 103 son proveedores de remisión pagados en efectivo desde Caja General ($35.67 M), y esas
  compras no tienen póliza en ContPAQi (CAJA registra $0.47 M en 2026) — hallazgo para contabilidad.
- **2026-10-22** — `[CP.8.75]` la pantalla pasaba de 500 ms por el servidor, no por la red: los egresos del mes
  se leían cuatro veces por carga con `to_char` en el WHERE (974 ms de servidor cada una → 58 ms con rango).
  La fuente de pagos se comparte y se precalienta. Tiempo dentro del pod NO MEDIDO.
- **2026-10-22** — `[CP.8.76]` la pantalla pasa a un asistente de cuatro pasos (elección del PM): contestaba
  siete preguntas a la vez. Sin validación visual.
- **2026-10-22** — `[CP.8.77]` auditoría del PM en prod: cada «Movs» abre sus movimientos (144 cifras cruzadas
  contra prod, idénticas) y el texto de los pasos se va a la ayuda; sólo queda el foco de cada paso.
