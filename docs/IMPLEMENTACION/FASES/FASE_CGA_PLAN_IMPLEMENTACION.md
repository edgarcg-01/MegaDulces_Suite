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
| **B.3** | **C0** | **Arreglar `contado_en_cero`: 7 de 8 SÍ contaron.** Tienen el desglose por denominación poblado ($109,637.03) y 3 cuadran al centavo. `esProponible()` los descarta por `monto>0` → **$91,087.74 desaparece sin dejar rastro** | El caso del 2026-07-31 (2,620 + 6.53 = 2,626.53 = esperado) deja de perderse. Es el modo de fallar que ADR-056 prohíbe | — |
| **B.4** | **C0** | **Latido para el árbitro.** `analytics.cash_cuts` (4,497 filas) la alimenta un sync con **cero jobs en `cron_runs`** | **Prueba negativa:** apagar el sync y verificar el rojo. Hoy, si se cae, los días nuevos llegan con `cortes IS NULL` → `sin_arqueo` → `esProponible()` da `false` → **la bandeja se vacía en silencio** | — |
| **B.5** | **C0** | **Sacar la sucursal `03`.** Sus 4 día-caja «vecinales» tienen **1 solo ticket cada uno** y la venta vecinal es 0.3–3.1 % del cajón: son falsos positivos | Un ticket no hace una jornada de ruta. La `08` sí entra, pero su historia arranca el 26-sep | — |
| **B.6** | ⛔ **medición** | **Por dónde llega a caja general el efectivo de `02`/`03`/`04`/`05`.** No tienen **un solo `U-A-5` en 6 meses**, y los `U-D-10` **no aparecen** en la bandeja (0 filas en `mv_caja_movimientos`) | Es el hueco H2 de verdad: para esas plazas no hay depósito contra el cual chocar, así que la pregunta no es el doble conteo — es **dónde está el dinero** | — |

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
