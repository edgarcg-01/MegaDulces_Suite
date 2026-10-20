# Caja General — plan de implementación de los tres frentes (`CGA`)

> **2026-10-16 · propuesto · dueño: Edgar.**
>
> Alcance y mediciones base en [`FASE_CG_ALCANCE_2026-10-16.md`](FASE_CG_ALCANCE_2026-10-16.md).
> Estabilización del corte en [`FASE_CG_PLAN_POR_CAPAS.md`](FASE_CG_PLAN_POR_CAPAS.md) (`CGP`) —
> **son planes hermanos, no rivales**: `CGP` arregla el arqueo, `CGA` tapa de dónde entra y sale
> el dinero.
>
> **Cómo se armó.** Siete agentes midieron prod en paralelo (sólo lectura,
> `system_identifier` `7688376744939610156`) y cada hallazgo pasó por un escéptico que intentó
> refutarlo. **46 veredictos.** ⚠️ Al escéptico se le ordenó *«si la implicación no se sigue de la
> evidencia, eso también es refutarla»* y *«ante la duda, refutado=true»* — por eso cayeron 43 de
> 46, y la frase que se repite es *«la aritmética se reproduce al centavo… pero la implicación no se
> sigue»*. **Los hechos aguantan; las conclusiones son las que hay que leer con pinzas.** Acá sólo
> entran cifras que un escéptico volvió a correr contra prod.
>
> ⛔ **La corrida se cortó a pedido de Edgar con 10 escépticos en vuelo.** Faltaron verificaciones
> del bloque de proveedores. Va marcado donde aplica.

---

## 1. Lo que cambió respecto de lo que creíamos

Tres supuestos míos cayeron, y los tres estaban escritos en el anexo de alcance.

| # | Lo que decía | Lo que midió prod |
|---|---|---|
| **1** | *El cobro de ruta de detalle es `D-23-1`* | ⛔ **`D-23-1` es el documento SALDADO** (corte de caja POS), no el ingreso. El ingreso es `U-A-5-1` «Cobro PUE». Una consulta que filtre `doc_tipo='D-23-1'` sobre `kdm1` **devuelve 0 filas** |
| **2** | *El ingreso de detalle no tiene puente al libro* | ⛔ **Falso.** `finance.v_caja_movimientos_pendientes` ya trae **2,282 filas / $41,482,490.07** de cobro de detalle derivadas del ODS por vista — el **61.7 %** de la cola de ingresos. El discriminante es `kdm1.c10` (`RUTA 21`…`RUTA 28`, `RD 501`…`RD 505`) |
| **3** | *`route_collections` «se detuvo» el 12-oct* | ⛔ **Nunca arrancó.** Las 48 filas se escribieron **a mano, en dos corridas del 12-oct** (21:18 y 23:00 UTC). El importer no está en `run-prod-feeds.js` ni en `ops/vl/crontab.feeds`, y su latido **nunca pudo escribirse**: inserta `finished_at` y `detail`, columnas que `analytics.cron_runs` no tiene |

⭐ **Y dos cosas que creíamos abiertas están cerradas:**

- **El doble conteo vecinal tiene llave, y no es el importe.** `kepler_ods.kdm5` enlaza **2,618 de
  2,629 `U-A-5` de efectivo (99.6 %)** con su cargo `U-D-13-1`, que trae la **fecha del día de
  venta** (`c9`) y la **cuenta por cobrar de la ruta** (`c10`). El 100 % de los `U-A-5` trae `c10`
  y el 98.7 % trae `c12`. Y `entidad_code` (= `kdm1.c10`) **ya es columna** de la bandeja.
- **Quién cobra en efectivo ya es derivable.** `analytics.erp_supplier_payments.medio_pago`
  publica **130 proveedores / $57.3 M en caja** contra 204 / $366.8 M en banco. *(Sobrevivió al
  escéptico, que volvió a correr los cuatro cubos y salieron idénticos al dígito.)*

---

## 2. El orden, y por qué

```
  C0 dato ──────────► C1 dominio ──► C2 API ──► C3 UI
```

| Orden | Frente | Por qué va ahí |
|---|---|---|
| **1º** | **A — ruta de detalle** | Es el único con **dinero parándose hoy**. Las 4 camionetas vendieron $213,940.09 los días 13/14/15-oct y **nada de eso llegó al libro**. Además es el más barato: las capas C1–C3 ya están probadas por 3 cobros que cruzaron |
| **2º** | **C — proveedores en efectivo** | No hay sangrado, pero **$38,490,509.74 de deuda** no tiene dónde verse, y hay **otra sesión escribiendo** en `commercial.supplier_payment_obligations` desde hoy. Llegar tarde cuesta coordinación |
| **3º** | **B — vecinal** | ⛔ **El único que NO debe arrancar en código.** Su árbitro es circular y el 34 % de su dinero ya está ofrecido por la otra rama de la misma bandeja. Arranca con una decisión, no con una migración |

⚠️ **Tres frentes abiertos, no cuatro.** El método fija tope de 4 en curso y `CGP` ya ocupa uno.

---

## 3. Frente A — el cobro de ruta de detalle llega al libro

> **Objetivo:** que el cobro de las rutas de detalle entre al libro **derivado del ODS, sin
> importer**, y que el hueco abierto el 2026-10-02 se cierre.

**Lo que midió prod, y hay que entender antes de tocar nada:** el 2026-10-02 **no hubo una caída,
hubo un relevo de carril**. Las seis rutas de la plaza 01 dejaron de cobrarse en oficinas y pasaron
a emitir **su propio corte `U-D-23` con `c1` compuesto** (`01-001`…`01-006`). El carril viejo muere
el 01-oct; el nuevo sigue vivo.

⛔ **Y por eso no se ven:** `analytics.kepler_bank_movements` filtra `btrim(d.c1) = d.sucursal` —el
filtro anti-réplica canónico— que **descarta todo documento con `c1` compuesto**. Resultado:
`mv_caja_movimientos` tiene **cero** filas de ruta. **Relajar ese filtro no es opción**: es lo que
impide que `kdmm` replicado por sucursal infle todo.

### ⭐ A.0 — ENTREGADO el 2026-10-16: el detector de «corte sin cobro»

`database/scripts/check-corte-sin-cobro.js` · `npm run check:corte-sin-cobro` (+ `:self`).
Sólo lee, **exit 0 siempre** (informa, no frena). **Lo que encontró al encenderse:**

| Estado | Cortes | Monto | Quién lo arregla |
|---|---:|---:|---|
| `saldado` | 350 | $14,121,767.46 | — |
| **`sin_cobro`** — sucursal `01`, sin aplicación | **81** | **$2,984,827.33** | **quien captura en Kepler** |
| **`fuera_del_ods`** — camioneta | **67** | **$1,151,493.52** | el push |
| | **498** | **$18,258,088.31** | *(últimos 30 días)* |

⛔ **Y el dato que nadie tenía: 36 de esos cortes de camioneta ($608,045.99) no están en NINGÚN
libro** — ni el ODS ve su cobro, ni el push los trajo.

⛔⛔ **Esto corrige D3 y es lo más importante que midió el frente.** `kepler_ods.kdm5` **no tiene
una sola fila con almacén compuesto**: el circuito de sucursal salda el 82 % de sus cortes
(350/426 en octubre) y el de camioneta salda **0 de 67, nunca**. La aplicación del cobro de
camioneta vive en el Kepler local de la unidad y no sincroniza. **El ODS NO es superconjunto del
importer** — puede ver el corte, nunca el enlace cobro↔corte. **Retirar `route_collections` dejaría
ciego ese tramo.**

⚠️⚠️ **La trampa del join, que me costó una conclusión y quedó como prueba negativa.** `kdm5.c5`
es el **subtipo** del documento pagador, no el folio; el folio saldado es `kdm5.c11` (text con
ceros) contra `kdm1.c5` (numeric). Unir por `m.c5 = k.c5` **no ciega: SOBRE-CASA** — reporta
**431 de 498 saldados** contra los 350 reales, **escondiendo 81 cortes y $2,984,827.33** con la
pantalla en verde. *Un join que devuelve 0 se nota; uno que devuelve de más, no.* El `--self-test`
exige que los dos joins difieran y que el malo reporte de más; verificado que **sale en rojo
(exit 1)** cuando se rompe el join bueno a propósito.

| Fase | Capa | Qué entrega | Cómo se verifica | Bloquea a |
|---|---|---|---|---|
| **A.1** | **C0** | **Cablear el tramo camioneta→runner.** Meter `push-cobros.snippet.cmd` en `push-ruta.v2.template.cmd` y en `RUNBOOK_ALTA_CAMIONETA.md`, y repartirlo a las camionetas vivas | `ingest.route_collections_heartbeat.last_ok` avanza en las 4 camionetas **al día siguiente, desatendido** (hoy marca 2026-10-12). ⚠️ El 12-oct se invocó a mano: que corra dentro del `schtasks` **no está probado** | A.2 |
| **A.2** | **C0** | ✅ **ENTREGADO 2026-10-16.** El latido ya no se escribe a mano: usa el helper compartido `database/importers/lib/cron-heartbeat.js` (`begin`/`end`), que resuelve upsert, duración, host y autocuración del `running` colgado | Verificado contra prod: las **12 columnas** que usa el helper existen · la PK real `(tenant_id, job_key)` coincide con su `ON CONFLICT` · el INSERT viejo **falla** con *«column "finished_at" … does not exist»* · `analytics.cron_runs` tiene **0 filas** de `route_collections` — nunca latió. ⚠️ **La escritura NO se ejerció** (abajo) | A.3 |
| **A.3** | **C0** | **Agendar el importer** en `run-prod-feeds.js` o en `ops/vl/crontab.feeds`. ⛔ **No se retira** (D3 corregida) | Dos corridas consecutivas con latido verde y filas nuevas. ⚠️ **Tiene que correr con un rol de ESCRITURA** (abajo) | A.4 |
| **A.4** | **C0** | **Rama nueva de la vista para el carril del corte `U-D-23`**, leyendo `kepler_ods.kdm1` **directo** (no `mv_caja_movimientos`), filtrando `btrim(c10) ~ '^(RUTA\|RD) [0-9]+$'` para el carril viejo y `c1` compuesto para el nuevo | Los cobros de las 4 camionetas del 13/14/15-oct **aparecen en la bandeja**. Cuadre contra el testigo: $213,940.09 vendidos | A.5 |
| **A.5** | **C1** | **Declarar la frontera del relevo.** El 02-oct coexisten un cobro de oficinas y un corte de ruta para `01-002`: **son dinero distinto** (el de oficinas es la venta del 01-oct, lo dice su glosa). Corte por fecha, **sin de-duplicar por importe** | Los $15,087.00 del 02-oct entran **una sola vez**, y la prueba lo afirma nombrando el folio | A.6 |
| **A.6** | **C1** | **Marcar que el carril B es VENTA, no efectivo recibido.** El corte `U-D-23` es proxy del efectivo ≥99 % (probado contra 3 testigos independientes) pero sigue siendo la venta cerrada | La bandeja publica una columna que lo dice, y el arqueo no la trata como conteo | A.7 |
| **A.7** | **C3** | Que la bandeja muestre las dos ramas con su procedencia | `npm run check:pantalla -- finanzas` sin fallas nuevas, antes y después | — |
| **A.8** | ⛔ **fuera de código** | **`RD 501`–`RD 504`: $3.65 M al año, 14 días a oscuras.** Dejaron de cobrarse en oficinas y **nadie les abrió carril de reemplazo** — no existe un solo documento con `c1` compuesto fuera de la plaza 01 | **No se arregla con una vista.** Hay que preguntar en la plaza o mirar su Kepler local | — |

