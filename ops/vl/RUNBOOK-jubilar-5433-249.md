# Jubilar el `:5433` de `.249`

## ⛔ Lo primero: hay DOS cosas llamadas 5433

| | |
|---|---|
| **`md:5433`** (`192.168.0.222`) | **LA FUENTE VIVA.** Las 8 réplicas lógicas que alimentan todo el pipeline. Jubilarlo es apagar la ingesta. **NO SE TOCA.** |
| **`.249:5433`** (`SISTEMAS`) | La copia vieja. **Ésta es la que se jubila.** |

El contenedor se llama `pgvector-md` **en las dos máquinas**. Antes de correr cualquier cosa de
este documento, confirmá dónde estás parado:

```sh
docker exec pgvector-md psql -U postgres -tAc \
  "SELECT count(*) FILTER (WHERE subenabled) FROM pg_subscription"
```

**`0` = estás en `.249`** (todas apagadas, es la que se jubila). **`8` = estás en `md`. PARÁ.**

---

## Qué hay adentro, medido el 2026-09-12

| base | tamaño | estado |
|---|---|---|
| `wincaja` | **40 GB** | **lo único vivo.** Lo escriben 3 apps de PM2 |
| `kepler_md_00` … `_07` | **10.5 GB** | congeladas desde el corte de VL.2b (11-sep) |
| `kepler_consolidado` | 496 MB | sin actividad |

Delta medido en 150 s sobre las 11 bases: **cero transacciones**, salvo Wincaja cuando le toca.

---

## ⚠️ El "rollback" ya no es un rollback — está medido

