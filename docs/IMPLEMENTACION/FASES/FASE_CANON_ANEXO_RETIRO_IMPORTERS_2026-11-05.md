# Anexo CANON.5 — Retiro de los importers vivos (inventario del 2026-11-05)

> ⛔⛔ **2026-11-11 — la regla se endureció: «ningún importer y ningún cron» (Edgar, 2026-11-10) y
> «hay que erradicarlos» (2026-11-11).** «Repuntar» (seguir siendo tabla con reloj, pero leyendo el
> ODS) **ya no cierra nada**, y la categoría «se queda como tabla con razón» (§3.2) tampoco existe
> si la tabla se llena con reloj. El plan vigente es el **§8**; §2–§7 quedan como historia.
>
> **Estado anterior: ⏸️ — no se abre como fase.** El tablero tiene 9 fases 🔨 contra un cupo de 4
> (`node .claude/skills/pm/tablero.js`, 2026-11-05). Este anexo deja el trabajo **clasificado y
> priorizado**; sólo la oleada 0 (abajo) se hizo, porque no toca el esquema. Lo demás espera cupo o
> una excepción firmada (D1).
>
> Hermano de [`FASE_CANON_INGESTA.md`](FASE_CANON_INGESTA.md), que planteó la meta el 2026-08-20.
> Esto **no la reemplaza**: la pone al día contra el código y prod de hoy, y corrige lo que ya cambió
> (§5).

---

## 0. El pedido, literal

1. «analiza cuántos importers tenemos actualmente»
2. «eliminemos todo lo que es basura y dejemos sólo los que están activos» → se borraron 50 scripts
   sin quién los dispare (`chore([OPS])`, 2026-11-05) y 13 `_diag-*` sueltos sin versionar.
3. «dime cuáles son esos 54 imports» → contados uno por uno eran **51** (la cifra de 54 era una
   estimación y estaba mal).
4. «arma la clasificación como plan» y «limpiemos todo el mierdero entonces».
5. **2026-11-10, Edgar (PM): «necesito que eliminemos todo lo que no sale del ODS y es parte de
   Kepler»** — reabre este anexo como excepción al cupo firmada por el PM. Llegó desde dos casos de
   PQ: la caja de 15 sacada del NOMBRE del 99064 (`[PQ.105]`) y el proveedor «INHABILITADO» del
   10211, que la Suite copiaba de noche (`[PQ.107]`, vista `analytics.v_product_supplier`). Con él
   entra una clase que el inventario del 11-05 no contaba como importer: **lo que la Suite decide
   SOBRE un dato de Kepler** (override de unidad, fusión de proveedores, `factor_sale`/etiquetera
   en `v_product_box_factor`). Regla acordada (D1 de PQ.107): si Kepler está mal, **se corrige en
   Kepler**; la Suite lo muestra y lo señala, no lo arregla por su cuenta.
   ⚠️ «Eliminar» NO es borrar a ciegas: lo que NO es de Kepler se queda (1,006 productos de Wincaja,
   1,144 altas manuales sin SKU, el push de camionetas que no está en el ODS) y el árbitro
   independiente (`import-sales-by-channel`) se queda por diseño. Y el SUF del granel no se quita
   hasta que la demanda se lea de Kepler en su unidad base: quitarlo antes infla 20× la COBERTURA
   57009 (medido, `[PQ.105]`).

**El universo no es el trabajo.** De los 51, **24 se quedan como tabla con razón** (son cálculos,
documentos propios o catálogo con RLS), y 3 se retiraron hoy. **El trabajo de la regla 1 son 24**:
13 que pueden ser vista y 11 que siguen siendo tabla pero deben leer `kepler_ods` en vez de las
réplicas por sucursal o el `mart`.

## 1. Cómo se midió

- **Qué corre:** los pasos activos de `database/importers/kepler/run-prod-feeds.js` (sin comentar),
  `ops/vl/crontab.feeds` y `ops/k3s/*.yaml`.
- **Qué late:** `analytics.v_feed_step_health` y `analytics.cron_runs` en `pg-prod`, de sólo lectura,
  verificado por `system_identifier`. El costo es `corridas × seg_p50` en la ventana de 30 días.
- **Qué hace cada uno:** lo leyeron tres agentes en el código (cabecera **y** SQL), con la misma
  rúbrica: de dónde lee, qué escribe, naturaleza, bajas, lectores y qué decisión de dinero alimenta.
  ⚠️ **Lo que viene sólo de esa lectura es una lectura de código, no una medición.** Lo verificado
  en prod se dice explícitamente.
- **Un escéptico funcionó una vez.** El agente dijo «`sales_monthly` sin lectores», y prod mostró
  2.9 M lecturas por índice. Desglosadas por índice, **todas caen en la PK** (son los upserts del
  propio importer); el índice por mes tiene 0 lecturas, y ninguna vista ni función la nombra. Se
  retiró con esa evidencia, no con la del agente.

## 2. Oleada 0 — hecha el 2026-11-05 (sólo el carril, ninguna tabla)

| Paso | Qué se hizo | Evidencia |
|---|---|---|
| `import-sales-monthly` | fuera del `nightly`; script borrado | sin lector en código, vistas ni funciones; lecturas sólo por PK |
| `wincaja/import-sales-by-vendor-monthly` | fuera del `nightly`; script borrado | la réplica de Wincaja ya no se mueve (WR.7); ~9 min por noche para `n_tup_upd = 0`. La tabla queda como foto fija y Thot la sigue leyendo |
| `wincaja/import-wincaja-caja-factor` | fuera del `nightly`; script borrado | su tabla no tiene lector (la reemplazó `v_warehouse_box_factor`) |
| `import-label-data` en `nightly` | quitado del `nightly` (sigue en `prices`, cada 30 min) | mismos argumentos; en el `nightly` escribía 0 cambios |
| `repoint-catalog-prices --solo-promo` en `nightly` | quitado del `nightly` (sigue en `prices`) | mismos argumentos y salida idéntica |

- **Se quedan a propósito:** `route-push-monthly` y `route-push-lines` también se repiten en el
  `nightly`. Pero `canindo-routes-monthly` sobrescribe la misma llave y el reconciliador de procedencia
  va detrás de los dos. Mover ese orden para ahorrar 23 s no vale el riesgo.
- **Ahorro esperado:** unos 9 min por noche, casi todo de `sales-by-vendor-monthly`.
- ⚠️ **No llega a prod hasta reconstruir y desplegar la imagen `ingesta`** (skill `entrega`). La
  medición de después es la duración de `feed_nightly` y la ausencia de esos 5 pasos en
  `v_feed_step_health` tras la primera noche desplegada.
- **Las tablas no se tocaron.** Borrar `analytics.sales_monthly` y `analytics.wincaja_product_box_factor`
  es la decisión D2.

## 2b. Oleada 1 — hecha el 2026-11-05 (prioridad 1, esfuerzo S; Edgar: «sigamos purgando los que afectan»)

En todos los casos el método fue el mismo: comparar en seco contra prod (conexión de sólo
lectura), con un control negativo que debe salir en rojo, y cambiar la fuente sólo si cuadraba.
Ninguna tabla se tocó. **Nada llega a prod hasta desplegar `ingesta`.**

| Item | Qué | Comparación (antes) | Lo que cambia |
|---|---|---|---|
| **CANON.5.1** `import-margin` | ODS en vez del POS de la `03` | 9,009/9,057 iguales. De los 48 distintos, 35 eran un **bug** (el mapa SKU→id elegía la fila borrada de un SKU repetido) y 13 no se explicaron al centavo (la réplica lógica coincide con el ODS) | esos 48 markups: ~0.2 % de la venta de 90 días |
| **CANON.5.2** `import-purchase-adjustments` | ODS (`sucursal='00'`) en vez del POS del CEDIS | 1,690/1,690 iguales, total al centavo; control en rojo | nada |
| **CANON.5.3** `import-auto-received` | ODS en vez de 9 POS; además un SAVEPOINT por sucursal | 12,860/12,860 folio×sku iguales en las 9; control en rojo | nada. El savepoint arregla un COMMIT que, si fallaba una sucursal, era un ROLLBACK silencioso |
| **CANON.5.4** `import-pos-ticket-sales` | ODS en una consulta (~2 s) en vez de 9 POS | 4,728/4,743 iguales; los 15 distintos son de hoy y con el ODS más alto (frescura); control en rojo | el día en curso llega más fresco |
| **CANON.5.5** `repoint-catalog-prices` | el modo seguro (sólo `is_promo`) pasa a ser el default; escribir precio exige `--escribir-precio` | — | nada en los carriles (H3 cerrado) |
| **CANON.5.6** `import-logistics-dims` | respeta lo borrado en la app (D3) | causa medida: «ZAMORA CANINDO», borrada el 12-oct | vuelve a correr; costo de las 3 semanas: 0 altas perdidas (H1 cerrado) |

