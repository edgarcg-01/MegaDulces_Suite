---
name: entrega
description: El carril de entrega de esta suite, de punta a punta — revisar y mergear PRs, bajar (pull) sobre el árbol compartido, empujar (push) y SOLTAR a producción. OBLIGATORIO antes de tocar `git pull`, `git push`, `gh pr merge`, `soltar.sh` o `aplicar-migracion.sh`, y antes de afirmar que algo "ya está en prod". Se invoca con PR, pull request, mergear, revisar PRs, bajar cambios, pull, empujar, push, soltar, deploy, desplegar, producción, prod, migración, ci-green, prod-release, vigía, "por qué no llega a prod", "cuántos commits faltan".
---

# El carril de entrega — de un commit a producción

> ⛔ **Esta skill existe porque el carril tiene cuatro compuertas y ninguna avisa de la
> siguiente.** Medido entre el 2026-10-21 y el 2026-10-24: producción se quedó **23 horas**
> sin actualizarse con dos tramos ya sellados esperando, y cada vez que alguien dijo "ya lo
> solté" la causa real estaba una compuerta más abajo.

## La cadena, y dónde se corta

```
commit → push (pre-push: 25 compuertas sobre el ÁRBOL)
       → CI (compuertas sobre el COMMIT)
       → sellar mueve ci-green      ← sólo si build + secret-scan pasan
       → soltar.sh mueve prod-release  ← lo mueve una PERSONA
       → el vigía despliega         ← sólo si NO hay migraciones pendientes
       → /api/health contesta el commit nuevo
```

⭐ **Cada flecha es un lugar donde el tramo se detiene en silencio.** Antes de decir "está en
prod", preguntá a `/api/health`, que es el único testigo que no depende de dónde escribió nadie.

```bash
curl -s http://192.168.0.222:30080/api/health   # {"status":"ok","commit":"…","uptime":…}
git ls-remote origin refs/heads/ci-green refs/heads/prod-release
```

---

## 1 · Revisar y mergear PRs

### ⛔⛔ La mergeabilidad que reporta GitHub es una CACHÉ, y miente

Medido el 2026-10-22 sobre #424, #425, #427, #439, #441 y #443: GitHub decía `CONFLICTING`
y `git` fusionaba **sin un solo conflicto**. La API lo confesó:

```
mergeable=false  state=dirty  base=04444f1c4     ← main ya iba en 072c50db2
```

Calcula contra una base vieja y no recalcula sola. **No le creas: medí vos.**

```bash
git fetch origin -f "refs/heads/<rama>:refs/remotes/br/<n>" --quiet
git merge-tree --write-tree br/<n> origin/main   # exit 0 y cero CONFLICT = fusiona limpio
```

Si `merge-tree` sale limpio y GitHub insiste, **empujá la fusión a la rama del PR** — eso la
obliga a recalcular y además deja al PR al día:

```bash
T=$(git merge-tree --write-tree br/<n> origin/main)
C=$(git commit-tree "$T" -p br/<n> -p origin/main -m "merge: traer main a <rama>")
git push origin "$C:refs/heads/<rama>"
```

### Qué compuertas deciden de verdad

Sólo dos son obligatorias: **`Build & typecheck`** y **`Secret scan`**. `sellar` depende de
esas dos y de ninguna más. `Lint & test`, `CGP-D.1` y `Pruebas contra Postgres real` pueden
estar rojas y el PR se mergea igual — **a propósito**, porque exigirlas con la deuda actual
dejaría a prod sin despliegues.

⚠️ Eso tiene un costo que conviene decir en voz alta: **`main` sale a producción con
compuertas rojas**. Si mergeás con una roja, nombrala; no la dejes pasar como si no existiera.

### ⭐ Un rojo de `main` contamina a todos los PRs

El 2026-10-23, `landing-guards.spec.ts` fallaba **1 de 4,068 pruebas** en `main`, y por eso
#450 y #451 aparecían rojos. **No era de ellos.** Antes de diagnosticar un PR, mirá si el
mismo rojo está en `main`: si está, el PR no tiene nada que arreglar y se destraba solo
cuando entre el arreglo.

### Antes de mergear, dos preguntas que ahorran un revert

- **¿Es duplicado?** #452 y #453 agregaban **la misma entrada al mismo archivo**, hechos en
  paralelo por dos personas. Mergear los dos duplica el renglón.
