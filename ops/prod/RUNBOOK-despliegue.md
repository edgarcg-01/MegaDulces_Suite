# Runbook — desplegar a producción, y qué hacer cuando sale mal

> `md` · `192.168.0.222` · `ssh superoot@192.168.0.222`
> Escrito el 2026-09-24, el día que un commit sin arrancar llegó a producción por este camino.
> Cada regla de acá tiene un incidente detrás; ninguna es precaución teórica.

---

## 0. El resumen de una línea

**Nadie despliega a mano.** `origin/main` se despliega solo cada 5 minutos, y hay cuatro
compuertas entre un commit y la gente. Tu trabajo es que el commit pase las compuertas, no
empujarlo.

---

## 1. El camino normal

```
tu commit → origin/main → auto-deploy (cada 5 min) → 4 compuertas → prod
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

No es una falla del carril: **es el carril funcionando.** `origin/main` trae migraciones que prod
no tiene aplicadas, y subir ese código reventaría en la cara de quien abra la pantalla.

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
