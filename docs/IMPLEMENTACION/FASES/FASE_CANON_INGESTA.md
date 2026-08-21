# Fase CANON — Consolidación de la ingesta (menos fuentes de frescura)

> ADR-046. Continúa la trayectoria "derivar-no-copiar" ya iniciada (6 vistas erp_* sobre `kepler_ods`).
> Objetivo del usuario (2026-08-20): *"acotar a menos fuentes de frescura; kepler crudo ya debería traer
> toda la información; los imports deberían dejar de existir o al menos unos pocos; normalización no solo
> en las tablas sino en cómo LLEGA la información."*
>
> **Base**: [`MODELO_CANONICO_DATOS.md`](../../MODELO_CANONICO_DATOS.md) (análisis multi-agente 2026-08-15).
> Leer su **§7 (salvedades)** antes de ejecutar cualquier repunte.

---

## Tesis

`kepler_ods.*` **ya es el crudo canónico en prod**: espejo de **207 tablas** de Kepler, replicación lógica
continua (`OdsLiveLoop`, 2 carriles ctid+hash), **fresco al minuto** en las tablas calientes (kdm1/kdm2/
kdii/kdil/kdik/kdud). Verificado 2026-08-20: TODAS las tablas que los feeds necesitan ya están en el ODS
(incl. kdpv_folio_caja, kdpv_prod_util, kdxd, kdpv_prov_prod), con columna `sucursal` (unión de las 6).

**El problema de frescura NO es el crudo — es aguas abajo.** De 69 feeds activos, **solo 2 leen `kepler_ods`**;
el resto re-lee fuentes MÁS VIEJAS que ya viven, frescas, en el mismo Postgres.

## Estado actual (catálogo 2026-08-20)

| Leen de… | # | Qué es | Frescura |
|---|---|---|---|
| **`kepler_ods`** (objetivo) | 2 | crudo en prod | minutos ✅ |
| `branches` | 36 | md_* directo (6 conexiones) / KP_CONCENTRADA @4h / Mega_Dulces .245 (archivos) | 4h / stale 🔴 |
| `mart` | 6 | consolidado on-prem `ventas_enriched` + push `.249` | su cadencia |
| `prod` | 17 | transforms 2º nivel sobre `analytics.*`/`commercial.*` | heredada ✅ |
| wincaja / contpaqi / mdb / mixed | 8 | externos | propia |

Por TIPO: projection 19 · aggregation 33 · dim 16 · blend 1.

## Meta: **8 orígenes de frescura → 4**

Matar **KP_CONCENTRADA** (@4h cross-LAN) + **Mega_Dulces .245** (archivos) + colapsar el **`mart`** a una
derivación de `kepler_ods`. Quedan 4 crudos irreducibles: **Kepler ODS · Wincaja · ContPAQi · caja .mdb**.
Todo lo Kepler-derivado lee el ODS; los 17 `prod`-transforms se quedan (no son orígenes: su frescura = ODS + su cron).

## Los 3 límites duros (por qué NO todo puede ser vista cruda)

1. **El ODS NO propaga hard-DELETE** (UPSERT-only, `replicate-ods-live.js:21`). Una vista sobre el crudo deja
   SKUs/filas descontinuadas vivas para siempre → las tablas que expresan **bajas** siguen siendo transform
   con DELETE explícito, no vista pura.
2. **RLS no aplica a vistas/MVs.** `commercial.*` y `catalog.*` son tenant-scoped → no pueden ser vista cruda
   del ERP single-tenant sin reinyectar `tenant_id` a mano (riesgo de fuga cross-tenant). Para esas: **repunte
   de SRC** (lee ODS) pero sigue siendo tabla materializada por su feed.
3. **El skew per-sucursal es inherente** a 6 servidores en 6 subredes. Repuntar al ODS lo REDUCE (un solo linaje,
   same-DB) pero no lo elimina.

## Plan por fases (orden = frescura ganada / riesgo)

### Fase 0 — parar el sangrado (días, bajo riesgo)
- [x] **CANON.0** — sacar `import-erp-shipments` del modo `logistics` (ya es vista → error latente). ✅ 2026-08-20 (`5c47d6b3`)
- [x] **CANON.0.1** — reemplazo ODS del **COSTO**: `repoint-catalog-cost.js` (kepler_ods.kdik.c16 → cost_base/
      with_tax/per_case), wired en `nightly` tras presence. ✅ 2026-08-20 (`bf3e49db`). Regla: **mediana retail**
      de c16 (excl CEDIS '00') anclada al c90-implícito; UPDATE-only churn-free same-DB. **Descubrimiento clave:**
      la unidad per-pza/per-caja de c16 y c90 es **inconsistente por SKU y en AMBOS sentidos** (91059 16KG: ODS
      $152/pza correcto vs actual $5002 per-caja MAL; 96910: ODS $4034 per-caja MAL vs actual $136 correcto) — no
      hay ancla universal. Solución robusta: **CLAMP [1/3,3]×** al costo actual → refresca el drift en banda (dry-run:
      2,879 cambios, **−2% valuación, balanceado 1302↓/1349↑**, 76% ≤10%) y **RECHAZA+registra** los 126 saltos ~30×
      (backlog DQ de normalización de unidad; quedan intactos — 91059 ya estaba MAL hoy, pre-existente). ODS cubre
      **8,627/8,797 (98.1%)** del cost_base; 170 residuales sin kdik ni c90 quedan como están. El costo per-caja de
      kdik ya lo leía catalog-bulk desde las 6 sucursales (no de .245) → matarlo NO amenaza la frescura del costo.