- **¿Está superado?** #429 movía el selector de ruta *junto al campo Caja*; #440 ya había
  **quitado ese campo** y estaba en producción. Mergearlo era un retroceso disfrazado de
  avance. Compará la intención contra lo que `main` ya tiene, no contra la fecha del PR.

### Merges y drafts

- Un **draft** es decisión de su autor. No se marca listo por cuenta propia.
- `--auto` sirve, pero **un PR de documentación pierde la carrera**: `main` se mueve más
  rápido que su CI y vuelve a chocar. Para esos, mergear a mano en cuanto pase.

---

## 2 · Bajar (pull) sobre un árbol que no es tuyo

⛔ **El checkout es compartido por ~8 sesiones.** Un `git merge` que pisa archivos vivos de
otra sesión destruye trabajo que nadie commiteó.

### El orden que funciona

```bash
git fetch origin --prune --quiet
# 1. medir el choque
git diff --name-only HEAD...origin/main | sort -u > /tmp/entran.txt
git status --porcelain | awk '{print $NF}' | sort -u > /tmp/sucio.txt
comm -12 /tmp/entran.txt /tmp/sucio.txt          # los que chocan
# 2. respaldar SIEMPRE antes de apartar
git diff HEAD -- <archivos> > "$SCRATCH/vivos.patch"
git stash push -m "vivos antes del pull" -- <archivos>
git merge origin/main --no-edit
git stash pop
```

⚠️ **El diff de tres puntos no ve lo que está en el ÍNDICE.** Medido el 2026-10-23: el primer
`comm` dio 4 archivos, el merge falló igualmente por otros 8 que estaban *staged*. Si el merge
aborta nombrando archivos que tu medición no tenía, apartá esos también y repetí — no es un
error tuyo, es que `HEAD...origin/main` mide otra cosa.

⚠️ **`git stash pop` puede fallar por archivos que ni siquiera pediste.** Un stash guarda el
estado del índice completo, así que al aplicarlo choca con lo que otra sesión tocó mientras
tanto. La salida es el respaldo:

```bash
git apply --3way --whitespace=nowarn "$SCRATCH/vivos.patch"
```

### Los conflictos que vas a ver, y cuál es el arreglo

| Lo que choca | Por qué | Qué hacer |
|---|---|---|
| El bloque `INDICE-AUTO` de un `.md` | lo generan los dos lados | **regenerarlo**, nunca fusionarlo a mano |
| `CHANGELOG.md`, tracker, log | `merge=union` conserva los dos lados | dejar que union resuelva |
| Numeración (ADR, GOTCHAS §, puntos de ONBOARDING) | los dos lados tomaron el mismo número | **renumerar el que entra**, no pisar |

Para regenerar un índice sin tocar el árbol, usá el generador del repo sobre una copia:

```js
const { generar, DOCS } = require('<repo>/scripts/docs-indices.js');
// cfg = DOCS.find(d => d.archivo === 'docs/GOTCHAS.md'); generar(texto, cfg)
```

⭐ **`merge=union` duplica las filas del índice.** Medido: `03_LOG_REVISIONES.md` tenía **499
filas para 252 secciones**. Regenerar no sólo resuelve el choque: repara eso.

⭐ **La numeración choca más de lo que parece** — cuatro veces en una semana (ADR-098,
GOTCHAS §85, ONBOARDING §8.0b, GOTCHAS §90). Antes de insertar, medí el máximo real:

```bash
grep -oE '^## [0-9]+\.' docs/GOTCHAS.md | tr -d '#. ' | sort -n | tail -1
```

---

## 3 · Empujar

### ⛔⛔ El `pre-push` lee el ÁRBOL; el CI lee el COMMIT

Las dos direcciones muerden:

- Un defecto que está **sólo en el commit** pasa el hook y revienta en el CI.
- Un defecto que está **sólo en el árbol** —hasta un archivo **sin versionar de otra
  sesión**— bloquea tu push aunque tu commit no lo toque.

Medido el 2026-10-22: `pedido-negociacion-panel.component.ts`, `??` en el árbol, frenaba el
push de **todas** las sesiones. ⛔ No se evade con `--no-verify` ni se mueve el archivo de
otro: **se le pregunta a quien lo está escribiendo** (`ListAgents` + `SendMessage`).

### Commitear sin pisar a nadie

