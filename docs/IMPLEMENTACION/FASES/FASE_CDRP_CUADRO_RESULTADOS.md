# Fase CDRP — Cuadro de Resultados por Puesto

> **Estado:** 🔨 EN CURSO · **ADR-076** · Arranque 2026-09-17 · Última medición **2026-09-21**
> **Especificación de Dirección (verbatim, no editar):** [`ESPEC_CDRP_DIRECCION_2026-09-17.md`](ESPEC_CDRP_DIRECCION_2026-09-17.md)

---

## 0. Qué es y dónde vive

Dirección entregó una especificación funcional: la pantalla de apertura de cada puesto directivo
debe contestar cuatro preguntas en menos de 30 segundos — *«mi trabajo se llama…»*, *«cómo voy»*,
*«qué debo lograr»*, *«dónde pongo el foco hoy»*. §15 fija el criterio de aceptación: si sólo
responde **qué pasó**, es reportería.

⭐ **La restricción que ordena toda la fase la puso el usuario, y es más estrecha que la spec:**

> «mucho de lo que vamos a presentar ya existe, sólo vamos a tomar la información o redireccionar
> a la interfaz correcta» · «iniciemos con lo que ya está construido y dejemos al final lo que no»

Por eso **CDRP no es una pantalla nueva**. Se renderiza dentro de «Mi trabajo» (`/projects`,
Fase SN / ADR-061), que ya resuelve identidad, alcance, responsabilidades y colas. Un tablero
directivo aparte sería la duodécima landing de la suite, y además rompería `[SN.30]` (*si no
respondés de una cola, no la ves*), que es la regla que hace que esa pantalla signifique algo.

---

## 1. Lo entregado

| Item | Estado | Qué dejó |
|---|---|---|
| **[CDRP.0]** repartir las responsabilidades directivas que SÍ tienen cola | ✅ 2026-09-17 · prod **batch 455** | mig `20260918120000_responsabilidades_cdrp_directivos.js`. Cinco pares (puesto → responsabilidad) derivados de §3, §4 y §9: `direccion_comercial→comercial.thot`, `prevencion→almacen.cuadre`, `prevencion→almacen.conteo`, `jefe_finanzas→finanzas.conciliacion_ingresos`, `jefe_finanzas→finanzas.conciliacion_egresos`. **Sólo las que ya tienen cola viva detrás** — repartir una responsabilidad sin cola es prometer una bandeja vacía. |
| **[CDRP.1]** el CDRP empieza por lo que YA está construido | ✅ 2026-09-17 · prod **batch 456** | `identity.positions.proposito` + las 9 frases de §2–§10 (el *«mi trabajo se llama»* de §1.1, que ya estaba escrito y no vivía en ninguna tabla) · margen y ticket promedio por bloque de zona en `me-zona.ts` + `MeZonaBloque` · `[JZ.7]` consolidado de N zonas. ⚠️ El encabezado «Mi trabajo se llama…» se **retiró de la pantalla** a pedido del usuario (`79d04913`); el dato sigue en la tabla. |
| **[CDRP.2]** el registro de umbrales, antes que cualquier KPI | ✅ 2026-09-21 · prod **batch 495** (+ **503** la corrección) | `libs/contracts/src/http/kpi-threshold.contract.ts` + spec de 20 pruebas · `analytics.kpi_thresholds` con 5 CHECK y RLS forzado · smoke `test-newdb-kpi-thresholds` 42/42. Detalle en §3. |

### 1.1 El margen y el ticket se publican POR BLOQUE, no por zona

Decisión de `[CDRP.1]` que conviene no revertir por «simplificar»: medido, el ticket promedio son
**tres universos distintos** — tienda ~$86, ruta ~$586, vecinal ~$1,675. El promedio de zona no es
el de nadie. Y el margen sólo existe donde hay costo: la venta por ruta tiene
`costo_status = 'sin_dato_en_la_fuente'` en el **100 %**, así que el bloque publica
`margen_cobertura` y **declara** el hueco en vez de promediar sobre lo que sí tiene costo.

---

## 2. ⛔ Dónde la especificación choca con lo medido

No son objeciones de estilo. Cada una se midió antes de escribirse.