⚠️⚠️ **Lo que A.2 NO pudo probar, y se declara en vez de dibujarse.** La escritura del latido
**no se ejerció contra base real**: los roles de dev (`edgar`, `david`, `francisco`, `sistemas`)
tienen **`default_transaction_read_only = on` a nivel de rol** —protección deliberada, no se
desactiva— y además `edgar` **no tiene `INSERT` sobre `analytics.cron_runs`** (lo tiene
`app_runtime`). Se verificó el esquema (columnas, PK, el defecto viejo reproducido); **falta
ejercerlo**. Según la regla del proyecto, eso se hace en el CI o en un entorno de pruebas, nunca
en la laptop apuntando a prod.

⭐ **Y es un insumo directo para A.3:** el importer escribe en `analytics.route_collections` y en
`cron_runs`, así que la corrida agendada **tiene que usar un rol de escritura**. Con un rol de
dev fallaría entera — y, hasta A.2, habría fallado **en silencio**.

⚠️ **Medido de paso, y confirma de quién es A.1:** el dry-run contra el runner devuelve **las
mismas 48 aplicaciones** que ya están en prod (4 camionetas: `ruta_21`, `22`, `26`, `27`). El
runner **tampoco tiene nada nuevo desde el 12-oct** — el tramo que está muerto es
**camioneta→runner**, y eso se arregla repartiendo el bloque de cobros, no con código.

⛔ **A.4 cambia de forma por lo que midió A.0 — NO se deriva el ingreso del corte `U-D-23`.**
El circuito del ERP es **corte `U-D-23` → lo salda un cobro `U-A-5`**, y eso está probado con 761
aplicaciones ($10,130,576.46) en los 8 almacenes de sucursal. Traer el corte al libro sería meter
**la venta**, y cuando alguien capture el cobro el dinero entra dos veces. *Es exactamente la
trampa que mató al puente vecinal.* La rama nueva publica el corte **como pendiente de cobro, no
como ingreso**, y el ingreso sigue entrando por su `U-A-5`.

⚠️ **Y el tamaño del problema NO es derivable: es operación.** Para las camionetas el cobro dejó
de existir el 06-oct (6 `U-A-5` del 02 al 05-oct, cero después) mientras los cortes siguen hasta
el 15-oct. Y en sucursal `01` hay **81 cortes sin cobro aplicado, $2,984,827.33**. Es el mismo
síntoma que **D1**, un escalón más abajo.

---

## 4. Frente C — quién cobra en efectivo y cuánto se le debe

> **Objetivo:** que exista en pantalla **quién cobra en efectivo** y, al lado, **lo que se le debe
> hoy**, anclado a sus órdenes de entrada.

**Lo que midió prod:**

- ⛔ **Ningún campo de Kepler declara «a este proveedor se le paga en efectivo».** `kdud` es el
  maestro de **clientes** y no tiene `c31`. El maestro de proveedores es `kepler_ods.kdxd`, y su
  `c31` es un campo de **email** con un solo valor no vacío. `c35` (0/1/S) **no discrimina**:
  cruzado contra el hecho, el % pagado en efectivo es prácticamente igual en los cuatro estados.
  `kdm1.c31` es 1:1 con el doctype (`Tra`/`Che`/`Ant`) y rotula `Tra` lo mismo a caja que a banco.
  **La pantalla CREA un dato que no existe; no refleja uno que esté.**
- ⭐ **Pero la semilla sí existe:** `analytics.erp_supplier_payments.medio_pago` → **130
  proveedores / $57.3 M en caja**. *(Verificado por el escéptico.)*
- ⛔ **Un booleano modela mal el 35 % del dinero.** De los 314 proveedores pagados en 2026: **184
  son 0 % efectivo** ($282.97 M) · **109 son 100 % efectivo** ($38.96 M) · **23 son MIXTOS y se
  llevan el 35 % del efectivo**.
- **Es una lista, no un buscador:** top-10 = 57.3 % · top-20 = 71.0 % · top-50 = 89.4 %.
- **La deuda ya está derivada.** `XA2001` «Aplica Orden Entrada» crea la CxP en el subledger
  `kepler_ods.kdxe`; el saldo es `kdxe.c11 − Σ kdxf.c10` y se publica como
  `analytics.v_supplier_payables`. **$38,490,509.74** en 814 documentos / 81 proveedores con saldo
  vivo, de los cuales **$38,453,352.08 (99.90 %) son órdenes de entrada** y **$22.83 M vencido**.

| Fase | Capa | Qué entrega | Cómo se verifica | Bloquea a |
|---|---|---|---|---|
| **C.1** | **C0** | ⚠️ **RE-MEDIDA el 16-oct: ya NO bloquea al frente C.** `analytics.v_supplier_payables` no filtra cancelados y el motor de ECA sí (`[ECA.7]`). **En todo el universo difieren $171,832.92**; **en los proveedores de efectivo, $299.70 sobre $38.5 M (0.0008 %)** — ver abajo | Las dos implementaciones devuelven el mismo número, o una queda retirada. Es un defecto real de `v_supplier_payables`, pero **se arregla en paralelo**, no antes | — *(ya no bloquea)* |
| **C.2** | **C0** | 🔨 **ESCRITA 2026-10-16 — `20261016132420_supplier_cash_payment_mode.js`.** Aditiva sobre `catalog.suppliers`: `cash_payment_mode` (`CHECK` con `NULL` permitido + `siempre\|mixto\|nunca`), `cash_payment_reason`, `cash_payment_updated_by/at`, índice parcial. Sigue el precedente de `[RE.30]` en la misma tabla | Generada con `nueva-migracion.js` · sintaxis ✔ · `check:mig-colisiones` ✔ · los 4 nombres de columna, el CHECK y el índice **verificados libres en prod** · idempotente por `hasColumn`. ⚠️ **NO aplicada ni ejercida** (abajo) | C.3 |
| **C.3** | **C0** | ⛔ **RE-MEDIDA: no es un hueco de catálogo, es un BORRADO.** Los 10 **sí tienen fila** — están soft-deleted. Y el problema es mayor: **324 proveedores borrados el 16 y 20-jul sin autor**, de los cuales **22 siguen cobrando en 2026 por $11,220,546.79** · detector entregado | `npm run check:proveedor-borrado` (+ `:self`). Prueba negativa que **muerde**: quitar el filtro de borrado la pone en rojo (exit 1) | C.4 |
| **C.4** | **C1** | 🔨 **ESCRITA 2026-10-16 — `20261016134215_analytics_supplier_cash_payment_hint.js`.** VISTA (no tabla) que publica **el hecho al lado de la declaración**: peso y % en caja, modo sugerido, modo declarado, quién y cuándo, y si coinciden | **Cuadra al centavo contra la fuente**: 130 proveedores y **$57,351,665.93** en la vista y en `erp_supplier_payments`. 1,331 filas · 184 `nunca` · 108 `siempre` · 22 `mixto` · **1,017 sin sugerencia** (NULL, no `nunca`). ⚠️ **No aplicada** | C.5 |
| **C.5** | **C2** | **Endpoint hermano** del de plazos (no el mismo `PUT`), leyendo la deuda del resolvedor de C.1 | ⛔ **Un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció contra base real con el payload de la pantalla.** Acá no es retórica: el precedente que íbamos a copiar (`finance.caja_bank_crosswalk`) tiene **0 filas en prod** con 209,925 depósitos de insumo, **y nadie descartó que el POST esté roto** | C.6 |
| **C.6** | **C3** | **5ª pestaña en `/compras/obligaciones?tab=efectivo`** — la ruta, el guard y el ítem de sidebar ya existen. Patrón a copiar: **`[RE.30]` Plazos de pago a proveedor**, archivo por archivo | Cargar la skill `diseno` y correr `npm run check:pantalla -- compras` **antes y después**, sin fallas nuevas | — |

### ⭐ C.1 re-medida — qué es de verdad el descuadre de los dos saldos

Medido contra prod el 2026-10-16 reproduciendo **la regla exacta de ECA** (`kdm1.c2='X' AND
c43='C'`, un documento cancelado da saldo 0 y una aplicación de cargo cancelado no consume):

| Regla | Documentos | Saldo |
|---|---:|---:|
| `v_supplier_payables` (sin filtro) | 2,962 | $136,319,907.81 |
| ECA (excluye cancelados) | 2,985 | $136,491,740.73 |
| **Diferencia** | **+23** | **+$171,832.92** |

⭐ **La dirección importa y es la contraria a la intuición: la vista SUBESTIMA la deuda.** Cuenta
como «aplicado» pagos que Kepler canceló.

⛔ **Pero NO es un agujero sistémico de $13.8 M, y ese era el riesgo de leerlo mal.** Hay
**$13,857,944.72 en 348 documentos** con alguna aplicación de cargo cancelado — y casi todo eso
**no mueve el saldo**, porque Kepler canceló el cargo **y aplicó otro bueno en su lugar**. El
efecto neto se descompone exacto:

| | Docs | Monto |
|---|---:|---:|
| «Resucitadas» — la vista las da por **PAGADAS** y se deben | **26** | **+$169,957.00** |
| Ya visibles, su saldo sube | 3 | +$2,168.55 |
| Documentos cancelados que la vista aún cuenta | 3 | −$292.63 |
| | | **$171,832.92** ✔ |

⭐⭐ **Y el 84 % es UN proveedor:** `CE003` **EMBOTELLADORA AGA DEL CENTRO**, 8 facturas de la
sucursal `03`, **$142,875.97**, de febrero a julio. Le siguen `CR002` Rodolfo Bravo (6 facturas,
$8,730.42) y una cola de 12 proveedores con menos de $3,500 cada uno.

⭐ **Por qué deja de bloquear al frente C:** acotado a los proveedores que cobran en efectivo —el
universo de este frente— las dos implementaciones dan **808 docs / $38,457,958.66** contra
**809 / $38,458,258.36**: **$299.70 de diferencia sobre $38.5 M**. Una sola factura, de `CJ020`
Jorge Pérez Ramírez, por **$203.70**. **C.2 en adelante pueden arrancar.**

⚠️ **Lo que sigue siendo cierto:** la vista está mal y hay que arreglarla — son **26 facturas que
el sistema declara pagadas y no lo están**. Sólo que es un trabajo en paralelo, no una compuerta.

### C.2 — lo que decidió el diseño, y lo que quedó sin probar

**Tres estados, medido sobre los pagos de 2026** (re-medido por mí; la cifra del agente era 23/35 %
y el escéptico la había tumbado por contar `puente` como banco — `puente` es **FACTORAJE**, cuenta
210, más «AJUSTE A SALDO» y «DEVOLUCIONES»: 106 pagos, 10 proveedores, $22.77 M):

