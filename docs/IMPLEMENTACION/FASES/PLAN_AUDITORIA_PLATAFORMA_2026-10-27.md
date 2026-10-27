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

## 8. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-27 | Auditoría general en sólo lectura (base, importers, contenedores) y este plan. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.3 corregido:** el importer NO pisaba el CEDIS. El guard lo frenaba desde el corte del 30-sep (`cutover_done`), y la auditoría lo dio por activo sin leer el guard. Igual se retiró (`6d17c81ef`): corría 2× por ciclo y revivía si alguien vaciaba `kepler_code`. Wincaja Irapuato queda sólo para históricos (PM). | Sesión Claude |
| 2026-10-27 | **OPS-AUD.6 (parte código):** fuera 10 importers sin referencias y el módulo `mega-dulces-sync` (`5b7dccfd4`). Se quedan `import-bank-statement` (lo usa un test) y `checadores/*` (corte de relojes de RH). Arranque no verificado en local: lo valida el CI. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.5 (desde el código):** ~341 archivos van por `TenantKnexService` (rol `app_runtime`, RLS filtra). **45 archivos del dominio `trade`** (supervisor-ai ×21, reports, users, auth, scope, ability…) inyectan `KNEX_CONNECTION` = `DATABASE_URL`, que según el manifiesto leído por la auditoría es `postgres` → **se saltan RLS**. 11 usan `KNEX_NEW_DB_ADMIN` (`postgres`), todos crons o mantenimiento. ⚠️ El rol real de `DATABASE_URL` en el pod NO se midió (lectura de prod denegada en esta sesión). | Sesión Claude |
| 2026-10-27 | **OPS-AUD.10 (`cash_cuts`):** fuera `import-cash-cuts` del runner (`8430bab74`); dueño único el `@Cron` de 10 min sobre `kepler_ods`. Paridad fila a fila NO medida. **`sales_by_route_monthly` (4 escritores) queda pendiente**: el `GREATEST` entre escritores parece intencional y hay que medirlo antes de tocarlo. Además: la pantalla `almacen-cuadre` dice «¿Corriste import-cash-cuts?» cuando no hay cortes — texto que ya miente. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.8 era un falso hallazgo:** `podar-disco.sh` no toca la caché a propósito mientras haya > 60 GB libres (`[CD.22]`: vaciarla cuesta ~10 min por despliegue); hoy hay 93. La baja de 125 → 81 GB libres en dos días NO es la caché: queda por medir (candidatos: `pgbackrest` y volcados). **OPS-AUD.2:** advertencia en `ops/README.md` §2.1 (`557380ec7`). **DOCS-AUD.2 era otro falso hallazgo:** la auditoría miró PM2 en la máquina de trabajo y §3.1 habla de `.249`. **DOCS-AUD.1:** aviso de rancio con cifras remedidas en `ARQUITECTURA_DATOS.md`. | Sesión Claude |
| 2026-10-27 | **OPS-AUD.4 BLOQUEADO:** la lectura de `pg-prod` por `kubectl exec … psql` la deniega el clasificador de permisos de Claude Code (a los agentes y a la sesión). Hace falta una regla de permiso o que alguien corra la consulta de `pg_stat_statements` a mano. | Sesión Claude |
