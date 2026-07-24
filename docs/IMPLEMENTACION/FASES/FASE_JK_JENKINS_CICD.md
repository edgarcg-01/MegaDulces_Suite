# Fase JK — Jenkins on-prem: orquestación de feeds + build/deploy fuera de Railway

> **Estado:** 🔨 EN CÓDIGO (scaffold JK.0–JK.3) 2026-07-24 · sin correr en runtime aún.
> **Objetivo:** sacar dos cargas del hosting de prod — (1) los feeds del Windows Task
> Scheduler mudo, (2) el build de Angular que hoy corre EN Railway (deploy lento +
> consumo de recursos) — hacia un orquestador on-prem con RAM de sobra.

---

## Contexto / dolor

Dos síntomas reportados por Edgar: **consumo alto de red** y **deploys lentos**.

Diagnóstico sobre el código:
- **Feeds** ([`run-prod-feeds.js`](../../../database/importers/kepler/run-prod-feeds.js)): un runner on-prem
  disparado por **Windows Task Scheduler** corre importers Node que leen de Kepler
  local (`localhost:5433`) + `.245` y **escriben a Railway prod** (`DATABASE_URL_NEW`).
  Ese push a Railway es el egress. Cuando falla, Task Scheduler **no captura logs**
  (el feed `bviteb92z` falló con output vacío → imposible diagnosticar).
- **Deploy**: el [`Dockerfile`](../../../Dockerfile) multi-stage se **compila EN Railway**
  (Angular heap 4 GB + API). Eso es el deploy lento + el consumo de build.

## Decisión (ADR-034, propuesto)

**Orquestar en Jenkins on-prem; Railway sigue siendo el hosting, deja de compilar.**
- Jenkins corre en el box que ya alcanza Kepler local + `.245` + el proxy de Railway.
- Los feeds migran de Task Scheduler a jobs de Jenkins (logs, historial, reintento, alerta).
- El build del Docker image se hace **local** y se pushea a **GHCR**; Railway apunta su
  servicio a esa imagen (source = Docker Image) y solo la **baja**.

**Nota honesta:** para un solo dev, Jenkins es más pesado que un self-hosted GitHub
Actions runner (ya existe [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)).
Se mantiene Jenkins por decisión explícita de Edgar. El equivalente liviano queda
documentado como alternativa si el mantenimiento pesa.

**Corrección técnica registrada:** "comprimir importers en binario" **no reduce el
egress** (lo causan las filas que viajan a Railway, no el arranque de Node). El fix
de raíz al egress de feeds es mover la DB de prod a la LAN (proyecto Coolify on-prem,
aparte). El binario solo da portabilidad → JK.4, baja prioridad.

---

## Sprints

| Item | Estado | Descripción |
|---|---|---|
| **JK.0** | 🔨 | Jenkins LTS en Docker on-prem ([`jenkins/docker-compose.yml`](../../../jenkins/docker-compose.yml)), portable Linux/Windows, socket Docker montado para builds, TZ MX. |
| **JK.1** | 🔨 | Pipeline feeds ([`jenkins/Jenkinsfile.feeds`](../../../jenkins/Jenkinsfile.feeds)): parametrizado por modo (`live/stock/nightly/finance/catalog/logistics/all`) + `APPLY` (dry-run default), corre el orquestador, captura+archiva log por corrida. Mapa 1:1 vs Task Scheduler en el README. |
| **JK.2** | 🔨 | Build local → push GHCR ([`jenkins/Jenkinsfile.deploy`](../../../jenkins/Jenkinsfile.deploy), stage Build&Push): `docker buildx --platform linux/amd64`, tags `:<git-sha>`+`:latest`. |
| **JK.3** | 🔨 | Deploy: Railway service source = Docker Image (paso dashboard, una vez) + stage que dispara `railway redeploy`. El `preDeployCommand` (`migrate.sh`) se conserva. |
| **JK.4** | ⬜ | *(opcional, baja prioridad)* binario de importers con `bun build --compile` para portabilidad. NO ataca el egress. |
| **JK.1.1** | ⬜ | Alerta en fallo de feed (hoy solo `echo`): enganchar WS `AlertsService` / correo / webhook. |

## Pendientes operacionales (no-código)

1. `docker compose -f jenkins/docker-compose.yml up -d` **en el box on-prem** (no en la
   máquina de desarrollo — necesita el acceso de red a los feeds).
2. Credenciales en Jenkins (3 URLs de DB con IP LAN `192.168.0.245`, no `localhost`;
   `GHCR_CREDS`, `RAILWAY_TOKEN`).
3. GHCR: PAT `write:packages`+`read:packages`; reemplazar `CHANGEME` por el owner en
   `Jenkinsfile.deploy`.
4. Railway dashboard: Service → Source → Docker Image → `ghcr.io/<owner>/trade-marketing:latest`.
5. **Orden de rollout de menor riesgo:** feeds dry-run (`APPLY=false`) → deploy sin push
   (`PUSH=false`) → feeds `APPLY=true` → deploy `PUSH=true`. Apagar las tareas de Windows
   recién con los jobs equivalentes verdes (evitar doble escritura).

## Relación con el proyecto VPS/Coolify on-prem

Fase separada (en análisis): mover prod de Railway a un box on-prem con Coolify +
Cloudflare Tunnel para bajar costo y hospedar múltiples proyectos. JK.2/JK.3 (build
local → registry) es compatible: si se migra a Coolify, el mismo image sirve; solo
cambia quién lo baja. El fix de raíz al egress de feeds vive en ESE proyecto (DB de
prod en la LAN).

Guía operativa completa en [`jenkins/README.md`](../../../jenkins/README.md).