| modo | Proveedores | Monto total | En caja |
|---|---:|---:|---:|
| `nunca` | 187 | $281,906,926.64 | — |
| `siempre` | 111 | $33,443,523.46 | $33,443,523.46 |
| **`mixto`** | **22** | $128,468,923.05 | **$23,908,142.47** |

⛔ **Los 22 mixtos se llevan el 41.7 % de todo el efectivo.** Un `pays_cash boolean` obliga a
mentir sobre esa plata: `true` promete efectivo donde el 86.7 % fue banco (`CG021` GAMAHUBIN,
13.3 % en caja) y `false` esconde $17 M (`CB005` BOLSAS DE LOS ALTOS, 53.6 %).

⚠️ **`NULL` está permitido en el CHECK a propósito:** «nadie lo declaró» **no es** «nunca»
(ADR-056). Las 1,331 filas arrancan en `NULL` y la pantalla las distingue.

⚠️ **Trampa heredada a C.4:** con tolerancia cero, `CB013` BOTANAS PAU ($2,587,209.71, **$9.09**
fuera de caja) y `CA022` ABARROTES (**$2.00** fuera) caen en `mixto` aunque redondeen a 100.0 %.
**La tolerancia de la siembra es una decisión declarada**, no un detalle de implementación.

⛔ **Y un defecto que casi entra:** la primera versión usaba `knex.raw('COMMENT ON … IS ?', [txt])`.
**GOTCHAS §51**: `COMMENT ON` toma un literal, no un bind param — habría reventado **a mitad de la
migración**, con el `ADD COLUMN` ya corrido. Corregido a literal con la comilla escapada.

⚠️⚠️ **NO está aplicada ni ejercida.** No se puede desde acá: el rol de dev es read-only y Docker
no levanta para probarla en local. Se aplica **una por una** con `apply-one-migration-prod.js`,
con autorización, y **fuera de horario hábil**.

### ⛔⛔ C.3 — no era un hueco de catálogo: el 20-jul se borraron 324 proveedores

Buscando los 10 proveedores de efectivo que «faltaban» en `catalog.suppliers`, resultó que **no
faltan: están borrados**. Y la punta del iceberg era chica:

| Día | Filas borradas | Autor |
|---|---:|---|
| 2026-07-16 | 63 | **ninguno** (`deleted_by` NULL) |
| **2026-07-20** | **260** | **ninguno** |
| 2026-08-08 | 1 | ninguno |
| | **324** | |

**De esos 324, 22 siguen recibiendo pagos en 2026 por $11,220,546.79** — 10 en efectivo
($1,951,182.86) — y **15 cobraron DESPUÉS de haber sido borrados** ($7,900,874.95):

| Código | Proveedor | Monto 2026 | Último pago | Efectivo |
|---|---|---:|---|---|
| `CB004` | **BIMBO S.A. DE C.V.** | $4,309,779.24 | **2026-10-08** | |
| `CP056` | PASTECH DE OCCIDENTE | $1,099,607.67 | 2026-09-02 | |
| `CD037` | **DULJAL S DE RL DE CV** | $727,938.06 | **2026-10-12** | |
| `CA31` | ALEGRIAS DE AMARANTO MONSIL | $414,303.81 | 2026-09-17 | sí |
| `CC031` | CUERITOS FRYEN | $339,085.00 | 2026-09-22 | sí |
| `CNFP001` | PIÑATAS TOÑO | $103,489.24 | **2026-09-29** | sí |

⛔ **Por qué importa más allá del frente C:** toda pantalla que filtre `deleted_at IS NULL` —que
son casi todas— **no ve a esos proveedores**. No muestran un dato viejo: muestran **un universo
incompleto**, y la falta no se nota porque nada dice «faltan 22».

⚠️ `catalog.suppliers.activo` **no es GENERATED** (verificado: `is_generated = NEVER`), así que
puede disentir de `deleted_at`. El detector mira `deleted_at`, que es lo que filtran las consultas.

**Entregado:** `npm run check:proveedor-borrado` (+ `:self`). Separa *borrado antes del último
pago* (sospechoso) de *borrado después* (probablemente correcto), porque son dos conversaciones.
⛔ **No propone restaurar**: un proveedor puede estar borrado con razón y seguir recibiendo el
pago de una deuda vieja. Afirma algo más chico y más cierto: *«a éste se le pagó después de
borrarlo»*.

⭐ **Y la prueba negativa hubo que rehacerla.** La primera comparaba el join con `btrim` contra uno
sin él: **los dos dan 22**, o sea que no probaba nada — *comparar la consulta consigo misma*. La
que muerde muta el predicado del que depende todo: con `deleted_at IS NULL` el universo da **292**
y sin filtro **314**, contra los **22** del detector, y exige que las dos mitades sumen el
universo. Verificado: **exit 1** al quitar el filtro, **exit 0** al restaurarlo.

### ⭐ C.4 — por qué la semilla NO lleva tolerancia en porcentaje

Iba a poner un umbral (`≥99 % → siempre`). **Medí los dos bordes y haría lo incorrecto en los dos:**

| Borde | Proveedores | El caso |
|---|---:|---|
| entre 99 % y 100 % | **2** | `CB013` BOTANAS PAU: **$9.09** fuera de caja sobre $2,587,209.71 |
| por debajo de 1 % | **5** | `CD015` DISTRIBUIDORA DE LA ROSA: 0.20 %… que son **$133,117.65 EN EFECTIVO** |

⭐⭐ **Un porcentaje esconde el importe absoluto, y acá el importe es lo que decide.** Los
$133,117.65 de `CD015` son más efectivo que el total anual de muchos proveedores clasificados
`siempre`; un umbral de «<1 % es nunca» los borraría del universo del frente C.

Por eso el modo sugerido es **estricto** (cero efectivo → `nunca`, cero no-efectivo → `siempre`,
lo demás `mixto`) y **la vista publica el peso y el porcentaje juntos**: quien decide ve los $9.09
y ve los $133,117.65, y **no hay un umbral escondido eligiendo por él**.

⚠️ **`modo_sugerido = NULL` para 1,017 de las 1,331 filas** — proveedores sin pagos en el feed
(que arranca el **2025-12-23**). `NULL` es *«no hay con qué sugerir»*, **no** `nunca` (ADR-056).

⚠️ La vista **incluye los 324 borrados** a propósito, con su bandera: filtrarlos repetiría el
defecto que encontró `[CGA-C.3]`.

⛔ **Coordinación, no opcional:** `commercial.supplier_payment_obligations` pasó de **0 filas el
08-oct a 37 creadas hoy entre las 07:22 y las 16:07**, todas con `kepler_doc_tipo=20/doc_sub=1` y
`paid_amount = 0`. **Hay otra sesión escribiendo esa tabla ahora mismo.** Y sólo **12 de los 814
documentos** de deuda en efectivo tienen obligación creada (**2.4 %**) — que no es desuso ni
defecto: es un carril abierto hoy.

⚠️ **Lo que NO arbitra, y hay que decirlo en pantalla:** ContPAQi **no puede confirmar esta deuda**
— de los 81 proveedores con saldo sólo **3 son comparables** y los tres discrepan por millones. El
árbitro es `kepler_ods.kdxe`+`kdxf`.
⛔ **Y una trampa de llave que sobrevivió al escéptico:** armar la cuenta contable como
`'2120'||lpad(contpaqi_suppliers.codigo,6,'0')` da **281 pares con 0 coincidencias de nombre** —
devuelve el saldo **de otro proveedor**, con nombre y todo. Se pasa por
`finance.gl_supplier_accounts` **y se verifica el nombre**.

⚠️ **No verificado por el corte:** la pestaña, el permiso y el patrón `RE.30` tenían escépticos en
vuelo cuando se cortó. Un veredicto parcial alcanzó a decir que **el público del frente C podría no
ver esa pestaña**. **Confirmar antes de C.6.**

---

## 5. Frente B — vecinal: una decisión, no una migración

> **Objetivo de esta tanda: NO conectar el puente.** Dejarlo declarado como deuda con nombre y
> arreglar lo que ya está mal medido.

**Tres hallazgos, y cada uno bastaría solo.**

**1. ⛔⛔ El árbitro es circular — y es el hallazgo que sobrevivió intacto.** *«No pude refutarla;
los ataques que intenté la REFORZARON.»* `efectivo_esperado` (c15), `efectivo_contado` (c25) y
`efectivo_diff` (c35) salen de **la misma fila de la misma tabla** (`kepler_ods.kdpv_folio_caja`).
El diff es una resta en **580 de 580** filas, y el contado está escrito **idéntico al esperado al
centavo en 484 de 580 días → $7,579,991.50, el 84.3 % del dinero, donde «cuadra» es verdadero por
construcción.** *`cuadra` no significa que alguien contó: significa que Kepler publicó un corte.*

**2. El puente propone el dinero equivocado.** `efectivo_contado` es **el cajón entero**, no la
ruta: de los $8,991,447.41 sólo **$7,103,425.47** es venta vecinal → **$1,888,021.94 (21.0 %) es
mostrador** que entraría al libro etiquetado «Ruta vecinal».

**3. El doble conteo no es raro: es el 34 %.** La bandeja **ya ofrece 614 `U-A-5`** con
`entidad_code` de una cuenta de ruta vecinal ($9,321,917.23; 449 depósitos / $6,755,421.46 en la
ventana). Conectar el puente hoy mete hasta **~$4.2 M que ya tienen documento en la otra rama de la
misma bandeja**.

| Fase | Capa | Qué entrega | Cómo se verifica | Bloquea a |
|---|---|---|---|---|
| **B.1** | ⛔ **decisión** | **Dónde vive `CGP-VEC.1`.** Es código vivo en `main` sin destino. O va a `CSU` (cortes de sucursal, que es donde se cuenta esa caja) o se declara deuda con nombre | ADR-056: un primitivo huérfano no cierra la fase. Queda escrito en el tracker | B.2 |
| **B.2** | **C0** | **El interruptor por ruta, si el puente llegara a conectarse.** Un cierre es proponible **sólo si ninguna de sus rutas tiene cuenta por cobrar en Kepler que reciba efectivo**. La identidad es `kdm1.c10`, que la bandeja ya expone. Medido: **414 cierres ($4.80 M) de rutas SIN cuenta por cobrar** | ⛔ **No es un pareo.** El importe **arbitra**, no llavea: para Padre Hidalgo, 107 de 166 pares (ruta, día) coinciden al centavo. **No reconstruyas el pareo por importe** — refutado con placebo (3.0 % vs 3.1 %) | — |
| **B.3** | **C0** | ⚠️ **RE-MEDIDA: el arreglo que yo iba a hacer está PROHIBIDO por el control.** `contado_en_cero` mezcla dos cosas y hay que **partirlo y declararlo**, no rellenarlo — ver abajo. ⛔ **Cambia el vocabulario de `veredicto`: es breaking para sus consumidores** | Los dos veredictos nuevos se distinguen en pantalla y **ninguno entra solo al libro**. Exige actualizar `app-vecinal-recon` antes de aplicar | B.1 |
| **B.4** | **C0** | **Latido para el árbitro.** `analytics.cash_cuts` (4,497 filas) la alimenta un sync con **cero jobs en `cron_runs`** | **Prueba negativa:** apagar el sync y verificar el rojo. Hoy, si se cae, los días nuevos llegan con `cortes IS NULL` → `sin_arqueo` → `esProponible()` da `false` → **la bandeja se vacía en silencio** | — |
| **B.5** | **C0** | **Sacar la sucursal `03`.** Sus 4 día-caja «vecinales» tienen **1 solo ticket cada uno** y la venta vecinal es 0.3–3.1 % del cajón: son falsos positivos | Un ticket no hace una jornada de ruta. La `08` sí entra, pero su historia arranca el 26-sep | — |
| **B.6** | ⛔ **medición** | **Por dónde llega a caja general el efectivo de `02`/`03`/`04`/`05`.** No tienen **un solo `U-A-5` en 6 meses**, y los `U-D-10` **no aparecen** en la bandeja (0 filas en `mv_caja_movimientos`) | Es el hueco H2 de verdad: para esas plazas no hay depósito contra el cual chocar, así que la pregunta no es el doble conteo — es **dónde está el dinero** | — |