| § | Lo que pide la spec | Lo medido | Qué se hizo |
|---|---|---|---|
| **§12** | contrato de KPI con **tres** estados `green\|yellow\|red` | Con tres estados, **un KPI sin meta sale verde**. Es el `cfg ? classify : 'ok'` que la Fase VP encontró dando verde incondicional a las 3 matvistas del sell-out — verdes por no tener umbral, no por estar sanas | **cinco** estados. Ver §3 |
| **§13** | umbral como **porcentaje** de la meta (`green: ">= 100%"`) | El porcentaje **se rompe con meta 0**, y «cartera vencida, meta 0» es un objetivo real acá. Además esconde el operando, y este proyecto ya publicó cifras falsas por no poder verlo (ADR-051: 3.3 pp de margen) | umbrales **absolutos** + CHECK de coherencia |
| **§14** | Fase 1 paso **4** = motor de semáforos; paso **5** = metas | El orden está invertido respecto de los datos: sin metas el motor sólo puede devolver «sin meta». Medido 2026-09-21: los renglones de presupuesto siguen en **0** | se construyó igual el motor **primero**, pero con `sin_meta` como estado de primera clase en vez de fingir verde |
| **§2, §3** | KPIs para Dirección General y Dirección Comercial | `identity.positions`: `direccion` **0 personas**, `direccion_comercial` **0 personas** | ver §4 — es el bloqueo #1 |
| **§1.6** | panel de compromisos / minutas | no existe módulo, tabla ni captura | declarado, no construido |
| **§1.3** | metas de corto y mediano plazo con avance | `budget.*` tiene encabezados, cero renglones | declarado, no construido |

---

## 3. `[CDRP.2]` — el registro de umbrales

### Ya existían TRES registros de umbral, y se midieron antes de crear el cuarto

| Registro | Qué es | Por qué no servía |
|---|---|---|
| `CRON_JOBS` (`db-health.service.ts:651`) | ~36 jobs con `warnH`/`critH` | frescura de **feeds en horas**, otra pregunta; y es un **array de TypeScript**: sin puesto, sin periodo, sin UI. Fuera de alcance a propósito |
| `commercial.execution_thresholds` (Horus HIQ.2/HIQ.4) | **sí es tabla** | **una fila por tenant y el umbral es una COLUMNA**. Agregar un indicador cuesta una migración; no escala a 16 KPIs × 9 puestos |
| `commercial.reorder_policy` | nivel de servicio por producto×almacén | otro grano |

`analytics.kpi_thresholds` **hereda el primitivo probado y corrige la forma**: `manual_lock` y
`auto_tuned_at` vienen tal cual de Horus (ADR-021 — el auto-calibrador no pisa lo que un humano
fijó), y el grano pasa a ser **una fila por (kpi, puesto, periodo)**.

### Cinco estados, y las dos ausencias no son la misma

```
ok | warn | bad | sin_meta | sin_medir
```

- **`sin_medir`** — no hay cifra. La fuente no existe o falló. **La arregla Sistemas.**
- **`sin_meta`** — hay cifra y nada contra qué compararla. **La arregla Dirección.**

Colapsarlas convierte *«no sé cuánto vendimos»* en *«vendimos y no sé si está bien»*, que son
problemas de dueños distintos. Y ninguna de las dos es `ok` — ésa es la regla entera (ADR-056).

`ORDEN_KPI_ESTADO` pone `ok` **último**: si `sin_meta` empatara con `ok`, un tablero ordenado por
estado escondería justo los indicadores que nadie puede juzgar.

### El CHECK de coherencia, y lo que la prueba refutó

```sql
(direction = 'higher_is_better' AND target >= warn_at AND warn_at >= escalate_at)
OR (direction = 'lower_is_better' AND target <= warn_at AND warn_at <= escalate_at)
```

⚠️ **Escribí que protege de «subir la meta» y el test lo refutó**: con `higher_is_better`, subir el
target lo **aleja** del amarillo y no puede romper nada. El descuido real es el inverso —
**RECORTAR la meta** a mitad de año (un presupuesto que se ajusta) y dejar el amarillo donde
estaba: ahí el amarillo queda por encima de la meta, `warn` se vuelve inalcanzable y el indicador
salta de verde a rojo sin etapa intermedia. Corregido en la migración y en el smoke, con el caso
positivo (subir la meta **debe** aceptarse) agregado.

### Nace vacía, con candado

Cero umbrales sembrados, y el smoke se pone **rojo** si aparece el primer **renglón** de
presupuesto — no porque algo se rompa, sino porque la razón para tener la tabla vacía dejó de
existir y toca registrar el primer umbral con su `source`.

⚠️ **La justificación ya envejeció una vez, en tres días.** La migración afirmaba *«las 6 tablas de
presupuesto tienen 0 filas (2026-09-18)»* y al 2026-09-21 eran **13** tablas con **3 pobladas**.
Peor: la frase estaba dentro de un `COMMENT ON TABLE`, o sea **persistida en prod**, donde editar
el archivo no la alcanza (la migración ya corrió). Hizo falta una migración aparte (**batch 503**)
para reemitirla. De ahí el candado: *un comentario con una medición no avisa cuando deja de ser
cierto; un test sí.*

