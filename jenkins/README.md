# Jenkins on-prem — orquestación de feeds + build/deploy

Reemplaza el **Windows Task Scheduler** (feeds) y saca el **build fuera de Railway**
(deploy lento + consumo). Corre en **`.249` (SISTEMAS)** — el box que hoy ya ejecuta
los feeds (tareas `Catalog`/`Nightly`/`Stock`), tiene Docker + `pgvector-md` (5433) +
el stack de pruebas + Watchtower, y alcanza `.245`. **NO va en `.245`** (ése es el box
de consolidación Kepler; se deja intacto).

> **Nota de arquitectura:** para 1 dev Jenkins es pesado. Los **feeds** SÍ necesitan un
> runner on-prem (acceso LAN a las DBs que un runner cloud no tiene) → justifican
> Jenkins acá. El **build** podría ir en el GitHub Actions que ya existe
> (`.github/workflows/ci.yml`, hoy solo gate). Se hace en Jenkins por decisión de Edgar.

---

## JK.0 — Levantar Jenkins (en .249)

```bash
docker compose -f jenkins/docker-compose.yml up -d
docker exec trade-jenkins cat /var/jenkins_home/secrets/initialAdminPassword
```

Abrí `http://localhost:8080`, instalá plugins sugeridos + **Docker Pipeline**.

**Red:** nada de `network_mode: host` (no existe en Docker Desktop). Los pipelines
alcanzan las DBs por **IP LAN** (`192.168.0.249:5433`, `192.168.0.245:5432`) — tus
Postgres escuchan en `0.0.0.0`, así que la IP LAN los ve desde cualquier contenedor.

**Seguridad:** Jenkins monta el socket de Docker → control del host. **Solo LAN/VPN**,
nunca abierto a internet (cuando montés Cloudflare Tunnel, detrás de Access).

---

## JK.1 — Pipeline de feeds

1. **Credenciales** (Manage Jenkins → Credentials → *Secret text*):

   | ID | Valor | Usado en |
   |---|---|---|
   | `DATABASE_URL_NEW` | proxy Railway prod | todos los modos |
   | `DATABASE_URL_KEPLER_CONSOLIDADO` | `postgresql://…@192.168.0.249:5433/kepler_consolidado` | todos |
   | `MEGA_DULCES_URL` | `postgresql://…@192.168.0.245:5432/Mega_Dulces` | solo `catalog` |

   ⚠️ IPs LAN (`192.168.0.249` = este host / `192.168.0.245` = Kepler), NO `localhost`.

2. **Un job por modo** (New Item → Pipeline → *Pipeline script from SCM* →
   `jenkins/Jenkinsfile.feeds`) con trigger cron, 1:1 contra el Task Scheduler:

   | Job | Cron | MODE | APPLY | Reemplaza tarea |
   |---|---|---|---|---|
   | `feeds-live` | `H/15 * * * *` | live | true | (live 15-30 min) |
   | `feeds-stock` | `H/30 * * * *` | stock | true | Stock |
   | `feeds-nightly` | `H 4 * * *` | nightly | true | Nightly |
   | `feeds-catalog` | `H 3 * * 1` | catalog | true | Catalog |

3. **Primer run = dry-run** (`APPLY=false`): valida checkout/deps/conexión sin escribir.
   Recién con verde ponés `APPLY=true`.

4. **Apagá las tareas de Windows** (`Catalog`/`Nightly`/`Stock`) recién con los jobs
   equivalentes verdes (evita doble escritura).

---

## JK.2 + JK.3 — Build local → Docker Hub → Railway baja la imagen

[`Jenkinsfile.deploy`](Jenkinsfile.deploy) compila el [`Dockerfile`](../Dockerfile) raíz
(combinado nginx+api, el que usa Railway) en `.249`, pushea a **Docker Hub
`edgarcg01/trade-marketing`**, y Railway solo **baja** la imagen. Watchtower actualiza
el stack de pruebas de `.249` de yapa.

### Setup (una vez)
1. Credenciales Jenkins:
   | ID | Tipo | Valor |
   |---|---|---|
   | `DOCKERHUB_CREDS` | Username+Password | user Docker Hub (`edgarcg01`) + Access Token |
   | `RAILWAY_TOKEN` | Secret text | Project/Service token de Railway |
2. Railway (dashboard, una vez): Service prod → Settings → **Source → "Docker Image"**
   → `docker.io/edgarcg01/trade-marketing:latest`. El **`preDeployCommand` (`migrate.sh`)
   se conserva** — las migraciones siguen aplicándose en el deploy.

### Flujo
- Job `deploy` (Pipeline from SCM → `jenkins/Jenkinsfile.deploy`). Tags `:<git-sha>` + `:latest`.
- **Primer run `PUSH=false`** → valida que compila local (build en frío ~min; luego cache buildx).
- `PUSH=true DEPLOY=true` → compila, pushea (Watchtower prueba en `.249`), `railway redeploy` a prod.

### Egress
El push local→Docker Hub sube ~300-500 MB por build (tu internet, una vez). Railway baja
de Docker Hub (no es tu egress de Railway). El build deja de correr en Railway = deploy rápido.

> **El fix de raíz al egress de feeds** (filas escritas a Railway) es mover la DB de prod
> a la LAN — proyecto Coolify on-prem, aparte de esto.

## JK.4 — Binario de importers (opcional, baja prioridad)
`bun build --compile` da portabilidad, **no** reduce egress (lo causan las filas a Railway).