- [x] **CANON.0.2** ✅ 2026-08-21 — retirados los dos escritores .245 del modo `catalog` + repuntado thot →
      **`Mega_Dulces` .245 queda con CERO lectores agendados (7→6 orígenes de frescura).**
      - **`import-prices-bulk`** RETIRADO del `catalog` mode. Los tiers P1-P4/MAYOREO = DATO MUERTO (0 clientes
        fuera de BASE-MXN). Su único valor, el recálculo de **`is_promo`**, se **REUBICÓ a `repoint-catalog-prices`**
        (mismo trx del sync, misma fuente fresca `kepler_ods.kdii.c90`, 3 pases precio/costo/nombre). Validado vs prod
        (solo-lectura): 219 promos por precio + cost/name passes; FLIP sano 25→true / 11→false. El .js queda como
        fallback histórico + semilla de un mayoreo real futuro desde `kepler_ods.kdpv_prod_util`.
      - **`import-catalog-bulk`** RETIRADO del `catalog` mode. Costo ya lo cubre CANON.0.1; nombre/precio/presencia/
        barcode los repoints ODS (CANON.1.3); factor_sale box-factor; el CFDI-facturado (iva_rate/ieps_rate) se
        **CONGELA**. Los campos ESTÁTICOS que solo él escribía (description/unit_purchase/factor_purchase/location/
        loyalty/iva_purchase) se congelan en su valor actual (cambian poco). **`category_id` NO se hereda a propósito**:
        verificado que está deprecado/inconsistente y **sin consumidor vivo** (los `categoria` de libs son de
        `inventory.products`/ajustes de compra, no de `catalog.products.category_id`) → propagarlo sería arrastrar dato
        muerto; new-SKU category_id=NULL degrada limpio (los lectores caen a marca/línea). Si algún día se quiere una
        taxonomía real, se construye fresca desde `kdie`/`kdig`, no del código .245 muerto.
      - **`thot-build-features` REPUNTADO** (era el ÚLTIMO lector de `Mega_Dulces`, vía `DATABASE_URL_REMOTE_SNAPSHOT`):
        · **affinity ← `kepler_ods.kdm1`/`kdm2`** (basket = documento (suc,c4,c5,c6); join verificado; U/D/10; 365d;
        co≥15). Basket físico correcto (sin el folio-reuse cross-día que inflaba el original). Dry-run: 25,072
        afinidades dirigidas (~1,003 productos) — frescas y más correctas que las 49,751 histórico-.245.
        · **zone_demand ← prod-local `analytics.product_sales_monthly`** + `zonaOf(code)` (mapa sucursal→ciudad
        best-effort; el mapeo cliente→zona real nunca existió; peso 0.5, opcional). Dry-run: 16,909 filas / 4 zonas
        reales (perdió el bucket basura "Desconocida" de .245). revenue = units × precio base (los lectores usan
        demand_index/rank, no revenue). Corre same-DB en el nightly (sin egress; DATABASE_URL_NEW debe ser prod).

