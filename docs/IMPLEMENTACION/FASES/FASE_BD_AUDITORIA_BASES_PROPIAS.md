# Fase BD — Auditoría de nuestras propias bases de datos (prod `railway`)

> **Disparador:** Edgar, 2026-09-14 — *"ya auditamos la implementación del ERP Kepler. ahora audita
> nuestras propias bases de datos"*. Es el espejo de la auditoría del Kepler crudo (`VERDAD_ABSOLUTA.md §13`),
> ahora sobre la base que **nosotros** diseñamos.
>
> **Medido read-only contra PROD** (`FLEET_DB_URL` → `trolley.proxy.rlwy.net:39023/railway`, PG 18.6,
> tenant `mega_dulces`) el **2026-09-14**. Cada probe confirma `current_database()='railway'` +
> `classify(url).kind==='prod'` ANTES del primer SELECT (`libs/platform-core/.../target-guard.js`).
> Postura **solo-auditar**: se mide, se declara, se propone; **no se ejecutó ningún cambio**.

Esta fase es un **censo + veredicto + tabla de ruteo**. NO inventa tooling: los arreglos se rutean a
su fase dueña (VP procedencia · OBS ingesta/db-health · SD linaje de ventas · VL servidor de ingesta)
o se declaran como hueco con nombre en `VERDAD_ABSOLUTA.md §7`.

---

## El veredicto en una tabla

| dimensión | qué la arbitra | resultado | ¿sano? |
|---|---|---|---|
| **Censo / mapa** | re-introspección vs `ESQUEMA_BD_PROD.md` (2026-09-11) | el snapshot **derivó** en 3 días (713 migs/batch 410, 617 tablas, 13 mv) | ⚠️ refrescar el snapshot |
| **Cero-copias (R2)** | `pg_class` por nombre `_bak/_snapshot/_dedup` | **los 6 `_bak` que F1 declaraba: BORRADOS** (purga batches 394-410) | ✅ sí |
| **Doble linaje de ventas (R1)** | `sales_daily` (tabla) vs `mv_kepler_sales_daily` (ODS) | vivo, ~30% de la DB, desync declarado | ⛔ abierto → **Fase SD** |
| **Tablas vacías (R1)** | `count(*)` exacto sobre 173 candidatas | **77 vacías = feature-antes-de-uso**, NO importer-muerto | ✅ sí (no recurre `customer_receivables`) |
| **tenant_id / RLS (R3)** | `pg_class.relforce…` + `pg_attribute` | 11 sin tenant (legítimas) · analytics 1/64 RLS **moot** (pool `postgres`) | ⚠️ declarado |
| **Migraciones (R4)** | `public.knex_migrations` vs archivos | **0 aplicadas-sin-archivo** (0 riesgo directory-corrupt) · 1 pendiente | ✅ sí |
| **Integridad estructural** | FK actions · PK · triggers | 5 FK NO ACTION (no 68) · 3 sin PK · **0 triggers deshabilitados** | ✅ sí |
| **Frescura / procedencia (VP)** | `master_data_history` / `cron_run_log` / `period_close` | **VIVOS en prod**, 202k filas / 202,748 en 7d (no "solo platform_test") | ✅ sí (delta +) |
| **Salud física** | `pg_stat_user_tables` bloat/analyze | **0 tablas con bloat** (autovacuum sano) · ⚠️ stats reseteadas | ✅ sí |
| **El propio monitor (db-health)** | `db_health_alerts` (`resolved_at IS NULL`) | dedup + resolve **funcionan** (1 abierta/fuente, 0 fantasmas) | ✅ sí |
| **Estado operativo REAL** | las 10 alertas abiertas del monitor | **6 = carril Wincaja caído** + backup 2.8d + cdc_reconcile error | ⛔ operativo → **VL/OBS** |

**Tesis del veredicto:** la base propia está **estructuralmente sana**. La limpieza que estaba declarada
como deuda (purga de `_bak`, SD) ya ocurrió; la infraestructura de procedencia (VP) se desplegó a prod y
está viva; el monitor de salud funciona; no hay bloat ni incoherencia de migraciones. Lo que está abierto
es **operativo** (ingesta en `.249`: Wincaja + backup) y el **doble linaje de ventas** (SD) — ninguno es
un bug de integridad nuevo. Y esta auditoría **cazó una afirmación falsa propia** antes de publicarla (§ El 4º rojo).