```bash
git commit -- <rutas>     # pathspec SIEMPRE; nunca `git add -A`, nunca `--amend`
```

Si el archivo que tenés que tocar trae además trabajo vivo de otra sesión, armá el commit
**fuera del árbol** y empujá sólo lo tuyo:

```bash
git show HEAD:<ruta> > "$SCRATCH/f.ts"      # partir de HEAD, no del árbol
# …aplicar SÓLO tus cambios a esa copia…
BLOB=$(git hash-object -w "$SCRATCH/f.ts")
export GIT_INDEX_FILE="$SCRATCH/idx"; rm -f "$GIT_INDEX_FILE"
git read-tree origin/main
git update-index --cacheinfo 100644,"$BLOB",<ruta>
T=$(git write-tree); git diff --stat origin/main "$T"    # ⭐ verificá que sea SÓLO lo tuyo
C=$(git commit-tree "$T" -p origin/main -m "…")
git push origin "$C:refs/heads/main"
```

### Cuando una compuerta te frena

Hay tres respuestas, y **sólo dos son legítimas**:

1. **Arreglar el defecto.** Casi siempre es real y del lote.
2. **Arreglar la compuerta**, si mide mal — con **prueba negativa**: rompela a propósito y
   verificá el rojo antes de dar por bueno el arreglo.
3. ⛔ `--no-verify`. No.

⚠️ **Una compuerta puede estar mintiendo, y pasa seguido.** Casos medidos:

- `check-no-emoji-ui`: **103 de 165** hallazgos eran falsos (no seguía comentarios HTML
  multilínea).
- `check-cifra-recorrible`: marcaba `.movimientos(` de **cualquier** servicio porque otro
  servicio distinto declara ese método con `limit`. **24 de 34** pantallas selladas eran ese
  falso positivo.
- La misma compuerta no reconocía `«mostrando 30 de 990»` como declaración del tope, porque
  sólo buscaba el nombre `has_more` — y frenaba **el commit que arreglaba su propio caso**.

⭐ La señal de que una compuerta miente: **te pide algo imposible de cumplir** (mandar un
`limit` a un método que no lo acepta). Un rojo imposible enseña a usar `--no-verify`, que es
justo la puerta que esa familia de candados existe para cerrar.

### Antes de empujar un cambio de tipos, comprobalo

```bash
npx tsc --noEmit -p libs/<dominio>/tsconfig.json
```

Dos veces en esta semana un tipado "obvio" tiró el build y dejó `main` roja (`TS2345` por
`unknown` donde el consumidor exigía `string`; `TS2339` por un campo sin declarar). ⭐ **La
lección: declarar un contrato exige recorrer a QUIÉN le pasás cada campo, no sólo quién lo
lee.** No es `nx build` —eso está prohibido—, es un typecheck acotado que no emite nada.

---

## 4 · Soltar

### ⛔ SOLTAR NO ES DESPLEGAR

`soltar.sh` mueve `prod-release`: **es la orden, no la ejecución**. El vigía la cumple sólo
si pasa sus compuertas. Decir "ya lo solté" y que prod no cambie es lo normal, no lo raro.

### El orden obligatorio

```bash
# 1. ¿selló? -- si ci-green no se movió, NO hay nada que soltar
git ls-remote origin refs/heads/ci-green

# 2. migraciones pendientes: PRIMERO, una por una
sh ops/prod/aplicar-migracion.sh --pendientes
sh ops/prod/aplicar-migracion.sh <archivo.js>      # ⛔ nunca migrate:latest

# 3. recién ahora
sh ops/prod/soltar.sh
```

⛔ **Una sola migración pendiente congela el despliegue entero.** De un `CREATE INDEX` o un
`GRANT` la compuerta no puede extraer ningún objeto, así que declara `NO_MEDIDO` y **frena**
— no adivina. Eso costó las 23 horas. **Aplicá antes de soltar, siempre.**

### Revisar una migración antes de aplicarla

```bash
grep -ioE "MATERIALIZED VIEW|CREATE INDEX CONCURRENTLY|ADD COLUMN|NOT NULL|DELETE FROM|GRANT" <mig>
```

- **`NOT NULL` en tabla NUEVA** → sin riesgo. **En tabla existente** → recorrer *todos* los
  caminos que insertan ahí.
