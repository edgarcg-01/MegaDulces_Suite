# Runbook — Rollout: proveedores multi-branch + cajas unit-aware + higiene catálogo

> Origen: investigación existencias/salidas (jul-2026). Commits `5b1762d`, `8329836`,
> `27aaa08`, `3722b7c`. Todo **validado en local**; falta aplicarlo a **prod (Railway)**.
> Los importers/scripts corren **on-prem** (Railway no alcanza la LAN Kepler 192.168.x).

## Precondición (shell on-prem)

```bash
# Proxy Railway prod (base "railway"); sslmode no-verify por el proxy.
export DATABASE_URL_NEW='postgresql://postgres:<PWD>@<host>.proxy.rlwy.net:<port>/railway?sslmode=no-verify'
# Mapa de sucursales (mismas que stock). Si ya está en el Task Scheduler, reusar.
# export STOCK_BRANCH_MAP='[{"code":"MD-10","url":"postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01"}, ...]'
```

Verificar destino antes de aplicar:
```bash
psql "$DATABASE_URL_NEW" -c "select count(*) activos from catalog.products where tenant_id='00000000-0000-0000-0000-00000000d01c' and deleted_at is null;"
```

---

## Paso 1 — Redeploy api + view (activa #2: cajas unit-aware + columna Unidad)

Deploy normal de Railway (push a la rama que dispara build, o redeploy del servicio).
No requiere migración ni re-login. Verificar tras deploy en `/comercial/salidas`:
- Aparece la columna **Unidad** (PZA/CJA/KGS).
- Productos no-pieza muestran **"—"** en Cajas (esperado, no error).

## Paso 2 — Proveedores multi-branch (recupera ~800 sin proveedor)

```bash
node database/importers/kepler/import-kepler-suppliers.js            # DRY-RUN (revisar "UNION … SKUs enlazados")
node database/importers/kepler/import-kepler-suppliers.js --apply    # aplica
```
Verificar: `% sin proveedor` baja (~40% → ~15%).
```bash
psql "$DATABASE_URL_NEW" -c "select round(100.0*count(*) filter (where supplier_id is null)/count(*),1) pct_sin_prov from catalog.products where tenant_id='00000000-0000-0000-0000-00000000d01c' and deleted_at is null;"
```
> Equivalente vía orquestador: `node database/importers/kepler/run-prod-feeds.js catalog --apply` (corre todo el catálogo).

## Paso 3 — Higiene: soft-delete SKUs legacy (~3,399, recuenta vs prod)

```bash
node database/scripts/deactivate-legacy-skus.js            # DRY-RUN — revisar el conteo LEGACY
node database/scripts/deactivate-legacy-skus.js --apply    # soft-delete
```
Guardas: activo + sin proveedor + sin stock + sin venta + ausente de `kdii` de las **6**
sucursales. **Aborta** si no alcanza las 6 (evita borrar algo que vive en la sucursal caída).
Reversible: `UPDATE catalog.products SET deleted_at=NULL WHERE …`.

> Correr el Paso 2 ANTES del 3: así los que sí tienen proveedor en otra sucursal
> dejan de contar como candidatos a higiene.

---

## Rollback

- #2: redeploy del commit anterior.
- Proveedores: no destructivo (solo setea supplier_id).
- Higiene: `UPDATE catalog.products SET deleted_at=NULL, updated_at=now() WHERE tenant_id='…d01c' AND deleted_at >= '<fecha del run>'::date;`