---

## Censo — el snapshot derivó en 3 días

| | `ESQUEMA_BD_PROD.md` (2026-09-11) | medido (2026-09-14) | Δ |
|---|--:|--:|---|
| Migraciones (ledger) | 692 / batch 393 | **713 / batch 410** | +21 migs, +17 batches |
| Tablas | 623 | 617 | −6 (purga) |
| Vistas | 313 | 313 | = |
| Matviews | 12 | **13** | +1 (`mv_kepler_unit_ladder`) |
| FKs | 534 | 515 | −19 |
| Triggers | 90 | 87 | −3 |
| Tamaño | 30 GB | 31 GB | +1 GB |
| Roles login | — | `app_runtime`, `postgres` | 2 |

⚠️ **`ESQUEMA_BD_PROD.md` está viejo por 3 días de actividad de esquema.** No es error — es una FOTO;
se anotó su caducidad en el propio doc. Regenerarlo requiere re-correr su script de introspección.

---

## Hallazgos por dimensión

### D1 · Cero-copias (R2) — F1 CERRADO por otra sesión
Los 6 `_bak`/backup que la memoria `project_norm_audit_frozen_mirrors`/`ESQUEMA` declaraban vivos
(`analytics.bank_postings_snapshot_bak` 45k, `analytics.kepler_bank_movements_snapshot_bak` 56k,
`public.products_normalize_backup_20260528`, `identity.products_dedup_backup_20260716`,
`identity.brands_dedup_backup_20260716`, `pgboss.queue_stats_20260813/14`) **ya no existen** — se
dropearon en la purga (batches 394-410, Fase SD). **Re-verificar en vivo evitó reportar 6 hallazgos muertos.**
- ⚠️ **Residuo R2:** el fantasma `identity.knex_migrations` (+`_lock`) **sigue físicamente presente y vacío**,
  aunque su migración de retiro (`20260907160000_retirar_knex_migrations_fantasma`) figura **aplicada**. La
  migración no dropeó la tabla. El ledger real es `public.knex_migrations` (713 filas). Cota: nula (vacía) → **hueco menor declarado**.

### D2 · Doble linaje del hecho de venta (R1) → Fase SD
`analytics.sales_daily` (tabla, 3.76 GB, poblada por importer, **$54.4M/mes** todos los canales) y
`analytics.mv_kepler_sales_daily` (matview, ODS-derivada, 730k filas) coexisten — el mismo hecho por dos
caminos. Confirmado vivo (ambos con dato reciente). Canales Ago-2026 en la tabla: tienda $16.5M · wincaja_mostrador
$15.5M · mayoreo $7.5M · wincaja_credito $7.0M · credito $5.5M · wincaja_preventa $1.5M · wincaja_ruta $0.8M.
El desync exacto lo **arbitra y posee la Fase SD** (Ago table $21.30M vs matview $25.74M, 17.3%). **No se
re-deriva acá** para no producir un número apples-to-oranges por definición de canal distinta. **Ruteo: SD.**

### D3 · tenant_id / RLS (R3) — mayormente por diseño
- **11 tablas de negocio sin `tenant_id`**, todas excepciones legítimas: listas SAT globales
  (`fiscal.sat_list_*`), la propia `identity.tenants`, catálogos globales (`identity.responsibilities`,
  `scope_dimensions`), el espejo ex-FDW (`inventory.products`/`products_active`), `trade.stores_route_audit`,
  y el fantasma `identity.knex_migrations`. Ninguna es multi-tenant de negocio.
- **`analytics`: 1/64 tablas con RLS forzado** (sólo `db_health_alerts`) — donde vive el dinero. **Pero es
  moot**: el pool primario corre como **`postgres` (superuser + bypassrls)** — medido: 10 conns `postgres`
  (3 activas) vs 4 `app_runtime` (0 activas). El aislamiento real es el `WHERE tenant_id` manual de cada query.
  Ya **declarado** en `ESQUEMA_BD_PROD.md §1` y ADR-010. Restado, no nuevo. **Ruteo: deuda declarada.**