**No ejercido, declarado:** el `--source=branch` de los cuatro (el `pg_hba` de los POS sólo
acepta `md`) y el camino de escritura de `margin` y `auto-received` (corre en la primera noche
desplegada). **El después:** tras esa noche, el dry-run de `import-margin` debe dar 0 cambios y
`import-logistics-dims` debe salir `ok` en `v_feed_step_health`.

`import-pos-ticket-sales` sigue siendo tabla: volverla vista pide borrarla (D2).

## 2c. Oleada 2 — respaldos que repetían al hop-2 (CANON.5.7, 2026-11-05)

El hop-2 de `services/feeds-ingest/apply-handlers.js` llama a las mismas funciones de
`ods-derived.js` cada vez que cambia `kdii`, `kdik` o `kdpv_prod_util`. El nocturno las volvía a
pasar sobre todos los SKUs. Medido en `analytics.cron_run_log` (30 días):

| Paso nocturno | Noches que escribieron | Decisión |
|---|---|---|
| `import-box-factor` | 1 de 33 (2 filas, 5-oct). El hop-2 escribió 516 filas en el mes | **retirado** |
| `import-reorder-policy` | 0 de 34 | **retirado** (misma ruta de código que box-factor) |
| `repoint-catalog-cost` | 2 de 33 (el 30-oct atrapó un costo que el hop-2 no vio) | se queda como red |
| `import-box-price` | la mayoría (depende de `factor_sale` de la app, que no dispara el hop-2) | se queda |
| `repoint-catalog-presence` | 1 de 29 | se queda |

De paso, `test-newdb-master-data-history.js` estaba rojo desde PURGA.P1 por un archivo borrado
(`import-kepler-prices`): la lista se corrigió.

## 2d. Oleada 3 — la velocidad de compra entra al plan (CANON.5.8, 2026-11-05)

`import-purchase-velocity` llenaba `analytics.purchase_velocity` una vez por noche, y su único
lector era `import-replenishment-plan`. El plan ahora deriva la velocidad en línea de
`analytics.stock_movements`, con el mismo cálculo y el mismo redondeo (~275 ms). El importer se
retiró; la tabla queda sin escritor (borrarla es D2).

Antes y después, comparando el plan COMPLETO de las dos versiones en prod (sólo lectura, 44,175
filas almacén×producto): 41,429 idénticas. Todas las diferencias se explican:
- **Frescura (181 productos):** compras registradas después de las 03:00. El plan del carril
  `stock` (cada 15 min) ahora las ve; antes usaba la foto de la noche.
- **Desempate (H13):** 189 productos empatan en la cantidad máxima comprada entre almacenes, y
  `primary_wh` (el almacén de compra) lo decidía el orden físico de las filas. Ahora a igual
  cantidad gana donde se compró más reciente.
- **`stock_pz` (84 filas):** existencia que se movió entre las dos corridas, no el cambio.

Control: la misma comparación sin clasificar los empates da 885 fuera de explicación, así que la
prueba sí distingue.

## 2e. Oleada 4 — la mensual por producto se vuelve rollup en línea (CANON.5.9, 2026-11-05)

`import-product-sales-monthly` era el rollup de `analytics.product_sales_daily` (Σ por
producto×almacén×mes, sólo productos del catálogo). Lectores medidos: `thot-build-features.js`
(nocturno) y `deactivate-legacy-skus.js` (manual); ninguna vista ni función de la base, y las
lecturas por índice eran los upserts del propio importer.

- **Thot** suma la diaria por mes en su consulta: 36,502 de 36,502 filas de `zone_demand`
  idénticas a la versión anterior; control con ventana de 11 meses en rojo (5,655 distintas).
- **`deactivate-legacy-skus`** ya exigía «sin venta diaria», y 0 productos de la mensual faltan
  en la diaria: la condición sobre la mensual era redundante y salió.
- **`test-newdb-product-sales-parity`** guardaba «mensual = rollup(diaria)», que sin escritor se
  pondría rojo al cerrar el mes. Ahora guarda lo que importa: **nadie lee la tabla congelada**
  (con prueba negativa). En su primera corrida atrapó dos textos que todavía nombraban la
  mensual. Su etiqueta en `run-all-tests.js` quedó vieja: ese archivo tiene cambios de otra sesión.

## 2f. Oleada 5 — repuntes y errores (2026-11-06; Edgar: «termina con todos los innecesarios o erróneos»)

Mismo método que la oleada 1: comparación en seco contra la tabla de prod (sólo lectura,
`system_identifier` verificado), cada diferencia clasificada y un control negativo en rojo. Lo que no
cuadró **no se repuntó**. Todos aceptan `--source=` para volver a la fuente vieja.

| Item | Qué | Comparación | Lo que cambia |
|---|---|---|---|
| **CANON.5.11** consolidado | `mart.refresh_si_cambio` por servidores `dblink_fdw` con keepalives y `statement_timeout` remoto; sin contraseña en el código | prueba de corte de red: 9 s contra colgado indefinido; prueba negativa 2 s | aplicado en md el 2026-11-06 |
| **CANON.5.12** `import-ap-findings` | POS → ODS + **H4**: se descarta el renglón ajeno sólo si existe idéntico en su base dueña | 1,135/1,154 proveedores iguales; las 19 son frescura (captura posterior al nocturno, por `kdm1.c68`) | 9 proveedores de la `03` bajan (H4 cerrado) |
| **CANON.5.13** `import-ledger-chain` | POS → ODS; la cadena se arma en orden estable | balanza 2,467/2,562 (95 frescura, 0 sin explicar); cadena 14,749/14,806, 44 desempates igual de válidos | la cadena deja de depender del orden físico |
| **CANON.5.14** `import-expenses-polizas` | POS → ODS; líneas numeradas por el renglón de Kepler (`c7`); un folio sin líneas en el ODS ya no borra las de la tabla | 19,459/19,459 presentes + 73 frescura; 4 filas toman un departamento que el ODS no borró | la numeración deja de cambiar cada noche |
| **CANON.5.15** `import-top-sellers-from-consolidado` | `mart` → `sales_daily` | top-100 idéntico; el `mart` contaba doble las rutas de Padre Hidalgo (base 01 + push) | `units_sold` en unidad canónica |
| **CANON.5.16** `import-route-push-monthly` | `mart` → Σ `route_push_lines`; en el carril las líneas van antes | las 77 ruta×mes ya existen y ninguna cambia | — |
| **CANON.5.18** `import-sales-by-route-monthly` | POS → ODS | 224/248; las 24 son noviembre con el ODS más alto | no toca H7 (escribe `UD…`, no `WIN-`) |
| **CANON.5.19** `import-product-sales-daily` | POS → ODS | 726,835/726,835 en 180 días | — |
| **CANON.5.21** `import-transfers-monthly` | POS → ODS | 1,070 filas iguales | ver D6 |
| **CANON.5.23** H12/H6 | una sola función de identidad (retail primero) para el hop-2 y `repoint-catalog-names` | 0 diferencias contra el barrido en 9,554 SKUs; la regla vieja del hop-2 da 6 en rojo | al desplegar: 1 nombre y 4 códigos de barras (gana el de las tiendas) |
| **CANON.5.24** H11 | el hop-2 firma `app.actor = 'hop2:<normalizador>'` y lo restaura | prueba nueva en `test-newdb-master-data-history.js`; dos mutantes en rojo | `master_data_history` deja de tener escrituras anónimas |
| **CANON.5.26** H9 + H9 bis | `import-sales-fact`: mapa SKU→id determinista, gana la fila viva; migración `20261106130742_sales_daily_reasigna_productos_borrados` | el mapa sin orden escribía la misma venta a nombre de las dos filas del SKU: ~0.02 % de la venta del periodo contada doble | la migración borra las copias y reasigna el resto; **va DESPUÉS de desplegar la imagen** |

⚠️ **Corrección a CANON.5.26 (aplicada el 2026-11-06 13:47):** el «antes» medía **10** filas vivas
con valor distinto; la migración corrigió **873**. La medición comparó sólo el importe y las
unidades, pero el paso 1 compara 9 columnas (costo, tickets y el modelo de unidades además) y copia
las 9. Las 863 de más tenían el mismo importe —el total se movió sólo por las 10— pero recibieron el
costo y el modelo de unidades calculados con el producto BORRADO (`import-sales-fact` toma el markup
y el modelo del producto al que asigna la venta). Que «la más reciente gana» no vale para esas
columnas: el producto correcto es el vivo. **Se corrige solo:** el nocturno recalcula 13 meses desde
la fuente con el mapa nuevo, y las copias empiezan el 2025-10-10, dentro de la ventana. Lección:
medir la condición EXACTA que ejecuta el SQL, no una parecida.

**No se repuntaron, con la causa medida:**
- `import-rotation-from-consolidado`: su `u90` está en pieza suelta (`units × factor_sale`); `sales_daily`
  no, y 3,085 SKUs difieren de 10× a 94×. Pide pasarle su modelo de unidades.
