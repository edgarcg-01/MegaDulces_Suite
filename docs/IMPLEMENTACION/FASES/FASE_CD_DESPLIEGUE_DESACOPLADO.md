# Fase CD — Despliegue desacoplado de migraciones, y un CI que se pueda leer

> **Estado:** 🧪 EN CÓDIGO (2026-10-02). Medido contra el repo y contra las corridas reales de
> GitHub Actions. Falta: redeploy de `auto-deploy.sh`/`compuerta-migraciones.sh` a `md` y una
> corrida de CI que confirme en vivo los tiempos.

---

## 0. Lo que el pedido daba por sentado, y lo que midió distinto

El pedido decía: *«el CI/CD es excesivamente lento»* y *«aborta los despliegues si detecta
migraciones pendientes»*. La segunda mitad es cierta. La primera no sobrevivió a la medición, y
el problema real resultó ser otro.

**Desglose del job `build`, corrida 37033825652 (2026-10-02):**

| Paso | Tiempo |
|---|---|
| Checkout (`fetch-depth: 0`) | 11 s |
| Setup Node 20 | 11 s |
| **`npm ci`** | **70 s** |
| Derivar SHAs (`nx-set-shas`) | 4 s |
| **`nx affected -t build`** | **10 s** |

**El build tarda 10 segundos.** `nx affected` y el caché remoto de Nx ya estaban bien hechos y ya
funcionaban; el 65 % del job se iba instalando dependencias. Optimizar "la compilación" habría
sido trabajar sobre el 9 % del tiempo.

**Lo que sí estaba roto: las 15 corridas más recientes del CI, en rojo. Las 15.**

Y la causa no era deuda del que empujaba. Medido sobre el commit `1d3c504dc`, que toca **un**
archivo:

```
el commit toca : apps/view/.../compras-pedido-real.component.ts
el CI falló por: comercial-inventory-variance.component.ts
                 mkt-resultado.component.ts
                 compras-costo-estandar.component.ts
                 guide-cost-panel.component.ts
                 sucursal-picker.component.ts
```

Cinco archivos, **ninguno** el que el commit tocó. `check:tables` y `check:tokens` barren
`apps/view/src`, `apps/vendor/src` y `apps/portal/src` enteros, así que cualquier deuda vieja en
cualquier pantalla pone roja la corrida de cualquiera.

Eso es lo que estaba bloqueando los hotfixes: no la lentitud, sino que **el tablero dejó de
significar algo**. Es la misma forma que el repo ya había diagnosticado y resuelto para `lint`
(ratchet `scripts/lint-changed.js`, comentado en `ci.yml`) y que nunca se aplicó a las
compuertas de diseño.

> ⚠️ `ci-green` **sí se estaba moviendo** (está en el HEAD de `main`, 0 commits atrás): el job
> `sellar` depende de `build`+`secret-scan` y no de `verify`, tal como declara el `CLAUDE.md`. O
> sea que la compuerta de despliegue no estaba trabada por esto. Lo que estaba trabado era la
> señal.

---

## 1. [CD.1] Migraciones — el freno se afina, NO se quita

### El error que esta fase estuvo a punto de cometer

La primera versión de este trabajo clasificaba cada migración pendiente en **destructiva** vs
**aditiva**, para dejar pasar las aditivas. Está mal de raíz, y conviene dejarlo escrito para que
nadie lo reconstruya.

El riesgo que guarda `auto-deploy.sh` **no** es que la migración rompa al código viejo. Es el
inverso: que el código **nuevo** necesite un esquema que todavía no existe. Visto así, un
`ADD COLUMN` —lo más "aditivo" que hay— es justo el caso peligroso, porque el código nuevo *lee*
esa columna. La cabecera de `auto-deploy.sh` ya lo decía con todas las letras:

> *«sube código que espera columnas inexistentes y revienta en la cara de quien abra la pantalla,
> no en el build»*

**Medido, 2026-10-02**, sobre los últimos 14 commits que tocan `database/migrations-newdb/`:
**8 traen además código de `apps/` o `libs/` en el MISMO commit.** La migración y el código que
la necesita viajan juntos. **Frenar por defecto es correcto.**

### Lo que sí se desacopla

Lo que se afloja es el caso en que la migración pendiente y el código a desplegar **no se tocan**:
un hotfix de frontend no tiene por qué esperar a que alguien aplique una matvista de compras que
ese hotfix ni nombra. Eso es medible.

`ops/prod/compuerta-migraciones.sh`:

1. De cada migración pendiente extrae los **objetos** que crea o altera (tablas, columnas, vistas).
2. Del diff `<commit vivo>..<commit objetivo>` lee los archivos de `apps/` y `libs/` que cambian.
3. Si **ninguno** nombra **ninguno** de esos identificadores → `DESACOPLADO`: el código nuevo no
   puede necesitar lo que no nombra. Se despliega.