VL.2c dejó las 8 suscripciones en `DISABLE` (no `DROP`) para poder volver a `.249` si el corte
salía mal. **Esa ventana se cerró sola**, tal como el plan advirtió ("volver deja hueco en cuanto
el nuevo confirma LSNs"). Medido comparando `pg_replication_origin_status` en las dos máquinas:

| origen | `.249` se quedó en | `md` va en | lo que `.249` NUNCA vio |
|---|---|---|---|
| pg_487702 | 9/1A361470 | 9/3DFE5C08 | **573 MB** |
| pg_404779 | 11/BC037F58 | 11/D50EBEB0 | **401 MB** |
| pg_468875 | 2/64375978 | 2/7C0C00A0 | **381 MB** |
| pg_508783 | C/8FF8CFE8 | C/9C1D0E30 | **194 MB** |
| pg_582362 | C/DCB7E7D8 | C/E57BDBE8 | **140 MB** |
| pg_442245 | 3/B5976FB0 | 3/BC193DA0 | **104 MB** |
| pg_542361 | 3/9B55CC98 | 3/A08A8160 | **83 MB** |
| | | **total** | **≈ 1.83 GB, y creciendo** |

Re-apuntar `.249` a los slots hoy lo haría retomar desde la posición **actual** del slot: ese
1.83 GB no se aplicaría nunca y quedaría un hueco permanente. Los `kepler_md_*` de `.249` son una
**foto fría del 11-sep**, no un standby. Llamarlos "rollback" es el error de etiqueta que hay que
sacar del vocabulario antes de que alguien tome una decisión apoyándose en él.

---

## ✅ Paso 0 — YA HECHO (2026-09-12): desactivar el explosivo

Las 8 suscripciones apagadas **seguían agarradas al `slot_name` del publicador** — el mismo slot
que `md` usa ahora mismo. Con eso puesto, un `DROP SUBSCRIPTION` en `.249` **no es local**: va al
publicador y le borra el slot, **cortándole la fuente al servidor vivo**. Es la única manera de
convertir una limpieza en una caída de producción.

Ya se corrió, en las 8:

```sql
ALTER SUBSCRIPTION <sub> SET (slot_name = NONE);   -- exige la suscripción DESHABILITADA
```

Verificado después: `.249` con las 8 en `slot = (ninguno)`, y `md` con las 8 activas recibiendo a
0.0–0.3 min. Es **reversible** (`SET (slot_name = '<sub>')`), y a partir de ahora un `DROP` en
`.249` sólo toca a `.249`.

---

## Precondiciones que faltan

1. ⛔ **Wincaja fuera.** Es el 80 % de la base y lo único vivo. Sistemas informó el 2026-09-12 que
   **deja de existir en ~1 semana**. Hasta entonces, `.249:5433` no se apaga.
   → Y con eso **VL.5 queda CANCELADA**: no se porta Jet 32-bit a Linux para un sistema con siete
   días de vida.
2. **Decidir qué pasa con la historia de Wincaja.** Los 40 GB son la única copia de esa era. El
   sell-out tiene un corte explícito *Kepler ≥ / Wincaja <*: esa serie **no se reconstruye desde
   Kepler**, porque esas sucursales nunca estuvieron ahí. Si el volumen se borra con la máquina,
   se pierde. Hay que congelarla a propósito **antes** del corte.
3. **El respaldo en `md`** (VL.6.3). Es precondición del apagón, no un pendiente.

---

## Los pasos, cuando toque

### 1. Preflight — que nadie esté usando la base

```sh
docker exec pgvector-md psql -U postgres -d postgres -c "
  SELECT datname, usename, COALESCE(host(client_addr),'(local)') origen, count(*)
    FROM pg_stat_activity WHERE datname IS NOT NULL AND pid <> pg_backend_pid()
   GROUP BY 1,2,3;"
```

⚠️ **Una foto instantánea NO alcanza** y ya nos engañó: los carriles corren cada 2–60 min, así que
salir vacío prueba poco. La medida buena es el **delta acumulado**:

```sh
docker exec pgvector-md psql -U postgres -d postgres -c "
  CREATE TEMP TABLE s1 AS SELECT datname, xact_commit FROM pg_stat_database;
  SELECT pg_sleep(150);
  SELECT d.datname, d.xact_commit - s.xact_commit AS transacciones
    FROM pg_stat_database d JOIN s1 s USING (datname)
   WHERE d.datname IS NOT NULL ORDER BY 2 DESC;"
```

### 2. Apagar los productores de `.249`

```sh
pm2 stop wincaja-inc wincaja-hash wincaja-live-tickets
Disable-ScheduledTask -TaskName WincajaLive,WincajaSyncActual,WincajaSyncConcentrada
```

`pm2 stop` y `Disable`, **no** `delete` ni `Unregister`: el rollback de *esto* sí existe.

### 3. Respaldo final de `wincaja` — fuera de `.249`

Es la única copia de la era Wincaja. Sacarla de la máquina que se va a apagar, no dejarla adentro.

### 4. Recién ahí, soltar

```sh
docker stop pgvector-md && docker rm pgvector-md
docker volume ls          # identificar el volumen ANTES de borrarlo
```

⛔ **El `docker volume rm` es irreversible y se pide por separado.** Un contenedor parado no borra
nada; el volumen sigue ahí y se puede volver a montar. Separar los dos pasos es lo que deja una
salida.

### 5. Después del volumen, y no antes

`PM2 Resurrect ODS` y `\Kepler\FeedGuardian` se pueden deshabilitar **cuando ya no quede nada que
resucitar**. Hoy `PM2 Resurrect ODS` es lo que revive los carriles de Wincaja tras un reinicio:
apagarlo antes los mata en el próximo boot.

---

## Cómo se sabe que salió bien

El veredicto **no** es que el contenedor esté parado. Es que la ingesta siga entregando:

```sh
ssh superoot@192.168.0.222 'set -a; . ~/secrets/ingest.env; set +a;
  psql "$ODS_HB_URL" -c "SELECT job_key, status, host,
    round(extract(epoch from (now()-last_finish))/60.0,1) AS hace_min
    FROM analytics.cron_runs ORDER BY last_finish DESC NULLS LAST LIMIT 20;"'
```

Y las 8 suscripciones de `md` recibiendo, que es lo que el Paso 0 protege:

```sh
ssh superoot@192.168.0.222 'docker exec pgvector-md psql -U postgres -tAc \
  "SELECT count(*) FILTER (WHERE subenabled) FROM pg_subscription"'   # debe decir 8
```
