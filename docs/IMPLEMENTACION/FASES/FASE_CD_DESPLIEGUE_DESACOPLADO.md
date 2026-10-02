# Fase CD — Despliegue desacoplado de migraciones, y un CI que se pueda leer

> **Estado:** 🧪 EN CÓDIGO (2026-10-02). Medido contra el repo y contra las corridas reales de
> GitHub Actions. Falta: redeploy de `auto-deploy.sh`/`compuerta-migraciones.js` a `md` y una
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

`ops/prod/compuerta-migraciones.js`:

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

- [ ] Subir `compuerta-migraciones.js` a `md` (`ops/prod/deploy.sh --imagenes` lo sincroniza).
      **Hasta que esté, `auto-deploy.sh` frena con `falta compuerta-migraciones.js`** — a
      propósito: no se despliega a ciegas.
- [ ] Una corrida de CI real que confirme el ahorro del caché de `node_modules` (estimado ~60 s
      × 2 jobs; **no medido en vivo todavía**).
- [ ] Decidir si `check:teclado` y `check:busqueda` —que no se auditaron acá— tienen el mismo
      barrido repo-wide y merecen el mismo tratamiento.