### D4 · Migraciones (R4) — coherente
`public.knex_migrations` = 713 filas · `database/migrations-newdb/` = 714 archivos. **0 aplicadas sin archivo**
(cero riesgo de *"directory corrupt"*). **1 archivo pendiente:** `20260911090000_grant_catalogo_interno_administrativo_piso_tienda.js`
(un GRANT, no aplicado a prod). El fantasma `identity.knex_migrations` está vacío (0 filas) — no re-poblado.

### D5 · Frescura / procedencia (VP) — delta POSITIVO grande
**Re-verificación en vivo CONTRADICE la memoria "solo en platform_test, historia = cero en prod":**
- `analytics.master_data_history` — **202,750 filas, 202,748 escritas en 7 días**, `max(changed_at)` hace min. VIVO.
- `analytics.cron_run_log` — **72,441 filas**, `max(logged_at)` hace min. VIVO.
- `analytics.period_close` — **28 filas**, `last_check_at` hace ~4h (job `period_close_check` corre). Existe.
- `analytics.declared_gaps` — **10 filas** (los huecos de VERDAD §7 como tabla con caducidad).
→ **VP.3.1/3.3/4.1 SÍ están desplegados y activos en prod.** Lo que queda abierto de VP (servir el mes
cerrado al usuario VP.4.2, latido en los 9 importers de datos maestros VP.3.4) **no se re-reporta como nuevo**.
- **Matviews frescas:** las 13 con conteo esperado (las 3 @15min de 1 fila; la cadena sell-out refrescada
  ~4.8h atrás / anoche; `mv_sales_blended` `business_date` = hoy). Sin "verde incondicional" (VP.0.4 cerrado).

### D6 · Integridad estructural — sana (delta vs FKJ)
- **FK actions:** de 515 FKs, sólo **5** son NO ACTION puro (no los "68" de FKJ). El resto: 243 RESTRICT,
  158 SET NULL, 105 CASCADE en `ON DELETE` — deliberadas.
- **Sin PK: 3 tablas** (`catalog.products_top_sellers`, `catalog.top_sellers_live` — el hotfix MV→tabla;
  `fiscal.sat_list_staging` — staging). Todas de bajo riesgo.
- **0 triggers deshabilitados** (el único no-`O` es `trade.stores.trg_audit_store_route` con `tgenabled='A'`
  = ALWAYS, o sea *más* habilitado). El temor "`identity.users` triggers off / `convalidated` miente" **no aplica en prod**.

### D7 · Salud física — sana, con un asterisco de stats
- **0 tablas con bloat** (>30% dead-tuples, >10k filas) — autovacuum sano.
- ⚠️ **`pg_stat` fue reseteado** (reinicio de Railway): `n_live_tup=0` mintió en **96 tablas** que sí tienen
  filas (`inventory.products_active`=9,772 aparecía "vacía"). Consecuencia: **el análisis de índices sin uso
  (`idx_scan=0`) NO ES MEDIBLE ahora** — se declara **NO MEDIDO** (candado: re-medir tras 7 d de stats frescas).
- **188 tablas nunca analizadas** (`last_analyze`/`last_autoanalyze` NULL con dato) → el planner vuela a ciegas
  hasta que autoanalyze las alcance. Transitorio post-reset.
- Anomalía trivial: **4 filas futuras en `sales_daily`** (2026-12, $230 total). Negligible.

### D8 · Seguridad / acceso — deuda conocida
- **2 roles login:** `app_runtime` (no super, no bypassrls, no createrole/db — correcto) y `postgres`
  (super + bypassrls). El pool primario usa `postgres` → RLS es defensa-en-profundidad **no efectiva** hoy (D3).
- **Secretos en texto plano** (deuda OBS: `FEEDS_INGEST_KEY` en launchers) y la **credencial de Railway pegada
  en texto plano en una sesión previa, SIN ROTAR** — sigue siendo deuda de seguridad abierta.

---