- `import-kardex`: 3 mermas reales de la `06` cuya cabecera llegó al ODS y su renglón `kdij` no
  (el hueco de OBS.15.9, que estaba registrado sólo para la `00`). Repuntar perdería mermas.
- `import-pos-cashiers`: el ODS tiene `kdpv_kdku` pero no recoge las ediciones de nombre (6 de 1,359).
- `import-supplier-params` (H5): ver D5.

**Lo que sigue sin esto (declarado):** las VISTAS que exigen borrar la tabla (`cash-sessions`,
`box-price`, `pos-ticket-sales`) esperan D2; `branch-stock-live` (~40 lectores) y `sales-fact` /
`customer-sales` (D4) son trabajo de fase. Los huecos viejos del `kdm2`/`kdij` del ODS (bases 00, 01,
06 y 08, antes del 26-oct) no tienen relleno y pegan a otros lectores además de éstos.

**NO MEDIDO:** el camino `--apply` de los repuntados (corre en la primera noche desplegada) y el
`--source=branch` (los POS sólo aceptan a md). La migración de CANON.5.26 sólo se ejerció en una base
desechable.

## 2g. Oleada 6 — lo que quedaba abierto (2026-11-06; Edgar: «sigamos»)

| Item | Qué | Comparación | Lo que cambia |
|---|---|---|---|
| **CANON.5.17** `import-rotation-from-consolidado` | `mart` → `sales_daily` (ya en pieza/kg anclados al precio) | la unidad se probó contra el precio de pieza de Kepler (`kdii.c90`): en 3,640 de 3,646 SKUs que difieren >3×, `sales_daily` da el precio de la pieza; la rotación vieja daba piezas de centavos. Control con ventana de 60 días en rojo | **la rotación estaba inflada ~200×**: el `mart` convertía por la etiqueta `PAQ`, que Kepler pone también a la pieza. Cambia el tier de ~1,600 SKUs y los «N u./30d» muestran piezas reales |
| **CANON.5.25** D5 parámetros de proveedor | `catalog.suppliers.order_params_source` (jsonb por campo: `manual`/`derivado`/`desconocido`); la service marca `manual` y firma `updated_by`; el importer refresca sólo lo derivado | primera corrida simulada en prod: 0 valores cambian, 378 campos `derivado`, 758 `desconocido` (protegidos); vitest 7/7 con negativa; prueba contra base real en `pruebas-db` | orden: migración → soltar la API → `ingesta` |
| **CANON.5.27** D6 `import-transfers-monthly` | reemplaza (actualiza lo que cambió y borra lo que ya no sale) en vez de GREATEST; guarda si una sucursal lee 0 | 141 grupos: docs(tabla) − docs(borradas) = docs(nuevo); la salida del CEDIS cuadra con los folios del ODS los 11 meses; control en rojo | se van 119 llaves duplicadas por destino renombrado (~11 % de la salida del CEDIS ene–jul) y 54 bajan por **documentos cancelados** que la tabla conservaba |
| **CANON.5.28** `import-pos-cashiers` + resync | el espejo agrega `kdpv_kdku` y `kdpv_gerentes` a su red de resync (el envío del carril hash se perdía y nada lo reponía); el importer lee el ODS | 1,351/1,357 iguales; las 6 explicadas (4 del ODS atrasado, que repara el resync; el resto, la tabla atrasada) | — |
| **CANON.5.29** `import-kardex` | POS → ODS | 581/581 iguales a 30 días; las 3 «mermas perdidas» de la `06` eran mermas **canceladas** en Kepler, que el upsert nunca borró | — |

**Huecos del ODS, medidos contra la réplica en md (jul-2025 → hoy):** `02/kdm2` falta un día (15-ago,
29 documentos `U-D-6` con cabecera y sin renglones); `00/kdm2` faltan de 1 a 24 renglones por mes
(dic–ago). `00/kdij` tiene de MÁS (el CEDIS purga su kardex; el ODS conserva). El reconciliador
existente los repone (`reconcile-ods-window.js --branch=02|00 --tables=kdm2 --days=90|340`, primero
en seco); lo corre Edgar fuera de horario.

**Sueltos:** hay filas `wincaja_ruta` de `sales_daily` con fecha futura (2026-12-06), y
`database/scripts/sync-erp-product-costs.js` escribe la rotación leyendo un servidor que ya no se usa
(no está en ningún carril: candidato a borrar).

## 3. Los 51, clasificados

**Leyenda.** **Lee:** `ods` = `kepler_ods` · `réplicas` = bases `md_*` por sucursal · `mart` = el
consolidado (`mart.ventas*`) · `prod` = tablas de prod de segundo nivel. **Veredicto:** VISTA ·
MATVIEW (por costo, refrescada por evento) · REPUNTAR (sigue tabla, pero lee `kepler_ods`) ·
SE QUEDA · RETIRADO.

### 3.1 Retirados hoy (3)
`import-sales-monthly` · `import-sales-by-vendor-monthly` · `import-wincaja-caja-factor` (ver §2).

### 3.2 Se quedan como tabla, con razón (24)

| Importer | Lee | Por qué es tabla legítima |
|---|---|---|
| `import-sales-stats` | prod | cálculo (ABC por Pareto) sobre `sales_daily` |
| `import-demand-clean` | prod | modelo de demanda; numerador del sugerido |
| `import-sales-by-channel` | réplicas | **árbitro independiente** de `income_entries_src` (VERDAD_ABSOLUTA): repuntarlo al ODS lo vuelve espejo |
| `import-sales-boxes-monthly` | prod | cálculo de cajas con el resolvedor de factor de la app |
| `import-canindo-routes-monthly` | wincaja + mart | une dos eras; el push de camionetas no está en el ODS |
| `import-route-push-lines` | mart | única entrada del push a prod (comisiones) |
| `import-label-data` | ods | catálogo con RLS, filas `manual` y aviso TDA.8 |
| `import-product-barcodes` | ods + wincaja | catálogo con RLS y soft-delete (la rama Wincaja se puede congelar) |
| `import-brands-lineas` | ods | altas sobre un catálogo curado a mano |
| `import-kepler-suppliers` | ods | catálogo con RLS que normaliza y fusiona |
| `repoint-catalog-cost` | ods | regla de negocio (mediana retail con tope) sobre catálogo con RLS |
| `repoint-catalog-names` | ods | catálogo con RLS (ver hallazgo H6) |
| `repoint-catalog-presence` | ods | da de alta productos nuevos (operativa) |
| `repoint-catalog-prices --solo-promo` | ods | único escritor de `is_promo` (ver hallazgo H3) |
| `import-replenishment-plan` | prod + ods | cálculo del pedido |
| `import-stock-movements` | ods | ya lee el ODS; comparte la tabla con el escritor Wincaja (`W%`) |
| `import-reorder-policy` | ods | catálogo con RLS compartido con `computed` y `manual` |
| `import-computed-reorder` | prod | stock de seguridad por nivel de servicio |
| `import-network-reorder` | prod | DRP multi-escalón |
| `import-replenishment-cadence` | prod | cálculo de cadencia (con una topología fija en el código) |
| `import-demand-acceleration` | prod | Welch-Z |
| `import-inventory-health` | prod + vista ods | cálculo de σ/CV y cobertura |
| `import-supplier-params` | prod | cálculo sobre catálogo con RLS (ver hallazgo H5) |
| `import-logistics-dims` | ods | operativa: la app y el GPS escriben las mismas tablas (**roto**, H1) |

> Dos de estos son **costo, no regla 1**, y van aparte (regla 15: optimizar no se mezcla con cambiar
> alcance): `import-stock-movements` gastó **~45 h de base en 30 días** (21.5 min por corrida, cada
> hora) e `import-replenishment-plan` **~23 h**. Son los más caros del carril, con diferencia.

### 3.3 La deuda de la regla 1 (24), por prioridad

> **Al 2026-11-06** la tabla de abajo es el inventario del 11-05. Ya repuntados en la oleada 5 (§2f):
> `ap-findings`, `ledger-chain`, `expenses-polizas`, `top-sellers`, `route-push-monthly`,
> `sales-by-route-monthly`, `product-sales-daily`, `transfers-monthly`. No repuntados con causa medida:
> `rotation`, `kardex`, `pos-cashiers`.

Prioridad = dinero en juego × esfuerzo ([criterios del PM](../../../.claude/skills/pm/references/criterios.md) §1).
⚠️ **El monto en pesos NO SE MIDIÓ en ningún renglón.** «Alto» sale de la clase («una cifra con la que
se decide dinero: margen, pagos, precios»), no de un monto.

