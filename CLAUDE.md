# Contexto del proyecto Trade Marketing (auto-cargado por Claude Code)

> Este archivo se lee en cada sesión nueva. Mantenerlo **breve, actualizado, accionable**. Si necesitás detalles, los `.md` están en `docs/IMPLEMENTACION/`.

---

## ⛔ Las 20 reglas, en una pantalla

> Esto es el **resumen escaneable**. Cada regla tiene abajo su evidencia medida — no las
> borres ni las "simplifiques": la cifra es lo que impide que alguien las racionalice.
> Si una regla y un relato se contradicen, **gana la fecha más nueva** y hay que corregir acá.

**Nunca, sin autorización explícita:**
1. **Crear un importer.** Todo dato sale del ODS (`kepler_ods.*`), de UNA tabla principal, por VISTA. Si no se puede derivar: **parar y decirlo**.
2. **Copiar una tabla** (`*_bak`, "la misma en otro schema", 2ª materialización). Derivá o extendé la que existe.
3. **Compilar o levantar el backend en local** (`nx serve`, `nx build`, `node dist/...`). Compila **el CI**; se verifica **leyendo prod**.
4. **Invocar Python.** Node/TS/JS, SQL y PowerShell/Bash. Un `python - <<EOF` mal formado **no falla: espera stdin para siempre**.
5. **Borrar tablas, columnas o migraciones aplicadas** en prod.
6. **Hacer push o abrir PR.**
7. **Tocar CORS o credenciales.**
8. **Crear ramas o worktrees.** Se trabaja sobre `main`, en el checkout compartido, **commiteando con pathspec**.
9. **Escrituras pesadas en horario hábil** (un `CREATE MATERIALIZED VIEW` ya sostuvo el candado de migraciones 22 min).

**Siempre, por default:**
10. **Nunca adivinar una fuente de datos** — investigarla, contrastarla contra un hecho independiente y **probar la unidad**.
11. **Lo que no se pudo medir se DECLARA** (`unknown`, `measured:false`, `NO MEDIDO`), **nunca se dibuja como cero ni como verde**.
12. **Un gate sin prueba negativa es una intención**: rompelo a propósito una vez y verificá el rojo.
13. **Un endpoint que ESCRIBE no está probado** hasta que una prueba lo ejerció contra base real, con el payload de la pantalla.
14. **Al agregar una columna `NOT NULL` o cambiar una PK**: recorrer TODOS los caminos que insertan en esa tabla.
15. **Un commit que cambia un número** no cierra sin la medición antes/después. Optimizar va **aparte** de cambiar alcance de negocio.
16. **Un primitivo inventado en una fase no cierra la fase** (ADR-056): va a `libs/` o queda como deuda con nombre.
17. **Migraciones**: se **generan** (`node scripts/nueva-migracion.js`), idempotentes, y en prod **una por una** (`apply-one-migration-prod.js`), nunca `migrate:latest`.
18. **Tablas nuevas**: `tenant_id` UUID NOT NULL + audit fields. Naming snake_case, inglés salvo término de dominio.
19. **Al cerrar un item**: actualizar `01_TRACKER_PROGRESO.md` y `03_LOG_REVISIONES.md` (⬜→🔨→🧪→🚀→✅), y ADR si hubo decisión.
20. **Un módulo no está entregado** hasta que su permiso está **repartido** en prod, no sólo declarado en el enum.

---

## Modo de trabajo

**Equipo de 4 devs** (lead Edgar + 3). El trabajo se apoya fuerte en **Claude Code**: los `.md` del repo son la memoria compartida del proyecto entre sesiones y máquinas; mantenerlos actualizados es **mandatorio** al cerrar cualquier item.

**Flujo de trabajo: ⭐ SE TRABAJA SOBRE `main`.** Decisión de Edgar, 2026-10-08: **nada de ramas por feature**. Commiteás y empujás a `main`; la compuerta es el `pre-push` local (13 gates sobre *tus* archivos) y después el CI. ⛔ Lo que NO cambia: **`ci-green` sigue siendo el candado de producción** — `auto-deploy.sh` se niega a desplegar un commit que el sello no bendijo, así que `main` roja no llega a prod (tampoco llega nada más hasta que la arregles). **Una rama sólo se justifica si el trabajo no puede entrar a `main` a medias**; si la abrís, va contra `main`, nunca apilada sobre otra, y se borra al mergear.

> ⭐⭐ **LO QUE CREÁS, LO BORRÁS. Reiterado por Edgar el 2026-10-12** — «mantengamos todo en `main`» y «que las sesiones no generen ramas innecesarias». La regla de arriba ya existía desde el 08-oct; lo que faltaba era la **mitad de la limpieza**, y esto es lo que costó:
>
> - **14 ramas sueltas y 4 worktrees abandonados** en un solo barrido. De las ramas, **ninguna aportaba nada**: `q281`/`q283`/`q286` eran restos del incidente de PRs apilados —su trabajo ya estaba en `main` por sus propios PRs y **`main` lo había SUPERADO**, así que aterrizarlas habría **retrocedido** `rh-asistencia.component.ts` de 447 a 403 líneas—, y el resto eran versiones viejas de PRs ya mergeados.
> - **Los 4 worktrees (`w311`, `w321`, `w322`, `pvi4b`) llevaban 4 días muertos, 146–289 commits de atraso.** No son inofensivos: alguien abrió uno por error, el editor le mostró `20d99231` en vez de `main` y **14 errores de compilación que eran de código del 8-oct**. Perdió el rato creyendo que el proyecto estaba roto.
>
> ⛔ **`git cherry` MIENTE sobre lo que falta.** Cuenta commits, y los SHAs cambian al rebasear o al empujar aparte: marcó 36 commits «fuera de `main`» que ya estaban adentro. **Lo único que decide es comparar CONTENIDO** — si ningún archivo falta y ninguno difiere, la rama ya está en `main` y se borra sin pensar. Antes de borrar: (1) sin PR abierto, (2) sin worktree activo encima, (3) cero archivos ausentes en `main`.
>
> ⚠️⚠️ **Al quitar un worktree: `cmd /c rmdir node_modules` ANTES de `git worktree remove`.** Al revés ya destruyó el `node_modules` real del checkout compartido una vez. Y **no es un riesgo pasado**: verificado el 2026-10-12, `C:/tmp/pu-is-test` tiene hoy
> `node_modules` como **`<JUNCTION>` apuntando a `C:\Users\Sistemas\CascadeProjects\Trade_marketing\node_modules`**. Un `git worktree remove --force` ahí se lleva puesto el de TODAS las sesiones. ⭐ En ese barrido se salvó por el criterio de «worktree activo», **no** por haber mirado el enlace — o sea que el candado que funcionó fue el equivocado. **Mirá el enlace siempre, aunque creas que el worktree está muerto.**