### Fase 1 — repuntar los lectores de KP_CONCENTRADA a `kepler_ods` (1-2 sem)
KP_CONCENTRADA @4h cross-LAN → ODS @min same-DB. Todas las tablas confirmadas en el ODS.
- [x] **CANON.1.1** — `import-cash-sessions` → `kepler_ods.kdpv_folio_caja` (same-DB prod). ✅ 2026-08-20. Dry-run compare: ODS superset (0 faltantes vs KP) y MÁS preciso (ODS 9 abiertas vs KP 13, con ~6 cierres de hoy que KP @4h no veía). `source=ods` default; `kp`/`branches` quedan de fallback. Límite R2 visto: 1 sesión con lag del carril hash (se cierra en el próximo ciclo). Toma efecto en la próxima corrida `live`/`livefast`.
- [x] **CANON.1.2** — `import-label-data` → `kepler_ods.kdii`+`kdpv_prod_util` (same-DB). ✅ 2026-08-20. Dry-run compare: ODS cubre TODOS los 9,452 SKUs de KP (0 faltantes) + 22 extra + 19 precios ODS>KP (frescura: subieron y KP @4h no vio); tiers kdpv idénticos (18,411 vs 18,412). `source=ods` default (lee en la misma conexión de prod, sin src .245); `kp` de fallback. Toma efecto en la próxima corrida `nightly`.
- [x] **CANON.1.3** — `repoint-catalog-presence/names/prices` → `kepler_ods.kdii` (same-DB). ✅ 2026-08-20. Reconciliación decidida (Edgar): **excluir CEDIS '00' (mayoreo) + MODA retail** (01-06) para precio; retail-first + fallback a CEDIS para identidad. Dry-run: precio 99% idéntico (solo 90 correcciones al consenso); identidad ODS superset (nombre 0 diffs); names 5 correcciones, presence 0/0 (ya en sync). Arregla de paso landmine #13 (base = etiqueta). `source=ods` default; `kp` fallback. **Milestone: KP_CONCENTRADA eliminada como fuente de frescura** (los 5 lectores repuntados).
- [x] **CANON.1.3b** — ⚠️ **la doc estaba equivocada**: quitar el gate a lo bruto REGRESARÍA 1,184 barcodes (medido: current EAN bueno + c7 basura) para "arreglar" solo 13 divergencias reales (EAN-A→EAN-B). El c7 crudo de names es basura para ~1184 SKUs. **Fix correcto (opuesto): sacar barcode del UPDATE de names** → barcode = único-escritor de `import-label-data` (valida c7 + rescata c95). Gate sigue por nombre. ✅ 2026-08-20. Diferido: reasignación masiva de MARCA (el gate ampliado a marca movía ~507 filas sin validar) + los 13 EAN-A→EAN-B (marginal).
- [x] **CANON.1.2b** — `import-label-data` alineado a la MISMA regla (excl CEDIS + moda retail, moda-join que elige la fila al precio moda) → etiqueta = base (landmine #13 cerrado). ✅ 2026-08-20. Dry-run OK (8,672 match).

### Fase 2 — colapsar el `mart` (2-4 sem)
- [ ] **CANON.2.1** — `mart.ventas_enriched` → **VISTA sobre `kepler_ods.kdm1/kdm2`** (enrichment de canal en módulo
      compartido). Los 6 mart-feeds (sales-fact, rotation, top-sellers, customer-sales, route-push-monthly/lines)
      heredan frescura ODS; muere el paso `concentrate-kepler` como origen separado.

### Fase 3 — repuntar los 36 branch-readers a `kepler_ods` (3-6 sem)
Same-DB → mata el fan-out de 6 conexiones + el skew por-feed. Por lote:
- [ ] **CANON.3.1** contables (`kdc2*`): expenses-polizas / ap-findings / ledger-chain / kepler-polizas / sales-by-channel / bank-postings / cash-cuts.
- [ ] **CANON.3.2** ventas/stock (`kdm1/kdm2/kdil/kdii`): pos-ticket-sales / kardex / purchase-adjustments / stock-movements / reorder-policy / in-transit / product-sales-monthly+daily / sales-by-route / canindo-routes / transfers-monthly / vecinal-routes / branch-stock-live.
- [ ] **CANON.3.3** dims: box-factor / box-price / brands-lineas / kepler-suppliers / margin / logistics-dims / pos-cashiers.

### Fase 4 — derivar-no-copiar (respetando los 3 límites)
- [ ] **CANON.4** — las projection/dim puras sobre ODS (sin cols de app, sin bajas, no tenant-scoped) → **vistas**.
      Candidatas: box-factor, box-price, label-prices, pos-cashiers, kepler-accounts. Las con bajas/RLS quedan transform.

## Método de verificación (por cada repunte)
1. Confirmar tabla + columnas en `kepler_ods` (hecho para las 16 core).
2. **Dry-run compare**: correr el query viejo (source actual) vs el nuevo (ODS) y diffear conteos + Σ de control
   (revenue/filas/claves). Solo cambiar el SRC si cuadran (o el delta se explica por frescura, ODS ≥ viejo).
3. Aplicar el switch de SRC, correr `--apply` contra prod, re-verificar la pantalla consumidora.
4. Commit verde por item. Actualizar este doc + `03_LOG_REVISIONES.md`.

## No tocar (por diseño)
- Los 17 `prod`-transforms (rollups/demanda/reorden/inventory-health): ya derivan de prod, no son orígenes.
- Snapshots point-in-time inmutables: `order_lines.unit_price`, `purchase_requisition_lines.on_hand`, etc.
- Wincaja / ContPAQi / caja .mdb: universos disjuntos legítimos, cada uno UNA replicación monitoreada.