- **`DROP` de una vista o matvista** → los `GRANT` **no sobreviven**. Registrá la ACL antes y
  verificala después:
  ```sql
  SELECT relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='<esquema>' AND c.relname='<objeto>';
  ```
- **`CREATE MATERIALIZED VIEW … WITH DATA`** → si la fuente filtra por `current_tenant_id()`
  y la sesión no trae `app.tenant_id`, **nace con cero filas y sin error** (GOTCHAS §87.1).

### `CREATE INDEX CONCURRENTLY` — la trampa que costó un día

El aplicador fija **`lock_timeout` en 15 s**, a propósito, para que una migración no haga cola
delante del tráfico. Sobre una tabla con escritura continua eso es una carrera que no se gana:
falla, **y deja un índice `INVALID`** que el CDC mantiene en cada escritura sin que sirva para
leer.

⭐ Lo que hay que saber: **`CONCURRENTLY` no bloquea las escrituras** — su lock sólo choca con
DDL y autovacuum. Esperarlo es seguro. Lo que falla es el timeout, no la operación.

```bash
# 1. ¿hay una transacción vieja? CIC espera a TODAS las anteriores
ssh superoot@192.168.0.222 "sh ~/ops/prod/pgprod.sh -At -c \"SELECT pid, age(now(),xact_start), left(query,60) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND now()-xact_start > interval '30 seconds' ORDER BY xact_start\""
# 2. limpiar un INVALID anterior, si quedó
ssh superoot@192.168.0.222 "PGOPTIONS='-c lock_timeout=30000' sh ~/ops/prod/pgprod.sh -At -c 'DROP INDEX CONCURRENTLY IF EXISTS <esquema>.<ix>'"
# 3. crearlo con margen, FUERA del aplicador
ssh superoot@192.168.0.222 "PGOPTIONS='-c lock_timeout=900000 -c statement_timeout=0' sh ~/ops/prod/pgprod.sh -At -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS …'"
# 4. y recién entonces la migración, que lo encuentra hecho y registra el ledger
sh ops/prod/aplicar-migracion.sh <mig>
```

⚠️ Una consulta que filtra por el nombre del objeto **se cuenta a sí misma**. Excluí siempre
`pid <> pg_backend_pid()`; si no, vas a "medir" que algo sigue corriendo cuando es tu propio
`SELECT`.

### Verificar que llegó

```bash
curl -s http://192.168.0.222:30080/api/health
ssh superoot@192.168.0.222 'tail -8 ~/ops/prod/auto-deploy.log'
```

⛔ **El registro NO es el testigo.** Un despliegue corrido a mano escribe su salida en la
sesión de quien lo lanzó y **no deja un renglón**: el log puede terminar en `FALLO` mientras
producción ya sirve el commit nuevo. Quien lo lea después concluye lo contrario de lo que pasó.

⚠️ **El vigía no reintenta un `fetch` caído.** Trata "se cayó la red un segundo" igual que
"el build está roto": guarda el SHA y no vuelve a intentar. Un parpadeo dejó prod **1 h 50
min** sin el despliegue ya aprobado. Si el log dice `no reintento`, comprobá la causa —
`ls-remote` y la llave— y relanzá a mano.

---

## Lo que nunca cambia

- ⛔ **Nada de compilar ni levantar el backend en local.** Compila el CI; se verifica leyendo
  prod. Un `tsc --noEmit` acotado es la única excepción, y no emite nada.
- ⛔ **Nada de ramas ni worktrees.** Se trabaja sobre `main` en el checkout compartido.
- ⛔ **Nada de Python.** Un `python - <<EOF` mal formado no falla: espera `stdin` para siempre.
- ⛔ **`git commit -- <rutas>`**, nunca `git add -A`, nunca `--amend`.
- ⭐ **Lo que no se pudo medir se DECLARA** — nunca se dibuja como cero ni como verde.
- ⭐ **Un gate sin prueba negativa es una intención.**

## Cómo se reporta

Decí **qué se midió y con qué**, no sólo el resultado. «Prod sirve `abc1234`, uptime 49 s»
vale; «ya está desplegado» no, porque no dice quién lo vio.

Y si una medición tuya resultó mal, corregila explícitamente en el mismo mensaje en que la
reemplazás. En este carril, una afirmación vieja que nadie retiró manda a la siguiente
persona a buscar el defecto donde no está.