| Pri | Importer | Lee hoy | Veredicto | Dinero | Esf. | Por qué |
|---|---|---|---|---|---|---|
| ✅ | `import-margin` | ~~réplica de una sola sucursal~~ ods | REPUNTAR | Alto | S | **CANON.5.1** — el costo de `sales_daily` sale de este markup → margen |
| ✅ | `import-purchase-adjustments` | ~~réplica CEDIS~~ ods | REPUNTAR | Alto | S | **CANON.5.2** — notas de crédito y devoluciones a proveedor (ver H10) |
| ✅ | `import-auto-received` | ~~réplicas~~ ods | REPUNTAR | Alto | S | **CANON.5.3** — cierra las OC abiertas → obligaciones de pago |
| 🟡 | `import-pos-ticket-sales` | ~~réplicas~~ ods | VISTA | Alto | S | **CANON.5.4** repuntado; la vista espera D2 |
| **1** | `import-ap-findings` | réplicas | REPUNTAR | Alto | M | saldo y DPO por proveedor (y H4) |
| **1** | `import-ledger-chain` | réplicas | REPUNTAR | Alto | M | balanza para impuestos provisionales y P&L |
| **1** | `import-expenses-polizas` | réplicas + ods | REPUNTAR | Alto | M | P&L de egresos, rentabilidad de ruta |
| 2 | `import-branch-stock-live` | réplicas | VISTA (ADR-055) | Alto | L | la copia cuadra 91 % contra el POS; `v_erp_stock_on_hand` ya cuadra 100 %. ~40 lectores |
| 2 | `import-sales-fact` | mart + réplicas | REPUNTAR (CANON.2.1) | Alto | L | base del costo, la demanda y el sell-out; el push no está en el ODS |
| 2 | `import-kardex` | réplicas | VISTA | Medio | S | mermas en la conciliación; 2 lectores |
| 2 | `import-purchase-velocity` | prod | VISTA o CTE dentro del plan | Medio | S | su único lector es `import-replenishment-plan` |
| 3 | `import-cash-sessions` | ods | VISTA | Bajo | S | sólo tablero (cajas abiertas), pero arregla H2 |
| 3 | `import-pos-cashiers` | réplicas | VISTA (si `kdpv_kdku` está en el ODS: NO DETERMINADO) | Bajo | S | nombre del cajero en el faltante |
| 3 | `import-transfers-monthly` | réplicas | VISTA | Bajo | S | `/logistica/traspasos`; 1 lector |
| 3 | `import-product-sales-monthly` | prod | VISTA sobre la diaria | Bajo | S | sólo la lee Thot |
| 3 | `import-top-sellers-from-consolidado` | mart | REPUNTAR a `sales_daily` | Bajo | S | orden del portal por popularidad |
| 3 | `import-route-push-monthly` | mart | REPUNTAR a `route_push_lines` | Bajo | S | es la suma de una tabla que ya está en prod |
| 3 | `import-box-factor` | ods | VISTA | Medio | M | la vista `v_product_box_factor` ya lee el ODS: la tabla sobra |
| 3 | `import-box-price` | ods + catálogo | VISTA | Medio | M | hay que recrear las vistas que dependen de ella |
| 3 | `import-expense-requests` | ods | VISTA | Medio | M | comparte tabla con `ap-findings` (UNION por tipo) |
| 3 | `import-sales-by-route-monthly` | réplicas | REPUNTAR | Medio | M | 3 escritores en la misma tabla (H7) |
| 3 | `import-rotation-from-consolidado` | mart | REPUNTAR | Medio | M | escribe `catalog.products` (RLS) por UPDATE |
| 4 | `import-product-sales-daily` | réplicas | MATVIEW (o retirar a favor de `sales_daily`) | Bajo | M | reporte semanal |
| 4 | `import-customer-sales` | mart | MATVIEW (depende de CANON.2.1) | Bajo | M | RFM / customer-360 |

**Cómo se parte la L de dinero Alto:** el pedazo S de `branch-stock-live` es retirar el importer de
**un** lector crítico a la vez, empezando por el que decide pedidos (`order-stock.service.ts`).
`sales-fact` no tiene pedazo S hasta decidir qué hacer con el push (D4).

## 4. Hallazgos (lectura de código; lo que dice «medido» está medido)

- **H1 — `import-logistics-dims` está roto desde el 12-oct** (medido: 23 fallas en 29 noches; el
  último resumen dice `duplicate key … logistics_routes_tenant_name_unique`). Causa probable en el
  código: los índices únicos (`tenant_id, name` y `tenant_id, plate`) incluyen las filas borradas,
  pero el importer sólo busca las vivas. Una ruta borrada en la app que Kepler sigue trayendo se
  vuelve a insertar, choca y hace ROLLBACK de vehículos, choferes y rutas a la vez. **No se vio**
  porque el `nightly` sólo marca error si fallan todos sus pasos. Arreglarlo es S, pero pide D3.
- ✅ **H2 — `import-cash-sessions` tenía fijos los códigos `01`–`05`** (cerrado en CANON.5.10).
  Medido el 2026-11-05: Canindo, Morelia Madero y Morelia Abastos tenían 11 cajas abiertas en el
  ODS que `/tienda/cajas` no mostraba; la `00` no tiene cajas. Ahora lee todas las sucursales del
  mapa único (dry-run: 113 sesiones y 23 abiertas, igual que el ODS).
- **H3 — `repoint-catalog-prices` sin bandera vuelve a sincronizar el precio.** En los carriles corre
  con `--solo-promo`, pero quien lo lance a mano sin ella escribe `commercial.product_prices` y
  deshace los rechazos de `ods-derived`. Es una mina: el modo por defecto debería ser el seguro. S.
- **H4 — `import-ap-findings` cuenta doble, poco** (medido el 2026-11-05 en el ODS, 12 meses,
  cuenta 201): sólo la base de la `03` trae movimientos con `c14` de otra sucursal, 41 por unos
  $0.68 M, alrededor del 0.1 % de las compras del año, aunque infla ~2.6 % el auxiliar de la `03`.
  **29 de esos 41 también están en su base dueña** (duplicado real); los otros 12 sólo existen ahí.
  Un filtro `c14 = propia` como el de `ledger-chain` perdería esos 12: el arreglo es deduplicar
  contra la base dueña, y se hace al repuntarlo al ODS (item M de prioridad 1).
- **H9 bis — el arreglo de H9 no es chico:** si `sales-fact` empieza a escribir a nombre de la fila
  viva, las filas viejas a nombre de la borrada siguen en `sales_daily` y la venta se cuenta doble.
  Requiere una migración que reasigne esas filas en el mismo cambio.
- **H5 — `import-supplier-params` sólo llena columnas en NULL**, así que lo que deriva una vez no
  vuelve a refrescarse nunca.
- **H6 — Reglas opuestas sobre el mismo producto.** El hop-2 (`normalizeProductsFromOds`, en
  `services/feeds-ingest/apply-handlers.js`) da de alta y renombra con CEDIS primero y el `c7` crudo;
  `repoint-catalog-names` y `presence` usan retail primero. El código de barras lo escriben tres
  caminos, contra la regla de CANON.1.3b («un solo escritor: `import-label-data`»).
- **H7 — `analytics.sales_by_route_monthly` tiene 3 escritores**, y dos de ellos (`route-push-monthly`
  cada hora con GREATEST, `canindo-routes-monthly` de noche con sobrescritura) escriben la misma
  llave (`06`, `WIN-50N`, mes).
- **H9 — `import-sales-fact` arma el mismo mapa SKU→id que tenía `import-margin`** (incluye las
  filas borradas de los 887 SKUs repetidos). Medido: en 90 días, 31 productos borrados reciben
  venta en `sales_daily`, alrededor del 0.07 % del total. Chico, pero esa venta no aparece en la
  ficha del producto vivo.
- **H10 — `analytics.erp_purchase_adjustments` sólo lee el CEDIS.** Las bases de las sucursales
  01–08 tienen **487 ajustes X-D-40/55 propios en 2026** que la tabla nunca leyó. Su monto **NO
  está validado**: en las sucursales `c16` no parece significar lo mismo (147 ajustes de la 01
  suman casi lo mismo que los 1,690 del CEDIS). Ampliar el universo es cambio de alcance.
- **H11 — El hop-2 escribe datos maestros sin declarar actor.** `services/feeds-ingest/` no llama
  a `declararActor`: lo que escribe en `catalog.products`, `commercial.reorder_policy` y demás
  queda en `analytics.master_data_history` como anónimo.
- **H12 — H6 está activo, pero es UN producto** (diagnosticado el 2026-11-05 con
  `analytics.master_data_history`). Cada noche `repoint-catalog-names` (retail primero) pone
  «AGUA DOÑA VITA 500M/ 1 ZORRO» a las ~03:28, y entre 03:32 y 03:47 el hop-2 (sin actor, CEDIS
  primero) lo regresa a «\*\*\*DESC DOÑA VITA 500 ML / 1 ZORRO», el nombre que el CEDIS le dio al
  descontinuarlo. Mismo producto las 4 noches medidas. Se arregla aplicando CANON.1.3 (retail
  primero) **en el hop-2**, que se despliega con los carriles del ODS.
  ⚠️ **Corrección:** este hallazgo decía que `import-product-barcodes` escribía en 953 de 1,417
  corridas. Era cierto **hasta el 29-oct** (4–5 cambios en cada media hora desde el 6-oct); desde
  el 30-oct está en 0 salvo algún cambio aislado. El promedio de 30 días escondía que ya se había
  resuelto.
