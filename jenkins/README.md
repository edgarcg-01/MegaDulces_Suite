# Jenkins on-prem — orquestación de feeds + build/deploy

Reemplaza el **Windows Task Scheduler** (feeds) y saca el **build fuera de Railway**
(deploy lento + egress). Corre en el box on-prem que ya alcanza Kepler local, el
`.245` y el proxy de Railway.

> **Nota de arquitectura:** Jenkins funciona, pero es pesado para un solo dev. El
> equivalente liviano sería un self-hosted GitHub Actions runner (ya existe
> `.github/workflows/ci.yml`). Se mantiene Jenkins por decisión explícita.

---

## JK.0 — Levantar Jenkins

```bash
docker compose -f jenkins/docker-compose.yml up -d
# password inicial:
docker exec trade-jenkins cat /var/jenkins_home/secrets/initialAdminPassword
```

Abrí `http://localhost:8080`, instalá los plugins sugeridos + **Docker Pipeline**.

**Dónde correrlo:** el mismo box que hoy dispara los feeds. En **Linux** (ideal,
ej. `.245`) `network_mode: host` deja que los agents alcancen `localhost:5433` y la
LAN sin NAT. En **Windows/Docker Desktop**: quitá `network_mode: host` del compose,
descomentá los `ports:`, y en las credenciales usá `host.docker.internal` en vez
de `localhost`.

### Seguridad (obligatorio)
Jenkins monta el socket de Docker → puede construir imágenes y correr contenedores.
Eso es control total del host. **Nunca** lo expongas directo a internet:
- Detrás de **Cloudflare Access** (Zero Trust, login con tu correo) cuando montemos el túnel, o
- Solo accesible por LAN / VPN mientras tanto.

---

## JK.1 — Pipeline de feeds

1. **Credenciales** (Manage Jenkins → Credentials → System → Global → Add, tipo *Secret text*):

   | ID | Valor | Usado en |
   |---|---|---|
   | `DATABASE_URL_NEW` | proxy Railway prod | todos los modos |
   | `DATABASE_URL_KEPLER_CONSOLIDADO` | `postgresql://…@192.168.0.245:5433/kepler_consolidado` | todos |
   | `MEGA_DULCES_URL` | `postgresql://…@192.168.0.245:5432/Mega_Dulces` | solo `catalog` |

   ⚠️ Usá la **IP LAN `192.168.0.245`**, NO `localhost` — el pipeline corre en un
   contenedor y `localhost` sería el contenedor, no el host.

2. **Un job por modo** (New Item → Pipeline → *Pipeline script from SCM* →
   `jenkins/Jenkinsfile.feeds`), con trigger cron. Mapa 1:1 contra el Task Scheduler actual:

   | Job | Cron Jenkins | MODE | APPLY | Reemplaza |
   |---|---|---|---|---|
   | `feeds-live` | `H/15 * * * *` | live | true | tarea "live 15-30 min" |
   | `feeds-stock` | `H/30 * * * *` | stock | true | tarea "stock 30 min" |
   | `feeds-nightly` | `H 4 * * *` | nightly | true | tarea nightly 04:00 |
   | `feeds-catalog` | `H 3 * * 1` | catalog | true | tarea catálogo semanal |

3. **Primer run = dry-run.** Dejá `APPLY=false` la primera vez: valida checkout,
   deps, conexión y secuencia **sin escribir a prod**. Recién con el dry-run verde
   ponés `APPLY=true` en los triggers.

4. **Apagá las tareas de Windows** recién cuando los jobs equivalentes estén verdes
   en Jenkins (evita doble escritura).

---

## JK.2 + JK.3 — Build local → GHCR → Railway baja la imagen

El [`Dockerfile`](../Dockerfile) hoy se compila **en Railway** (deploy lento + build
consume recursos de Railway). [`Jenkinsfile.deploy`](Jenkinsfile.deploy) lo compila
**local** (RAM sobra), pushea a **GHCR**, y Railway solo **baja** la imagen. Railway
sigue siendo el hosting; deja de compilar.

### Setup (una vez)

1. **Credenciales en Jenkins:**
   | ID | Tipo | Valor |
   |---|---|---|
   | `GHCR_CREDS` | Username+Password | user GitHub + PAT con `write:packages` |
   | `RAILWAY_TOKEN` | Secret text | Project/Service token de Railway |

2. **GitHub PAT:** scope `write:packages` (push desde Jenkins) + `read:packages`
   (para que Railway baje si el paquete es privado).

3. **Railway (dashboard, una vez):** Service → Settings → **Source → "Docker Image"**
   → `ghcr.io/<OWNER>/trade-marketing:latest` + registry credentials (user + PAT
   `read:packages`) si es privado. El **`preDeployCommand` (`migrate.sh`) se conserva** —
   corre igual con image source, así que las migraciones siguen aplicándose en el deploy.

4. En `Jenkinsfile.deploy` reemplazá `CHANGEME` en el param `IMAGE` por tu owner de GitHub.

### Flujo

- Job `deploy` (Pipeline from SCM → `jenkins/Jenkinsfile.deploy`).
- Tags: `:<git-sha>` + `:latest`. Railway apunta a `:latest`.
- **Primer run con `PUSH=false`** para validar que el Dockerfile compila local
  (build en frío ~varios min; luego el cache local de buildx acelera).
- Con el build verde: `PUSH=true DEPLOY=true` → compila, pushea, y dispara
  `railway redeploy`.

### Egress / red
El push local→GHCR sube ~300-500 MB por build (tu internet, una vez). Railway baja
GHCR→Railway (no es tu egress de Railway). El build deja de correr en Railway =
deploy en segundos.

> **El fix de raíz al egress** (feeds escribiendo a prod) es mover la DB de prod a
> la LAN — eso es el proyecto Coolify on-prem, aparte de esto.

## JK.4 — Binario de importers (opcional, baja prioridad)

Compilar los importers con `bun build --compile` da portabilidad, **no** reduce el
egress (eso lo resuelve mover prod a la LAN). Solo si se quiere correr sin `node_modules`.

## JK.4 — Binario de importers (opcional, baja prioridad)

Compilar los importers con `bun build --compile` da portabilidad, **no** reduce el
egress (eso lo resuelve mover prod a la LAN). Solo si se quiere correr sin `node_modules`.