4. Si alguno lo nombra → `FRENA`, diciendo **qué archivo** y **qué identificador**.
5. Si no se pudo extraer o no se pudo leer el diff → `NO_MEDIDO` → **frena** (ADR-056).

**El sesgo está puesto del lado seguro a propósito:** un falso positivo frena (cuesta una espera),
un falso negativo despliega código roto (cuesta producción).

### Verificado contra casos reales del repo

| Caso | Esperado | Resultado |
|---|---|---|
| `6cb07c327` — 4 migraciones + 5 archivos de código (Mesa de Servicio) | FRENA | ✅ FRENA: `task.contract.ts` usa `requests` y `request_messages`, que crea `20261002110000_servicedesk_requests.js` |
| Hotfix `1d3c504dc` (1 archivo de compras) + migración ajena de `servicedesk` pendiente | DESPLIEGA | ✅ `DESACOPLADO` |

Prueba negativa del clasificador: **6/6** (`--self-test`).

### Lo que NO ve, dicho en voz alta

- Un identificador armado por concatenación (`from('tab' + suf)`) no se detecta.
- Una migración que sólo hace `GRANT` no crea objeto: si el código nuevo depende del permiso,
  esto no lo ve. **Por eso esas caen en `NO_MEDIDO` y frenan.**
- Mira los archivos **cambiados**, no el repo entero: el código viejo que ya usaba el objeto ya
  estaba desplegado y funcionando, así que no es el riesgo de *este* despliegue.

### ⚠️ Consideraciones de compatibilidad que esto te impone

Esta compuerta **no** te exime de la disciplina expand/contract; la hace cumplible:

1. **La migración va PRIMERO, el código después.** El orden correcto sigue siendo: aplicar la
   migración (expand, aditiva) → desplegar el código que la usa. Esta compuerta sólo evita que un
   cambio ajeno quede rehén de ese orden.
2. **Una migración que estrecha (DROP COLUMN, RENAME, SET NOT NULL) necesita DOS despliegues.**
   Primero el código que deja de usar la columna; después, cuando no queda nadie usándola, el
   DROP. Si los juntás, el código viejo que todavía corre durante el rollout revienta.
3. **Nunca renombres: agregá y deprecá.** Un `renameColumn` rompe a los dos lados a la vez.
4. **`GRANT` no se detecta como dependencia.** Si tu código nuevo necesita un permiso nuevo,
   aplicá la migración antes — la compuerta te va a frenar con `NO_MEDIDO`, y en ese caso el
   freno es correcto.
5. **`VIVO=desconocido` frena.** Si Docker no reporta la etiqueta del commit horneado, no hay
   diff que medir, y medir nada no es medir cero.

---

## 2. [CD.2] Las compuertas de diseño cortan por lo que el cambio tocó

`scripts/lib/alcance-diff.js` — primitivo compartido (ADR-056: el mecanismo vive en un solo
lugar, no copiado en cada script). Enchufado con una línea en `check-css-tokens.js` y en
`check-dense-tables.js`.

- **Acota** al diff `NX_BASE..NX_HEAD` (en CI lo pone `nx-set-shas`; fuera de CI, el `merge-base`
  con `@{upstream}`).
- **Siempre declara su alcance**, porque un verde acotado y un verde de barrido completo no
  significan lo mismo: `alcance: 13 de 692 archivo(s)`.
- **No esconde la deuda**: el barrido completo sigue disponible con `--todo`, y los bloques de
  deuda declarada (`PENDIENTE_DISENO`, `DEUDA_COLUMNAS`) se siguen imprimiendo.
- Si **no hay base** o **no se pudo leer el diff** → **no acota** (barrido completo). Acotar sin
  poder medir el diff dejaría pasar todo.

### Prueba decisiva, sobre el commit que falló

```
ANTES  (barrido completo)     exit=1   ROJO
DESPUÉS (acotado a su diff)   exit=0   VERDE   — alcance: 1 de 692 archivo(s)
```

Pruebas negativas de las dos compuertas, intactas: **11/11** y **17/17**.

---

## 3. [CD.3] El tiempo: se ataca el `npm ci`, no el build

Caché de `node_modules` **armado**, con clave exacta por hash de `package-lock.json`, en los dos
jobs (`build` y `verify`) y con la **misma clave** a propósito: corren en paralelo sobre el mismo
lock, así que el segundo come de lo que guardó el primero.

⛔ **Sin `restore-keys`, a propósito.** Un `node_modules` restaurado desde un lock *parecido* es
peor que no tener caché: instala una versión que nadie pidió y el fallo aparece lejos, en runtime.
Si el lock cambió, se paga el `npm ci` y listo.

El `if: steps.cache-nm.outputs.cache-hit != 'true'` es lo que convierte el caché en tiempo
ahorrado — sin él se cachea y se instala igual.