- **H13 — El almacén de compra del plan era una moneda al aire para 189 productos** (ver §2d).
  Cerrado en CANON.5.8 con un desempate determinista.
- **H8 — Duplicados de significado**: `product_sales_daily` contra `sales_daily` (otro linaje),
  `stock_ledger` contra `stock_movements`, y `transfers_monthly` contra los traspasos de
  `stock_movements`.

## 5. Lo que `FASE_CANON_INGESTA.md` decía y ya no es cierto

| Decía | Hoy (código del 2026-11-05) |
|---|---|
| CANON.3.2 y 3.3: falta repuntar `stock-movements`, `reorder-policy`, `logistics-dims`, `box-factor`, `box-price`, `brands-lineas`, `kepler-suppliers` | **los 7 ya leen `kepler_ods`**. De ese lote, sólo `import-margin` sigue leyendo una réplica |
| CANON.3.1: repuntar `sales-by-channel` | **no se repunta**: es el árbitro independiente de `income_entries_src`, y repuntarlo lo vuelve espejo |
| CANON.2.1: `mart.ventas_enriched` → vista sobre el ODS | **no completo**: `mart.ventas` trae el push de las camionetas, que el ODS no replica. Son 7 los lectores del mart, no 6 |
| CANON.4: `label-prices` como vista | **no puede ser vista**: tiene RLS, filas `manual` y aviso. `box-factor` y `box-price` sí pueden serlo, aunque las dos borran filas |
| CANON.3.2: `product-sales-monthly` lee las sucursales | desde AUD-DAT.10 es un rollup de la diaria |
| Límite 1 (el ODS no propaga borrados) frena las vistas | no frena a `kardex`, `purchase-adjustments`, `transfers-monthly` ni `auto-received`: ninguno borra hoy |

## 6. Decisiones (firma Edgar)

- ✅ **D1 — resuelta (Edgar, 2026-11-05: «sigamos purgando los importers que afectan»).** Se
  hicieron los S; las M de prioridad 1 siguen esperando cupo. Texto original:
  **¿Excepción al cupo para los 4 items S de prioridad 1?** (`margin`, `purchase-adjustments`,
  `auto-received`, `pos-ticket-sales`) más H1 y H3. **Recomendación: sí, como «parar el sangrado»,
  sin abrir la fase.** Cada uno es ≤ 1 día, repunta un SRC con comparación en seco antes y después
  (método CANON), y toca números con los que se decide dinero. Las M de prioridad 1 esperan cupo.
- **D2 — ¿Se borran `analytics.sales_monthly` y `analytics.wincaja_product_box_factor`?**
  **Recomendación: sí, pero dentro de 30 días**, y sólo si sus índices de lectura siguen en 0.
  `sales_by_vendor_monthly` se queda como foto fija, porque Thot la lee.
- ✅ **D3 — resuelta por el PM técnico con la recomendación** (es reversible y conservadora: no
  revive nada). Edgar puede revertirla. Pregunta original: **Una ruta o un vehículo que se borró
  en la app pero Kepler sigue trayendo: ¿se queda borrado o se revive?** **Recomendación: se queda borrado.** Lo decidió una persona en la app; el importer lo
  salta y lo declara en su resumen. Es lo que desbloquea H1.
- **D4 — El push de las camionetas: ¿se replica al ODS o sigue como única fuente en el `mart`?**
  Decide si `sales-fact` y `customer-sales` pueden terminar de repuntarse. **Recomendación: que siga
  en el `mart` hasta que el proyecto de camionetas (`route-push`) se estabilice.**

- **D5 — Parámetros de proveedor (H5): ¿se marca qué valor es manual?** Medido el 2026-11-06: de 290
  proveedores derivables, 260 tienen hoy al menos un valor distinto del que se derivaría (cadencia,
  colchón, mínimos). El importer sólo llena NULL porque la app los edita sin `updated_by` y no hay
  historia: no se sabe qué capturó una persona. **Recomendación:** una columna de procedencia
  (`derivado`/`manual`) por migración, que la app marque `manual` al editar, y que el importer refresque
  sólo lo derivado.
- **D6 — `analytics.transfers_monthly` (CEDIS, salida) está inflada ~10 % en el primer semestre.** El
  catálogo de destinos `kdud` se renombró y el upsert GREATEST nunca retira el renglón con el nombre
  viejo: el mismo documento queda bajo dos destinos. **Recomendación:** volverla vista sobre el ODS
  (junto con D2); mientras, una corrida con `--reset`.

## 7. Qué NO incluye este anexo

- Las fuentes que no son Kepler: ContPAQi (5), CAOS, Caja General en SISTEMAS y relojes checadores.
  Cada una es la única replicación de su sistema.
- La optimización de costo de `import-stock-movements` e `import-replenishment-plan` (va aparte).
- Los 2 backfills de `warehouse_id`. Siguen trabajando: medido el 2026-11-05, hay 2,949 renglones de
  `gl_poliza_lines`, 23 de `gl_polizas` y 34 de `blind_counts` sin almacén.
- `import-route-stock` e `import-route-collections`: sin agenda, pendientes de Edgar desde RD.32/RC.4.

---

## 8. Erradicación — «ningún importer y ningún cron» (2026-11-11)

### 8.0 El pedido, literal

- 2026-11-10, Edgar: **«hay reglas, ningún importer y ningún cron»**.
- 2026-11-11, Edgar, al saber que quedaban decenas de pasos con reloj: **«hay que erradicarlos»**.

Lo que cambia contra §3: el único destino válido para un dato de Kepler es una **vista sobre
`kepler_ods`**, o —si la vista no cabe en 500 ms— algo **mantenido por cambio** (trigger por
sentencia en la base, ADR-104; o aviso + recálculo acotado, como el apareo de `[RE.69]`). Un
reloj sólo se tolera como **árbitro que alarma** (debe encontrar 0) y con fecha de retiro.

**Cupo:** esto sigue dentro de la excepción que Edgar firmó para CANON.5 el 2026-11-10; no se abre
fase nueva. Items nuevos: `[CANON.6.N]`.

### 8.1 El universo, medido el 2026-11-11

Medido sobre `run-prod-feeds.js` (sólo pasos sin comentar), `ops/vl/crontab.feeds` (sólo líneas
activas), el loop `feeds-livefast` y `ops/k3s/*.cronjob.yaml`. Las tablas, contra el catálogo de
`pg-prod` (sólo lectura, `system_identifier` 7688376744939610156); los lectores, con `git grep` en
`apps/` y `libs/` (sin specs).

| Qué | Cuántos |
|---|---:|
| Scripts distintos que corren con reloj en la ingesta | **61** |
| …agendados en 20 renglones del crontab + 1 loop de 60 s | — |
| Tablas que esos scripts escriben | 66 |
| …de ésas, **sin ningún lector** en código ni vista | **0** (no hay retiro gratis) |
| CronJobs de K3s (reconciliadores del ODS) | 2 |
| `@Cron` dentro de la API (`libs/` + `apps/api/`), **universo aparte, no contado arriba** | 73 en 66 archivos |

⚠️ **Lo que §3 no veía:** `contpaqi_ods` **existe** (202 tablas, 4.8 GB), pero su sincronía está
**apagada** desde que se construyó (`crontab.feeds` líneas «contpaqi-replica»: falta
`CONTPAQI_SQL_PASSWORD` en `/secrets/feeds.env`, **D15**, regla 7). Por eso los importers de
ContPAQi siguen leyendo SQL Server directo.

⚠️ **La ingesta corre código viejo.** `ops/vl/deploy.sh --estado` (2026-11-11 ~09:30): 7 pods de
K3s (`feeds-cron`, `feeds-livefast`, los 5 `ods-*`) con un digest de código anterior a la imagen
`latest`. Todo lo que diga «falta desplegar `ingesta`» (CANON.5.12–5.29, RE.68/69) sigue sin correr.

### 8.2 Los 61, por destino