### ⛔⛔ B.3 re-medida — iba a reconstruir una hipótesis que el repo ya había matado

**Lo que iba a hacer:** usar `arqueo_billetes + arqueo_monedas` como respaldo cuando
`efectivo_contado = 0`. **El control lo prohíbe, y `[VEC.10]` ya lo había medido:**

| Control — donde `efectivo_contado > 0`, ¿el desglose lo reproduce? | |
|---|---:|
| Cortes | 4,456 |
| Cuadran al peso | **1,102 — 24.7 %** |
| Peor brecha | **$415,476.05** |

**No se puede rellenar `efectivo_contado` con el desglose.** Punto.

⭐ **Pero hay una pregunta distinta, y ésa sí tiene señal.** En vez de *«¿el desglose es el
contado?»* (no), la pregunta es *«en los cortes que dicen contado = 0, ¿hay evidencia de que
alguien contó?»*. Con control de placebo:

| Grupo | n | El desglose reproduce el **esperado** |
|---|---:|---:|
| **REAL** — `contado = 0` con desglose | 31 | **19 · 61.3 %** |
| **PLACEBO** — `contado > 0` con desglose | 4,234 | 1,021 · **24.1 %** |

**2.5× la tasa base.** Eso no sale del pozo denso.

**El alcance es mayor que vecinal:** en todo `analytics.cash_cuts` hay **43 cortes con
`efectivo_contado = 0` y esperado > 0**, y **31 de ellos tienen desglose poblado** —
**$302,806.65 contados que el sistema reporta como cero**. En vecinal son 8 (7 con desglose,
$109,637.03, con $91,087.74 de venta en juego).

Casos que lo muestran solos: **2026-07-31** billetes 2,620.00 + monedas 6.53 = **2,626.53 =
el esperado al centavo**; **2026-08-15**, 26,636.00 contra 26,635.93 → **$0.07**. Y el único sin
desglose —`01` caja 4 del 2026-07-25— ése sí es «nadie contó».

**Lo que corresponde hacer, entonces, no es rellenar: es PARTIR EL VEREDICTO.**

| Hoy | Debería ser |
|---|---|
| `contado_en_cero` (8 vecinal / 43 total) | **`sin_contar`** — contado 0 **y** desglose 0 → nadie contó |
| | **`contado_sin_capturar`** — contado 0 **pero** desglose > 0 → hay un conteo que no llegó al campo |

⚠️ **Ninguno de los dos entra solo al libro.** El desglose se **muestra como declaración** («hay
un conteo de $X que no se capturó»), que es información, no un número inventado — y 19 de 31 no
es 31 de 31, así que afirmar «los 31 contaron» sería pasarse de lo medido.

⛔ **Es un cambio BREAKING del vocabulario de `veredicto`**, que hoy consume el panel
`app-vecinal-recon` en `/comercial/ventas-por-ruta`. Por eso no lo mandé como migración sorpresa:
va junto con su consumidor, y después de **B.1**.

⚠️ **Y una defensa que es un no-op:** `cerrado` se escribe literal `true` en el `INSERT` y se fuerza
otra vez en el `ON CONFLICT` — las 4,497 filas lo tienen `true`. El candado de `esProponible()` que
lo mira **no filtra nada**; lo único que defiende es el veredicto `dia_en_curso`.

---

## 6. Lo que NO se hace en esta tanda, dicho con todas las letras

1. **No se conecta el puente vecinal.** Tres razones medidas, cualquiera suficiente (§5).
2. **No se captura el histórico anterior al 10-oct** — 13,206 movimientos, $162,080,748.92.
   Decisión de Edgar del 16-oct: *«todo lo anterior ya debería estar conciliado»*.
3. **No se tocan los 7 mal fechados** ($50,796.40). Se corrigen **en Kepler**, no capturándolos.
4. **No se tocan los 6,324 movimientos `G%`** ($20.21 M: nómina, caja chica, bancos, servicios).
   No son proveedores de compra — son dominio de Egresos (`GX`).
5. **No se relaja el filtro anti-réplica** `btrim(c1)=sucursal`. La rama nueva lee `kdm1` directo.
6. **No se crea tabla nueva en ningún frente.** Se extiende `catalog.suppliers` y se derivan vistas.

---

## 7. Lo que necesita a Edgar (no lo decido yo)

| # | Decisión | Lo que recomiendo |
|---|---|---|
| **D1** | ⛔⛔ **Por qué Kepler dejó de registrar depósitos `U-A-5` el 12-oct** (de ~90–115/semana a **3**, con el feed sano y los gastos normales) | **Es lo más urgente de todo este plan y no se arregla con código.** Preguntarlo en operación hoy. Mientras no vuelva, la bandeja se vacía sola y se lee como «ya no hay trabajo» |
| **D2** | **`RD 501`–`RD 504`**: $3.65 M al año, sin carril de reemplazo desde el 02-oct | Preguntar en la plaza. No es derivable del ODS |
| **D3** | ⛔ **CORREGIDA el 16-oct por `A.0`. ¿Se retira `import-route-collections.js`?** | **NO se retira.** Medido: `kdm5` no tiene **ninguna** fila con almacén compuesto → el ODS ve el corte pero **nunca** el enlace cobro↔corte (**0 de 67 saldados**, contra 82 % en sucursal). El importer es la **única** fuente de ese tramo; retirarlo lo dejaría ciego. Lo que sí hay que hacer es **cablearlo** (A.1–A.3) — hoy no está agendado y su latido no puede escribir |
| **D4** | **¿Quién es el dueño de la bandera de efectivo** — Compras (que negocia) o Finanzas/Tesorería (que paga)? | Decide el permiso de escritura. Con `COMPRAS_PROVEEDORES_GESTIONAR` ya entran `finanzas` y `tesorería` sin crear clave |
| **D5** | **¿Cuál es el resolvedor único del saldo a proveedor** — la vista o el motor de ECA? Re-medido el 16-oct: difieren **$171,832.92**, y son **26 facturas que la vista da por PAGADAS y se deben** (84 % de un solo proveedor) | **El de ECA**: la vista subestima porque cuenta como aplicados pagos que Kepler canceló. ⚠️ Ya **no bloquea al frente C** (ahí difieren $299.70 sobre $38.5 M). Lo urgente es otra cosa: que **Finanzas mire esas 26 facturas**, empezando por las 8 de `CE003` Embotelladora AGA, **$142,875.97** |
| **D6** | **¿Qué se hace con `CGP-VEC.1`** — se muda a `CSU` o se declara deuda? | Declararlo deuda con nombre ahora, mudarlo cuando `CSU` lo pida |
| **D7** | ⛔⛔ **¿POR DÓNDE ENTRA UN DEPÓSITO AL BANCO?** Medido el 20-oct: `finance.cash_ledger` tiene **0 de 250** movimientos `tipo='deposito'` — cero en toda la vida del módulo — y `total_depositos = 0.00` en los 7 cortes. Nada registra el efectivo que **sale** del cajón, así que el `esperado` arrastra la entrada entera como si se hubiera quedado adentro (causa de fondo de `[CG.195]`, ver §10.13) | **Reabrir la captura manual SÓLO para `tipo='deposito'`.** Es la opción que respeta el motivo de `[CG.120]`: lo que aquella decisión frenó fue *dinero sin procedencia*, y un depósito **sí tiene respaldo** — la ficha de depósito que Fase `CC` ya guarda con su OCR. ⚠️ Las otras dos salidas tienen costo: *derivarlo del movimiento bancario* lo ata a la conciliación (`CB`) y no existe hoy; *declarar que el depósito no va en Caja General* deja el arqueo sin poder cuadrar nunca, y entonces hay que decirlo en pantalla en vez de publicar un veredicto. ⛔ **Y esto hay que contestarlo antes de interpretar las diferencias de ±$100K**: hasta saber si la pierna falta por modelo o por proceso, no se puede distinguir un defecto de un faltante real — la regla del propio proyecto (*descartar el defecto antes de culpar a la gente*) |

---

## 8. Huecos que siguen sin medir

| # | Hueco | Consulta / cómo se mide |
|---|---|---|
| G1 | **Cuánto dinero esperan las 4 laptops** (13–16 oct) | Vive en el Kepler local de cada camioneta (`//127.0.0.1/cobro.kpl`), inalcanzable desde acá |
| G2 | **Cuántas camionetas más tienen cobros sin traer.** `route_collections_heartbeat` tiene **4 filas**; `route_push_heartbeat` tiene **11 camionetas** | Comparar las dos tablas de latido |
| G3 | Si el bloque de cobros corre **desatendido** dentro del `schtasks` | El 12-oct se invocó a mano. No hay evidencia |
| G4 | Por qué **10 de los 130** proveedores en efectivo ($1.65 M) faltan en `catalog.suppliers` | `SELECT proveedor_code, proveedor_nombre, count(*), sum(monto) …` |
| G5 | Si la mezcla caja/banco de los **23 mixtos** obedece a una regla (sucursal, monto, tipo de compra) o es discrecional | Decide si tres estados alcanzan o hace falta una regla |
| G6 | Si `medio_pago='caja'` es **la Caja General** del corporativo o cualquier cuenta de tipo caja (incluida caja de sucursal) | Es la diferencia entre 130 proveedores y otro número |
| G7 | Quién creó las **37 obligaciones de hoy** (¿piloto manual de Finanzas o proceso automático?) | Coordinar antes de tocar esa tabla |
| G8 | Por qué los pagos en caja llegan hasta **2026-12-01**, en el futuro | Mismo síntoma que los 7 mal fechados. Sin investigar |
| G9 | Si el carril del corte de ruta **sigue vivo hoy** | Al medir, cortes y tickets terminan el 15-oct y hay **0 de hoy** — los dos a la vez |
| G10 | Si los **$24,109,112.88** clasificados como `otro` en la cola de ingresos esconden más cobro de ruta bajo códigos que no empiezan con `RUTA`/`RD`/`RV` | Listar `entidad_code` de ese cubo |

---

## 9. Nota de método — qué tan firme es este plan

- **Lo que un escéptico volvió a correr contra prod** está en §1, §3, §4 y §5. Esas cifras
  reprodujeron.