---

## 4. [CD.4] El rojo se puede leer

Paso `Resumen semántico de la falla`, sólo `if: failure()`. Escribe en el resumen de la corrida
**qué compuerta cortó, qué significa y cómo reproducirla local**, sin abrir el log.

⛔ **No es `continue-on-error`**: el job sigue en rojo. Lo único que cambia es que el rojo se
puede leer. Una compuerta que falla sin explicarse se termina ignorando (ADR-056).

---

## 5. Por qué el pipeline nuevo es más rápido — 3 puntos

1. **Deja de pagar `npm ci` dos veces por corrida.** Era el 65 % del job `build` (70 s de 108 s) y
   se pagaba también entero en `verify`. Con el caché de `node_modules` por hash de lock, una
   corrida cuyo lock no cambió —la mayoría— se saltea el paso en los dos jobs. El build en sí ya
   estaba resuelto: 10 s con `nx affected` + caché remoto.

2. **Deja de reventar por deuda ajena, así que deja de reintentarse.** 15 de 15 corridas en rojo
   por archivos que el commit no tocó; cada rojo es un ciclo de ~4 min más el tiempo humano de ir
   a mirar un log de miles de líneas para descubrir que no era tuyo. Acotar las compuertas de
   diseño al diff convierte ese ciclo en cero.

3. **Deja de serializar el despliegue detrás de una migración que no le importa.** Antes
   *cualquier* migración pendiente frenaba *cualquier* despliegue; ahora sólo frenan las que el
   código de ese despliegue realmente nombra. Medido: un hotfix de frontend con una migración de
   `servicedesk` pendiente pasa de **bloqueado** a **desplegable**, sin aflojar el freno en el
   caso acoplado —que se verificó que sigue frenando, con nombre y apellido del archivo.

---

## 6. Pendiente

- [ ] Subir `compuerta-migraciones.sh` a `md` (`ops/prod/deploy.sh --verificar` lo sincroniza; `--imagenes` NO sincroniza guiones).
      **Hasta que esté, `auto-deploy.sh` frena con `falta compuerta-migraciones.sh`** — a
      propósito: no se despliega a ciegas.
- [ ] Una corrida de CI real que confirme el ahorro del caché de `node_modules` (estimado ~60 s
      × 2 jobs; **no medido en vivo todavía**).
- [ ] Decidir si `check:teclado` y `check:busqueda` —que no se auditaron acá— tienen el mismo
      barrido repo-wide y merecen el mismo tratamiento.

---

## 7. [CD.5] Lo que el despliegue real a `md` enseñó (2026-10-02)

Tres defectos que **sólo aparecieron al desplegar de verdad**. Ninguno los habría encontrado un
build verde ni una prueba local.

### 7.1 ⛔ La compuerta estaba en Node, y en `md` NO HAY node

Medido en el host: ni en el `PATH`, ni en `/usr/local/bin`, ni nvm, ni snap. Sólo `awk`. La app
corre en pods de k3s, pero depender de un pod para una compuerta de despliegue es **circular**:
es pedirle permiso para desplegar a la cosa que se está desplegando.

Y el modo de falla era feo: `node` ausente devuelve **127**, y el llamador leía ese no-cero como
"hay acoplamiento" — la feature muerta, pero con cara de estar funcionando.

⭐ **La señal estaba puesta y no la leí**: `clasificar-migraciones.awk` ya era awk por este mismo
motivo. Reescrita en POSIX sh (`compuerta-migraciones.sh`); la versión `.js` se retiró, porque
dos implementaciones de lo mismo divergen.

### 7.2 ⛔ `grep -i` + `-f` devuelve CERO en silencio (GNU grep 3.0 / MSYS)

| combinación | resultado sobre un archivo real de 14 KB |
|---|---|
| `grep -o -f` | 6 coincidencias ✅ |
| `grep -i -o` (patrón literal) | 2 ✅ |
| `grep -i -F` | **aborta**, exit 134 (ruidoso, se ve) |
| **`grep -i -f`** | **0, exit limpio, sin una línea de error** |

El segundo es el peligroso: cero coincidencias se lee como `DESACOPLADO`, o sea que el modo de
falla era **desplegar código que necesita esquema inexistente** — justo lo que la compuerta
existe para impedir.

⭐ **Y la prueba negativa no lo atrapó, porque corría sobre 40 bytes.** El defecto aparece con
volumen. Ahora el self-test ejerce el cruce sobre un archivo de 51 KB: *una prueba negativa que
no se parece al caso real puede ponerse verde sobre un gate roto.*

Solución: no depender de `-i`. Se normaliza a minúsculas con `tr` antes de comparar.

### 7.3 ⛔ Falsos positivos que devolvían el freno indiscriminado

