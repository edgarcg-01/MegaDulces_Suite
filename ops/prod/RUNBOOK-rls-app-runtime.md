# `[SEC.RLS]` Encender el RLS: sacar la app de `postgres`

> **Estado: medido y preparado. El corte NO se ha hecho.**
> Candado: `node database/tests/test-newdb-rls-app-runtime.js` — hoy **4 ✔ · 0 ✖ · 2 NO MEDIDO**.

## 1. El hecho

La API de producción se conecta como **`postgres`**: superusuario, `rolbypassrls = true`.

```
DATABASE_URL     = postgresql://postgres@…
DATABASE_URL_NEW = postgresql://postgres@…
```

⛔ **Las 401 tablas con `FORCE ROW LEVEL SECURITY` no filtran nada en runtime.** Todo el RLS del
repo es documentación, no una defensa. Lo único que aísla hoy es el `where tenant_id` que cada
servicio escribe a mano: un servicio que lo olvide **no tiene red**.

⚠️ **`TenantKnexService` NO hace `SET ROLE`.** Pone `SET LOCAL app.tenant_id`, que es lo que leería
la política — pero la conexión sigue siendo superusuario y la política nunca se evalúa.

**Hoy no hay fuga ENTRE tenants porque hay uno solo (`mega_dulces`).** El riesgo es de futuro
—multi-tenant es la tesis del proyecto— y de defensa en profundidad.

## 2. Lo que está probado

Medido el 2026-10-09 con `SET LOCAL ROLE app_runtime` (ese rol **no** tiene `BYPASSRLS`, así que
el RLS se evalúa de verdad), en transacción revertida:

| | |
|---|---|
| `app_runtime` existe, puede conectarse, no es superusuario, no salta RLS | ✅ |
| Puede leer **las 14 tablas con datos** de la lista, **con el tenant puesto** | ✅ el hueco **no** es de permisos |
| Sin tenant, esas 14 devuelven **CERO** | ✅ la política **sí** funciona |

```
catalog.products          14,887 → 0 → 14,887
commercial.stock          57,627 → 0 → 57,627
finance.findings         157,263 → 0 → 157,262
```

⚠️ **`finance.findings` tiene 1 fila que no es del tenant** (157,263 contra 157,262). Vale
mirarla antes del corte: hoy es invisible porque el superusuario ve todo.

## 3. ⛔ Lo que ningún `GRANT` resuelve

**`REFRESH MATERIALIZED VIEW` exige ser DUEÑO.** Las **50** matvistas son de `postgres`.
El refresco tiene que seguir pasando por **`KNEX_NEW_DB_ADMIN`** (pool postgres) pase lo que pase
con el usuario de la app. Verificado: `analytics-refresh.service.ts` y `new-database.module.ts`
ya lo usan.

## 4. ⚠️ Lo que NO se puede saber por análisis estático

**Se intentó tres veces enumerar las consultas que corren sin tenant, y las tres sobrecontaron:**

1. *«41 servicios con el knex crudo»* — incluía los que usan `TenantKnexService` indirectamente.
2. *«8 archivos tocan tablas con RLS»* — incluía los que ponen `SET LOCAL app.tenant_id` **a mano**
   (`recommendations-refresh`, `replenishment-scanner`, `kp.service`, `db-health`,
   `route-ticket-reminder`). Grepear por la clase no es grepear por la conducta.
3. *«3 archivos problemáticos»* — incluía `stock-reservation-cron`, que usa el pool **ADMIN** a
   propósito y lo documenta en su cabecera. `KNEX_NEW_DB` es **subcadena** de `KNEX_NEW_DB_ADMIN`.

Resultado final: de los **11** servicios que de verdad usan el pool normal sin tenant, **ninguno
toca una tabla con RLS** (tocan `analytics.cron_runs`, `erp_goods_receipts`,
`mv_sellout_budget_rollup` y `public.tenants`, las cuatro sin política).

⛔ **Pero eso es una COTA INFERIOR, no una prueba**: el grep sólo ve tablas escritas como
`'schema.tabla'` entre comillas, no las que van dentro de un `.raw()` con SQL inline.
**La única forma de saberlo es correr la app como `app_runtime` y ver qué se rompe.**

## 5. El plan: cortar por partes, empezando por lo seguro

⭐ **El orden correcto es al revés del intuitivo.** Los caminos de **request** son los seguros —
todos pasan por el interceptor → `tk.run()` → tenant puesto. Los **crons** son los riesgosos,
porque corren sin request. Entonces:

| Paso | Qué | Por qué |
|---|---|---|
| **1** | `prod-api` → `app_runtime` | Toda petición trae tenant. Es donde el RLS **sirve** (datos de usuario) y donde un fallo **se ve en segundos**. |
| **2** | Observar 48 h | Los caminos raros (reportes, export, deep-links) salen solos. |
| **3** | `prod-worker` → `app_runtime` | Sólo después de arreglar los crons que lo necesiten. |
| — | `KNEX_NEW_DB_ADMIN` | **Se queda como `postgres`, siempre.** Es el que refresca matvistas. |

⛔ **No hay entorno de pruebas**: `.245` se declaró muerto por decisión (2026-09-12). Así que el
paso 1 es un **canario en producción**, y por eso tiene que ser reversible en segundos.

## 6. El procedimiento del paso 1

**Antes** (todo verde, si no, no se corta):

```sh
node database/tests/test-newdb-rls-app-runtime.js     # 4 ✔ · 0 ✖
node database/tests/test-newdb-rd-rentabilidad.js     # 38 ✔ · 0 ✖
```

**El cambio** — sólo el `Secret` de la API, no el del worker:

```sh
ssh superoot@192.168.0.222
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
k3s kubectl -n prod get secret <el-de-api> -o yaml > /root/secret-api.backup.yaml   # ⛔ el rollback
# editar DATABASE_URL_NEW para que use app_runtime
k3s kubectl -n prod rollout restart deployment/api
k3s kubectl -n prod rollout status deployment/api --timeout=120s
```

**La verificación**, en este orden (si alguna falla, rollback sin pensarlo):

1. `curl -s http://192.168.0.222:30080/api/health` → responde.
2. **Login real** y que el JWT traiga permisos — es el camino que más toca `identity`.
3. Una pantalla con datos por tenant: `/comercial/comisiones` tiene que traer **las mismas
   filas** que antes. ⛔ **Cero filas es el modo de falla a vigilar, y no da error**: se ve como
   una pantalla vacía, no como un 500.
4. Esperar un ciclo de cron y mirar `analytics.cron_runs`: ningún carril en `error`.

**El rollback**, si algo de lo anterior falla:

```sh
k3s kubectl -n prod apply -f /root/secret-api.backup.yaml
k3s kubectl -n prod rollout restart deployment/api
```

## 7. Lo que queda abierto

- ⚠️ **Hace falta la contraseña de `app_runtime`** para el `Secret`. No está en este repo ni debe
  estarlo.
- La fila de `finance.findings` que no es del tenant.
- Los crons, antes del paso 3. Hoy **no se sabe cuáles** lo necesitan: se sabrá cuando el paso 1
  lleve 48 h y se pueda repetir el ejercicio sobre el worker.

Ver [[reference_prod_corre_como_postgres_rls_inerte]] en la memoria del equipo.