- **Lo que NO alcanzó verificación** por el corte de la corrida: la casa de la pantalla del frente
  C, su permiso y el patrón `RE.30`. Va marcado en §4.
- **Lo que no se midió** está en §8, con cómo medirlo — no dibujado como cero ni como verde
  (ADR-056).
- ⚠️ **Y una advertencia sobre el propio método:** mi escéptico marcaba `refutado=true` tanto si el
  número estaba mal como si la conclusión no se seguía. **El conteo 43/46 no significa nada**;
  cada veredicto hubo que leerlo. Si alguien repite este montaje, que separe los dos campos.

---

## 10. ⛔⛔ OBJETIVO PERMANENTE DE LA FASE: que un cobro NUNCA vuelva a volverse invisible

> Pedido de Edgar el 2026-10-16, dos veces y con estas palabras: *«necesito que documentes esto y me
> des una **solución general, no parches**, y que jamás vuelva a ocurrir»*.
> **Esta sección es un objetivo de la fase, no una tarea cerrable: `CGA` no se da por entregada
> mientras A.10–A.13 no estén ✅.**

### 10.1 Qué pasó, en una pantalla

El 16-oct se cablearon cuatro camionetas al push de cobros. Edgar capturó el cobro de la ruta 28 y
**el de la ruta 22 desapareció de la bandeja**:

```
01-006  ruta_28  U-A-5 0000013  $13,699.00  ← capturado
01-002  ruta_22  U-A-5 0000013  $15,321.00  ← INVISIBLE
```

El descuento anti-duplicado de `movimientosPendientes()` (`[CG.85]`) preguntaba
`yac.glosa LIKE doc_tipo || ' ' || folio || '%'`. **El folio de camioneta es consecutivo por unidad,
no global**, así que cada captura tapaba a todos sus homónimos de otras sucursales.

| | movimientos | importe |
|---|---:|---:|
| Escondidos por el defecto | **157** | **$1,325,687.43** |
| Recuperados por `[CGA-A.9]` (acotar el descuento a `origen_tipo='caos'`) | **141** | **$1,114,139.29** |
| **Hueco que queda abierto** (capturas CAOS que chocan entre sí) | **16** | **$211,548.14** |

⛔ **El modo de fallar es el peor posible: el dinero no se pierde ni se duplica — se vuelve
invisible.** La fila sigue en la vista, con su importe correcto, y la pantalla no la ofrece. No hay
error, no hay log, no hay descuadre. Es **indistinguible de «ese día no hubo cobro»**. Mismo patrón
que `GOTCHAS` §83 (corpus ausente ≡ producto inexistente) y que el arqueo de 8 días en cero.

⚠️ **Y no fue un incidente aislado: fue el cuarto parche del día sobre el mismo carril** — el bloque
de cobros que no estaba en ninguna plantilla, el host equivocado, el `connect_timeout`, y este
filtro. **Cuatro síntomas, dos causas de fondo**, y son las que atacan A.10–A.13.

### 10.2 Causa raíz 1 — se identifica un documento por PROSA

`finance.cash_ledger.glosa` es texto libre para que lo lea un humano. Que hoy empiece con
`doc_tipo folio` es **una coincidencia de formato, no un contrato**. Y la llave buena ya existe:

- `origen_ref` lleva la identidad completa (`sucursal|doc_tipo|folio` para Kepler,
  `device|external_id` para CAOS) y está protegida por el candado único
  `ux_cash_ledger_origen_vivo (origen_tipo, origen_ref)`.
- La vista `finance.v_caja_movimientos_pendientes` **ya excluye lo capturado por `origen_ref`**, que
  es exacto. El `LIKE` nunca debió mirar esas filas.

El `LIKE` existía por **un solo caso**: la captura desde CAOS no tiene `origen_ref` del documento de
Kepler —el suyo es `device|external_id`—, así que *declaraba* el documento **escribiéndolo en la
prosa**. Ese es el defecto de diseño, y es lo que A.10 elimina.

### 10.3 Causa raíz 2 — cada camioneta es un archivo suelto que nadie valida

El `.cmd` de cada unidad se pega a mano, máquina por máquina. No hay plantilla única, no hay quién
compare lo desplegado contra lo esperado, y **un bloque faltante o un host mal escrito no produce
rojo: produce silencio**. De ahí salieron los otros tres parches del día. Lo ataca A.12/A.13.

### 10.4 La solución general — cuatro items, en orden

| # | Item | Qué hace | Estado |
|---|---|---|---|
| **A.9** | **Acotar el descuento a `origen_tipo='caos'`** | Quita el `LIKE` de encima de todo lo que ya tiene llave exacta. Recupera 141 movimientos | ✅ commiteado (`2d3ba49b1`) · ⚠️ **sin desplegar** |
| **A.10** | ⭐⭐ **Matar el `LIKE`: la captura CAOS declara el documento en una COLUMNA** | Columna nueva `declared_doc_ref` en `finance.cash_ledger` (`sucursal\|doc_tipo\|folio`), que la pantalla llena al elegir el documento. El descuento pasa a ser **igualdad sobre la llave**, en los dos lados. **El `LIKE` desaparece del código.** Cierra los 16 / $211,548.14 | ⬜ |
| **A.11** | **Compuerta estática: prohibido un `LIKE` sobre `glosa` dentro de un `NOT EXISTS`** | `check:dedup-por-llave` recorre `libs/finance/**` y falla si un descuento anti-duplicado compara texto libre. Con prueba negativa | ⬜ |
| **A.12** | **Una sola plantilla versionada para el `.cmd` de camioneta** | El archivo se **genera** desde `database/importers/kepler/route-push/`, no se pega. Fin de las variantes por máquina | ⬜ |
| **A.13** | **`check:camioneta-sin-cobro`** | Compara `route_push_heartbeat` (11 unidades) contra `route_collections_heartbeat` (4): toda unidad que empuja ventas y no empuja cobros sale nombrada. Cierra G2 | ⬜ |

#### Cómo se migra A.10 sin apagar nada

1. Migración **aditiva**: `declared_doc_ref text NULL` + índice parcial. Nada se rompe.
2. La pantalla de captura CAOS la llena **al elegir el documento** (el dato ya está en la mano —
   es la fila que el operador tocó). Se sigue escribiendo la glosa, para el humano.
3. El descuento queda **en dos ramas declaradas**: igualdad por `declared_doc_ref` cuando lo hay;
   el `LIKE` acotado sólo para `declared_doc_ref IS NULL`, es decir **lo histórico**.
4. `check:cobro-escondido` cuenta las filas que siguen cayendo en la rama vieja. **Cuando llegue a
   cero, el `LIKE` se borra** — y hasta entonces el hueco tiene número, no adjetivo (ADR-056).

### 10.5 Las tres reglas que quedan, más allá de esta fase

1. ⛔ **Un descuento anti-duplicado se hace por LLAVE, nunca por TEXTO.** Si el origen no trae la
   llave, el defecto es del origen: se arregla ahí, no se compensa con un `LIKE`.
2. ⛔ **Un `LIKE` sobre texto libre dentro de un `NOT EXISTS` es un filtro que BORRA filas sin dejar
   rastro.** Antes de escribir uno: ¿qué pasa si dos filas distintas producen el mismo prefijo?
3. ⭐ **Todo filtro que QUITA filas de una bandeja necesita su propio detector que las cuente.** No
   alcanza con probar que el filtro funciona: hay que medir **cuánto se lleva puesto**.

Las tres quedan asentadas en [`docs/GOTCHAS.md` §86](../../GOTCHAS.md).

### 10.6 Lo que vigila hoy, mientras A.10 no esté

`npm run check:cobro-escondido` — compara **lo que la vista publica** contra **lo que la bandeja
deja pasar** y nombra la diferencia.
⭐ **Es la única compuerta de esta familia que sale con `exit 1` cuando ENCUENTRA algo**: un cobro
escondido no es una decisión de negocio pendiente, es dinero que nadie puede ver.
Su prueba negativa (`--self-test`) corre el descuento sin acotar y exige que esconda MÁS —
`16` contra `157`—; si los dos dan igual, **lo declara no medido** en vez de darlo por bueno.

⚠️ **Y lo que todavía NO está hecho, dicho con todas las letras:** `[CGA-A.9]` está **commiteado y
sin empujar ni desplegar**. En producción el defecto sigue vivo. Verifiqué la consulta **leyendo
prod**, no ejerciendo el endpoint — o sea que, según la regla 13 del proyecto, **no está probado**.

### 10.7 ⛔ Segundo defecto del mismo carril: **la captura CONGELA el importe**

Medido el 2026-10-16 al corregir el cobro de la ruta 27. **No es el mismo bug que §10.1, y el
arreglo de A.9 no lo toca.**

```
CI-2026-00047   01-005|U-A-5|0000015|0011   libro $120.00   fuente $21,240.00
```

⭐ **La vista de pendientes excluye por `origen_ref`, no por monto.** El importe se copia al libro
en el instante de capturar y nunca se vuelve a contrastar. Si la fuente se corrige después —acá el
importer re-corrió a las 22:08 y completó los renglones del corte que a las 21:07 estaban a
medias— **el libro conserva el número viejo y el documento ya nunca vuelve a ofrecerse en la
cola**. Para la pantalla ese cobro está resuelto.

⛔ Mismo modo de fallar que §10.1 y que `GOTCHAS` §86: **el dinero no se pierde ni se duplica, se
vuelve invisible.** Y el arreglo del folio no lo cubre, porque acá la identidad es correcta — lo
que miente es el importe.

**Alcance, medido sobre todo el libro:** 2 filas.

| folio | libro | fuente | diferencia | qué es |
|---|---:|---:|---:|---|
| `CI-2026-00047` | $120.00 | $21,240.00 | **$21,120.00** | desfase de tubería |
| `CI-2026-00004` | $16,648.00 | $16,647.62 | −$0.38 | redondeo que tecleó la persona |

**Lo entregado:**

- `npm run check:cobro-monto-desfasado` — contrasta cada cobro capturado contra la suma de
  `analytics.route_collections` para su propio `origen_ref`. **Exit 1**, y separa el redondeo
  humano (≤ $1.00, informativo) del desfase de tubería. Su prueba negativa quita la **sucursal**
  de la llave —el defecto de §86— y exige que el cruce se desborde: **2 contra 5**.
- Migración `20261016163855_cga_a10_vincular_cobro_ruta27_folio15_con_caos.js` — corrige
  `CI-2026-00047` **releyendo el importe de la fuente** (aborta si no suma lo medido) y enlaza el
  depósito de CAOS **#1615 · $21,120.00**, siguiendo el precedente de `CI-2026-00048` (ruta 28,
  libro $13,699.00, enlace $13,280.00): **el libro lleva lo que dice Kepler y el enlace lleva lo
  que llegó a la bóveda.** La diferencia de **$120.00** queda nombrada en `senales`, no promediada.
  ⚠️ Es una migración de datos: la compuerta del despliegue la clasifica **NO_MEDIDO** y frena al
  equipo → **aplicar a mano antes de mergear**.
- **No se toca `CI-2026-00004`.** Esos $0.38 son una decisión de quien capturó, no un defecto.

