# Runbook — desplegar a producción, y qué hacer cuando sale mal

> `md` · `192.168.0.222` · `ssh superoot@192.168.0.222`
> Escrito el 2026-09-24, el día que un commit sin arrancar llegó a producción por este camino.
> Cada regla de acá tiene un incidente detrás; ninguna es precaución teórica.

---

## 0. El resumen de una línea

**El commit no sale solo: alguien lo suelta.** Un merge a `main` lo compila el CI y lo sella en
`ci-green`, pero prod no se mueve hasta que alguien corre `soltar.sh`. Entre ese momento y la
gente hay cuatro compuertas. Tu trabajo es que el commit las pase, y después soltarlo.

```
ssh superoot@192.168.0.222 'ops/prod/soltar.sh'
```

---

## 0.1 Soltar a producción

**Desde el 2026-10-07 el despliegue es manual.** Antes el vigía miraba `ci-green` y **cada merge
salía solo**: medido, **14 despliegues en un día**, cada uno reiniciando los pods y cortando las
conexiones en vivo. Ahora mira `prod-release`, que mueve una persona.

```
ci-green      ¿el CI lo aprobó?       ← lo mueve el job `sellar`, automático
prod-release  ¿lo queremos afuera?    ← lo mueve `soltar.sh`, a mano
```

⭐ **`ci-green` no cambió de significado.** Sigue siendo el sello que `compuerta-ci.sh` exige, y
como esa compuerta acepta **ancestros**, `prod-release` puede ir detrás sin frenar nada.

| Comando | Qué hace |
|---|---|
| `ops/prod/soltar.sh` | muestra qué sale + **avisa de migraciones pendientes** + suelta |
| `ops/prod/soltar.sh --ver` | sólo muestra, no suelta |
| `ops/prod/soltar.sh --volver <sha>` | regresa prod a un commit anterior (lo rechaza si el CI nunca lo selló) |

El vigía lo levanta en **≤30 s**.

⚠️ **El aviso de migraciones es lo que más gana con esto.** Las migraciones **no** las aplica el
despliegue (§3), así que si el código que sale necesita esquema que prod no tiene, la compuerta
2 FRENA y el vigía reintenta cada 120 s hasta que alguien las aplique. El 2026-10-07 eso pasó
**dos veces en veinte minutos** y las dos se supo leyendo el log, tarde. `soltar.sh` las lista
**antes**. Y juntar varios merges junta también sus migraciones: soltá seguido.

### Volver al modo automático

Borrar `~/ops/prod/vigia.env` en `md` y reiniciar el vigía (`pkill -f vigia-ci-green.sh`; systemd
lo levanta en ~30 s). El guion cae a `ci-green` por omisión.

⛔ **`/home/superoot/ops` NO es un repo git** — estos guiones se copian a mano. Cambiar la copia
del repo **no cambia lo que corre**.

⛔ **La configuración vive en `vigia.env`, no en la unidad de systemd**, porque `/etc/systemd/`
exige `sudo` y `sudo` sobre SSH no autenticado pide terminal (medido el 2026-10-07).

---

## 1. El camino normal

```
tu commit → origin/main → CI sella ci-green → soltar.sh → auto-deploy → 4 compuertas → prod
```

| # | Compuerta | Dónde vive | Qué frena |
|---|---|---|---|
| 1 | **arranque** | `npm run check` → `scripts/check-boot.js` | que el proceso no levante (**local, antes del push**) |
| 2 | **migraciones** | `auto-deploy.sh` | código que espera columnas que prod no tiene |
| 3 | **commit servido** | `auto-deploy.sh` | que se haya levantado otra versión de la que se pidió |
| 4 | **humo del login** | `auto-deploy.sh` | «la versión correcta está sirviendo» ≠ «funciona» |

Y si la 3 o la 4 fallan: **reversión automática** + **cuarentena** del commit.

### Antes de pushear

```sh
npm run check        # incluye `boot`: ~4 s, y es la que hoy no existía
```

⛔ **`nx build` verde no significa nada sobre el arranque.** El grafo de inyección de Nest se
resuelve al levantar el proceso. El 2026-09-24 pasaron `build`, `typecheck`, `lint` y 159 pruebas
de `libs/finance`, y el API moría en el boot.

---

## 2. Mirar qué está pasando

```sh
ssh superoot@192.168.0.222 'sh ~/ops/prod/auto-deploy.sh --estado'
ssh superoot@192.168.0.222 'tail -n 40 ~/ops/prod/auto-deploy.log'
curl -s https://megadulcessuite.com/api/health
```

⭐ **El veredicto que vale es el latido**, no el log: Salud BD → `job_key = 'auto_deploy'`.
Un log que no crece puede ser «no hay nada que subir» o «nadie lo corre», y esas dos se ven
idénticas. El latido las distingue.

---

## 3. ⛔ «El despliegue está FRENADO por migraciones»

