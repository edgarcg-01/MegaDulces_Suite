# `ops/k3s` — la ingesta hacia K3s

> **Decisión del usuario (2026-10-01): todo debe vivir en K3s/K8s.** Este directorio es el
> camino, y existe porque esa decisión cambió la respuesta al punto 3 de `ADR-080`.

## Por qué esto, y no un proxy del socket

El punto 3 era **sacar `/var/run/docker.sock` de `ods-autoheal`** — una imagen de terceros con un
socket que **equivale a root en el host** (montarlo `:ro` no cambia nada: un socket de sólo lectura
sigue aceptando llamadas a la API).

La solución obvia en el mundo Compose es un proxy acotado a `containers:read` + `post:restart`.
Se **descarta**, y no por gusto: con K3s como destino es trabajo que se tira entero. En Kubernetes
**no hay brazo** — el que reinicia un contenedor que falla su `livenessProbe` es el kubelet. O sea:

> **`ods-autoheal` no se arregla. Desaparece.** Y con él, el socket.

⭐ Lo que **sí** sobrevive a la migración es `ops/ingest/health.js`: hoy es el `HEALTHCHECK` de
Docker y mañana es el `exec` de la `livenessProbe`, **sin cambiarle una línea**. Mide ENTREGA
contra `analytics.cron_runs`, no «el proceso vive» (ADR-053).

## ⛔ Las tres trampas, medidas en ESTE sistema

No son advertencias de blog. Cada una ya cobró acá, en Compose, y el default de Kubernetes la
reintroduce:

| default de K8s | qué provoca | la evidencia local |
|---|---|---|
| `Deployment.strategy` = **RollingUpdate** | con `replicas: 1`, `maxSurge 25%` redondea a 1 → levanta el pod nuevo **antes** de matar el viejo. Dos shippers se pisan `ods.ctl` (llavea sólo `table_name`) y **pierden filas sin un solo log** | es la falla que `[INFRA.4]` candadeó del lado de Compose, y la que costó seis días de precios viejos en la Fase OBS |
| `CronJob.concurrencyPolicy` = **Allow** | una corrida larga se solapa con la siguiente: dos reconciliadores propagando `DELETE` a la vez | el `--full` recorre `kdm2` con 1.8 M filas en la rama 03; no tiene techo garantizado |
| `Job.backoffLimit` = **6** | reintenta solo un trabajo que propaga `DELETE` — seis veces | `[OBS.12]`: ese mismo job quiso borrar **62,864 filas, el 99.8 % del kardex del CEDIS** |

Y una cuarta que no es un default sino una **tentación**: ponerle `livenessProbe` o
`activeDeadlineSeconds` a un Job. Ya costó **505 reinicios en 7 días** (300 en un día), porque la
sonda de entrega mataba al proceso que producía justo lo que la sonda exigía. Un Job termina o
falla; eso ya es la señal.

**Las cuatro las verifica `npm run check:k3s`**, con cinco pruebas negativas. No dependen de que
quien edite el YAML se acuerde.

## ⭐ El puente de nombres: por qué esto no toca ni una credencial

Medido dentro de `ods-live-hot` el 2026-10-01, los tres destinos se resuelven por **DNS de la red
de Docker**:

```
DATABASE_URL_NEW  ->  pg-prod:5432
ODS_HB_URL        ->  pg-prod:5432
ODS_SOURCE_BASE   ->  pg-ods:5432
```

El camino obvio sería reescribir el entorno a IPs. ⛔ Se rechaza por dos razones: el entorno vive
en `/home/superoot/secrets/ingest.env` y **tocar credenciales está BLOCKED** (`[A.0bis.1-3]`); y un
entorno distinto entre Compose y K3s significa **dos verdades conviviendo** sobre a dónde escribe
cada carril durante la migración — que es exactamente cómo `[VL.14]` terminó shipeando la Caja
General a la producción vieja sin que nadie lo notara.

En su lugar, `10-postgres-externo.yaml` declara un `Service` **sin selector** más sus `Endpoints`
a mano. El clúster publica el nombre `pg-prod` y lo apunta al host. **Misma imagen, mismo secreto,
misma URL.** El día que Postgres entre al clúster, se le pone selector a ese mismo Service y los
carriles siguen sin enterarse.

⚠️ Los dos Postgres **no se mudan ahora**: `pg-prod` usa 11.96 GiB y `pgvector-md` 4.35 GiB contra
**1.06 GiB de los otros 19 contenedores juntos**. Entran al final, si entran.

## Estado

`npm run check:k3s` → **19 ✔ · 0 ✖**, y declara su propia cobertura: **2 de 8 carriles** tienen
manifiesto. Faltan `ods-live-mirror`, `ods-reconcile`, `ods-reconcile-chicas`, `feeds-cron`,
`feeds-livefast`, `store-poller`. Eso **se imprime siempre**: una cobertura parcial que no se ve se
lee igual que una completa.

⛔ **Nada de esto está aplicado.** K3s **no está instalado** en `md` (verificado). Los manifiestos
son el diseño, no el estado.

## El orden que propongo, y por qué

1. **Instalar K3s en `md`** — cabe: 9.8 GB disponibles, 8 hilos, load 1.66; el server pide ~0.5–1 GB.
   Es aditivo: usa su propio containerd y no toca a `dockerd`.
2. **Piloto con UN carril, el menos crítico** (`ods-reconcile-chicas`). Se apaga en Compose y se
   levanta en K3s. El veredicto **no es que el pod diga `Running`**: es que su renglón de
   `analytics.cron_runs` siga latiendo fresco. Si no late, vuelve a Compose y no se perdió nada.
3. **El resto de los carriles continuos**, de a uno.
4. **Los agendados** (`feeds-cron` trae 9 carriles → 9 `CronJob`). Acá se gana algo concreto:
   `failedJobsHistoryLimit` conserva el pod fallido, así que **los logs de lo que falló
   sobreviven**. El 2026-10-01 perdí la evidencia del nocturno por recrear un contenedor.
5. **Borrar `ods-autoheal`** cuando el último carril que dependía de él se haya ido. **Ahí se cierra
   el punto 3**, sin haber escrito un proxy.
6. Prod (`prod-api`, `portal`, `vendor`, `worker`, `caddy`) — después, y con su propia decisión.

⚠️ `ods-autoheal` sigue cuidando los **9 contenedores de prod**, así que el socket no se va con el
paso 5: se va cuando prod también migre. Mientras tanto el agujero sigue abierto y **eso se
declara**, no se tacha de la lista.