---

## 4. ⛔ Estado medido contra prod — 2026-09-21

### 4.1 El bloqueo #1: las sillas están vacías

```
identity.positions   direccion             0 personas
                     direccion_comercial   0 personas
```

`comercial.venta_zonas` y `comercial.thot` **ya están repartidas a esos dos puestos** y no le
llegan a nadie. El dueño de la empresa (Luis Francisco López Gutiérrez, usuario `superuser`) está
registrado en el puesto `sistemas`. Consecuencia: **`[CDRP.0]`, `[CDRP.1]` y `[JZ.7]` están en
prod y no los ve ninguna persona.**

⭐ **Y no hace falta mover a nadie de puesto.** El reparto **por persona** ya existe entero:
`identity.user_responsibilities`, endpoint `POST /users/org/users/:id/responsibilities`
(`org.controller.ts`), UI en `/admin/personas` → ficha → Responsabilidades
(`persona-detalle.component.ts`, `agregarResponsabilidad()`), y `responsabilidadesDe()`
(`users.service.ts`) resuelve `position_responsibilities ∪ user_responsibilities`. Es **un clic,
reversible, sin migración ni deploy**.

⚠️ **La aceptación es visual, no de base de datos.** Si la clave se escribe mal, `medirZona`
devuelve vacío **con `motivo: null`** — pantalla muda, sin mensaje de error. El criterio de cierre
es *«entró a `/projects` y ve las 6 zonas + el consolidado»*, no *«la fila está insertada»*.

### 4.2 El presupuesto: ya se está capturando, y cambió la respuesta

| Tabla | Filas | |
|---|---|---|
| `budget.budgets` | **2** | una FY2027 «presupesto» en borrador, creada el **2026-09-21 a las 17:21Z** |
| `budget.sales_plan_settings` | **1** | método híbrido; crecimiento por canal: ruta +1.3 %, crédito −29.4 %, preventa +44.4 %, mostrador +12.5 % |
| `budget.expense_plan_settings` | **1** | |
| `budget.sales_plan_lines` | **0** | ⬅ los **renglones**, que es donde vive la meta |
| `budget.budget_lines` | 0 | |
| `budget.expense_plan_lines` | 0 | |
| `commercial.sales_targets` | **0** | tiene la forma exacta y **cero escritores** |

⭐ **Pregunta que estaba abierta y quedó contestada:** la meta de ventas saldrá de
`budget.sales_plan_lines` (`budget_id, entity_key, period_no, meta_amount, method, growth_pct,
base_amount`), **no** de `commercial.sales_targets`.

### 4.3 Cartera vencida: no es un KPI por construir, es un consumo

Fase CXC ya tiene todo — vista `analytics.customer_receivables` (derive-no-copy sobre
`kepler_ods.kdue`), `customer-ledger.service.ts` con buckets `por_vencer/d0_30/d31_60/d61_90/d90_plus`
y `pct_vencido`, `GET /finance/receivables/{resumen,tendencia}`, pantalla `/finanzas/cartera`,
permiso `FINANCE_RECEIVABLES_VER`, y un scanner `@Cron` que llena
`analytics.customer_receivable_snapshots`.

⛔ **Tres obstáculos medidos, ninguno de diseño:**

1. **`customer_receivable_snapshots` está en 0 filas en prod** y **no existe ni un
   `analytics.cron_runs` que la mencione**. El scanner nunca corrió, o corre mudo: `scanAll()`
   hace `.catch(e => logger.warn(...))`. Es la trampa que `CLAUDE.md` documenta para esta misma
   fase (*«quedó en prod como tabla vacía porque el importer nunca corrió»*), un nivel más arriba.
2. **La vista viva con aging cuesta 2.5 s** — el gate del proyecto es <1 s.
3. **La columna `estatus` es texto libre capturado a mano.** Valores reales medidos: `VTA 2-73`,
   `50-vta/07`, `CARRO`, `0119`, `15-08-2026`. **No clasifica nada**; el aging sale de
   `vencimiento` contra la fecha MX.

**Cifra medida (2026-09-21, por vencimiento):** $56,844,201 de saldo, **89.7 % vencido**
($50,970,764). Repartido: 1–30 d $22.69 M · 31–60 d $14.92 M · 61–90 d $7.04 M · 90+ d $6.32 M ·
vigente $5.87 M.

### 4.4 Liquidez: no es «una consulta»

No existe mapa de cuentas **circulantes** vs no circulantes. Hay balanza
(`analytics.ledger_monthly` por sucursal y `analytics.contpaqi_ledger_monthly` consolidada con
saldo de apertura, que es la apta) y `expense-family.contract.ts` sólo declara
`150 = ACTIVO NO CIRCULANTE`. **Falta una decisión contable humana**, no código.