Contra el despliegue real de prod (`6cb07c3..11562e4`, 34 archivos), la compuerta marcaba
archivos sin relación. Dos causas distintas, las dos medidas:

1. **Subcadena**: el objeto `requests` matcheaba dentro de `analytics.expense_requests`.
2. **Palabra genérica en prosa**: `settings` dentro de un **comentario**.

El verdadero positivo, en cambio, aparece **calificado**: `'servicedesk.requests'`. Esa era la
señal buena que se estaba tirando al quedarse con el último segmento del nombre.

Arreglo: conservar el nombre **calificado** y cruzar con **límite de palabra** (``). Como `_`
cuenta como carácter de palabra, `requests` no matchea dentro de `expense_requests`.

**Resultado medido:** el despliegue real de 34 archivos pasó de `FRENA` (falso) a
`DESACOPLADO`, y el caso realmente acoplado sigue frenando con nombre y apellido
(`servicedesk.requests`, `servicedesk.request_messages`).

### 7.4 `--imagenes` NO sincroniza guiones

La documentación de esta fase decía que `deploy.sh --imagenes` subía la compuerta. Es falso:
`--imagenes` hace `verificar_limpio; enviar; construir` (construye imágenes). Los flags que
llaman a `subir_compose` son `--recrear`, `--verificar`, `--pitr` y `--tunel`. **El liviano es
`--verificar`**, que además corre la verificación de prod. Corregido también en el mensaje de
error de `auto-deploy.sh` (donde el mismo texto equivocado ya existía para
`clasificar-migraciones.awk`).

Y `compuerta-migraciones.sh` **no estaba en `_guiones`**, así que `subir_compose` habría
sincronizado el `auto-deploy.sh` que la invoca sin el archivo que la provee. Regla nueva
escrita ahí: *si un guion de esa lista llama a otro archivo, ese archivo va en la lista.*

### 7.5 Estado verificado en `md`

- `compuerta-migraciones.sh` sincronizada · prueba negativa **10/10 corriendo en `md`**
- `deploy.sh --verificar` → prod **sin fallas** (1 punto NO MEDIDO, declarado)
- Caso real `6cb07c3..11562e4` con migración ajena pendiente → `DESACOPLADO` ✅
- Caso acoplado → `FRENA` nombrando archivo y objeto ✅
- Prod al día: **0 migraciones pendientes** hoy, así que la compuerta no está frenando a nadie

### 7.6 Colisión de timestamps, resuelta

`20261001160000` lo compartían dos migraciones. Verificado contra prod **antes** de tocar nada:
`price_signal_h1_margen_por_canal.js` **está aplicada** (congelada, no se toca) y
`obligaciones_gestionar_tres.js` **no**. Se renombró esta última a `20261001160100`. La
compuerta pasa a 1015 migraciones sin colisiones.

---

## 8. [CD.10] Node en `md` sin instalar Node en `md`

`[CD.5]` dejó la compuerta en POSIX sh porque el host no tiene Node, pero la fricción de fondo
seguía: `~/auto-deploy/repo` tiene el clon fresco de `origin/main` y para correr cualquier
herramienta de `database/scripts/*.js` contra ese clon había que entrar a un pod — que tiene una
versión **ya construida y distinta** del código.

### Por qué NO se instaló por `apt`

Medido el 2026-10-02 en `md` (Ubuntu 26.04.1):

| | |
|---|---|
| `apt` ofrece | Node **22.22.1** |
| el pod de prod corre | Node **20.20.2** |
| `sudo` | **pide contraseña** (no automatizable) |

Instalar por apt abriría deriva de versiones justo en las herramientas que tocan la base de
prod. Y ADR-060 ya dice que el sustrato es Docker declarado en el repo; el Dockerfile razona lo
mismo para la glibc (*el runtime viaja CON la imagen*). Un paquete en el host es lo contrario.

### Lo que se hizo

`ops/prod/node.sh` corre Node **desde la imagen de la propia app**, con el repo del host montado:

```sh
sh ~/ops/prod/node.sh database/scripts/<lo-que-sea>.js
```

- **Paridad exacta** con producción (v20.20.2, verificado), y si la app sube a 22 esto sube sola.
- Sin sudo, sin paquete nuevo, sin nada que mantener al día a mano.
- `--network host`, así que alcanza la base igual que el host.

**Verificado en `md`:** versión `v20.20.2` · ejecuta código del repo montado (`package.json`, 65
scripts) · alcanza `pg-prod :5434`.

⚠️ El contenedor ve **sólo** el directorio montado, y escribe como `root` en él. Para lectura y
para `database/scripts/` alcanza; si algo escribe en el repo, revisar el owner después.

> **Node en el host queda OPCIONAL.** Si se quisiera igual, el comando que respeta la major es
> NodeSource (`setup_20.x`), **no** `apt install nodejs`.