| Destino | # | Scripts | Qué lo reemplaza |
|---|---:|---|---|
| **V — vista** (el dato ya está en `kepler_ods` y la consulta cabe) | 11 | `pos-cashiers` · `kardex` · `pos-ticket-sales` · `transfers-monthly` · `box-price` · `expense-requests` · `ap-findings` · `refresh-inventory-products` · `refresh-products-active` · `sales-by-route-monthly` (pierna Kepler) · `branch-stock-live` (`v_erp_stock_on_hand` ya cuadra 100 %, ~44 lectores: L) | vista `analytics.v_*`, lectores repuntados, paso fuera del carril — **patrón `[RE.68]`** |
| **E — mantenido por cambio** (agregado caro o cálculo propio) | 23 | `stock-movements` · `product-sales-daily` · `expenses-polizas` · `ledger-chain` · `sales-fact` · `customer-sales` · `sales-stats` · `demand-clean` · `demand-acceleration` · `inventory-health` · `computed-reorder` · `network-reorder` · `replenishment-plan` · `replenishment-cadence` · `supplier-params` · `sales-boxes-monthly` · `top-sellers` · `thot-build-features` · `thot-build-pdv-presence` · `reconcile-route-provenance` · `refresh-existencia-aux` (4 matviews) · `refresh-cierre-matview` · `auto-received` (escribe nuestros documentos) | trigger por sentencia sobre `kepler_ods` (ADR-104) o aviso desde `feeds-ingest` + recálculo acotado (`MiradaAlAviso`, `[RE.69]`) |
| **C — catálogo con dueño mixto** (Kepler pone unas columnas y la Suite otras) | 11 | `repoint-catalog-presence` · `-names` · `-cost` · `-prices` · `label-data` · `product-barcodes` · `brands-lineas` · `kepler-suppliers` · `logistics-dims` · `margin` · `rotation` | lo de Kepler se LEE de una vista unida al vuelo; lo de la Suite queda en su tabla — **patrón `[PQ.107]` `v_product_supplier`** |
| **X — fuente que no es Kepler y su carril ODS está apagado** | 10 | ContPAQi: `contpaqi-polizas` · `-bank-movements` · `-ledger` · `-suppliers` · `-cfdis` · `derivar-reglas` (→ `contpaqi_ods`, **D15**) · Push de camionetas: `route-push-lines` · `route-push-monthly` · `canindo-routes` · `refresh-consolidado` (→ **D4**) | encender el carril y derivar como V/E |
| **A — árbitro con reloj** (permitido: alarma, debe encontrar 0) | 4 | `health-watchdog` · `sales-by-channel` (árbitro independiente por diseño, VERDAD_ABSOLUTA) · `kepler-replica-refresh` · `publish-ods-remote` (salida a la tienda) | se quedan; cada uno declara su fecha de retiro o por qué no la tiene |
| **B — backfill que tapa un INSERT incompleto** | 2 | `backfill-warehouse-id-batch1` · `-batch2` | arreglar el camino que inserta sin `warehouse_id`; después se borra el backfill |

### 8.3 El orden (dinero × esfuerzo)

| Oleada | Qué | Relojes que mueren | Esfuerzo | Bloqueo |
|---|---|---:|---|---|
| **7** | V chicas, ya repuntadas al ODS: `pos-cashiers`, `kardex`, `pos-ticket-sales`, `transfers-monthly`, `box-price`, `inventory-products`, `products-active` | 7 | S c/u | — |
| **8** | Primitivo **«por cambio»** en `libs/` (ADR-056): `feeds-ingest` avisa QUÉ tabla del ODS cambió; con él, `refresh-existencia-aux` (288 corridas/día), `refresh-cierre-matview` y `auto-received` | 3 | M | — |
| **9** | C, catálogo: una vista de lo que Kepler dice del producto/proveedor/ruta, y los lectores a ella | 11 | L | — |
| **10** | Venta: `sales_daily` desde el ODS (CANON.2.1) y su cadena de cálculos por cambio | 14 | XL | **D4** |
| **11** | Contable: `expenses-polizas`, `ledger-chain`, `ap-findings`, `expense-requests` y ContPAQi | 10 | L | **D15** |
| **12** | B: el INSERT pone `warehouse_id`; se borran los backfills | 2 | S | — |
| — | Los 73 `@Cron` de la API: inventario propio (`PLAN_AUDITORIA_PLATAFORMA_2026-10-27.md`) | — | — | después de la 12 |

**Cómo se cierra cada uno (DoD):** la vista o el mantenimiento existe en prod · comparación
tabla-vs-vista medida, con las diferencias explicadas una por una · todos los lectores repuntados ·
el paso fuera del carril y **la ingesta desplegada** · la tabla vieja queda congelada y su borrado se
pide aparte (regla 5).

### 8.4 Decisiones (firma Edgar)

- **D4 (reabierta) — el push de las camionetas entra al ODS.** Con «ningún importer», dejarlo en el
  `mart` ya no es opción: `sales-fact`, `customer-sales` y las 4 rutas de X dependen de él.
  **Recomendación: replicarlo al ODS** como cualquier otra fuente.
- **D15 — `CONTPAQI_SQL_PASSWORD` en `/secrets/feeds.env`** para encender `contpaqi_ods`. Es
  credencial: la pone Edgar (regla 7). Sin eso, la oleada 11 sólo cubre la parte de Kepler.
- **Despliegue de la ingesta** (`sh ops/vl/deploy.sh` + `--k3s`). Además del OK, está frenado por
  trabajo sin commitear de otras sesiones en rutas que viajan en la imagen
  (`database/importers/kepler/route-push/armar-push-camioneta.js`, `ops/k3s/52-pg-prod.deployment.yaml`):
  el script archiva `HEAD` y se detiene si hay cambios sueltos ahí.

### 8.5 Oleada 7 — lo hecho el 2026-11-11 (🧪, commits locales, sin empujar)

Cada vista se comparó contra su tabla en prod (sólo lectura, por knex: el mismo cliente que la API),
llave por llave. Patrón `[RE.68]`: vista nueva `analytics.v_*`, lectores repuntados, paso fuera del
carril, tabla vieja congelada.

| Item | Vista | Comparación | Lo que cambia | Costo |
|---|---|---|---|---|
| `[CANON.6.1]` `pos-cashiers` | `v_pos_cashiers` | 1,373 de 1,375 llaves idénticas (nombre, origen, almacén) | 2 lugares de cajero que Kepler dejó **sin nombre** (Morelia Madero 03, Morelia Abastos 04); la tabla guardaba el último por un UPSERT sin borrado. Ningún corte los cita | 8 ms |
| `[CANON.6.2]` `kardex` | `v_stock_ledger` + índice `ix_kdij_genero_n` | 29,293 de 29,296 idénticas (unidades, importe, clase) | las 3 que sobran son las mermas de Canindo **canceladas** en Kepler (`[CANON.5.29]`): merma acumulada $6,040,555 → $6,034,576 | 382 ms sin índice |
| `[CANON.6.3]` `pos-ticket-sales` | `v_pos_ticket_sales` | 4,896 de 4,908 cajero×día idénticos | los 12 distintos son de HOY, con la vista más alta: va al día, la tabla iba a la corrida de las 09:15 | ~1.6 s; su único lector es el escáner de conciliación, no una pantalla |

**Reclasificados al medir** (no eran S):

- `transfers-monthly` → **M**: une renglones de `kdm2` por mes y su lector es una pantalla
  (`/logistica/traspasos`); la vista necesita que el filtro de mes llegue a un índice.
- `box-price` → **E con hueco**: ya se mantiene por evento (`normalizeBoxPrice` en `feeds-ingest`),
  pero el respaldo nocturno **corrige 47–270 precios cada noche** (`cron_run_log`, 31-oct → 11-nov).
  Retirarlo hoy dejaría ~50 precios de caja viejos por día. Primero: qué cambio no dispara el evento.
- `refresh-inventory-products` y `refresh-products-active` → **C**: no copian el ODS, copian
  `catalog.products` (una 2ª materialización, regla 2). Van con el catálogo (oleada 9).

**Para que lleguen a prod** (en este orden): push → CI → aplicar las 4 migraciones (`20261111093151`,
`20261111093819` —el índice, con la receta de la skill `entrega` §5—, `20261111093820`,
`20261111094100`) → soltar la API → desplegar la ingesta (que es la que deja de correr los 3 pasos).

**Entregada el 2026-11-11:** API en prod `dd13a0261` (13:24), las 4 migraciones aplicadas una por una
(índice `indisvalid`), ingesta desplegada `trade-ingest:ffa49e979` (13:51, 9 carriles y 3 cronjobs;
`kubectl diff` previo: sólo cambiaba la imagen y el árbitro de pólizas `[OPS-AUD.13.4]`, que estaba en
`main` desde el 29-oct sin haber llegado). Falta medir que las tablas congeladas dejen de moverse
(kardex y tickets a las :15; cajeros después de las 03:30).

### 8.6 Oleada 8 — medida antes de construir: la premisa no sobrevivió (2026-11-11)

El plan decía «un primitivo por cambio: `feeds-ingest` avisa QUÉ tabla del ODS cambió, y con él se
retiran tres relojes». Medido en prod (sólo lectura) antes de escribir código:

| Reloj | Costo medido (7 días, `cron_run_log`) | Fuentes (`pg_depend`) | Ritmo de cambio de las fuentes |
|---|---|---|---|
| `refresh-existencia-aux` (4 matviews) | **19.2 s por corrida** (el comentario decía 6.7), máx 54 s · 288/día · **5,533 s/día** | `kdm1`, `kdm2`, `kdii`, `kdik`, `kdpv_*`, catálogo, overrides, Wincaja | `kdm2` ~35 cambios/min en horario hábil |
| `refresh-cierre-matview` | 2.0 s · 96/día · 188 s/día; reescribe las 115 filas cada vez (`refrescado_en` cambia por construcción) | `gl_polizas`, `gl_poliza_lines`, `bank_movements`, `cfdis` | `gl_*` cambian cada minuto (pólizas de Kepler todo el día) |
| `auto-received` (nocturno) | 1–2 s | `kdm1`/`kdm2` X-A-40 | 22–59 entradas/día |

**Lo que eso dice:** un aviso por TABLA no sirve para los dos primeros — sus fuentes cambian cada
minuto, así que «refrescar al aviso» es refrescar todo el día. Lo que sirve es **mantener por llave**
(ADR-104, ya aplicado en caja y en `[PQ.59]`/`[PQ.60]`/`[PQ.61]`): recalcular sólo los productos o
meses que tocó la sentencia. Y el `MiradaAlAviso` de `[RE.69]` no gana un tercer consumidor, así que
**no se mueve a `libs/`**: moverlo sin consumidor nuevo es churn, no ADR-056.

**`auto-received` no se pasa a evento: se retira (`[CANON.6.4]`).** Desde D21 (`[PQ.16]`,
2026-10-26, firmado) la Suite no emite OC ni recepciones propias; sus OC quedaron congeladas. El
script siguió creando OE sobre ellas por presencia de SKU. Medido después de D21: **158 OE sobre 80
OC congeladas** (11,232 unidades; 56 casaron una entrada de más de 14 días después de su OC) y 19 OC
pasaron a `received`. ⚠️ **Pendiente de Edgar:** esas 158 OE se quedan (borrar es regla 5); ¿se
rotulan «auto-conciliada después de D21» o se revierten?

**El orden nuevo:**

| | Qué | Esfuerzo | Estado |
|---|---|---|---|
| 8a | `auto-received` fuera del nocturno (contradice D21) | S | 🧪 2026-11-11, commit local; llega con el próximo despliegue de la ingesta |
| 8b | `existencia-aux` → una tabla por matview mantenida por llave (ADR-104): función por producto/almacén, triggers por sentencia en sus fuentes del ODS, árbitro nocturno que debe encontrar 0 | L | ⬜ — es donde está el costo (1.5 h de CPU al día) y el factor de caja que se imprime al cliente |
| 8c | cierre por mes tocado (ADR-104) | M | ⬜ — antes medir cuántas sentencias por minuto le llegan: si recalcular un mes por sentencia cuesta más que 188 s/día, se dice y se decide |

**8b, el diseño medido (2026-11-11, prod sólo lectura).** Costo por matview en el log del carril
(3 corridas): `mv_warehouse_box_factor` 8–13 s (45 %) · `mv_price_truth` 7–10.5 s (38 %) ·
`mv_kepler_unit_cost` 1.6–2.3 s · `mv_product_box_factor` 0.7–1 s. La forma: **una tabla por matview
que se recalcula DESDE LA MISMA VISTA filtrada a las llaves tocadas** (`DELETE … WHERE sku = ANY(k)` +
`INSERT … SELECT * FROM <vista> WHERE sku = ANY(k)`), con triggers por sentencia en cada fuente que
sacan los SKU de sus tablas de transición. La regla sigue viviendo en un solo lugar —la vista— y el
nombre `mv_*` se conserva como vista sobre la tabla (ADR-104 §6: ninguna pantalla cambia). Costo de la
vista filtrada a 10 SKU: `v_warehouse_box_factor` **150–190 ms** (contra 8–13 s entera) ·
`v_product_box_factor` **13 ms** · `v_kepler_unit_cost` 400 ms (el filtro no llega al `GROUP BY` de
`kdik`: su recálculo filtra `kdik` directo). Antes de construir:
- `mv_price_truth` no tiene vista debajo (el SQL vive en la matview): primero sacarlo a `v_price_truth_calc`.
- `v_warehouse_box_factor` lee **otra matview**, `mv_kepler_sold_rung`: localizar quién la refresca (es
  un reloj más que entra al mismo arreglo).
- Crear triggers en `kdm2`/`kdii`/`kdik` toma candado y la carga inicial recorre todo: **fuera de horario**.
- Árbitro nocturno por matview: tabla vs vista completa, debe encontrar 0.

**8b, decisiones y diseño final (2026-11-11).**

- **D-8b.1 — ventanas ancladas a la última venta (Edgar: «hagamos a»).** `mv_kepler_sold_rung` (365 d),
  `mv_kepler_bought_rung` (365 d) y `mv_price_truth` (90 d) cuentan desde `CURRENT_DATE`: su valor cambia
  sin que llegue ningún evento, y eso no se puede mantener por llave. Se anclan a la ÚLTIMA venta/compra
  del SKU. Medido sobre los mismos datos vivos: peldaño vendido **0 cambios** en `rung_max`/`rung_modal`
  (28,760 llaves; sólo el conteo de renglones en 29). Precio (aproximación de la regla, no la consulta
  exacta): moda distinta en ~660 de 25,480 sucursal×SKU (2.6 %); la regla «sin venta en 90 días → precio
  de configuración» se queda **en la lectura** (`CASE` sobre `ultimo_cobro`), así esos 5,679 no cambian.
- **Mecanismo: cola de llaves sucias, no recálculo en la ingesta.** Triggers por sentencia en las fuentes
  sólo anotan el SKU en `analytics.llaves_sucias` (dedup) y avisan `NOTIFY`; el worker junta ~30 s
  (`MiradaAlAviso`, que gana su 3er consumidor y se muda a `libs/platform-core`) y llama a una función
  `SECURITY DEFINER` que recalcula cada SKU una vez, en orden: peldaños → factor por producto → factor por
  almacén / precio / costo. La cola persiste: un aviso perdido se drena al arrancar.
- **Fuentes con trigger:** `kdm2`, `kdm1` (por documento → SKU vía `kdm2`), `kdii`, `kdik`,
  `kdpv_prod_util`, `kdpv_prov_prod`, `catalog.products`, `product_label_prices`,
  `product_unit_overrides`, `analytics.product_box_factor`, `product_prices`, `wincaja.articulos`;
  `commercial.warehouses` y `TRUNCATE` reconstruyen todo. Existentes y compatibles: ADR-104 en `kdm1`,
  `[PQ.59]` en `kdii`.
- **Se retiran:** el renglón `existencia-aux` (cada 5 min) y las dos entradas nocturnas de
  `analytics-refresh` (`sold_rung`, `bought_rung`). Las matviews quedan sin refresco y su borrado se pide
  aparte (regla 5); sus lectores (vistas y código) se repuntan a las tablas.

**8b, D-8b.1 REEMPLAZADA (Edgar firmó, 2026-11-11): no se ancla nada.** Al medir el peldaño COMPRADO, anclar
cambiaba el factor de caja final de 40 de 11,365 productos **a uno equivocado** (50 → 1, 12 → 1, 100 → 1:
compras de hace más de un año en peldaño 1 que la ventana de hoy descarta a propósito). Se mantiene la regla
de hoy exacta: por llave al llegar el evento + **un recálculo completo con el primer movimiento de cada día**
(lo único que la fecha mueve). Medido: llaves que pierden un día cada día — precio 3,511, peldaño vendido
626, comprado 12; recalcular por llave ~330 s, todo junto ~50 s → gana el recálculo completo. Ningún número
cambia. Costo total estimado ~2,000 s/día contra ~5,560 de hoy; frescura de ≤5 min a ~30 s. Por llave, el
precio es lo caro (~90 ms/SKU): segunda etapa, un histograma diario de precios mantenido por evento.
Lo que se declara: lo que envejece a medianoche se pone al día con el primer movimiento de la mañana.

**Orden firmado (dinero × esfuerzo): oleada 12 (S, 2 relojes) → 9 (L, 11) → 8b (L, 3).**

### 8.7 Oleada 12 — el `warehouse_id` al escribir (`[CANON.6.6]`, 2026-11-11)

Medido antes (prod, sólo lectura): de las 33 tablas de los dos barridos, **10 ya eran vistas** y **5
congeladas**; de las 18 vivas, 13 sin pendientes (sus escritores ya ponen el almacén). Lo pendiente era lo
escrito ese día: `identity.users` 1,011 altas de la carga de RH (más 4 de abril–octubre que el barrido
nunca llenó: probablemente el RLS forzado sin tenant), `reconciliation.blind_counts` 57,
`finance.goods_receipt_proofs` 13, pólizas 393 + 3. Ningún código resuelve a dos almacenes.