**Lo que falta para que no vuelva** (va dentro de A.10): que la pantalla **re-contraste el importe
contra la fuente al mostrar el movimiento**, en vez de confiar en la copia. Mientras eso no exista,
el detector es lo único que lo encuentra — y hay que correrlo, no esperar a que avise.

### 10.8 A.10 y A.11 — entregadas el 2026-10-16, y qué mueven de verdad

**A.11 · `npm run check:dedup-por-llave`** — compuerta estática: marca todo `LIKE` sobre una
columna de prosa (`glosa`, `concepto`, `referencia`, `notas`…) que viva dentro de una existencia
**negada**. Ese es el caso peligroso: un `LIKE` en un `WHERE` normal trae filas de más y se ven;
dentro de un `NOT EXISTS` **quita** filas, y eso no deja rastro. Lleva un **trinquete**: la deuda
que ya existe va declarada con motivo y salida, contada; la compuerta no se pone roja por ella
—eso la apagaría el primer día— **pero sí por la siguiente**, y también avisa si quedan menos de
las declaradas, para que nadie deje el permiso puesto después de arreglarlo.

⭐⭐ **Lo que encontró en su primer barrido es el hallazgo del día: las dos pruebas de `[CG.85]`
replicaban el descuento en vez de ejercer el servicio, y por eso llevaban el defecto adentro.**

| | movimientos | monto |
|---|---:|---:|
| Denominador de cobertura **roto** (sin acotar) | 13,222 | $162,111,454.69 |
| Denominador **bueno** (acotado a `caos`) | 13,361 | $163,188,930.98 |
| **Diferencia que la cobertura daba por hecha** | **139** | **$1,077,476.29** |

Y la negativa de `cola-sin-duplicados` no podía verlo: apagaba la exclusión **entera**, comparando
filtro contra nada, con las dos ramas mal. Se le agregó una tercera rama `'roto'` que reproduce el
defecto a propósito y exige que esconda más — ejercida contra prod: **49 movimientos más** en la
ventana de 45 días. Si deja de distinguir, lo **declara no medido**.

> ⭐ **La lección general: una prueba que REPLICA la consulta hereda sus defectos y después los
> certifica.** Lo que vale es ejercer el servicio.

**A.10 · `finance.cash_ledger.declared_doc_ref`** (migración `20261016170505`) — la captura declara
el documento en una **columna** con la forma de `origen_ref` (`01-005|U-A-5|0000015|0011`), y el
descuento pasa a ser **igualdad por llave**, con el `LIKE` degradado a rama histórica
(`declared_doc_ref IS NULL`).

El relleno **no adivina**. Medido en prod antes de escribirlo, sobre las 12 capturas de CAOS que
declaran documento:

| candidatos en la cola | capturas | monto | qué hace |
|---:|---:|---:|---|
| 1 | 7 | $56,185.00 | **se rellena** |
| 2 | 4 | $57,865.00 | queda `NULL` |
| 7 | 1 | $22,676.00 | queda `NULL` |

⚠️ **Y acá va la medición honesta del efecto: la migración mueve la cola en CERO.** Simulado
contra prod con la columna rellenada, la cola sigue en **13,361 · $163,188,930.98** — idéntica.
Es esperable: los casos de un solo candidato **nunca fueron el problema**. Lo que A.10 instala es
el **mecanismo**; la recuperación llega cuando la pantalla haga declarar el documento.

**Lo que sigue abierto es exactamente el hueco de §10.1, y ahora tiene cara.** Los **16
movimientos · $211,548.14** salen de un puñado de capturas ambiguas; la más cara es una de
**$22,676.00** cuya glosa dice `U-A-5 0000007` — y ese folio existe el **mismo día en siete
sucursales** (`00`, `01-001` … `01-006`), que suman **$136,385.41**. Una captura tapa las siete.

| # | lo que falta | quién |
|---|---|---|
| **A.10b** | La pantalla de captura manda `declared_doc_ref` al elegir el documento | frontend |
| **A.10c** | Resolver a mano las **5 capturas ambiguas** ($80,541.00) desde esa pantalla | Finanzas |
| **A.10d** | Cuando `check:cobro-escondido` llegue a **0**, borrar la rama del `LIKE` y bajar el trinquete de `check:dedup-por-llave` a cero | quien cierre |

⛔⛔ **ORDEN DE DESPLIEGUE, no negociable:** el servicio ya **lee** `declared_doc_ref`. La migración
`20261016170505` va **ANTES** del deploy del código; al revés, la cola de Caja General responde
500. Verificado por simulación que, con la columna en `NULL`, el predicado nuevo devuelve
**exactamente lo mismo** que el vigente (13,361 = 13,361): el cambio es un no-op hasta que haya
declaraciones.

### 10.9 A.12 y A.13 — el `.cmd` de la camioneta deja de ser un archivo suelto

**A.13 · `npm run check:camioneta-sin-cobro`** — cruza los **dos latidos** del runner:
`route_push_heartbeat` (venta) contra `route_collections_heartbeat` (cobro). Exit 1 cuando una
unidad con venta fresca lleva su cobro atrasado o ausente.

⭐ **La venta es el testigo independiente.** Si una unidad mandó venta hoy, estuvo prendida, con
red y con su Kepler vivo — así que la ausencia del cobro **no es la camioneta, es el `.cmd`**.
Es el mismo razonamiento de `check-route-stock-push.js` (`[RD.32]`), que ya lo hacía para la
existencia. Prueba negativa: degrada el `LEFT JOIN` a `INNER` —el error natural de quien escribe
esa consulta— y exige que encuentre menos: **11 unidades y 6 problemas contra 6 y 2**. Las 5 que
se pierden son justo las que **nunca** mandaron un cobro.

**Censo del 2026-10-16 17:10:**

| camión | venta | cobro | estado |
|---|---|---|---|
| `ruta_22` `ruta_23` `ruta_27` `ruta_28` | fresca | fresca | ✓ cableadas hoy |
| **`ruta_21`** · **`ruta_26`** | **12 y 27 min** | 4 d | ⛔ carril caído |
| `ruta_501`–`ruta_504` | fresca | nunca | ⛔ sin cablear |
| `ruta_505` | 32 d | nunca | · dormida, no se juzga (ADR-056) |

⚠️ **Corrección a lo que reporté antes:** dije que `ruta_21` y `ruta_26` llevaban días sin
empujar ventas y que las máquinas podían estar apagadas. **Es falso: las dos mandaron venta hoy**,
con minutos de diferencia. Están vivas y les falta el bloque, como a las otras cuatro.

**A.12 · `npm run camioneta:armar`** — el archivo se **genera** y se **verifica**.

- `--truck ruta_21 --serie UD1001 --salida push-ruta.cmd` escribe el archivo completo, con los
  **tres carriles adentro**. Nunca imprime una credencial: salen `<CLAVE_LOCAL>` / `<CLAVE_RUNNER>`.
- `--verificar C:\KeplerPush\push-ruta.cmd` recibe el archivo **real de una máquina** y dice qué
  le falta. ⭐ **Ésta es la mitad que vale**: lo desplegado ya existe y nadie lo puede mirar desde
  el repo; suponer que es igual a la plantilla es justo lo que falló.

Siete reglas, cada una con su costo medido. La que cierra el incidente del día: **toda variable
de conexión usada tiene que estar definida en el mismo archivo** — un bloque pegado del repo usa
`%SRC%`/`%DST%` y la máquina vieja define `%LOCAL_CONN%`/`%RUNNER_CONN%`; **`psql` con una
variable vacía no grita**, así que el bloque «corre» y no manda nada.

Prueba negativa: cinco mutaciones de la plantilla propia, **cada una tiene que disparar su regla
y no otra**. ⚠️ Y su primera versión salió **roja sobre su propio archivo**: el `REM` que explica
por qué el runner no es `.249` *contiene* `192.168.0.249`. Las reglas que buscan algo prohibido
miran el **código**, no los comentarios — un archivo correcto marcado como malo se apaga el
primer día.

**Retirados** con banner, no borrados: `push-cobros.snippet.cmd` (existía para pegarse a mano, y
ese mecanismo *es* el defecto) y `push-ruta.v2.template.cmd` — **al que le faltaba el bloque de
cobros, y de ahí copiaba todo el mundo**. Comprobado con el verificador: falla «manda COBROS».

| # | lo que falta | quién |
|---|---|---|
| **A.12b** | Regenerar y verificar el `.cmd` de `ruta_21` y `ruta_26` (están vivas) | quien entre a la máquina |
| **A.12c** | `501`–`505`: cargar `almacen_erp` en `analytics.v_rd_route_identity` (mapa medido 1:1, `501→06-001`…`505→06-005`). **Sin almacén no se puede escribir el filtro obligatorio del bloque de cobros** | C0 |
| **A.3** | El importer sigue **sin agendar** en ningún crontab | ops |

### 10.10 A.3 — el importer entra al cron, y una compuerta busca a los demás huérfanos

**El carril, agendado.** `ops/vl/crontab.feeds` lleva desde hoy:

```
4,14,24,34,44,54 * * * * /app/ops/vl/run-feed.sh route-collections "node /app/database/importers/kepler/import-route-collections.js --apply"
```

Minutos terminados en **4** porque es el único hueco libre: `prices` toma 2,32; `publish-tienda`
7…57; `contpaqi-cfdis` cae en 3 y 8; `contpaqi-cfdis-emit` en 1 y 6; `stock` en 5,20,35,50.
Cada 10 min y no más fino: las camionetas empujan al reconectar, así que muestrear más seguido
sólo multiplica corridas vacías. El UPSERT es por `(tenant_id, truck, cobro_folio, folio_corte)`:
**una corrida repetida no duplica dinero.**

**`npm run check:importer-sin-agenda`** — la generalización. Todo archivo que **late** en
`analytics.cron_runs` tiene que tener **quién lo dispare**: una línea de crontab, una mención en
`ops/`, un padre agendado (un salto, que es como entran los ~50 pasos de `run-prod-feeds.js`), o
una entrada declarada con dueño.

⭐ **La pregunta no es «¿corrió?» sino «¿hay algo que lo corra?»** — y ésa se contesta leyendo el
repo, sin red. Porque un carril que nunca corrió **no escribe un latido en rojo: no escribe
nada**, y una tabla de latidos sin la fila es indistinguible de un carril que todavía no existe.

⚠️ Su primera versión reusaba el recorrido que filtra por extensión, y **`ops/vl/crontab.feeds`
no termina en `.js/.sh/.cmd`**: declaró huérfanos a 16 carriles que sí estaban agendados,
incluido el que la funda. Una compuerta con 16 falsos en 22 hallazgos se apaga el primer día.

**⛔⛔ Lo que encontró en su primer barrido limpio — un segundo carril en el mismo estado:**

> **`import-route-stock.js`** (`[RD.32]`, la foto de existencia del camión) **no llega a prod.**
> Medido el 2026-10-16: el runner tiene **30,146 renglones de 10 camionetas, frescos de hoy**;
> `commercial.route_counts` con `source='kepler'` tiene **UNA fila, del 2026-10-06** — el día que
> alguien lo corrió a mano. **Diez días sin ancla de saldo de ruta.**
>
> **No lo agendo por mi cuenta:** activarlo cambia el ancla del saldo de 10 camionetas, y eso es
> alcance de negocio. Queda **declarado como deuda medida** en la compuerta, que lo imprime en
> cada corrida sin ponerse roja por él. Decide Edgar.