> ⛔⛔ **ESTE PROCEDIMIENTO ESTÁ RANCIO: prod ya NO corre en Docker Compose.** Se mudó a
> **k3s** el 2026-10-02, y los contenedores `prod-api` / `pg-prod` / `prod-caddy` que se citan
> abajo están `Exited` desde entonces — son **residuo**. Un `docker exec prod-api` hoy falla.
>
> ⚠️ **Y engaña en la dirección peligrosa:** el reflejo de mirar `docker ps` hace creer que
> **producción está caída** cuando está sirviendo. El 2026-10-08 estuve a un paso de reportarlo
> al revés; lo que lo desmiente es `curl` al dominio, no el listado de contenedores.
>
> ⛔ **Y en la otra dirección también:** esta página decía que hay **un solo** `prod-api`. Hoy el
> deployment es **`api 2/2`**. Leí esa línea como si fuera una medición y diseñé un
> emparejamiento de sockets para un único proceso — roto la mitad de las veces en prod
> (`[CG.68]` → `[CG.68b]`). **Leer dónde dice un documento que corre algo no es medir dónde
> corre.**
>
> ⭐ **El camino VIGENTE está en la cabecera de**
> [`apply-one-migration-prod.js`](../../database/scripts/apply-one-migration-prod.js): `kubectl cp`
> + `kubectl exec` sobre un pod de `api`, con el pre-vuelo por `pg_stat_activity` **desde el pod
> de Postgres** (⛔ no por `knex_migrations_lock`, que ya mintió). Usado el 2026-10-08 — batch 822.

No es una falla del carril: **es el carril funcionando.** `origin/main` trae migraciones que prod
no tiene aplicadas, y subir ese código reventaría en la cara de quien abra la pantalla.

### ⭐ El camino vigente: `aplicar-migracion.sh`

```sh
sh ops/prod/aplicar-migracion.sh --pendientes          # qué falta, y qué sobra
sh ops/prod/aplicar-migracion.sh <archivo>.js          # una por una, en orden
```

Hace tres cosas que el camino manual de abajo no hacía:

1. ⛔ **Se niega si el archivo no está en `origin/main`**, y te dice dónde vive (este árbol, un
   commit sin empujar, o el worktree de otra sesión).
2. **Destraba el ledger solo**: copia al pod las migraciones que la tabla ya nombra y a la imagen
   le faltan — el baile que había que hacer a mano, tres veces en un día.
3. **Verifica la copia por BYTES**, no por código de salida: una copia truncada produce un archivo
   que existe, pasa cualquier `test -f`, y revienta recién al ejecutarse.

> ⛔ **Por qué existe la compuerta.** El 2026-10-08 se aplicaron **ocho** migraciones a producción
> desde commits que nunca se empujaron. Cada una deja `knex_migrations` nombrando un archivo que la
> imagen no tiene, y `knex.migrate.list()` aborta con *«the migration directory is corrupt»* — o
> sea que **frena la siguiente migración de cualquiera**, no sólo la de quien la aplicó. Una de las
> ocho hubo que rastrearla hasta `/c/tmp` porque el archivo no existía en ningún otro lado.
>
> ⚠️ La comprobación **no puede vivir en el aplicador**: ése corre dentro del pod, donde no hay
> git. Por eso es un envoltorio y no un parche.

<details><summary>El camino manual (sigue sirviendo si el envoltorio no está a mano)</summary>

```sh
# 1. Copiar la migración y el aplicador al contenedor de prod, que ya tiene la URL buena
scp database/migrations-newdb/<archivo>.js superoot@192.168.0.222:/tmp/
scp database/scripts/apply-one-migration-prod.js superoot@192.168.0.222:/tmp/
ssh superoot@192.168.0.222 'docker cp /tmp/<archivo>.js prod-api:/app/database/migrations-newdb/ \
  && docker cp /tmp/apply-one-migration-prod.js prod-api:/app/database/scripts/ \
  && docker exec prod-api node /app/database/scripts/apply-one-migration-prod.js --list'

# 2. Una por una, en orden
ssh superoot@192.168.0.222 'docker exec prod-api node /app/database/scripts/apply-one-migration-prod.js <archivo>.js'
```

⚠️ Hoy prod corre en **k3s**, así que `docker exec prod-api` hay que leerlo como
`kubectl -n prod exec deploy/api -c api --`.

</details>

⛔ **Nunca `migrate:latest`.** Hay **dos** `knex_migrations` en prod y el `search_path` lleva a la
vacía: reaplicaría ~800 migraciones.

⛔ **Nunca `apply-one-migration-prod.js` desde tu máquina sin `PROD_DB_URL`.** El `FLEET_DB_URL`
del `.env` **sigue apuntando a Railway**, que ya no es producción. El script tiene un candado de
identidad de clúster y se niega — pero el candado frena el daño, no la causa.

⚠️ **«migration directory is corrupt»**: a la imagen del contenedor le faltan migraciones que la
tabla ya registra, porque otras sesiones aplicaron archivos sin pushear. El error las nombra una
por una; se las copiás y listo. Ya están aplicadas — knex sólo necesita verlas.