⚠️ **El riesgo mayor no es no tenerla:** `budget-cashflow.service.ts` emite una alerta llamada
`falta_liquidez` que es **flujo prospectivo sobre saldo proyectado** — otro indicador. Confundirla
con la razón corriente es el error fácil.

### 4.5 Crecimiento interanual: no entra en la consulta que ya corre

Las dos consultas de venta de `me-zona.ts` acotan `whereBetween` a `[desde_comparado, hasta]`
(~2 meses), y el propio archivo documenta que esa forma bajó de **4.4 s a 131 ms**. Estirarla a 13
meses lo revienta. Es una **tercera consulta separada**, no una tercera ventana.

---

## 5. Backlog, en orden de valor entregado / esfuerzo

| Item | Estado | Qué falta y qué decisión humana espera |
|---|---|---|
| **[CDRP.3]** ocupar la silla | ⬜ **bloqueado en el usuario** | Cero código. `/admin/personas` → Luis Francisco → Responsabilidades → `comercial.venta_zonas`. Ídem `comercial.thot` para Dirección Comercial. **Enciende cuatro commits ya pagados** |
| **[CDRP.4]** cartera vencida en «Mi trabajo» | ⬜ | Latido + umbral en `CRON_JOBS` **antes** de diagnosticar por qué el scanner está mudo; bloque `me-cartera.ts` sobre la **foto diaria**, nunca la vista viva; `snapshot_date` + `dias_de_rezago` en pantalla. ⛔ **sin backfill**: la vista es de saldos actuales, no hay pasado que reconstruir |
| **[CDRP.5]** primer consumidor de `clasificarKpi()` | ⬜ | Hoy **nadie lo llama**. El veredicto lo emite el **servidor**; el cliente sólo mapea `estado` → clase CSS. Falta `KPI_KEY` como catálogo único + candado de biyección contra la tabla |
| **[CDRP.6]** crecimiento interanual | ⬜ | Tercera consulta + `desde_interanual` en `ventanaComparable()` + **tercer universo de pareo** (un canal puede no haber existido el año pasado). Gate de perf obligatorio |

### No se construye — declarado, con dueño

| Qué | Por qué | Dueño |
|---|---|---|
| **Liquidez / razón corriente** (§1.1 DG KPI 4, §4 KPI 1) | falta el mapa de cuentas circulantes: es decisión contable | Dirección / Contabilidad |
| **EBITDA, capital de trabajo, días de inventario** (§2 KPIs 3, 5, 6) | mismo bloqueo: exigen firmar qué agrupadores entran | Dirección / Contabilidad |
| **Metas por renglón** (§1.3) | se están capturando ahora mismo; el software no lo destraba | Dirección |
| **Compromisos / minutas** (§1.6) | módulo entero inexistente; es lo más caro de la spec | Dirección |
| **Clientes activos / líneas por ticket** (§3 KPIs 4, 6) | falta definir qué cuenta como «cliente activo» | Dirección Comercial |
| **CRUD de `analytics.kpi_thresholds`** | con 0 filas, las primeras entran por migración con su `source`. Una pantalla para una tabla vacía es justo lo que se pidió no construir | — |

---

## 6. Decisiones que sólo puede tomar un humano

1. **Ocupar `direccion` y `direccion_comercial`** (o repartir la responsabilidad por persona).
2. **Arbitrar el 89.7 % de cartera vencida** — o es real y es una emergencia, o el criterio de
   `vencimiento` no es el que usa el negocio. Hoy nadie lo ha dicho.
3. **Firmar qué agrupadores SAT entran a EBITDA** y qué cuentas son circulantes.
4. **Definir «cliente activo»** y explicar el salto 196 → 588 que quedó sin resolver.
5. **Nombrar las marcas estratégicas** (§3 KPI 8).
6. **La regla de escalamiento y su SLA** (§13): `escalate_to` existe en la tabla y nadie lo llenó.

---

## 7. Hereda

`ADR-076` (este) · `ADR-056` Verdad y Procedencia (lo que no se mide se DECLARA) ·
`ADR-053` / `db-health` (un umbral registrado o verde incondicional) · `ADR-021` Horus
(`manual_lock`: el auto-calibrador no pisa al humano) · `ADR-057` (la precedencia vive en un solo
lugar) · `ADR-061` / Fase SN (el mapa de espacios) · `[SN.30]` (si no respondés de una cola, no la
ves) · `[JZ.6]` (la portada toma el número de donde lo toma la pantalla).