## El 4º rojo — una afirmación falsa MÍA que la disciplina cazó

Iba a publicar como **hallazgo estrella**: *"`db_health_alerts` tiene 648 alertas abiertas, muchas duplicadas
por fuente; fuentes ya recuperadas siguen críticas → el resolve/dedup del monitor está roto."* Medí la columna
`status` (`IN ('critical','warn')`) como si fuera el flag de abierto/cerrado.

**Es falso.** El scanner marca resuelto poniendo **`resolved_at`**, NO cambiando `status` (lo leí en
`db-health-scanner.service.ts:96,149` antes de publicar). Medido con el predicado correcto (`resolved_at IS NULL`):
**648 filas totales, sólo 10 abiertas, 638 resueltas, exactamente 1 abierta por fuente, 0 fantasmas.** El dedup
y el resolve **funcionan perfecto**. El monitor no está roto — está diciendo la verdad: **Wincaja caído + backup viejo.**

Es el mismo modo de falla que esta auditoría existe para cazar (§13.3 de VERDAD: medir la columna/DB equivocada
y publicar un rojo que no existe). Se conserva como caso testigo. **Lección: leer qué significa la columna antes de contarla.**

---

## Estado operativo real (las 10 alertas abiertas del propio monitor)

| fuente | sev | qué es | ruteo |
|---|---|---|---|
| `wincaja_sync` `wincaja_feed` `wincaja_concentrada` `wincaja_branch_stale` `wincaja_cedis_stale` `wincaja_existencias_entrega` | critical ×6 | **el carril de ingesta Wincaja está caído** (todo en `.249`) | **VL.5** (Wincaja sigue en `.249`) |
| `backup_prod` | critical | **respaldo diario de prod sin correr 2.8 d** (66.8h > critH 50h), host `.249` | **VL/OBS** — riesgo real |
| `cdc_reconcile` | critical | el reconciliador ODS errorea (continuo) | **OBS** |
| `route_provenance` · `stock_cedis_00` | crit/warn | procedencia de ruta · existencia CEDIS 00 | OBS |

Los 10 los **detecta** el monitor bien, pero **no salen del edificio** (`SMTP_*`/`WATCHDOG_WEBHOOK_URL` sin
configurar — OBS.0.2/5). "La alarma suena en un cuarto vacío" — instancia viva.

---

## Tabla de ruteo (hallazgo → dueño)

| hallazgo | dueño | estado |
|---|---|---|
| Doble linaje `sales_daily` vs ODS | **Fase SD** | ⛔ abierto (declarado) |
| Carril Wincaja caído en `.249` | **Fase VL.5** | ⛔ abierto (declarado) |
| `backup_prod` sin correr 2.8 d | **VL/OBS** | ⛔ abierto — riesgo |
| Alarma no sale del edificio | **OBS.0.2/5** | ⛔ abierto (declarado) |
| `analytics` RLS moot (pool superuser) | deuda declarada (ADR-010) | ⚠️ aceptada |
| Fantasma `identity.knex_migrations` persiste | **VP.5.4** (retiro) | ⚠️ menor |
| Credencial Railway sin rotar · secretos en claro | seguridad | ⛔ abierto |
| `ESQUEMA_BD_PROD.md` viejo 3 d | esta fase | ⚠️ anotado |
| Índices sin uso NO MEDIBLE (stats reset) | esta fase | declarado NO MEDIDO |

---

## Estado

🟢 **Auditoría de las bases propias = CERRADA al 100%** (censo + veredicto + ruteo), 2026-09-14. Cero
incógnitas: cada hallazgo o está cerrado, o declarado con nombre + monto/cota + candado + dueño.

La base propia está **estructuralmente sana**: sin `_bak` vivos, sin bloat, migraciones coherentes,
procedencia (VP) viva en prod, monitor funcionando. **Deuda con nombre y dueño (no incógnitas):**
(1) doble linaje de ventas → SD; (2) carril Wincaja + backup en `.249` → VL.5; (3) alarma sin canal
externo → OBS; (4) credencial Railway sin rotar; (5) `ESQUEMA_BD_PROD.md` a refrescar.