⚠️ **Índices sobre tablas grandes van `CONCURRENTLY`** y el aplicador pone `statement_timeout=0`
a propósito: cortar un `CREATE INDEX CONCURRENTLY` a mitad deja el índice **inválido**, que el
planificador ignora — o sea lento y en silencio.

---

## 4. ⛔ «Revirtió» — el commit no arranca o el login no contesta

El carril ya dejó prod en la versión anterior y puso el commit **en cuarentena**: no lo va a
reintentar. Eso es a propósito, y se aprendió caro — el 2026-09-24 la primera versión reintentó
17 segundos después, con caché, y tiró prod una segunda vez.

**Qué hacer:**

1. **Confirmá que prod sirve**, no que arrancó:
   ```sh
   ssh superoot@192.168.0.222 'curl -s http://127.0.0.1:8080/api/health; \
     curl -s -o /dev/null -w "login %{http_code}\n" -X POST http://127.0.0.1:8080/api/auth-mt/login \
     -H "Content-Type: application/json" -d "{\"username\":\"zz\",\"password\":\"zz\"}"'
   ```
   `401` es lo correcto. Un `500` es el incidente del 2026-09-23 otra vez.

2. **Leé por qué murió** — el log del carril ya trae las líneas de error si fue bucle de reinicio.

3. **Reproducilo sin tocar prod.** Esto es lo que convierte «no sé» en «sé»:
   ```sh
   ssh superoot@192.168.0.222 'docker inspect prod-api -f "{{range .Config.Env}}{{println .}}{{end}}" \
     | grep -v "^$" > /tmp/diag.env && chmod 600 /tmp/diag.env
   docker run -d --name api-diag --network prod_default --env-file /tmp/diag.env -e PORT=3999 \
     trade-prod-api:<commit>
   sleep 45 && docker ps -a --filter name=api-diag --format "{{.Status}}" \
     && docker logs api-diag 2>&1 | tail -20
   docker rm -f api-diag; rm -f /tmp/diag.env'
   ```
   `Exited (1)` = el proceso muere al arrancar. `Up 45 seconds` = arranca, el problema es otro.

4. **Arreglá, verificá con `npm run check` (que ahora incluye `boot`), y pusheá.** La cuarentena
   se levanta sola cuando `origin/main` avanza a otro commit.

⚠️ **No uses `--forzar` para «ver si ahora sí».** Es para cuando sabés qué cambió, no para
reintentar a ciegas.

---

## 5. 🔥 Prod caído — el orden importa

**Primero levantarlo, después entender.** El diagnóstico se puede hacer con prod arriba; al revés
no.

```sh
# 1. PARAR el carril, para que no pelee con vos
ssh superoot@192.168.0.222 'crontab -l | sed "s|^\*/5 \* \* \* \* flock|#PAUSADO &|" | crontab -; \
  pkill -f auto-deploy.sh; pkill -f "docker build -q -f Dockerfile"'

# 2. Volver a la última imagen buena de CADA servicio (pueden ser commits distintos)
ssh superoot@192.168.0.222 'docker images | grep trade-prod-api | head -5; \
  docker images | grep trade-prod-worker | head -5'
ssh superoot@192.168.0.222 'docker tag trade-prod-api:<bueno> trade-prod-api:latest; \
  docker tag trade-prod-worker:<bueno> trade-prod-worker:latest; \
  cd ~/ops/prod && set -a && . ~/secrets/prod-compose.env && set +a && \
  docker compose -p prod up -d --force-recreate api worker'

# 3. Verificar que SIRVE (health + login + por el túnel)
```

⛔ **`api` y `worker` NO comparten commit.** El worker no se reconstruye en cada despliegue: el
2026-09-24 el API estaba en `a2052fa1` y el worker en `022a2604`, de 18 h antes. Revertirlos al
mismo tag deja uno de los dos roto — y fue exactamente el bug que alargó ese incidente.

**Despausar el carril sólo cuando `origin/main` tenga el arreglo:**
```sh
ssh superoot@192.168.0.222 'crontab -l | sed "s|^#PAUSADO ||" | crontab -'
```

---

## 6. Lo que este runbook NO cubre, y se declara

- **El CI de GitHub sigue apagado** (`disabled_manually`, última corrida 2026-08-25) y la
  protección de `main` **no exige ningún check**. O sea que la compuerta de arranque **sólo corre
  si alguien escribe `npm run check`**. Mientras eso siga así, `main` puede volver a quedar sin
  arrancar — la compuerta existe, pero nada la obliga.
- **`FLEET_DB_URL` sigue apuntando a Railway** en el `.env` del repo. Hay candado, no cura.
- **No hay alerta que salga del edificio**: `SMTP_*` sin configurar, así que el latido en rojo
  sólo lo ve quien abra Salud BD.
- **La caché de construcción crece sola** (65 GB medidos el 2026-09-24, 55 reclamables) y el
  carril construye en cada cambio. `docker builder prune` cuando apriete el disco.