### 10.11 ⛔⛔ TRES COSAS ESPERAN EL MISMO DESPLIEGUE

Verificado **dentro del contenedor** `feeds-cron` el 2026-10-16 17:35 — la imagen es anterior a
los arreglos de hoy:

| | repo | imagen desplegada |
|---|---|---|
| latido de cobros (`[CGA-A.2]`, `47461372e`) | usa el helper `cron-heartbeat` | todavía `finished_at` → **el latido no se escribe** |
| línea de cron `route-collections` (`[CGA-A.3]`) | presente | **no existe** |

El `crontab` va **horneado en la imagen** (`ops/ingest/Dockerfile` lo copia,
`26-feeds-cron.deployment.yaml` lo instala al arrancar), así que **agregar la línea al repo no
agenda nada hasta reconstruir y desplegar `ingesta`**. Que la línea exista y que el carril corra
son dos hechos distintos.

Y por el lado de la suite, lo de §10.8: la migración `20261016170505` va **antes** del deploy del
código, porque el servicio ya lee `declared_doc_ref`.

### 10.12 `[CG.194]` — el arqueo restaba $5,070 sin nombrarlos (2026-10-19)

Auditando la ventana **«Tu jornada»** con la pantalla a la vista, contra prod del 19-oct:

```
libro: gastos          $8,179.00
pantalla: "Gastos"     $3,109.00
                       ─────────
diferencia             $5,070.00   ← gasto pagado con efectivo de la máquina
```

El servidor hace bien en restarlo —ese dinero nunca pasó por el cajón, son `gastosCajon`— pero
el renglón se rotula **«Gastos»** dentro de una tabla titulada **«Caja general (nuestro libro)»**.
Y el mismo importe reaparecía **sumado** del otro lado:

```
de eso, a la bóveda      $270,200.00      ┐ difieren en los mismos
Movimiento de la bóveda  $265,130.00      ┘ $5,070, sin una línea que lo diga
```

⭐ **Tres cifras correctas y ninguna explicando a las otras.** Hoy *Ingresos* sale completo sólo
por casualidad (`ing_boveda = 0`); el día que un cobro se parta, se recorta igual y en silencio.
Es la regla del propio proyecto —*declarar el universo, no sólo el número*— incumplida **dentro de
una misma tabla**.

⭐⭐ **El dato ya viajaba.** El backend publica `se_fue_a_boveda` desde `[CG.139]`, con sus dos
piernas y el conteo de los que tocaron las dos cajas; la pantalla nunca lo leyó. No se tocó el
servidor ni se movió una cifra: se pintó lo que ya llegaba.

⚠️ **Las dos piernas NO se suman en un total.** Un ingreso que se tragó la máquina y un gasto que
salió de ella van en sentidos contrarios: un número único los compensaría y volvería a esconder
exactamente lo que esto vino a mostrar. Cada una corrige **su** renglón, dentro de la tabla.

**Segundo defecto, mismo commit** — `cash-cut.service.ts:1590` tenía dos espacios donde iba la
interpolación de `fueraDeFecha`: *«Esta jornada es lo REGISTRADO hoy:␣␣de esos movimientos traen el
documento de Kepler fechado otro día»*. Un aviso al que se le cae su única cifra no avisa. Hoy
diría **13 de 18** (72% de la jornada). El campo viajaba bien como número desde `[CG.82]`; lo roto
era la frase, y por eso nadie lo vio.

Commit `29067cf49`. Probado: 307 en `view` (4 nuevas, con la negativa **ejercida** en rojo), 98 en
`finance`. ⚠️ Sin validación visual.

#### Lo que la misma auditoría midió y NO se tocó

| Hallazgo | Medido | Estado |
|---|---|---|
| **6 cortes cerrados, CERO autorizados** | `CC-2026-00001`…`00006`, 12→17-oct, `authorized_by IS NULL` | ⬜ el último paso del flujo nunca se completó; la pantalla lo dice de a uno y nunca «van seis». ⭐ **Re-medido el 20-oct: ya son 7 y sigue en cero** — y NO es hueco de permiso, ver `CGA-A.26` en §10.13 |
| **La cobertura no cierra** | `2,850 de 3,020 · 114 sin subcuenta` → faltan **56** sin nombrar | ⬜ enumera una de dos exclusiones |
| **«Fuera de esta jornada»** | 11 sueltos previos, 1 cancelado → **10 · −$1,704.47** | ✅ exacto, verificado al centavo. Falta **salida**: el del 28-sep lleva 21 días y no hay camino para abrir su corte |
| **Contraparte «CONTADO»** en el historial | mismo defecto de `GOTCHAS` §86 | ⚠️ lo resuelve la columna `ruta` de `20261019094522`, **sin aplicar** |

### 10.13 ⛔⛔ `[CG.195]` — un cajón no debe dinero: 4 de 7 cortes afirmaban un sobrante imposible (2026-10-20)

Auditoría de **estructura** de `/finanzas/caja-general`, midiendo prod en sólo lectura
(`system_identifier` `7688376744939610156`, 20-oct 08:58 hora de México).

⭐⭐ **Empiezo por lo que me salió mal, porque es la lección del método.** Entré con dos hallazgos
de lectura de código: el monolito de 502 KB y el endpoint `POST /cortes/:id/contar` —el que tiró
prod el 14-oct—. **El segundo estaba equivocado y la medición lo desmintió en diez minutos:**
`[CG.155]` unificó los TRES caminos de escritura en `filasDenominacion()`, la migración
`20261014212702` puso los invariantes, y `cash-cut.servicio-real.spec.ts` ejerce
`abrir → contar → cerrar → autorizar` con el payload de la pantalla contra Postgres real como
`app_runtime`. Prod: **7 cortes cerrados, 49 filas de denominación, 0 cortes trabados.**

**Lo grave no estaba en ninguno de mis dos hallazgos. Apareció al mirar las cifras.**

#### Qué publicaba la pantalla

```
folio            esperado        contado      diferencia     veredicto
CC-2026-00001    3,402.45       3,653.50        +251.05      sobra   ← creíble
CC-2026-00002  -149,915.32     57,571.00    +207,486.32      sobra   ← IMPOSIBLE
CC-2026-00003   87,781.66      24,960.00     -62,821.66      falta
CC-2026-00004   -68,199.86     11,820.00     +80,019.86      sobra   ← IMPOSIBLE
CC-2026-00005   -62,631.80     32,198.50     +94,830.30      sobra   ← IMPOSIBLE
CC-2026-00006   -81,227.27        618.50     +81,845.77      sobra   ← IMPOSIBLE
CC-2026-00007  296,867.09      88,272.50    -208,594.59      falta
```

**4 de 7 cortes afirmaban «sobra efectivo»** por decenas de miles de pesos, con un `esperado`
**negativo** — o sea, con el libro diciendo que en el cajón debería haber **menos que cero**
efectivo. Y no podía ser otra cosa: `contado` es una suma de piezas, **nunca negativa**, así que
contra un esperado bajo cero la diferencia es positiva **siempre**. ⭐ **Cuanto más rota la cuenta,
más grande el «sobrante» que la pantalla afirmaba** — el error se presentaba como su propio
contrario.

El motor ya había peleado esto una vez: su propio comentario en `[CG.96]` dice *«con esto el
esperado de hoy pasa de −$45,990.05 (imposible) a $3,357.45»*. Eso arregló el **12-oct** —y es por
eso que `CC-2026-00001` es el único creíble—. **Desde el 13-oct volvió a pasar**, por otra causa.

#### El arreglo: el séptimo veredicto

`veredictoDe` **nunca miraba el `esperado`**: devolvía `sobra`/`falta` leyendo sólo la diferencia.
Ahora lo recibe, y con el esperado bajo cero declara **`esperado_imposible`**, que entra a
`VEREDICTOS_SIN_RESPUESTA` junto a `sin_contar`, `sin_base` y `sin_medir`.

⭐ **No se inventó un primitivo** (ADR-056 §5): el vocabulario para decir *«la pregunta no tiene
respuesta»* ya existía, lo construyeron `[CG.42]` y `[CG.156]`, y vive en `libs/contracts` desde
`[CG.42.1]` justamente para que el motor y la pantalla no puedan divergir. Esto es una entrada más
en ese tipo, no un mecanismo nuevo.

⛔ **El `esperado` es un campo REQUERIDO del input, no opcional.** Los dos llamadores de producción
ya lo tenían a mano; hacerlo opcional dejaría que un tercero lo omitiera sin enterarse — que es
**exactamente** cómo nació el defecto de `[CG.155]` (una migración que actualizó uno de tres
caminos). El tipo protege al código.

Commit `71a66e18f`. Verde: **504** pruebas en `libs/finance`, **690** en contracts, **1,010** en
view finanzas; `check:templates` y `check:spec-vivo` en verde. Prueba negativa con los 4 cortes
reales al centavo, **más el corte creíble que NO debe cambiar** — sin ese contraste, «ninguno dice
sobra» se cumpliría también rompiéndolos todos. ⚠️ **Sin validación visual.**

#### ⛔⛔ Lo que esto NO arregla — y es la causa de fondo

**`finance.cash_ledger` no tiene UNA SOLA fila `tipo='deposito'` en toda su vida.**

```
gasto     en_corte      163    $1,592,713.65
gasto     registrado      4      $139,560.00
gasto     cancelado       3          $121.00
ingreso   en_corte       74    $1,772,411.60
ingreso   registrado      6      $137,855.53
deposito  —               0            $0.00   ← la pierna que falta
```

$1.77 M entró al cajón en el modelo, $1.59 M salió como gasto, **$0.00 se registró como depósito**,
y el cajón físicamente guarda entre $618.50 y $88,272.50. `total_depositos = 0.00` en los **7**
cortes.

El esperado se apoya hoy **sólo** en las dos piernas del cajero CAOS (`[CG.96]`,
`dispensadoCajero − depositadoCajero`), que explican el efectivo que pasa por la AST700. **Lo que
sale del cajón hacia el banco sin pasar por la máquina no tiene cómo registrarse.** Reconstruido,
esa pierna neta explica toda la distancia entre la suma ingenua y el esperado guardado (−$320,720
en `CC-2026-00007`), así que **la aritmética funciona como está diseñada**: lo que falta es un
hecho, no una cuenta.

⚠️ Y `[CG.120]` apagó la captura manual el **19-oct** —por una razón buena, *dinero sin
procedencia*— que era la **única** puerta de esta pantalla para registrar un depósito al banco.
Nota: los depósitos ya eran **cero antes** del 19-oct, así que `[CG.120]` no es la causa; es lo que
hoy cierra la salida.

⛔ **No se puede concluir desde acá si las diferencias de ±$100K son modelo roto o efectivo real
perdido**, y ésa es justamente la distinción que la regla del proyecto exige resolver antes de
leerlo como desuso o como descuido de nadie. **Va como decisión `D7` en §7.**