> ⛔⛔ **NO SE INVOCA PYTHON. Y el que lo invoca deja un proceso girando para siempre** — medido el 2026-10-12. Había **9 procesos `python.exe -` huérfanos desde el 7-oct**, cada uno al 98 % de un núcleo: **8.8 de los 12 hilos** de la máquina y **~366 horas de CPU** quemadas en nada. Al matarlos, `nx build api` pasó de **2m05s a 1m03s** — la mitad.
>
> ⭐ **El mecanismo, aportado por otra sesión que verificó en vez de asentir:** `TaskStop` mata el envoltorio de `bash`, **NO al hijo de Python**. El proceso queda huérfano leyendo un stdin que nadie va a cerrar, y sigue girando. Por eso el turno «se destraba» y el costo queda invisible: usa 12 MB de RAM y nadie lo mira.
>
> ⚠️ **La regla NO es «no uses heredoc»**: los casos reales fueron un `python` pegado por reflejo delante de un `grep`, en comandos donde Python no pintaba nada. Esa sesión lo hizo **dos veces el mismo día conociendo la regla** — o sea que el problema no es que falte la regla, es que el reflejo gana. Si tu comando necesita Python, no lo necesita: hay `node`, `grep`, `awk` y `psql`.

> **Lo que lo motivó, medido el 2026-10-08.** Una cadena de tres PRs apilados (#281→#283→#286) llegó con **11,736 líneas que ningún compilador había visto**: `ci.yml` arranca con `on: pull_request: branches: [main]`, así que un PR contra otra rama **no corre CI**. Al mergear el primero, GitHub **cerró el segundo solo** (cierra el PR cuya base desaparece), y el squash dejó los SHAs sin correspondencia con los parches originales, así que rebasar encima no detectaba lo ya aplicado. Hubo que desenredarla a mano trasplantando commits. En paralelo, **el checkout compartido quedó divergido** (3 commits locales contra 5 del remoto, con un commit duplicado de los dos lados) y nadie podía ni traer ni empujar. ⭐ Y **cinco migraciones se aplicaron a producción desde commits que nunca se empujaron** — una de ellas con el archivo existiendo **sólo** en el worktree de otra sesión, lo que deja el ledger de prod referenciando algo que la imagen no tiene y **frena la siguiente migración de cualquiera**. Todo eso es la misma causa: trabajo vivo repartido en ramas y árboles que no convergen.
>
> ⚠️ **Esto NO afecta a `ci-green` ni a `prod-release`**, que son ramas marcadoras y se mueven solas. Y **`main` SÍ está protegida** desde el 2026-10-02 (ver abajo): exige `Build & typecheck` + `Secret scan`, bloquea force-push, borrado e historia no lineal. ⛔ Pero `enforce_admins` está en **`false`** —no en `true` como decía este archivo—, así que **el admin las saltea y nadie más**: medido sobre los últimos 40 commits, **30 son pushes directos de Edgar y cero de los otros cuatro**, que entran 100% por PR. Mientras eso siga así, "trabajar sobre `main`" es cierto para una persona, no para el equipo.

⛔⛔ **NADA DE WORKTREES NI RAMAS — SE TRABAJA SOBRE `main` EN EL CHECKOUT COMPARTIDO** (Edgar, 2026-10-12; deroga el `[PROC.2]` de 2026-10-07 que pedía un worktree por sesión). El árbol es compartido por varias sesiones: **commiteá SIEMPRE con pathspec** (`git commit -- <rutas>`), nunca `git add -A`, nunca `--amend`. Onboarding de máquina en [`ONBOARDING.md`](ONBOARDING.md) — **§8.0 `npm run hooks:install` es obligatorio por máquina**. Reglas duras en [`docs/GOTCHAS.md`](docs/GOTCHAS.md).

> **Tres correcciones al proceso, medidas el 2026-10-07 — ver `[PROC.1]`–`[PROC.3]`:**
>
> - ⛔ **Acá decía «→ 1 review (CODEOWNERS) →» y era FALSO: 1 de los últimos 25 PRs mergeados tuvo reseña**, y `required_approving_review_count` es **ninguna**. Los PRs viven **4 a 30 minutos** (#278 entró con 3,567 líneas en 10). ⭐ **El PR es el carril del CI, no una revisión** — y conviene decirlo, porque una línea que describe un proceso que no ocurre se cita para dar por revisado lo que nadie miró. Si se quiere revisión de verdad, se prende en la protección de rama; mientras no esté, **la compuerta es el CI**.
> - ⭐ **UN SOLO ÁRBOL, VARIAS SESIONES.** 16 sesiones activas en 24 h sobre UN solo árbol de trabajo ya produjo: un commit sin pathspec que borró **4,887 archivos**, seis migraciones **aplicadas en producción sin existir en ningún commit**, y un árbol sucio que iba a revertir tres features que estaban en prod. La respuesta de 2026-10-07 fue un worktree por sesión; **Edgar la revirtió el 12-oct** (14 ramas y 4 worktreets muertos en un barrido). La respuesta vigente es **pathspec en cada commit** y leer el árbol antes de escribirlo.
> - ⭐ **Una migración nueva se GENERA, no se escribe a mano:** `node scripts/nueva-migracion.js <nombre_snake_case>`. ⚠️ `npm run migrate:new` **no crea nada: corre `migrate:latest`** y aplica todas las pendientes. (Medido: **187 de 1,084** migraciones comparten marca de tiempo; **1,058 terminan en segundos `00`**.)

> ⛔ **El CI corre, y aun así nada bloquea un merge rojo. Medido el 2026-09-30.** Lo que decía esta línea (workflow `disabled_manually` por facturación, sin correr desde el 2026-08-25) **quedó viejo**: se destrabó y hoy está `active`, corriendo. Lo que cambió para peor es otra cosa: **el repo es PÚBLICO** (`edgarcg-01/MegaDulces_Suite`; verificado el 2026-10-02 con lectura **anónima**: `raw.githubusercontent` devuelve **HTTP 200** sin token sobre `CLAUDE.md`, `.env.example` y el runbook de despliegue). Eso tira abajo lo que esta línea afirmaba —que GitHub respondía **`403` "Upgrade to GitHub Pro"**—: hoy responde **`404 "Branch not protected"`**, y la diferencia entre esos dos códigos es todo el asunto. **La protección estaba disponible y gratis, y nadie la había prendido.** Había incluso un ruleset a medias (`rukes`): deshabilitado, con **cero** ramas seleccionadas y sólo `deletion` + `non_fast_forward`. Lo que cuesta, medido a 30 días: **~58 de 60 commits entraron por push directo** y de los últimos 20 pushes a `main` **15 quedaron rojos y 1 verde** — y las fallas son **reales**, no infra (dos veces hoy, `check:tokens` marcando `var(--token)` inexistentes). **El CI no está roto: corre tarde.** ⭐ **El 2026-10-02 se prendió la protección de `main`** (y el repo **sigue público** por decisión de Edgar ese mismo día): exige **`Build & typecheck (affected)` + `Secret scan (gitleaks)`**, **aplica también a los admins** (`enforce_admins: true` — sin eso la compuerta sería porosa justo para la cuenta que hace casi todos los pushes), y bloquea force-push, borrado de `main` e historia no lineal. ⛔ **`Sellar CI verde (ci-green)` NO se exige, a propósito**: tiene `if: github.event_name == 'push'`, **no corre nunca en un PR**, y pedirlo habría bloqueado **todos** los merges para siempre. **`Lint & test (affected)` tampoco se exige todavía** — aunque el 2026-10-02 está en **VERDE** por los arreglos `[CD.2]`/`[CD.2.1]`/`[CD.11]` de ese día, que es un cambio respecto de lo que esta línea decía; se deja informativo hasta que acumule historia. **Reviews obligatorios: no** — con un solo dueño nadie puede aprobar su propio PR y frenaría todo. ⚠️ **`ci-green` queda SIN proteger a propósito**: `sellar` la mueve con `git push --force`, y protegerla cortaría el sello **en silencio**. ⛔ **Y lo que el repo público trae consigo**: los `.md` con IPs internas, hostnames de base y cifras del negocio **son públicos**, y SonarQube detectó el 2026-10-02 **68 contraseñas de Postgres escritas en el código** (`database/importers/`, `database/scripts/`) — 49 con clave de dev conocida pero apuntando a **hosts REALES de la LAN**, y 2 al **superusuario de `.245`**; el `pre-commit` no las ve porque su allowlist **permite `192.168.` explícitamente**. ⛔ Y un **runner propio de GitHub Actions queda prohibido**: en un repo público, un PR desde un fork ejecutaría código en `md`. Además de la protección, la compuerta sigue en los dos lugares donde somos dueños: (1) **`npm run hooks:install`** por máquina — `.githooks/pre-push` bloquea el push directo a `main` + 6 gates sobre *tus* archivos en ~2.5 s, sin frenarte con la deuda ajena; es **débil** (se evade con `--no-verify`, no existe si nadie lo instaló); y (2) ⭐ **`[CI.SELLO]`, la que manda**: el job `sellar` de `ci.yml` mueve la rama marcadora **`ci-green`** cuando pasan `build` + `secret-scan`, y [`ops/prod/auto-deploy.sh`](ops/prod/auto-deploy.sh) **se niega a desplegar un commit que `ci-green` no bendijo** — nadie la evade, corre en `md`. O sea: **`main` puede ponerse roja, pero lo rojo no llega a producción.** No frena por `verify` (lint/tests/estilo) a propósito: hoy está rojo por deuda preexistente y exigirlo dejaría a prod sin despliegues desde el primer día. Lógica en [`ops/prod/compuerta-ci.sh`](ops/prod/compuerta-ci.sh) con su candado de 6 casos (2 negativos): `npm run check:compuerta-ci`. Detalle en la cabecera de [`.github/workflows/ci.yml`](.github/workflows/ci.yml) y en [`ONBOARDING.md` §8](ONBOARDING.md).

> **Para el Claude de un dev nuevo:** seguí el protocolo de orientación en [`docs/CLAUDE_ONBOARDING.md`](docs/CLAUDE_ONBOARDING.md) — te guía paso a paso a entender la estructura completa (leé esos docs en orden: ARCHITECTURE, ARQUITECTURA_DATOS, GLOSSARY, ERP_KEPLER, GOTCHAS, DESIGN + los 6 modelos mentales y las reglas duras). La memoria personal de Claude NO se comparte entre máquinas — todo lo que deba verlo el equipo va a estos `.md`.

---

## Qué es el proyecto

App de **trade marketing y auditoría de ejecución en PdV** para **Mega Dulces** (distribuidora de dulces en MX), en evolución hacia **plataforma B2B integral multi-tenant** estilo yom.ai.

**Stack actual (a migrar):**
- NestJS 11 + Knex + PostgreSQL + Socket.IO + Cloudinary
- Angular 18 standalone + PrimeNG + Tailwind + Spartan UI
- Capacitor + Dexie (mobile offline embebido en `apps/view`)
- Nx monorepo + Docker + Railway
- ERP de Mega Dulces: **no existe todavía** — el core comercial se construye desde cero en schema `commercial.*`. Si en el futuro aparece Kepler u otro ERP externo, se integra via FDW o sync hacia estas tablas (ver pivot 2026-05-26 en Fase B).

**Estado funcional hoy:** auditoría de visitas + scoring + reports realtime. **NO toma pedidos**, NO tiene catálogo comercial, NO es multi-tenant.

---

## Estado del producto

App de trade marketing + plataforma B2B multi-tenant para Mega Dulces. **Fases A, B, C y D cerradas (beta)** desde 2026-05-26; el resto del avance está en el índice de roadmap de abajo.

El historial de los sprints A.0mt.1 → D.5 (cerrados) se movió a [`00_ROADMAP_FASES_DETALLE.md`](docs/IMPLEMENTACION/00_ROADMAP_FASES_DETALLE.md).

---

## Reglas críticas (preferencias del usuario)

### ⛔ NO hacer sin autorización explícita
- **⭐ REGLA PRINCIPAL — CERO importers: todo dato sale del ODS, de UNA tabla principal, normalizada, documentada y verificada.** Es la regla de más peso del proyecto; ante conflicto con cualquier otra consideración (rapidez, "ya hay un script que lo hace", "el importer ya está probado"), gana ésta. Las cuatro condiciones son conjuntas: (1) **sin importer** — nada de `script → tabla` que haya que re-correr o agendar; (2) **del ODS** `kepler_ods.*`, no los réplicas por sucursal ni los POS ni un `.mdb`; (3) **de una sola tabla principal normalizada** — si necesitás otra forma del dato, **derivá** (vista), no materialices una segunda; (4) **documentada y verificada** contra un hecho independiente antes de usarla. Dataset nuevo = **VISTA `derive-no-copy` sobre `kepler_ods`** (fresca sin mantenimiento: la alimenta `OdsLiveLoop`). Tabla real SOLO para datos propios (HITL, OCR, feedback) o histórico/snapshots. **La lógica que vive en `database/importers/**` no es canónica — es justamente lo que se está retirando.** Si no se puede derivar, **parar y decirlo**, no improvisar un importer. Evidencia: en Fase CXC `analytics.customer_receivables` quedó en prod como tabla vacía porque el importer nunca corrió; el fix fue convertirla en vista sobre `kepler_ods.kdue`.
- **NUNCA hacer copias de tablas — siempre trabajar contra la tabla principal.** Ni copias de respaldo (`*_bak`, `*_old`, `*_tmp`), ni "la misma tabla en otro schema", ni una segunda materialización de algo que ya tiene tabla. Si necesitás una forma distinta del dato, **derivá** (vista) o extendé la tabla que ya existe. Materializar por costo sí es legítimo (§19); el pecado es materializar un valor **inventado**, sin origen verificable en la primaria. Regla y evidencia en [`docs/GOTCHAS.md` §32](docs/GOTCHAS.md), el caso canónico en §29.
- **⛔⛔ NADA DE COMPILAR NI LEVANTAR EL BACKEND EN LOCAL DURANTE UNA SESIÓN.** Ni `nx serve api`, ni `nx serve view`, ni `node dist/apps/api/main.js`, ni `nx build` "para verificar". Si hace falta comprobar que algo compila, lo compila **el CI** (push a rama → el job `Build & typecheck`), que además es el que sella `ci-green`. La verificación contra datos se hace **leyendo prod**, no levantando una copia del backend al lado.
  **Por qué, medido el 2026-10-02:** alguien levantó `node dist/apps/api/main.js` en la máquina de trabajo y quedó con **6 conexiones abiertas directo a la base de PRODUCCIÓN** (`192.168.0.243 → 192.168.0.222:5434`). En la misma ventana, una sesión local corrió un `CREATE MATERIALIZED VIEW` contra prod que **sostuvo el candado de migraciones 22 minutos** — ningún despliegue, de nadie, podía entrar mientras tanto; y al final la transacción **se revirtió entera**, así que fueron 22 minutos de bloqueo a cambio de nada. Más `nx serve view` + el demonio de Nx ocupando 236 MB desde las 08:42 sin que nadie los mirara.
  ⭐ El costo real no es la CPU: es que **un backend local apuntando a prod es un escritor que nadie declaró**, y un candado tomado desde una laptop para la tubería de todo el equipo.
  ⚠️ Si de verdad hace falta correr algo pesado contra prod, va **fuera de horario hábil** y se avisa — es la misma regla de «nada de escrituras pesadas en horario hábil», que aplica igual a un `CREATE MATERIALIZED VIEW` que a un `UPDATE`.
- **No borrar tablas** en la DB de prod.
- **No borrar columnas** sin pedir confirmación.
- **No hacer push** ni crear PRs sin pedir.
- **No tocar CORS ni credenciales** todavía (diferido por decisión del usuario 2026-05-26 — items `[A.0bis.1-3]` BLOCKED).
- **No borrar archivos de migración aplicados** (Knex valida `knex_migrations` vs filesystem → "directory corrupt" → crash loop. Vivido en este proyecto.).
- **⛔ NADA DE PYTHON.** Los lenguajes de este repo son **Node/TypeScript/JavaScript**, **SQL** y **PowerShell/Bash**. Ni siquiera para un script de un solo uso en el scratchpad. ⚠️ Un `python - <<EOF` mal formado **no falla: espera `stdin` para siempre**, sin error ni log — el 2026-10-12 había **9 colgados desde el 7-oct quemando 8.8 de 12 núcleos y ~366 h de CPU**, y al matarlos `nx build api` pasó de **2m05s a 1m03s**. ⭐ Y la causa de fondo no fue Python: la regla existía desde el 5-oct pero vivía **sólo en la memoria personal de una sesión**, que no se comparte — las otras ~16 no podían verla. En su lugar: `Edit`/`Write` para archivos, `node -e "..."` sin heredoc para datos, o `Write` al scratchpad + `node <ruta>`. Detalle y detección en [`docs/GOTCHAS.md` §79](docs/GOTCHAS.md).

### ✅ SÍ hacer por default
- **NUNCA adivinar una fuente de datos — investigarla y verificarla.** Vale para cualquier `cN` de Kepler, columna sin documentar, tabla ajena o feed. Antes de usarla en código, contrastarla contra un hecho independiente (¿costo? contra lo que se pagó; ¿precio? contra lo que se cobró) y **probar la unidad** explícitamente (¿la razón se pega a 1, a `bf`, o a `1/bf`?). Si la fuente no alcanza para decidir, **declararlo** — no dibujarlo como cero ni publicarlo con `%`. Protocolo completo en [`docs/ERP_KEPLER.md`](docs/ERP_KEPLER.md) §5 regla 0. *Ya nos costó: ADR-051 (3.3 pp de margen falso por mezclar pieza y caja) y CANON.0.1 (costos 32× por leer un peldaño fijo de la escalera de unidades).*
- Commits locales cuando se completa un item del tracker. Convención: `feat([A.0mt.1.1]): descripción`.
- **Protocolo previo a enviar un PR** ([`ONBOARDING.md` §8.0b](ONBOARDING.md); feedback de Edgar en #304/#305, 2026-10-08 — cada punto ya costó): **(1)** el PR va **siempre contra `main`, nunca apilado** (el CI sólo corre contra `main`; re-apuntar la base no lo dispara; el squash rompe el rebase de una cadena); **(2)** `origin/main` fusionado **y re-probado** (un CI verde sobre una rama atrasada describe un `main` que ya no existe); **(3)** migraciones: `npm run check:mig-colisiones` al abrir **y** antes del merge, marca = hora real de creación, **jamás renombrar una ya aplicada**, y las aditivas que el código nuevo lee van **antes** del código; **(4)** declarar en el PR los cambios de comportamiento y lo que **no** incluye; **(5)** si cambiás un tipo de `libs/contracts`, recorré **todos** sus consumidores —plantillas incluidas— y no escribas «compila» sin evidencia: `vitest` no tipa las plantillas, sólo `Build & typecheck` (#346: `priority` nullable → `TS2538` en 3 plantillas con 2657 tests verdes); **(6)** en PR de seguridad/BD, pruebas que **intentan violar** la defensa y esperan el error exacto, y RLS verificada contra prod. **(7)** corré a mano lo que **sólo** corre en CI (mirá los pasos de `ci.yml` que el `pre-push` no tiene): el `Boundary type gate` faltaba y #350 y #351 llegaron con 12 y 4 violaciones de `any`/retorno sin tipar — desde 2026-10-13 el `pre-push` ya lo corre; **(8)** probá el **directorio entero** del módulo, no un filtro por nombre; **(9)** tras fusionar `main`, buscá lógica **duplicada** entre tu PR y lo recién entrado aunque git no marque conflicto, y comprobá con `git merge-tree` los choques **entre PR abiertos**; **(10)** verificá cada cifra y afirmación de la descripción contra el diff y **releé la descripción tras el último push** (conteos, atraso contra `main`, funciones que ya quitaste). **(11)** en frontend: cargá la skill `diseno` y corré `npm run check:pantalla -- <módulo>` **antes y después** (ninguna falla nueva; mi resumen a mano sumó `Q.1` porque la cargué tarde); **(12)** si a una pieza compartida le falta una variante, extendela **aditiva** (default sin cambio + prueba de que no pierde información), no la reimplementes; **(13)** scripts de edición a un archivo —`node -e` con acentos graves los expande el shell y borra nombres del texto— y nunca Python; **(14)** lo que no pudiste ver se declara «sin validación visual» con lo más probable de ajustar. **(15)** recorré los puntos 18–29 de `ONBOARDING.md` §8.0b (observaciones del PM sobre pantallas de precios y lecciones de ETQ-CAMBIOS.11) contra tu diff **antes** de abrir el PR: cifras en una sola unidad y dicha, campos que viajan y se pintan, error ≠ vacío, lectura opcional en SAVEPOINT, SQL no ejecutado = script de verificación de sólo lectura + declararlo, y si sumás columnas a una tabla corré `node scripts/check-dense-tables.js` (apilado en estrecho). **(30)** un script de edición calcula el contenido ANTES de abrir el archivo para escribir y se revisa `git diff --stat`; **(31)** si se manda contenido de personas a un proveedor externo, la regla de quién queda fuera va en el servidor y se prueba apagándola. Los comentarios de `nx-cloud` son ruido, no feedback.
- **Actualizar `01_TRACKER_PROGRESO.md` y `03_LOG_REVISIONES.md` al cerrar items**. Cambiar símbolo: ⬜ → 🔨 → 🧪 → 🚀 → ✅.
- Crear ADRs en `02_DECISIONES_ARQUITECTURA.md` cuando se toma una decisión técnica relevante.
- Migraciones nuevas: **idempotentes** (con `hasColumn` antes de `addColumn`).
- Usar `Logger` de NestJS (no `console.log`) en código nuevo.
- Tablas nuevas: **siempre con `tenant_id` UUID NOT NULL + audit fields completos**.
- **Un primitivo inventado en una fase NO cierra la fase** (ADR-056). Si al resolver un item construiste un mecanismo genérico —declarar frescura, medir cobertura, versionar una definición, guardar el valor anterior, cuadrar contra un árbitro, una bandeja de hallazgos— el item no está cerrado hasta que el mecanismo vive en `libs/` compartido **o** queda declarado como deuda con nombre en el tracker. *Medido: ocho fases inventaron su propia bandeja de hallazgos; cinco familias de constantes están duplicadas a mano; la frescura llegó a 4 de 171 endpoints.*
- **Un commit que cambia un número no se cierra sin la medición del antes/después.** Optimizar es un commit **aparte** de cambiar alcance de negocio: si el diff toca un `WHERE` de negocio, no es optimización.
- **Lo que no se pudo medir se DECLARA, nunca se dibuja como cero ni como verde** (ADR-056). Vale para el dato (`status: 'unknown'`), la cobertura (`measured: false`) y **los tests**: un bloque sin datos con qué comprobarse reporta `NO MEDIDO`, no ✔.
- **Un gate sin prueba negativa es una intención**: al agregar una compuerta, rompela a propósito una vez y verificá el rojo.
- ⛔⛔ **UN ENDPOINT QUE ESCRIBE NO ESTÁ PROBADO HASTA QUE UNA PRUEBA LO EJERCIÓ contra una base real, con el payload que manda la pantalla.** Pedido de Edgar el 2026-10-14, con producción caída. **Medido:** `POST /cortes/:id/contar` devolvía **500** (`null value in column "denom_key" … violates not-null constraint`) y `finance.cash_ledger_cut_denominations` llevaba **8 días en CERO filas** — el arqueo de caja **no se pudo cerrar ni una vez**. La migración `20261006123000` agregó la columna `NOT NULL` y actualizó **uno de los dos** caminos de inserción. Build verde, lint verde, y `test-newdb-cash-ledger-cuts.js` verde **porque escribe el conteo directo a la tabla y nunca llama a `contar()`**.
  - ⚠️ **Y se leyó como falta de adopción**: el día anterior se reportó *«1 corte abierto, 0 cerrados en toda la historia»* como que nadie usaba el módulo. **Cero filas por un defecto es indistinguible de cero filas por desuso** — descartar el defecto ANTES de culpar a la gente.
  - **Al agregar una columna `NOT NULL` o cambiar una PK: recorrer TODOS los caminos que insertan en esa tabla** (un `grep` del nombre de la tabla), no sólo el que estás tocando.
  - ⛔ **«Probar en local» NO es la salida**, y choca de frente con la regla de arriba (nada de levantar el backend local, que también se escribió después de un incidente medido). **El lugar donde se ejerce una escritura es el CI o un entorno de pruebas, nunca la laptop apuntando a prod.**
  - ⚠️ **Deuda con nombre:** `database/run-all-tests.js` (12+ suites, ~155 aserciones) **no corre en ningún lado automáticamente** — `ci.yml` lo declara en su línea 359 («necesita API arriba»). Es la deuda **VP.5**. Mientras siga así, cada camino de escritura depende de que alguien se acuerde de ejercerlo a mano.

### Convenciones técnicas
- Naming snake_case en DB y `role_name`.
- **URLs, query params, DTO fields y columnas DB nuevas: English snake_case.** Spanish solo para domain terms sin traducción limpia (`exhibicion`, `folio`). Legacy ES queda como alias hasta que se complete la migración. Ejemplos canónicos: `zone_id`, `route_id`, `date_from`, `date_to`, `user_id`. Migración inicial 2026-06-01: `/visitas/*` → `/visits-sync/*`, `/stores?zona_id` → `?zone_id`, `/daily-captures?fecha` → `?date`.
- TZ del backend: `America/Mexico_City` (helpers en `apps/api/src/shared/date/mx-date.ts`).
- Schemas Postgres: `commercial.*` (Fase B+), `analytics.*` (Fase C+).
- Para diffs de role_permissions JSONB: usar `permissions -> 'KEY' IS NULL` NO el operador `?` de JSONB (knex no lo escapa correctamente).

---

## Sistema de tracking (mantener vivo)

| Archivo | Cuándo actualizar |
|---|---|
| [`01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) | **CADA vez** que un item cambia estado (⬜→🔨→🧪→🚀→✅) |
| [`02_DECISIONES_ARQUITECTURA.md`](docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md) | Al tomar decisión técnica relevante (crear ADR) |
| [`03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) | Al cerrar un sprint o checkpoint |
| [`AUDITORIA_BASE_INICIAL.md`](docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md) | Si aparece finding nuevo no listado |
| [`/CHANGELOG.md`](CHANGELOG.md) | Al cerrar feature/sprint relevante. Vista "qué cambió las últimas N semanas" sin abrir git log. Una entry por fecha + categorías Added/Changed/Fixed/Internal. |

**Estados granulares por item:**
- ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD · ⚠️ BLOCKED · ❌ REVERTED

---

## Roadmap — índice de estado

> ⛔⛔ **CÓMO SE ORDENA EL TRABAJO: [`docs/METODO_DE_TRABAJO.md`](docs/METODO_DE_TRABAJO.md)** (Edgar, 2026-10-14). Cuatro capas **C0 dato → C1 dominio → C2 API → C3 UI** y una fase **no sube de capa hasta que la de abajo está verificada**; **máximo 4 fases 🔨 a la vez** (una por dev) y 🧪 **no libera el cupo** —lo libera ✅, ⏸️ o ❌—; **sin métrica medida HOY no se abre la fase**; DoD de 7 puntos. Fase nueva = copiar [`FASES/_PLANTILLA_FASE.md`](docs/IMPLEMENTACION/FASES/_PLANTILLA_FASE.md) **y agregar su fila acá** — sin fila, la fase no existe.
>
> ⛔ **Fase 0 en curso: campaña de aterrizaje — no se abre ninguna fase nueva hasta terminarla** (§7 del método). Lo que la motivó, medido el 2026-10-14: **26 fases abiertas a la vez** para 4 devs, **181 docs de fase contra 48 filas de roadmap**, y un tracker donde el estado más grande no es «hecho» ni «por hacer» sino **«probado y sin aterrizar» (330 🧪) + «bloqueado» (271 ⚠️) = 601 contra 395 en prod**. ⭐ El cuello **no es la calidad del código** —ya hay ~25 compuertas `check:*`, cada una con su prueba negativa `:self`—: es que **se abre más de lo que se cierra**.

> ⛔ **El detalle completo de cada fase vive en [`00_ROADMAP_FASES_DETALLE.md`](docs/IMPLEMENTACION/00_ROADMAP_FASES_DETALLE.md)** — no se repite acá.
> Esta tabla sólo dice **qué fases existen y en qué estado están**. Para trabajar sobre una fase, abrí su plan en [`docs/IMPLEMENTACION/FASES/`](docs/IMPLEMENTACION/FASES/).

🟢 cerrada (beta) · 🚀 en prod · 🧪 en código, probada · 🔨 en curso / diseñada · 🟡 parcial · 🔴 planeada, sin código · ⏸️ en espera · ⬜ TODO

| Fase | Tema | Estado |
|---|---|---|
| **A.-1** | Auditoría base | ⬜ |
| **A.0-multitenant** | Nueva DB multi-tenant | ⬜ |
| **A.0bis** | Plan correctivo audit (post-multitenant) | ⏸️ |
| **A.1-A.7** | Fundaciones (Sentry, Pino, Redis, CI, etc.) | ⏸️ |
| **B** | Core Comercial (built from scratch, no ERP externo) | 🟢 |
| **C** | Sales Intelligence ampliado | 🟢 |
| **D** | Catálogo + Portal B2B + Pedidos | 🟢 |
| **E** | Telemarketing (antes "Remote Manager / Televenta") | 🟢 |
| **F** | WhatsApp Bot conversacional | ⏸️ |
| **G** | Growth (campañas + promociones) | ⏸️ |
| **H** | Fintech (wallet) | ⏸️ |
| **I** | ML credit risk + WS scaling | ⏸️ |
| **J** | Logística (embarques, flotilla, costos) | 🟢 |
| **LT** | Rastreo de flota GPS (MagniTracking) | 🟢 |
| **K** | AI product match en captures (pgvector + Voyage + Haiku) | 🟢 |
| **Horus** | Supervisor AI de ejecución (Trade) | 🔨 |
| **LM** | Última Milla (entrega a domicilio local en moto) | 🔨 |
| **VR** | Venta en Ruta (autoventa offline-first, lap/móvil) | 🔨 |
| **Maat** | AI de Finanzas (conocimiento + chat + patrones) | 🔨 |
| **RA** | Compras / Reabastecimiento (punto de reorden + existencia crítica + sugerido) | 🟢 |
| **CB** | Conciliación bancaria (interfaz reemplaza el Excel) | 🔨 |
| **CP** | Conector ContPAQi (SoR contable externo) | 🚀 |
| **CC** | Comprobantes de Cobranza (ficha de depósito + OCR) | 🔨 |
| **LC** | Libro de Compras (el proceso aquí, a ContPAQi solo el TXT) | 🔨 |
| **RE** | Recepción de Mercancía 360 (digitaliza el Excel de recepción) | 🔨 |
| **CA** | CEDIS (Kepler Access 97) → ODS | 🔨 |
| **WR** | Réplica cruda Wincaja (Access 97 → Postgres, continua) | 🟢 |
| **AX** | Anexo de venta imprimible (detalle + pagaré) | 🧪 |
| **MR** | Motor de Rentabilidad (cascada de margen) | 🧪 |
| **VP** | Verdad y Procedencia (el número declara con qué se calculó) | 🟡 |
| **OBS** | Ingesta que no se cae en silencio | 🔨 |
| **CV** | Catálogo, verificador de precios y tienda mayorista (migración de proyecto externo) | 🔨 |
| **VL** | VPS local (sacar la ingesta de la máquina de trabajo) | 🔨 |
| **TP** | Calendario de Pagos | 🧪 |
| **SN** | Suite: navegación por espacios ("Mi trabajo" en `/projects`) | 🧪 |
| **CDRP** | Cuadro de Resultados por Puesto (el tablero directivo, DENTRO de «Mi trabajo») | 🔨 |
| **FLT** | Lista de faltantes (la venta que NO ocurrió) | 🧪 |
| **PU** | Presupuestos (motor de planeación y control) | 🧪 |
| **IC** | Inventario Continuo (3 ritmos) | 🚀 |
| **CE** | Costo estándar de Kepler (el que fija el precio) | 🚀 |
| **PO** | Post-corte del 1-oct-2026 (el `00` dejó de concentrar) | 🔨 |
| **NP** | Productos nuevos (seguimiento a 30/60/90 días) | 🧪 |
| **PF** | Flujo de venta de cualquier producto (Compras › Catálogo › Productos) | 🧪 |
| **MS** | Mesa de Servicio (tickets de servicio) | 🧪 |
| **CSU** | Cortes/Sucursales (corte de caja → cobro → ingreso) | 🧪 |
| **ECA** | Estado de cuenta de acreedores (por tipo) | 🧪 |
| **RH** | Recursos Humanos: migración de Mega Talento | 🔴 |
| **GP** | Gestión de pedidos en almacén (surtido/checado/embarque sin papel) | 🧪 |
| **VAC** | Acople del verificador de precios al estándar (`/tienda/verificador`) | 🧪 |

---

## Documentación clave

> ⛔ **Nueve de estos documentos NO caben en una ventana de contexto.** Todos los de 40 KB
> para arriba abren con un **índice navegable** (sección → línea → KB): buscá tu tema ahí y
> leé sólo ese tramo con `sed -n 'DESDE,HASTAp' <archivo>`. Los índices los refresca
> `npm run docs:indices`; `npm run check:docs-indices` se pone rojo si quedaron rancios.
> **Leer un fragmento por grep y dar la regla por cumplida es el modo de fallar acá.**

| Archivo | KB | Para qué |
|---|---:|---|
| [`ONBOARDING.md`](ONBOARDING.md) | 36 | **Empezar acá** — de cero a API+view corriendo (Docker local, flujo git) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 12 | Mapa de código: apps, dominios (libs), módulos, DBs, feeds, servicios externos |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | 7 | Términos de dominio + nombres internos (Thot/Horus/Maat, Kepler, fases) |
| [`docs/VERDAD_ABSOLUTA.md`](docs/VERDAD_ABSOLUTA.md) | 296 | ⭐⭐ **FUENTE PRINCIPAL DE RAZÓN** (ADR-059). Qué ARBITRA cada número, cuánto aguanta y qué se declara. Resolvedores únicos, las trampas que ya cobraron, los huecos con nombre y monto, y las **hipótesis refutadas** para que nadie las reconstruya. **Antes de publicar una cifra, abrí su índice y leé la sección de ese número** |
| [`docs/GOTCHAS.md`](docs/GOTCHAS.md) | 250 | 92 trampas ya vividas (RLS, transacciones, migraciones, permisos, dinero, cron). Entrá por el índice |
| [`docs/ERP_KEPLER.md`](docs/ERP_KEPLER.md) | 103 | Decode del ERP Kepler + pipeline `kepler_ods`. 31 secciones indexadas |
| [`docs/UNIDADES_DE_MEDIDA.md`](docs/UNIDADES_DE_MEDIDA.md) | 62 | Unidades y factores de caja: 31 tablas, 8 fuentes, el catálogo discrepa 73.6% con el ERP. **Antes de multiplicar dos columnas** |
| [`docs/MATRIZ_ACCESOS.md`](docs/MATRIZ_ACCESOS.md) | 43 | Accesos por puesto (puesto → rol → módulos V/G, permisos sensibles, huecos) + checklist para un módulo nuevo. Generada desde prod: `npm run docs:matriz-accesos`. **Consultar ANTES de crear un módulo, regenerar al cerrarlo** |
| [`docs/ARQUITECTURA_DATOS.md`](docs/ARQUITECTURA_DATOS.md) | 16 | Schemas, tablas, FKs, flujo, mermaid |
| [`docs/IMPLEMENTACION/INDEX.md`](docs/IMPLEMENTACION/INDEX.md) | 11 | Mapa de toda la documentación |
| [`docs/IMPLEMENTACION/00_ROADMAP_GENERAL.md`](docs/IMPLEMENTACION/00_ROADMAP_GENERAL.md) | 5 | Vista de pájaro |
| [`00_ROADMAP_FASES_DETALLE.md`](docs/IMPLEMENTACION/00_ROADMAP_FASES_DETALLE.md) | 232 | **Detalle íntegro de las 48 fases** (salió de CLAUDE.md el 2026-10-14). Una fila por fase: `grep -n '| **XX**'` |
| [`01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) | **1,723** | Kanban en vivo, 72 secciones. ⛔ El más grande del repo: **siempre por índice**, nunca entero |
| [`02_DECISIONES_ARQUITECTURA.md`](docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md) | 356 | **88 ADRs** (hasta ADR-092), 90 secciones indexadas |
| [`03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) | 911 | Historial de checkpoints, 196 secciones indexadas |
| [`AUDITORIA_BASE_INICIAL.md`](docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md) | — | 60 findings del código inicial |
| [`docs/PLAN_PLATAFORMA_B2B.md`](docs/PLAN_PLATAFORMA_B2B.md) | 28 | Visión completa — sólo al planear features grandes |

---

## Datos del entorno

- **⭐⭐ PRODUCCIÓN = el servidor `md` (`192.168.0.222`), NO Railway — desde el 2026-09-22.**
  Dominio `megadulcessuite.com`. DB: **`pg-prod`, `192.168.0.222:5434`**, base `railway`
  (⚠️ **mismo nombre** que la vieja: `md` es una restauración, misma forma y mismas tablas →
  **verificá siempre por `system_identifier`, nunca por el nombre de la base**).
- **⛔⛔ Prod corre en k3s (Kubernetes) desde el 2026-10-01, ya NO en Docker Compose.**
  Verificado contra [`ops/k3s/`](ops/k3s/). Namespaces `prod` e `ingesta`; NodePorts
  `:30080` suite · `:30081` portal · `:30082` vendedor. Prueba de vida:
  `curl http://192.168.0.222:30080/api/health`.
  ⛔ **Los deployments se llaman `api · caddy · cloudflared · garage · pg-prod · pg-rag ·
  pgvector-md · portal · redis · vendor · worker`** — `prod-api`/`prod-caddy` son nombres de
  **IMAGEN**, no de deployment: pasárselos a `kubectl` da `not found` y se lee como typo propio.
  Los contenedores Compose quedaron `Exited (0)`: es una **parada limpia, no una caída**.
- **⛔ NO "se despliega solo".** [`ops/prod/auto-deploy.sh`](ops/prod/auto-deploy.sh) existe y
  conserva sus compuertas (`ci-green` sigue siendo el candado de producción), pero **su renglón
  del `crontab` está comentado**: decir *"se despliega cuando Edgar autorice el push"* deja al
  equipo esperando algo que no va a pasar solo. **Confirmá el mecanismo vigente antes de prometer
  un despliegue.**
- Migraciones en prod: **una por una** con `apply-one-migration-prod.js` (⛔ nunca
  `migrate:latest`: hay **dos** `knex_migrations`). Runbook en
  [`ops/prod/RUNBOOK-despliegue.md`](ops/prod/RUNBOOK-despliegue.md).
- ⚠️ **Railway = prod VIEJA y congelada** (sin escrituras desde el 23-sep). El `FLEET_DB_URL`
  del `.env` local **todavía apunta ahí**. Medir contra eso no falla: **triunfa en el lugar
  equivocado** — ya costó una auditoría entera, una migración aplicada al clúster muerto y un
  "incidente de ingesta" reportado que no existía (2026-09-24).
  `ops/prod/README.md` §0 también está rancio.
- **Service ID Railway** (legacy, prod vieja): `69f64078-1678-40f4-a266-a18b61a20cde`.
- **⭐ Dónde corre la INGESTA**: servidor Linux **`md` · `192.168.0.222`** (Ubuntu Server 26.04.1,
  `ssh superoot@192.168.0.222`) desde el **2026-09-11**. Contenedores de Docker Compose declarados
  en [`ops/vl/docker-compose.yml`](ops/vl/docker-compose.yml) + agenda versionada en
  [`ops/vl/crontab.feeds`](ops/vl/crontab.feeds); arrancan con la máquina, **sin sesión de usuario**
  (verificado con un reinicio real). Ahí vive también **la fuente**: el Postgres `:5433` con las 8
  réplicas lógicas de las sucursales. ⛔ En `.249` sólo quedan los **3 carriles de Wincaja** (Jet
  32-bit sobre unidad mapeada — Fase VL.5) y el respaldo diario.
  **Qué corre dónde, medido: [`ops/README.md`](ops/README.md).** Despliegue: `ops/vl/deploy.sh`.
- **DB legacy**: Postgres en Railway (host `switchback.proxy.rlw...`). Ya no es prod.
- **DB nueva multi-tenant**: la de prod es `pg-prod` en `md` (arriba). Para desarrollo: el stack Docker local (`npm run dev:up`, `.env.dev.example`). ⛔ **`192.168.0.245` (`platform_test`, `postgres_platform`) ya no se usa** — era un espejo viejo que no se revive (decisión 2026-09-12) y hoy ni conecta. Los smoke tests exigen un destino seguro (`assert-safe-target`).
- **Primer tenant**: `mega_dulces` con UUID `00000000-0000-0000-0000-00000000d01c`.
- **WhatsApp BSP**: pendiente decidir (ADR-006).
- **LLM provider**: pendiente decidir (ADR-007, recomendado Claude Haiku 4.5).
- **Partner fintech**: pendiente identificar (ADR-008).

---

## ADRs

Los ADRs vigentes con su razonamiento completo están en [`02_DECISIONES_ARQUITECTURA.md`](docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md). **Leé ahí antes de contradecir una decisión, no de memoria.**

Los que gobiernan el trabajo diario: **ADR-010** multi-tenancy (`tenant_id` + RLS) · **ADR-040** integrar, no construir (ContPAQi = SoR contable, nunca escribimos directo) · **ADR-056** verdad y procedencia (lo que no se midió se DECLARA, nunca se dibuja como 0) · **ADR-059** la cifra se ARBITRA contra un testigo del mismo ERP y grano · **ADR-054** el permiso es una CLAVE, no una tupla.

---

## Notas de operación con Claude

- **Auto mode** activo → avanzar sin pausas largas, tomar decisiones razonables.
- **Estilo CONCISO**: no explicar de más. Confirmación + qué sigue. El tracker registra el detalle, no la respuesta. Sin recaps largos. Solo expandir cuando hay bug raro o decisión arquitectónica nueva.
- **Tickets/commits**: `feat([A.0mt.1.1]): descripción`. Código va entre brackets, viene del tracker.
- **Al cerrar item**: marcar `[x]` + cambiar símbolo a ✅ + fecha de cierre.
- **Al cerrar sprint**: entry en `03_LOG_REVISIONES.md` con resumen + lessons learned.
- **Finding nuevo no listado**: agregar a `AUDITORIA_BASE_INICIAL.md` con código nuevo.

---

## Design System ("Mercado" — 2 surfaces)

Antes de cualquier decisión visual/UI, leer [`DESIGN.md`](DESIGN.md). Un solo sistema, dos modes:

- **Storefront** (`/portal/*`): Fraunces editorial + Hanken Grotesk + Geist Mono. Decoración intencional, ilustraciones SVG, density comfortable.
- **Operations** (`/dashboard/*`, `/comercial/*`, `/logistica/*`, `/admin/*`, `/vendor/*`, `/telemarketing/*`): **NO Fraunces**, NO ilustraciones. Page-head = Hanken Bold. Tabla densa + master-detail como primary organism. Density compact++. Tesis "esto es serio".

Comparten: paleta Stone, sunset acción (`--action`), IA ember (mata morado `#8b5cf6` y azul `#2563EB`), dark **zinc `#111111` en Operations / espresso `#16130F` en Storefront** (mata `#000` puro), escala de radios. Tokens en [`libs/design-tokens/tokens.css`](libs/design-tokens/tokens.css) — **archivo único para las 3 apps**. No desviarse sin aprobación. En QA, marcar código que no respete `DESIGN.md`.

Migración Operations (tokens.css): **pendiente de aprobación del diff** — plan documentado en sección "Plan de migración Operations" de `DESIGN.md`.