Arreglo: `commercial.warehouse_id_de(tenant, valor, regla)` (la regla de los dos barridos, en un solo
lugar) + `trg_warehouse_id_al_escribir` (`BEFORE INSERT OR UPDATE`, nunca frena al escritor) en las 18
tablas vivas; la migración llena lo pendiente una vez. En `identity.users` los triggers de alertas (firma,
permiso, puesto, rol) son `UPDATE OF` otras columnas: el llenado no los dispara. Prueba contra base real
`test-newdb-warehouse-id-al-escribir.js` con negativa (sin el trigger queda NULL) — local NO MEDIDA (el
`.env` apunta a prod y la guarda aborta, correcto); la corre `pruebas-db` en el CI.

**Orden de entrega:** push → CI (`pruebas-db` verde en esta prueba) → aplicar `20261111160714` → **después**
desplegar la ingesta (si la ingesta va antes, esa noche nadie llena lo pendiente).

### 8.8 Oleada 9 — el catálogo, medido: no son respaldos ociosos (2026-11-11)

Inventario del código (lectura) + bitácora de 30 días en prod (sólo lectura). Los 13 por clase: **ya por
evento (E)** nombres, códigos de barras, etiquetas, costo y altas · **vista o por evento (V)** `is_promo`,
`markup_pct`, `inventory.products_active` · **dueño mixto (C)** marcas, proveedores (`[PQ.107]`, 35 lectores
por repuntar: es de PQ), logística · **no Kepler** rotación (sale de `sales_daily`, espera D4),
`inventory.products` (2ª copia de `catalog.products`).

**Los «E» siguen escribiendo** — cada uno esconde un hueco o un pleito que hay que explicar ANTES de quitarlo:

| Script | 30 días | Lectura |
|---|---|---|
| `repoint-catalog-names` | 54 identidades en 25 de 29 noches; 3 el 10-nov | hueco vivo: nombres que cambian sin que el evento los vea (¿edición en la Suite que Kepler pisa, o ficha que no se reenvía?) |
| `import-product-barcodes` | 100–190/día hasta el 29-oct; 0–4/día desde el 30-oct (34 el 3-nov) | el evento ya cubre casi todo; residuo chico por explicar |
| `import-label-data` | «2 productos» en CADA corrida (1,109 de 1,442), ~90/día, un mes | ida y vuelta entre dos escritores (como H12 en nombres); y `STORE_NOTIFY_URL` sin configurar en la ingesta: el aviso de precio a pantallas no sale |

Costo de todos juntos: ~550 s/día (etiquetas 371, códigos 118, `is_promo` 32). No es CPU lo que se gana:
es que ningún dato dependa de un reloj y que los pleitos se cierren.

**Orden propuesto (dinero × esfuerzo):** 9.1 etiquetas — el pleito de los 2 productos y el aviso apagado
(precio que ve el cliente) · 9.2 `markup_pct` por evento en `kdpv_prod_util` (37 cambios/noche; entra al
costo de `sales-fact`) · 9.3 `is_promo` por evento (4–13 por corrida; único escritor) · 9.4 nombres (el
hueco) · 9.5 marcas por evento en `kdig` (hoy una línea nueva cae en `SIN-LINEA` hasta 7 días) ·
9.6 `products_active` a vista (además borra una FK en cada corrida: DDL en un cron) · 9.7 códigos de
barras (residuo) · después logística, `inventory.products`, costo y altas.

**9.1 hecho en código (2026-11-11, `[CANON.6.7]`): dos pleitos, no huecos.** Con `analytics.master_data_history`:
- **Precio de etiqueta:** cada :02/:32 `import-label-data` escribía en SUPER VELA AGUA TUBO/70 (84234) y
  BLISTER FOAMY (96842) el precio de un SKU **descontinuado** con su mismo código de barras (70216: $71.51
  contra $40.37; 96230: $74.69 contra $48.99), por su fallback por barcode; el hop-2 lo regresaba ~20 min
  después. Un mes así, 8 plazas cada uno. Los 13 amarres del fallback eran todos `* DESCONTINUADO` (7 sobre
  productos vigentes): el fallback se quita; la identidad queda sólo por sku, como el hop-2.
- **Código de barras del catálogo:** el hop-2 sólo protegía códigos de ≥ 12 caracteres y pisaba el EAN-8 de
  BOING CAJA 500 ML (59264: `75003135` → `59264`); el backfill del script lo regresaba. ~48 veces al día
  cada uno, semanas. `BARCODE_CASE` protege también el EAN-8 — medido: cambia la decisión de ese único producto.
- ⚠️ **Hallazgo, de Edgar (credencial):** `STORE_NOTIFY_URL`/`STORE_INGEST_KEY` no están en el carril
  `feeds-cron`: el aviso de cambio de precio a las pantallas no sale («aviso NO enviado», 1,109 corridas).
- Llega con el próximo despliegue de la ingesta (script y hop-2 viajan en la imagen). Después de eso, retirar
  el script requiere mover al hop-2 su único aporte legítimo: el EAN real cuando la ficha trae placeholder.

**9.2 hecho en código (2026-11-12, `[CANON.6.8]`): el markup por evento.** `catalog.products.markup_pct` lo
reescribía `import-margin` a las 03:00 —2 a 181 cambios por noche (56, 24, 100, 181, 40, 37, 2 la última
semana) y además `updated_at` de los 9,066 productos cada noche—; la '03' sí llega en el día (3 filas entre
las 03:00 y las 09:30, y ya había un markup nuevo esperando). Ahora `normalizeMarkup` corre en el hop-2 de
`kdpv_prod_util` con la misma regla (promedio de `c6` de la '03'), acotado al SKU que llegó y sin churn.
No cambia un número: 9,066 con fuente, 1 diferente (el de la mañana); el SKU sin filas en la '03' conserva
su markup como antes (hoy 0 casos). `import-margin.js` sale del nocturno y queda manual: sin `--apply` mide
cuántos difieren del ODS (debe dar 0), con `--apply` recalcula con la misma función; se quitó
`--source=branch` (leer el POS directo). `master_data_history` no vigila `markup_pct` (su trigger lista 7
columnas): el testigo de que el evento funciona es ese «difieren = 0». Prueba contra base real: 15 ✓, la
negativa (`normalize=false` no mueve el markup) y dos mutantes en rojo. Llega con el mismo despliegue de la
ingesta que 9.1 y la oleada 12; el hueco del día del despliegue (lo cambiado entre las 03:00 y ese momento)
se mide con `import-margin.js` sin `--apply` y, si da > 0, se cierra con `--apply` una sola vez.

**9.3 hecho en código (2026-11-12, `[CANON.6.9]`): `is_promo` por evento.** La recalculaba
`repoint-catalog-prices --solo-promo` cada 30 min (1,443 corridas al mes) con tres pases que se peleaban
dentro de la misma transacción: el pase 1 (precio, en los dos sentidos) apagaba 4–13 productos y el pase 2
(costo) los volvía a encender — 1,013 corridas fueron «13 + 13». Una sola regla da exactamente el mismo
estado (0 diferencias en 14,946 filas, 3,581 borradas; 166 ms el catálogo, 7–9 ms acotada): con precio en
`kdii` manda el precio máximo ≤ $0.05 y sin precio se conserva; en filas vivas, además, costo en (0, $0.05]
o «= GRATIS» sin costo real. Corre donde cambia una entrada: hop-2 de `kdii` (al final de su cadena) y de
`kdik` (tras el costo), y los dos nocturnos que todavía escriben costo o nombre (`repoint-catalog-cost`, todo
el catálogo; `repoint-catalog-names`, sólo lo renombrado). El script queda manual (sin `--apply` mide
«difieren»); se quitaron `--escribir-precio` (deshacía los rechazos de `normalizeSalePrice`, VPR.3) y la
fuente `.245`. Prueba: 21 ✓ con paridad contra los tres pases (copiados como oráculo) en 13 casos, dos
negativas y tres mutantes en rojo. Sin hueco el día del despliegue: el estado ya es el punto fijo.
- ⚠️ **Hallazgo, de negocio:** la regla hereda que el costo manda sobre el precio. Hoy 4 productos con precio
  real quedan como promo por un costo de Kepler ≤ $0.05 y por eso **salen de los reportes de venta**:
  BUTTER CHOC/CAFÉ 300GR (precio $35.63, costo $0.001), «1 PIÑATA PACK + 1 PIÑATA TRADICIONAL POR $200»
  (costo $0.01), «VENTAS AL 8% IEPS» y una oblea «= GRATIS» con precio $9.37. O el costo se corrige en Kepler
  o se decide que el precio real gane; no se cambió aquí.
- ⚠️ `/comercial/precios` todavía rotula la lista BASE-MXN como hecha por `repoint-catalog-prices.js`; desde
  `[VPR.3]` (5-oct) la escribe `normalizeSalePrice`. Rótulo que miente, pendiente (toca pantalla).