#### Los otros cinco hallazgos, medidos y NO tocados

| Item | Hallazgo | Medición |
|---|---|---|
| **`CGA-A.25`** | ⛔⛔ **La pierna del depósito no existe** | 0 de 250 movimientos · `total_depositos = 0.00` en los 7 cortes → **D7** |
| **`CGA-A.26`** | **Cero cortes autorizados, ahora son 7** (eran 6 en §10.12) | `carmen_rodriguez` abre y cierra los 7. ⭐ **NO es hueco de permiso**: `FINANCE_CAJA_AUTORIZAR` está repartido en `direccion` (2) y `superadmin` (9), y `direccion` lo tiene **sin** `GESTIONAR` — diseñado como segunda llave. La llave existe y nadie la usa: es proceso |
| **`CGA-A.27`** | **Movimiento fechado 2026-12-10, vivo hace 3 semanas** | `CG-2026-00002`, $1,060, `pago_proveedor` `X-D-26\|0001298`, creado el 29-sep por `superoot`, sin `corte_id`. `[CG.25]` avisa y nada lo corrige. Mismo síntoma que **G8** |
| **`CGA-A.28`** | **Dos movimientos de prueba E2E en un corte de prod** | `CG-2026-00042` ($100) y `CG-2026-00043` ($1), glosa «AUDITORIA E2E», cancelados el 14-oct, colgados de `CC-2026-00003`. **Bien excluidos** del total guardado |
| **`CGA-A.29`** | **El job `caja-db` corre, se pone rojo y no bloquea nada** | Sin `continue-on-error` (tiñe la corrida), pero `sellar` depende sólo de `[build, secret-scan]` y la protección de rama exige esos dos. La única prueba que cubre el defecto que tiró prod dos veces es, de hecho, informativa |
| **`CGA-A.30`** | **Deuda de estructura, con nombre** | 8,152 líneas / 502 KB en un archivo; 109 signals, 56 computed. ⭐ **No es deuda de calidad** —la lógica pura ya vive afuera en `caja-captura.util.ts` con su spec— sino de **concurrencia**: el archivo cambió en disco entre dos comandos de esta misma sesión, y commitear 2 líneas exigió `git apply --cached` de un solo hunk para no llevarse 5 ajenos. ⛔ **No se abre como fase** (Fase 0 en curso) |

#### Por qué el orden es ése y no otro

La jerarquía del proyecto es *dinero que se para hoy > cifra publicada falsa > cerrar lo que está a
un paso > deuda invisible > lo nuevo*. `[CG.195]` calificaba por **dos** criterios a la vez: era
una cifra falsa publicada **y** el número que decide si la caja cuadra. Por eso se arregló primero
y en el mismo día; `A.25` es su causa pero depende de una decisión que no me toca, y `A.26`–`A.30`
no mueven dinero.

---

## 11. ⭐⭐ PLAN MAESTRO — un objetivo por sesión (Edgar, 2026-10-20)

> *«Necesito que avancemos más rápido. Te reporto los problemas para que los subdividamos en
> tareas. Genera un plan maestro donde le asignemos una tarea u objetivo a cada sesión. Tu
> objetivo ahora es ser el auditor.»*
>
> Edgar reparte las tareas; esta sesión **audita y no implementa**. El reparto nace de tres
> problemas que él reportó —la caja trabada, el saldo que debe existir en CAOS y en caja real, y
> qué movimientos faltan contra Control— más lo que la auditoría del mismo día ya había medido
> (§10.13).

### 11.0 La línea base, medida el 2026-10-20 contra prod (sólo lectura)

| Hecho | Cifra |
|---|---|
| Cortes cerrados / autorizados | **7 / 0** |
| Jornadas sin corte, eje canónico `created_at` (`[CGP-L.12]`) | **0** ⬅ el bloqueo **no** es éste |
| Cortes con `esperado` negativo | **4 de 7**, hasta −$149,915.32 |
| Movimientos `tipo='deposito'` | **0 de 250**, en toda la vida del módulo |
| Movimientos sin vínculo (`origen_tipo IS NULL`) | **15 · $380,449.10** |
| CAOS, último movimiento | 2026-10-19 18:03 |
| Caja real, último conteo sellado | **$88,272.50** (`CC-2026-00007`, 19-oct) |
| Control (`analytics.caja_general_movimientos`), oct-2026 | **567** movimientos, contra **250** en todo el libro nuevo |

### 11.1 `[CGA-A.32]` · S1 — Destrabar la caja ⛔ **hoy, antes que nada**

**Objetivo:** que Carmen pueda capturar hoy.

⛔ **Primero reproducir, no suponer.** El reporte dice *«ya no se puede usar la caja si no hubo un
corte ayer»*, pero **el bloqueo no se explica desde los datos**: las jornadas sin corte por el eje
canónico son **0** y no hay ningún borrador abierto. Las dos consultas que lo buscaban volvieron
vacías.

**Entregable:** el **mensaje literal** que ve Carmen y el `archivo:línea` que lo emite. A descartar
en orden: `puedeAbrirCorte` (`fecha_invalida` · `fecha_futura` · `ya_existe` · `hay_posterior`), el
candado de un-solo-borrador-por-sucursal, y `gateCierre` en la pantalla.

**DoD:** el motivo nombrado con su línea **más** la condición de prod que lo dispara.
⛔ **Si resulta ser `hay_posterior`, no se toca:** choca de frente con la decisión abierta
`[CGP-0.6]` (capturar días anteriores al primer corte) y es de Edgar.

⚠️ **El error que esta sesión cometió y hay que no repetir:** medí las jornadas pendientes con
`cash_ledger.fecha` y la definición canónica es `created_at` — *el día en que se movió el
efectivo*. Los dos ejes dan dos respuestas distintas y **una es falsa**: por `fecha` salían 5
jornadas pendientes, por `created_at` salen **0**.

### 11.2 `[CGA-A.33]` · S2 — El saldo de CAOS ⛔ **no es una resta de dos piernas**

**Objetivo:** el saldo que **debe** existir en la máquina, defendible.

La resta de dos piernas da **$570,800.00** (depositado $19,320,360.00 − dispensado
$18,749,560.00). ⛔ **No se publica: está incompleta.** Hay cuatro tipos de movimiento más, sin
clasificar, que suman mucho más que el supuesto saldo:

```
Vaciar Stocks          $2,915,150.00     13 movimientos
Dotar                  $1,701,890.00     16
Fin de Dia               $279,110.00      1
Contenido Modificado     −$25,420.00      3
```

**Entregable:** qué `type_label` **suma, resta o es neutro**, contrastado contra un **arqueo físico
de la máquina** — no contra sí mismo. Es la regla 10 del proyecto: probar la unidad y contrastar
contra un hecho independiente.

**DoD:** el saldo con su fecha de corte **más** el arqueo que lo confirma. Sin arqueo se reporta
`NO MEDIDO` (ADR-056), nunca un número redondo que parezca una respuesta.

### 11.3 `[CGA-A.34]` · S3 — Cuadrar caja real contra CAOS

**Objetivo:** cerrar la ecuación de `[CGA-A.24]` — `lo que contó la MÁQUINA + lo que quedó en el
CAJÓN = lo que dice KEPLER`.

Arranca con el cajón en **$88,272.50** (19-oct) más lo que entregue S2.

⛔ **Depende de S2 y no se adelanta.** Sin saldo de máquina defendible esto no cierra, y la
tentación exacta es rellenarlo con la resta de dos piernas que S2 ya declaró incompleta.

**DoD:** la ecuación al centavo, o la brecha **con monto y con nombre**.

### 11.4 `[CGA-A.35]` · S4 — Qué falta ingresar, contra Control

**Objetivo:** los movimientos que están en `/finanzas/caja` (el espejo del Access `Control`) y no
en el libro nuevo.

⚠️ **La trampa que ya frenó a esta sesión:** `analytics.caja_general_movimientos` **no tiene
columna `importe`** — tiene `ingreso`, `gasto`, `deposito` y `efectivo` por separado. La consulta
murió ahí. Hay que resolver cómo se arma el importe **antes** de comparar nada.

**DoD:** lista con folio, fecha, importe y **por qué falta cada uno**. Todo cruce por importe lleva
**control placebo** obligatorio (§11.5).

### 11.5 `[CGA-A.31]` · S5 — Aplicar la migración, que ya está escrita y verificada

**Objetivo:** que los 15 desvinculados queden con vínculo o con declaración.

Hecho: **11 vínculos** (6 gastos de Kepler + 5 cobros de ruta) y **4 declarados**. Las **tres
guardas pasaron contra prod real** — el ensayo en transacción revertida llegó hasta la primera
escritura y murió con `cannot execute UPDATE in a read-only transaction`, porque la credencial de
esta sesión es el rol `dev_ro`.

**Falta:** commitear, empujar y aplicar con `apply-one-migration-prod.js`.
⛔ **Sólo hace `UPDATE`**, así que la compuerta del despliegue la clasifica `NO_MEDIDO` y **frena
al equipo entero** hasta que alguien la aplique a mano: **va antes de mergear**.

⭐⭐ **Dos lecciones que esta migración ya dejó pagadas, y que S4 hereda:**

1. **La prosa miente.** `CG-2026-00028` nombra `X-D-26 0023047` en su glosa; ese documento
   **existe y es de $1,250.00**, no de $10,490.00. Creerle habría amarrado un movimiento a un
   documento ocho veces menor. Es la causa raíz §10.2 atrapada en vivo.
2. **`v_caja_movimientos_pendientes` tiene DOS ramas** unidas por `UNION ALL`. Esta sesión buscó
   en una (`mv_caja_movimientos`), declaró **8 movimientos «inexistentes en Kepler»** y **5 sí
   existían** en `analytics.route_collections`, con almacén **compuesto** (`01-001`, `06-003`), no
   un código de dos dígitos. **$106,602.00 de falsos negativos.** Lo delató que Carmen ya había
   declarado tres de ellos en `declared_doc_ref`: **la persona que capturó sabía más que la
   consulta.**

### 11.6 `[CGA-A.25]` · S6 — La pierna del depósito ⏸️ **en pausa por decisión de Edgar**

Es la causa de fondo del `esperado` negativo (§10.13). No se abre hasta que se responda **`D7`**
(§7): por dónde entra un depósito al banco.

### 11.7 El rol de auditor — qué se verifica y qué se rechaza

Esta sesión **no escribe el código de A.32–A.35**. De cada entregable comprueba cuatro cosas:

1. **El universo, no sólo el número** — cuántas filas de cuántas, y qué quedó fuera.
2. **El control placebo en todo cruce por importe.** Hoy salvó la migración: en CAOS con ±$99 los
   importes **inventados** casaron **5/8** contra **3/8** de los reales, mientras que en Kepler con
   importe exacto los reales casaron **5/6** y los inventados **0/6**. Un cruce sin placebo no se
   acepta aunque la aritmética cierre.
3. **La dirección y la unidad** — que el signo y el eje sean los que el texto dice que son (es
   justo lo que falló con `fecha` contra `created_at`).
4. **Que lo no medido se declare**, nunca como cero ni como verde.

⛔ Se rechaza un entregable que traiga una cifra sin su medición, **por plausible que suene**.

---
