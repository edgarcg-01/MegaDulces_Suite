# Plan — saneamiento de plataforma (auditoría general del 2026-10-27)

> **Qué es esto:** el plan que sale de una auditoría general, **en sólo lectura**, de la base de
> producción, los importers y los contenedores de `md`. No es una fase nueva: el método
> ([`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md) §7) no permite abrir fases hasta terminar
> la campaña de aterrizaje. Por eso el trabajo se reparte así:
>
> - **Bloques 0 y 1** son tareas de operación de tamaño S, con código de área (`[SEC]`, `[OPS]`).
>   El método permite hacerlas sin fase, y el bloque 0 es «riesgo de seguridad», que va antes que todo.
> - **Bloque 2** (retirar importers) **no se abre aquí**. Se monta sobre la fase **SD**, que ya
>   existe, y espera su turno de cupo.
>
> Cada cifra salió de una medición del 27-oct. Lo que no se pudo medir está declarado en §6.

---

## 1. Resumen de la auditoría

| Frente | Bien | Mal (lo más grave) |
|---|---|---|
| **Base de datos** | Sin dependencias vivas a Railway ni a `.245`. 337 vistas leen el ODS directo. RLS forzada en casi todo `commercial`/`finance`/`hr`/`budget`. Una sola `knex_migrations` con contenido (1,349). | `analytics` (20 GB) pesa más que el propio ODS (11 GB). `wincaja_hist_sales`: 5 GB sin uso. 3 tablas `*_snapshot_bak`. 132 de 561 tablas vacías. `analytics` con RLS en 9 de 86 tablas. |
| **Importers** | El ODS (replicación + reconciliación) está sano en k3s. El crontab que corre es idéntico al del repo. | ~60 importers vivos copian el ERP a otros schemas; ~20 ni siquiera leen del ODS. 68 archivos con contraseñas, incluida la del superusuario del `:5433`, en un repo **público**. |
| **Contenedores** | Sin ingesta duplicada. Respaldos diarios al día. Cada carril tiene su razón. | Los respaldos viven en el mismo disco que prod. Nodo al 88 % de CPU y swap casi llena. 73 GB de «volúmenes reclaimable» que **son** prod. GlitchTip y SonarQube ocupan recursos sin servir. |

---

## 2. Bloque 0 — Seguridad y pérdida de datos (prioridad 0, esta semana)

| # | Item | Esfuerzo | Criterio de terminado (verificable) |
|---|---|---|---|
| **SEC-AUD.1** | **Rotar la contraseña del superusuario `postgres` del `:5433`** (pod `pgvector-md`) y la de `platform_ro` de las sucursales. | S | Con la clave vieja, la conexión falla (prueba negativa). Los carriles de `ingesta` siguen escribiendo (latido en `cron_runs` después de rotar). |
| **SEC-AUD.2** | **Sacar las credenciales del código:** los 68 archivos con `usuario:clave@` pasan a leer variables de entorno. Borrar los que ya son huérfanos (ver OPS-AUD.6) en vez de arreglarlos. | M | `git grep -E "postgres(ql)?://[^:/ ]+:[^@$\{ ]+@" -- database` da **0**. |
| **SEC-AUD.3** | **Compuerta para que no vuelvan:** el `pre-commit` hoy deja pasar `192.168.` a propósito. Agregar una regla que rechace `usuario:clave@` en una URL de conexión. | S | Rota a propósito una vez: un archivo de prueba con una URL con clave **queda bloqueado** (regla 12). |
| **OPS-AUD.1** | **Copia de los respaldos fuera de `md`:** segundo repositorio de pgBackRest o rsync nocturno de los volcados. | S–M | Existe un respaldo de ayer **en otra máquina**, y se restauró una vez en una base de prueba (no en prod). |
| **OPS-AUD.2** | **Candado contra borrar prod por limpieza:** documentar en `ops/README.md` y en `GOTCHAS.md` que `docker volume prune` borra `pg-prod` y el ODS. Evaluar mover los datos a una ruta fuera de `/var/lib/docker/volumes`. | S | La advertencia está en los dos documentos, y `podar-disco.sh` **nunca** llama a `volume prune` (verificado leyendo el script). |

⛔ SEC-AUD.1 y SEC-AUD.2 tocan credenciales: la regla 7 exige autorización explícita de Edgar.
⚠️ Rotar es lo que cierra el riesgo. Borrar las claves del código no basta, porque quedan en el
historial de git de un repo público.

---

## 3. Bloque 1 — Medir lo que no se sabe y limpiar lo barato (prioridad 1–3, próximas 2 semanas)

### 3.1 Medir primero (cada uno puede volverse un hallazgo de dinero)

| # | Item | Por qué | Criterio de terminado |
|---|---|---|---|
| **OPS-AUD.3** | **¿`import-cedis-stock-wincaja` está pisando la existencia del CEDIS?** Corre cada 15 min en modo REPLACE desde `wincaja.v_stock`, y Wincaja se retiró el 1-oct. | La existencia del CEDIS alimenta el sugerido de compras: si está congelada, se compra mal. **Prioridad 1.** | Fecha del último cambio real en `wincaja.v_stock` y comparación de `commercial.stock` del almacén 00 contra la existencia de Kepler (`kdik`), SKU por SKU. Si está congelada: se apaga ese renglón del crontab. |
| **OPS-AUD.4** | **¿Qué consume los 4.3 núcleos de `pg-prod`?** Habilitar o leer `pg_stat_statements`. | El nodo va al 88 % de CPU y con swap casi llena. | Top 10 de consultas por tiempo total, cada una con su dueño (servicio, importer o vista materializada). |
| **OPS-AUD.5** | **¿Qué servicios se conectan como `postgres` (que se salta RLS) y cuáles como `app_runtime`?** | La auditoría vio ~30 sesiones `postgres` contra 9 de `app_runtime`. La medición del 14-sep coincide, pero hay una nota posterior que dice que la conexión principal ya es `app_runtime`. | Tabla de conexiones → variable de entorno → servicio. Si un camino de usuario final usa `postgres`, se abre como hallazgo de seguridad (deuda ADR-010). |

### 3.2 Limpieza barata (sin riesgo de negocio)

| # | Item | Criterio de terminado |
|---|---|---|
| **OPS-AUD.6** | **Borrar importers muertos:** los 13 sin ninguna referencia, `mega-dulces-sync` (falla todos los días a las 03:05 porque apunta a `.245`) junto con su `@Cron`, y los `spawn` muertos de `kepler-consolidado.service.ts`. Revisar uno por uno los ~25 casi huérfanos. | `git grep` de cada nombre borrado da 0, y el log del worker deja de mostrar `sync FAILED`. |
| **OPS-AUD.7** | **Contenedores:** borrar los 4 contenedores Compose detenidos. Apagar SonarQube (lleva 8 días caído). Decidir GlitchTip (D4). | `docker ps -a` sin restos de Compose. Medir RAM antes y después. |
| **OPS-AUD.8** | **Arreglar `podar-disco.sh`:** hoy no recorta la caché de build (77 GB recuperables; 44 GB de disco libre perdidos en 2 días). | Una corrida fuera de horario muestra la caché **más chica** después que antes. |
| **OPS-AUD.9** | **Tablas muertas en `analytics`:** `wincaja_hist_sales` (5 GB, ya la cubre el FDW `wincaja_hist`) y las 3 `*_snapshot_bak` de caja. | ⛔ Regla 5: borrar tablas en prod exige autorización explícita. Antes: `count(*)` exacto, ningún lector en el código (`git grep`) y respaldo verificado (OPS-AUD.1). Fuera de horario. |
| **OPS-AUD.10** | **Tablas con varios escritores:** `analytics.cash_cuts` (un `@Cron` y un importer) y `analytics.sales_by_route_monthly` (4). | Un solo escritor por tabla, o el motivo escrito en el código. `cash_cuts` es candidata directa a vista sobre `kdpv_folio_caja`. |

### 3.3 Documentos que mienten

| # | Item | Criterio de terminado |
|---|---|---|
| **DOCS-AUD.1** | `docs/ARQUITECTURA_DATOS.md`: dice 338 tablas y 17 schemas; hoy hay 802 y 38. Menciona Railway y `.245`, y no menciona el schema `md` ni el FDW `wincaja_hist`. | Cifras remedidas con fecha, y el flujo dibujado como es hoy: Kepler → `pg-ods` → ingesta → `kepler_ods` → vistas. |
| **DOCS-AUD.2** | `ops/README.md` §3.1 da por activos dos procesos de caja que no corren en esta máquina. El pod `pgvector-md` es en realidad la fuente del ODS, no una base de vectores. | El README dice dónde corre cada proceso, medido. El nombre engañoso queda advertido. |

---

## 4. Bloque 2 — Retirar los importers de ventas (fase SD, espera cupo)

Es lo de **más dinero y más esfuerzo**: el motor de margen y unos 65 servicios leen
`analytics.sales_daily`, que es una copia del ERP hecha por importer. Ya existe una fase diseñada
para esto: [`FASE_SD_RETIRO_LINAJE_VENTAS.md`](FASE_SD_RETIRO_LINAJE_VENTAS.md), en 🔨 «diseñado»
desde el 11-sep y **sin fila en el roadmap** (o sea, según el método, no existe).

**Propuesta:** no abrir una fase nueva. Darle a SD su fila con ⏸️, y cuando haya cupo partirla así:

| Paso | Qué | Tamaño |
|---|---|---|
| SD-a | Inventario: los ~60 importers vivos clasificados en (1) fuente externa legítima, (2) lee del ODS pero copia → vista, (3) lee de `mart.ventas`, `KP_CONCENTRADA` o `md_0X` → hay que cambiar la fuente. | S |
| SD-b | Los del grupo (2) que no tienen lectores pesados (`box_factor`, `reorder_policy`, `product_barcodes`, `cash_cuts`…) pasan a vista, uno por commit, con paridad antes/después. | M |
| SD-c | `sales_daily` y su cadena: lectores migrados al linaje del ODS con candado de paridad (lo que ya diseña SD). | L–XL |

---

## 5. Decisiones para el PM

| # | Decisión | Recomendación |
|---|---|---|
| **D1** | ¿Quién rota las credenciales y cuándo? (regla 7) | **Edgar, esta semana, fuera de horario.** Avisar a ingesta antes, porque los carriles se reconectan. |
| **D2** | ¿Reescribir el historial de git para borrar las claves? | **No.** Requiere force-push a `main`, que está protegida. Rotar las vuelve inútiles. |
| **D3** | ¿A dónde va la copia de los respaldos? | **`.249` como primer paso** (ya existe y está en la LAN), y algo fuera del edificio después. |
| **D4** | GlitchTip: ¿se conecta (cambiar `SENTRY_DSN`) o se apaga? | **Apagarlo** mientras ERR.3 no tenga dueño. Hoy son 4 pods que no reciben ningún evento. |
| **D5** | ¿SD entra en el cupo de 4 fases? | **Después de la campaña de aterrizaje.** Mientras tanto, sólo su paso SD-a (inventario), que es medición. |

---

## 6. Lo que NO se pudo medir

- Si los importers terminan bien según sus latidos en `analytics.cron_runs`: se negó la lectura.
- El lado de la fuente (`pg-ods`, `:5433`) y `pg-rag` por dentro: réplicas, slots y tamaños.
- Si `wincaja.v_stock` está congelado (es justo OPS-AUD.3).
- Los 3 carriles de Wincaja que siguen en `.249`.
- Uso de índices: las estadísticas se reiniciaron el 22-oct, así que **5 días no alcanzan para
  borrar ningún índice**. Se remide a 30 días.
- La CPU del nodo es una sola foto, sin serie histórica.

---

## 7. Orden de ejecución

```
Semana 1 (oct 27–31)    D1 → SEC-AUD.1 · SEC-AUD.3 · OPS-AUD.1 · OPS-AUD.2 · OPS-AUD.3
Semana 2 (nov 3–7)      SEC-AUD.2 · OPS-AUD.4 · OPS-AUD.5 · OPS-AUD.6 · OPS-AUD.7 · OPS-AUD.8
Semana 3 (nov 10–14)    OPS-AUD.9 (con autorización) · OPS-AUD.10 · DOCS-AUD.1–2 · SD-a
Después de Fase 0       SD-b → SD-c
```

## 7bis. Análisis: refrescar y re-escanear (PM, 2026-10-27)

> Pedido del PM: *«caja general necesita la información de inmediato, pero refrescar no es una
> solución. Todo lo que sea refrescar, re-escanear, etc. que sea un proceso de miles de consultas
> es ineficiente»*. Esto es el análisis previo al diseño. Medido en prod en sólo lectura.
> `pg_stat_statements` desde el 2026-10-26 09:13 (~27 h); `pg_stat_user_tables` desde el reinicio
> del 2026-10-22 (~5 días).

### Cuánto cuesta refrescar, todo junto

28 vistas materializadas se refrescaron en la ventana: **~52,400 s en 27 h ≈ 46,000 s/día ≈ 0.53
núcleos sostenidos** (sólo el proceso líder; los paralelos no se suman).

| Vista | Corridas en 27 h | Costo | Parte del total |
|---|---:|---:|---:|
| `mv_caja_movimientos` | 4,765 (~3 por minuto) | 35,730 s · 7.5 s c/u | **68 %** |
| grupo existencia-aux (`mv_warehouse_box_factor`, `mv_price_truth`, `mv_kepler_unit_cost`, `mv_product_box_factor`) | 328 c/u (cada 5 min) | 6,619 s | 13 % |
| `mv_new_products` | 55 (cada 30 min) | 3,708 s · 67 s c/u | 7 % |
| las otras 21 | — | ~6,300 s | 12 % |

### La caja: se recalcula más veces de las que cambia el dato

- `kepler_ods.kdm1` recibió **15,592 cambios en ~5 días** (6,581 altas, 8,977 cambios, 34 bajas):
  **~130 por hora**, de **todos** los tipos de documento, no sólo de caja.
- La vista se refrescó **~175 veces por hora**. Cada refresco recorre los ~651 mil renglones de
  `kdm1` para reflejar, en promedio, **menos de un cambio**.
- `kdb1` (catálogo de cuentas): **0 cambios en 5 días**. `kdfe33pagm1` (complemento): 43 altas.
- Cada movimiento depende **sólo de su propio renglón** de `kdm1` más catálogos chicos: no hay
  saldos acumulados, ventanas ni agregados en la vista. ⇒ mantenerlo por cambio es posible sin
  recalcular nada más.
- La cadena ya es por evento hasta el ODS: réplica → cola (`ODS_COLA_TABLES=kdm1,kdm2`) →
  `ods-live-caja` cada 0.25 s → `feeds-ingest` (UPSERT sin churn, sabe qué filas cambió) →
  `NOTIFY caja_fuente`. **El único eslabón que recalcula todo es el `REFRESH`.**
- Estimación a validar: ~3,100 cambios/día × pocos ms ≈ **segundos al día**, contra ~31,000 s/día
  de hoy. Y la latencia baja de 5–10 s (lo que tarda el refresco) a lo que tarda la ingesta.
- ⚠️ El complemento de pago (`v_kepler_payment_complement`) y las cuentas de `finance.bank_accounts`
  hoy quedan congelados dentro de la vista entre refrescos; en el diseño se cruzan al leer.

### Lo demás que recalcula sin preguntar (inventario del código)

- 14 vistas se refrescan cada ≤ 15 min y **sólo la de caja pregunta antes si algo cambió**.
- La foto «Para cuidar hoy» (`product-flow.service.ts:554`) recalcula el universo de productos
  **cada minuto**, sin compuerta y sin medición escrita. Es cálculo, no vista: no aparece arriba.
- `import-pos-ticket-sales` agrupa **toda la historia de `kdm1`** cada hora y reescribe todas las
  filas (`merge` sin `IS DISTINCT FROM`).
- El vigilante de recepciones (cada 5 min) y `publish-tienda` (cada 10 min) recorren tablas
  completas sólo para detectar lo nuevo, cuando `feeds-ingest` ya sabe qué cambió.
- `mv_caja_autofill_entidad` se refresca **sin** `CONCURRENTLY`: bloquea a los lectores cada hora.

### Conclusión del análisis

1. **La caja es el 68 % de todo el costo de refrescar** y el dato cambia menos veces de las que se
   recalcula. Mantenerla por cambio es posible y es lo de mayor retorno.
2. El primitivo que falta es **«avisar qué cambió»**: `feeds-ingest` ya lo sabe por tabla y por
   fila, pero sólo avisa para `kdm1`/`kdb1`. Con ese aviso general, los demás procesos pueden
   reaccionar a cambios en vez de recorrer todo (ADR-056: va a `libs/`, no a cada proceso).
3. Lo que no se puede hacer por cambio (agregados de 30/90/365 días, rankings) necesita al menos
   la compuerta «¿cambió algo desde la última vez?» que ya existe en la caja.

## 9. Diseño: la caja por cambio (`[OPS-AUD.11]`, ADR-104)

**Objetivo:** que un movimiento de caja llegue a la pantalla en cuanto entra a `kepler_ods.kdm1`,
sin recorrer la tabla. **Métrica:** costo de mantener la caja — HOY 35,730 s en 27 h (medido
2026-10-27) → META < 100 s/día; latencia ingesta → pantalla — HOY 5–10 s del refresco → META < 1 s.

### Lo que el análisis fijó (sin esto el diseño no se sostiene)

| Hecho | Medido / leído | Consecuencia |
|---|---|---|
| Un movimiento depende sólo de su renglón de `kdm1` + catálogos | definición `20260924230000`: sin ventanas ni agregados | se puede calcular renglón por renglón |
| Llave de `kdm1` | `kdm1_pkey (sucursal, c1, c2, c3, c4, c5, c6)` | la tabla guarda esa llave de origen |
| La llave de la pierna no incluye `c5` | índice único de la vista materializada | la tabla **no** exige unicidad por la llave de negocio: un duplicado no puede romper la ingesta |
| `kdb1` casi no cambia | 0 cambios en 5 días | un cambio ahí reconstruye todo (~5 s), aceptable |
| Complemento SAT y `bank_accounts` cambian por su cuenta | 43 complementos en 5 días | se cruzan al leer |
| `kdm1` en `pg-prod` no es suscriptor de replicación | 0 suscripciones | los triggers disparan normal, sin `ENABLE ALWAYS` |
| Escritores de `kdm1`: `feeds-ingest`, reconciliación, borrados de la cola | `ops/k3s/2*.yaml` | el trigger los cubre a todos |

### Pasos, cada uno se puede revertir solo

| Paso | Qué | Dónde se prueba | Riesgo |
|---|---|---|---|
| **11.1** | Migración A: tabla + función `kdm1_legs` + triggers + carga inicial + función de paridad. **No cambia ningún lector.** | prueba en base real: alta, cambio, baja, cancelado (`c43='C'`), traspaso con dos piernas, cuenta fuera del catálogo, cambio en `kdb1`, `TRUNCATE`, y error dentro del trigger que no frena el `kdm1` | se aplica fuera de horario; la carga inicial son ~5 s |
| **11.2** | Paridad en prod, sólo lectura: tabla contra la vista vieja, fila por fila en las dos direcciones | `EXCEPT` en ambos sentidos = 0 | si no da 0, se para aquí |
| **11.3** | Medir el costo del trigger en la ingesta (latido de `ods-live-caja`) un día hábil | antes / después | si sube, se revisa antes de seguir |
| **11.4** | Migración B: `kepler_bank_movements` y `mv_caja_movimientos` leen la tabla (mismo nombre y columnas); el trigger avisa a la pantalla | las pruebas de `libs/finance/src/lib/caja` + paridad | revertir = migración B hacia atrás |
| **11.5** | Retirar el cron de cada minuto, `caja-mv-push` y la sonda `mv_caja_refresh` (con `retiredOn`) | `pg_stat_statements`: 0 `REFRESH mv_caja_movimientos` | — |
| **11.6** | Árbitro diario (07:20) con latido en Salud BD — 🧪 en código | se rompe a propósito una vez (una pierna borrada a mano) y debe reportarla | — |

⛔ 11.1 y 11.4 son migraciones: se generan con `node scripts/nueva-migracion.js` y se aplican en
prod una por una, fuera de horario. 11.4 no entra hasta que 11.2 dé cero y 11.3 esté medido.

## 10. Retiro de crons: el dato se mantiene por EVENTO (PM, 2026-10-27)

> *«No deberían existir casi ningún cron.»* Regla: el camino del dato es por cambio (cola en la
> réplica, trigger en la base, `NOTIFY` a la pantalla). Un barrido periódico sólo sobrevive como
> **árbitro que alarma** (debe dar 0) y con fecha de retiro. Cada fila sale con su medición antes y
> después (`pg_stat_statements` / latido).

| Cron hoy | Cadencia | Reemplazo por evento | Estado |
|---|---|---|---|
| `REFRESH mv_caja_movimientos` + `caja-mv-push` | 1 min + aviso | Tabla mantenida por trigger desde `kdm1` (ADR-104) | ✅ 11.1–11.2 en prod · 🧪 11.4+11.5 en código (mig `20261027153139`), sin aplicar |
| Reconciliación y dedup nocturnos de pólizas (`kdc2*`) | 02:25 | Cola de cambios en vivo + event trigger por mes (`[OPS-AUD.13]`) | ✅ desplegado 2026-10-27; el nocturno queda de puente → alarma |
| `import-kepler-polizas` (reporte de pólizas que ve Contabilidad) | 03:00 | Triggers en cada `kdc2YYMM` rearman la póliza tocada + event trigger del mes (`[OPS-AUD.14]`) | ✅ retirado 2026-10-27 |
| `kepler-replica-refresh` (suscribe la tabla del mes) | diario 06:22 | ⬜ por resolver: el aviso de tabla nueva nace en el POS (publicador), fuera de nuestro alcance hoy | ⬜ |
| Grupo existencia-aux (4 MVs) | 5 min | ⬜ derivar de la cola de `kdik`/`kdil` (mismo patrón que la caja) | ⬜ medir |
| `mv_new_products`, `mv_rd_route_*`, 8 MVs de 15 min | 15–30 min | ⬜ por cada una: ¿se mantiene por fila (trigger) o es agregado? Los agregados, compuerta «¿cambió?» como mínimo | ⬜ |
| Foto «Para cuidar hoy» (`product-flow.service.ts:554`) | 1 min | ⬜ recalcular sólo al llegar un cambio de existencia o venta | ⬜ medir |
| `pos-ticket-sales` (toda la historia de `kdm1`) | 1 h | ⬜ por trigger desde `kdm1` (misma vía que 11.1) | ⬜ |
| Vigilante de recepciones · `publish-tienda` | 5 · 10 min | ⬜ `NOTIFY` por tabla desde `feeds-ingest`, que ya sabe qué cambió (primitivo a `libs/`) | ⬜ |
| `ods-reconcile` (ventana 3 días) | 15 min | Árbitro: la cola cubre `kdm1`/`kdm2`/`kdc2*`; queda para las tablas sin cola | → alarma |
| `ods-reconcile-full` (`kdpord`, `kdm2`, `kdij`) | 02:10 | ⬜ cola en esas tablas (borra 6,151 filas por noche: medir por qué) | ⬜ |
| `import-replenishment-plan`, `sales-stats`, `demand-clean` | 15–30 min | Agregados de ventana: compuerta «¿cambió?» y, a la larga, fase SD | ⬜ |
| `nightly` (~50 pasos, 69–99 min) | 03:00 | Se desarma con la fase SD (importers → vistas) | ⬜ |

## 8. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-27 | Auditoría general en sólo lectura (base, importers, contenedores) y este plan. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.3 corregido:** el importer NO pisaba el CEDIS. El guard lo frenaba desde el corte del 30-sep (`cutover_done`), y la auditoría lo dio por activo sin leer el guard. Igual se retiró (`6d17c81ef`): corría 2× por ciclo y revivía si alguien vaciaba `kepler_code`. Wincaja Irapuato queda sólo para históricos (PM). | Sesión Claude |
| 2026-10-27 | **OPS-AUD.6 (parte código):** fuera 10 importers sin referencias y el módulo `mega-dulces-sync` (`5b7dccfd4`). Se quedan `import-bank-statement` (lo usa un test) y `checadores/*` (corte de relojes de RH). Arranque no verificado en local: lo valida el CI. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.5 (desde el código):** ~341 archivos van por `TenantKnexService` (rol `app_runtime`, RLS filtra). **45 archivos del dominio `trade`** (supervisor-ai ×21, reports, users, auth, scope, ability…) inyectan `KNEX_CONNECTION` = `DATABASE_URL`, que según el manifiesto leído por la auditoría es `postgres` → **se saltan RLS**. 11 usan `KNEX_NEW_DB_ADMIN` (`postgres`), todos crons o mantenimiento. ⚠️ El rol real de `DATABASE_URL` en el pod NO se midió (lectura de prod denegada en esta sesión). | Sesión Claude |
| 2026-10-27 | **OPS-AUD.10 (`cash_cuts`):** fuera `import-cash-cuts` del runner (`8430bab74`); dueño único el `@Cron` de 10 min sobre `kepler_ods`. Paridad fila a fila NO medida. **`sales_by_route_monthly` (4 escritores) queda pendiente**: el `GREATEST` entre escritores parece intencional y hay que medirlo antes de tocarlo. Además: la pantalla `almacen-cuadre` dice «¿Corriste import-cash-cuts?» cuando no hay cortes — texto que ya miente. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.8 era un falso hallazgo:** `podar-disco.sh` no toca la caché a propósito mientras haya > 60 GB libres (`[CD.22]`: vaciarla cuesta ~10 min por despliegue); hoy hay 93. La baja de 125 → 81 GB libres en dos días NO es la caché: queda por medir (candidatos: `pgbackrest` y volcados). **OPS-AUD.2:** advertencia en `ops/README.md` §2.1 (`557380ec7`). **DOCS-AUD.2 era otro falso hallazgo:** la auditoría miró PM2 en la máquina de trabajo y §3.1 habla de `.249`. **DOCS-AUD.1:** aviso de rancio con cifras remedidas en `ARQUITECTURA_DATOS.md`. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.4 medido** (PM por SSH, `pg_stat_statements`, sólo lectura; ventana ≈ 3.1 días = 4,464 corridas de un refresco por minuto). Top: (1) `REFRESH mv_caja_movimientos` cada minuto: **33,616 s**, 7.5 s por corrida, con 2 procesos paralelos además del líder (que `pg_stat_statements` no suma). (2) **`pagoParaCoincidir`** (`supplier-payment-proofs.service.ts:507`), **N+1**: `recheck()` del autopiloto (`@Cron` cada 20 min) consulta pago por pago hasta 500 pendientes. **39,000 llamadas × 523 ms = 20,400 s**. (3) `REFRESH mv_price_waterfall_sku`: **una sola corrida de 2 h 56 min** (nocturna de `analytics-refresh`). El top 15 suma ~104 k s ≈ **0.4 núcleos de promedio** (sin contar los procesos paralelos): los 4.3 núcleos de la foto de la auditoría fueron un pico, no la carga sostenida. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.5 confirmado en el pod `api`:** `DATABASE_URL` y `DATABASE_URL_NEW` = `postgres`; sólo `DATABASE_URL_NEW_RUNTIME` = `app_runtime`. ⇒ los 45 archivos de `trade` que inyectan `KNEX_CONNECTION` corren como superusuario y **RLS no los filtra**. Hoy hay un solo tenant, así que no se cruzan datos entre clientes; el riesgo se activa con el segundo tenant (deuda ADR-010). | Sesión Claude |
| 2026-10-27 | **OPS-AUD.4 · consulta pago por pago del autopiloto corregida (`6158add83`, 🧪 sin desplegar).** Medido en prod (sólo lectura, `EXPLAIN ANALYZE` con la misma lista literal de tuplas que manda el código, 500 pendientes, 0 sin `doc_prefix`): **ANTES 500 × 523 ms ≈ 261 s por pasada → DESPUÉS 10.5 s** (−96 %), cada 20 min. Confirmado en el plan que el filtro se aplica antes de buscar el banco (`loops=485`, no 4,879). Lo que queda de esos 10.5 s: 3.6 s de JIT (el costo estimado lo dispara), 4.6 s del CTE `flj` de `kepler_bank_movements` (se arma una vez) y 485 × 16 ms de búsqueda en memoria. ⚠️ Con un `IN (SELECT …)` el planificador arma la vista de los 4,879 pagos antes de filtrar: 26.6 s. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.11.1 en código (`5039b9f9a`)**: tabla + función + triggers + árbitro; prueba contra base real 30/30, rota a propósito (sin el filtro de cancelados) → 8 rojos; `SECURITY DEFINER` probado en negativo. Falta: empujar, aplicar fuera de horario y paridad 11.2. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.12 · pólizas corregidas que no se veían (`9120d4af6`).** Medido en seco en prod (Job aparte de 4 GiB, sin `--apply`): **154 sobrantes**, no 118 — 124 en jun–sep de la 00 (jun–ago: cuenta 762-001, las correcciones del SUA; sep: pólizas completas borradas en Kepler) + 30 de octubre en 00/01/03/06; 18 duplicados por hora; 0 tablas abortadas; el freno de réplica en 0 se activó en 06/07/08. ⛔ **Defecto encontrado antes de encender el borrado:** el camino de sobrantes mandaba la fecha de la PK como Date de JS y, con los tipos reales del ODS (`timestamptz`, sesión en hora de México), pedir borrar la póliza de las 00:00 borraba la de las 06:00 — la otra copia. Corregido con `lib/ods-pk.js` (el mismo camino que el dedup, que ya funciona en prod) y probado en negativo. **Por qué reaparecen duplicados en jul–ago:** las filas anteriores al 23-sep quedaron con la convención vieja (+6 h); al editarlas, la versión nueva no empata y nace un duplicado que el dedup nocturno junta. No es un generador activo. ⚠️ **Junio queda fuera** de la ventana nocturna (4 meses): 31 sobrantes y 5 duplicados que requieren una corrida única autorizada. | Sesión Claude |
| 2026-10-27 | **PM: «nada debería ser nocturno; no deberían existir casi ningún cron».** Las pólizas pasan a la cola de cambios en vivo (`04401ac33`): event trigger que pone la cola sola en la `kdc2YYMM` de cada mes, borrado en vivo sin freno de edad (D1 del PM) y con tope, fecha de la PK como texto. test-ods-cola 84/84, roto a propósito → 2 rojos. El borrado nocturno (`9120d4af6`) queda como PUENTE hasta desplegar esto; después, sólo alarma y se retira. | Sesión Claude |
| 2026-10-27 | **Normalización única de la hora de pólizas** (`ops/prod/paso-a-mano/OPS-AUD13-polizas-hora-6h.sql`). Medido en prod: ~297 mil filas a las 06:00 (kdc22408 → kdc22612), 0 a otra hora, 27 con gemela a las 00:00. El script borra la copia de las 06:00 con gemela y mueve las demás a 00:00; aborta si aparece otra hora o si pasa del tope. Probado en local: en seco no toca, aplica bien, y los dos frenos abortan sin tocar. ⚠️ **Pendiente de investigar:** `kdc22610` tiene 8 filas a las 06:00 escritas DESPUÉS del 23-sep — algún carril sigue escribiendo con la hora corrida (hipótesis: el sink HTTP manda la fecha como JSON UTC y pasa por una tabla de paso sin zona; el sink `pg` lo hace bien). Y `kdc22612` (dic-2026) tiene 168 filas: revisar en Kepler. | Sesión Claude |
| 2026-10-27 | **11.1 APLICADA en prod** (13:39:02, ledger `public.knex_migrations`) y **11.2 PARIDAD = 0**. Medido 13:5x, sólo lectura: tabla 56,717 piernas = vista 56,717; faltan 0 · sobran 0 (fila por fila, 16 columnas, las dos direcciones, 1.1 s); árbitro `drift()` 0 · 0 (8.2 s); `bank_movement_legs_errors` = 0; última pierna 13:44:04, cinco minutos después de aplicar → el trigger recibe movimientos vivos. ⚠️ El push subió el `main` local entero (incluida la migración y 8 commits de otras sesiones) en vez del commit preparado; la migración se aplicó enseguida, así que el vigía no llegó a congelarse. Sigue 11.3: costo del trigger en la ingesta un día hábil. | Sesión Claude |
| 2026-10-27 | **11.3 · foto base del costo del trigger** (13:50:06, `pg_stat_statements` desde 2026-10-26 09:13; el trigger lleva ~11 min de esa ventana). UPSERT a `kepler_ods.kdm1`: **12,425 llamadas · 62,137 ms · 5.00 ms prom.**; DELETE: 63 · 10 ms. El trigger NO aparece por sí solo (track = top: lo de adentro de un trigger no se cuenta) — su costo va DENTRO del UPSERT. Mañana: misma consulta y Δms_total ÷ Δcalls = costo por escritura con trigger, contra 5.00 ms. Carga inicial: 9.3 s (la ingesta de kdm1 esperó eso a las 13:39). | Sesión Claude |
| 2026-10-27 | **OPS-AUD.14 · el REPORTE de pólizas (lo que ve Contabilidad) por cambio.** `import-kepler-polizas.js` (cron 03:00) leía cada sucursal directo, nunca borraba (llave con la cuenta → el 762-001 viejo se quedaba para siempre), inventaba `num_movto` sin ORDER BY y sólo miraba 6 meses. Se reemplaza por triggers en cada `kepler_ods.kdc2YYMM` que rearman la póliza COMPLETA tocada (mig `20261027135745`), event trigger para el mes nuevo, árbitro por mes, y se retira del runner. FRENO de la carga inicial: sucursal×mes sin filas en el ODS no se toca. Prueba contra base real 21/21 (paridad con la transformación del importer portada, cambio de cuenta, num_movto estable, freno, ContPAQi intacto, 2 negativas); rota a propósito (sin la guarda de otra plaza) → rojo. ⚠️ Orden en prod: imagen de ingesta SIN el importer → migración fuera de horario. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.13 + .14 EN PROD, verificado (sólo lectura, ~15:20).** Ledger: `20261027135745` aplicada 15:14:46. Triggers del reporte en **24 de 24** tablas `kdc2YYMM`; event trigger `kdc2_gl_polizas_auto` activo (`O`); `gl_polizas_kepler_errors` = **0**. ODS: **0** filas de póliza fuera de las 00:00 (normalización aplicada). Árbitro `gl_polizas_kepler_drift` en los 24 meses: **0 faltan · 0 sobran** → el reporte coincide renglón por renglón con el ODS, incluida la corrección del SUA (762-001 → 601-015). ⚠️ **NO MEDIDO con estas consultas:** (a) que la cola esté puesta en las réplicas de `pgvector-md` (`ods-cola-instalar --tables=kdc2*`) — el árbitro compara reporte contra ODS, no ODS contra el origen; se verifica con la primera póliza que Contabilidad edite mañana: debe llegar al reporte en segundos y sin duplicado; (b) que el ODS ya no tenga los 154 sobrantes contra el origen (eso lo dice la próxima corrida del árbitro `ods-reconcile`, que debe dar 0). | Sesión Claude |
| 2026-10-27 | **SEC-AUD.3 cerrado (código).** La regla de cadenas con clave ya existía en `.gitleaks.toml`; el hueco era su excepción, que aceptaba las claves conocidas hacia cualquier `192.168.*`. Medido en el repo (sin imprimir claves): con esas claves había **8 cadenas al superusuario de la fuente del ODS (`.222:5433`)** y **26 a las réplicas de sucursal (`platform_ro`)**, todas permitidas. Ahora la excepción sólo vale para `localhost`/`127.0.0.1`/`::1` seguidos de un delimitador. Prueba con gitleaks 8.30.1 en los dos sentidos: `postgres:…@192.168.0.222:5433` ANTES exit 0 → AHORA 7 (marcado); `localhost` y `127.0.0.1` siguen en 0; la trampa `localhost.evil.com` da 7. Efecto: gitleaks sólo escanea las líneas que se tocan, así que las cadenas viejas no frenan a nadie hasta que alguien las edite — y entonces obliga a pasarlas a variable de entorno (SEC-AUD.2). ⚠️ No cierra el riesgo: eso lo hace la rotación (SEC-AUD.1). | Sesión Claude |
| 2026-10-27 | **OPS-AUD.11.4 + 11.5 en código (🧪, sin empujar ni aplicar).** Van JUNTOS: al dejar de ser materializada, el refresco de cada minuto fallaría. Migración `20261027153139`: (1) `kepler_bank_movements` lee `bank_movement_legs` — mismas columnas; ANTES de reemplazarla compara vieja contra nueva fila por fila y ABORTA si no da 0/0; (2) `mv_caja_movimientos` pasa a VISTA con el mismo nombre (sin `security_invoker`, a propósito: expone lo mismo que exponía la materializada); su cadena de dependientes se repone desde el catálogo — **la guarda encontró una nieta que no estaba en el plan:** `analytics.mv_caja_autofill_entidad` (materializada, CG.141) cuelga de la bandeja; se repone con sus índices y **con el tenant fijado**, porque sin él nace vacía (GOTCHAS §87.1); (3) el aviso `NOTIFY caja_movimientos` lo emite un trigger sobre la tabla, sólo si cambió una pierna de caja, con el mismo payload **más `suma`** — `caja-autollenado` armaba su firma con `d.suma` que el refresco nunca mandó, así que una corrección de importe no lo despertaba. Retirados: renglón `caja-mv` del crontab, deployment `caja-mv-push` y su script, y los latidos `mv_caja_refresh`/`mv_caja_push` de Salud BD. La frescura de la bandeja pasa a `ods_live_caja` (si siguiera leyendo el latido retirado, la pantalla diría «datos de hace N horas» sobre datos al día). Prueba contra base real 22/22, con 3 negativas: tabla desfasada → la migración aborta sin tocar nada; aviso roto → kdm1 se escribe y el error queda registrado; **sin fijar el tenant → la nieta nace vacía y la migración se revierte** (roto a propósito: rojo; restaurado: 22/22). db-health.spec 13/13. ⚠️ NO MEDIDO: el costo de leer en prod con la forma nueva — `ops/prod/paso-a-mano/OPS-AUD11-4-medir-antes.sql` (sólo lectura, ROLLBACK) lo mide antes de aplicar; la entrega del NOTIFY (se verifica con `LISTEN` tras aplicar); typecheck de `libs/finance` (sólo cambian literales). Orden en prod: medir → imagen de ingesta sin `caja-mv` + borrar el deployment `caja-mv-push` → migración fuera de horario. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.11.6 en código (🧪, sin empujar): el árbitro de lo que mantienen los triggers.** `ArbitroPorCambioService` (`libs/finance/src/lib/caja`), diario 07:20 MX: mide `bank_movement_legs_drift()` y `gl_polizas_kepler_drift(mes)` en cada `kdc2YYMM`; si hay diferencia la REPARA y vuelve a medir, pero late con `error` igual — una diferencia significa que el trigger tiene un hueco, y repararla en silencio lo escondería. También es falla un error en `*_errors` de las últimas 25 h; lo que no se pudo medir se declara NO MEDIDO. Latido `arbitro_por_cambio` en Salud BD (warn 26 h, crítico 50 h). Usa `latirCron` (platform-core): no inventa primitivo. Veredicto puro con su prueba 5/5 (incluye: reparado sigue siendo falla; no medido no cuenta como limpio). Typecheck acotado de `libs/finance`: 0 errores en los archivos tocados (el total, 62, son TS1272 preexistentes de compilar suelto). ⛔ Corrección: un primer typecheck que reporté «sin errores» NO había corrido (ruta de tsconfig inexistente). ⚠️ NO MEDIDO: arranque del worker (servicio nuevo con `@Inject` por token explícito, mismo patrón que `CajaAutofillRefreshService`; lo valida el CI y el arranque), y la corrida contra prod (se ve en Salud BD mañana 07:20). | Sesión Claude |
| 2026-10-27 | **OPS-AUD.13.2 · quién sigue escribiendo pólizas a las 06:00 — mecanismo encontrado, carril NO identificado.** El receptor HTTP (`services/feeds-ingest/apply-handlers.js`, `applyRawUpsert`) arma `stg_raw` con el tipo de la FUENTE (`timestamp` sin zona); una fecha que sale de un contenedor en hora de México viaja como JSON `…T06:00:00.000Z` y al caer en una columna sin zona Postgres descarta la Z → 06:00. Es el mismo defecto que `lib/ods-pk.js` ya cerró en el borrado. El camino directo (`FEEDS_SINK=pg`) fija la sesión en hora de México y no lo tiene. ⚠️ NO MEDIDO: qué carril usa HTTP (los manifiestos toman `FEEDS_SINK` del secreto `ingest-env`; `make-env.js` trae `http` por defecto) ni la zona con que abre sesión el receptor. **No se corrigió el receptor a ciegas:** cambiar cómo interpreta las fechas podría correr 6 h datos que hoy llegan bien (Wincaja). Se agregó la ALARMA: el árbitro diario cuenta pólizas fuera de las 00:00 por tabla (tras la normalización deben ser 0 siempre) y lo publica como falla. Prueba del veredicto 6/6. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.13.2 · hipótesis del receptor HTTP REFUTADA.** Medido en prod (sólo lectura): el secreto `ingest-env` trae `FEEDS_SINK=pg` y ningún manifiesto de `ops/k3s` lo sobreescribe → los carriles de ingesta escriben directo con la sesión en hora de México y no pasan por `stg_raw`. El defecto del receptor (descarta la Z en una columna sin zona) es real, pero NO explica los 8 renglones de octubre a las 06:00. Su origen sigue sin identificar; la alarma diaria del árbitro (pólizas fuera de las 00:00) dirá si hay un escritor vivo. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.4 (sesión):** la lectura de `pg-prod` por `kubectl exec … psql` la deniega el clasificador de permisos de Claude Code (a los agentes y a la sesión). Hace falta una regla de permiso o que alguien corra la consulta de `pg_stat_statements` a mano. | Sesión Claude |
