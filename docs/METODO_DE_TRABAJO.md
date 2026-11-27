# Método de trabajo — fases, capas, objetivos y planeación

> Decidido por Edgar el 2026-10-14, sobre medición del estado real (abajo). **Manda sobre la costumbre.**
> Las reglas duras de git, prod y datos NO se repiten acá: viven en [`CLAUDE.md`](../CLAUDE.md), [`docs/GOTCHAS.md`](GOTCHAS.md) y [`docs/VERDAD_ABSOLUTA.md`](VERDAD_ABSOLUTA.md). Este archivo dice **cómo se ordena el trabajo**, no cómo se escribe el código.

---

## 0. Por qué — lo que se midió el 2026-10-14

| Medición | Valor |
|---|---|
| Fases abiertas a la vez (🔨 14 + 🧪 12) | **26**, para 4 devs |
| Docs en `FASES/` vs filas en el roadmap | **181 vs 48** → 133 sin fila |
| Docs de fase sin tocar hace +60 días | 59 (tocados en 3 días: 25) |
| Tracker — ✅ en prod | 395 |
| Tracker — 🧪 **construido y detenido** | **330** |
| Tracker — ⚠️ BLOCKED | **271** |
| Compuertas `check:*` con prueba negativa `:self` | ~25 |

⭐ **El estado más grande del tracker no es «hecho» ni «por hacer»: es «probado y sin aterrizar» (330) más «bloqueado» (271) — 601 contra 395 en prod.** Y ya existen ~25 compuertas técnicas, cada una con su prueba negativa.

**El cuello NO es la calidad del código. Es que se abre más de lo que se cierra, y nada limitaba cuánto podía estar abierto.** Todo lo que sigue ataca eso y nada más.

---

## 1. Las cuatro capas — el eje que secuencia

Una fase **no sube de capa hasta que la de abajo está verificada**. Esto explica directo los 330 🧪: pantallas construidas sobre datos que nunca cerraron.

| Capa | Qué es | Está verificada cuando… |
|---|---|---|
| **C0 · Dato** | El origen. Vista `derive-no-copy` sobre `kepler_ods.*` / `wincaja.*` | El origen está documentado, **la unidad probada de ambos lados**, y la cifra **arbitrada contra un testigo independiente** del mismo ERP y grano (ADR-059 · `VERDAD_ABSOLUTA.md`). ⛔ Sin importer (regla principal de `CLAUDE.md`) |
| **C1 · Dominio** | `libs/<dominio>` — regla de negocio y tipos en `libs/contracts` | La regla tiene prueba que la ejerce; si cambiaste un tipo de `contracts`, **recorriste todos sus consumidores, plantillas incluidas** |
| **C2 · API** | Endpoint NestJS, permiso, `tenant_id` + RLS | ⛔ Si **escribe**: una prueba lo ejerció **contra base real con el payload que manda la pantalla**. El permiso es una CLAVE (ADR-054). Nunca la laptop contra prod |
| **C3 · UI** | Pantalla Angular | Skill `diseno` cargada **antes**, `npm run check:pantalla -- <módulo>` **antes y después** sin fallas nuevas, sidebar + permiso propio, carga **<500 ms** |

**Regla de la capa:** si C0 no está arbitrada, **no se escribe C3**. El dato que no se pudo verificar **se declara** (`status: 'unknown'`, `measured: false`) — nunca se dibuja como cero ni como verde (ADR-056).

---

## 2. El objetivo — sin número medible no se abre la fase

Toda fase declara, **antes de la primera línea de código**, en la cabecera de su doc:

```
OBJETIVO: <una frase: qué cambia para quién>
MÉTRICA:  <nombre del número> — HOY: <valor medido, con fecha> → META: <valor> para <fecha>
CAPA TOPE: C0 | C1 | C2 | C3
ÁREA:      Comercial | Finanzas | Logística | RH | Plataforma | Trade
DUEÑO:     <nombre>
```

- **«HOY» es un valor medido, no estimado.** Si no se puede medir hoy, el primer item de la fase es medirlo.
- Al cerrar se publica el **antes/después** con la misma consulta. Un commit que cambia un número no se cierra sin esa medición, y **optimizar es un commit aparte de cambiar alcance de negocio**.
- Una fase sin métrica no se abre. Queda ⬜ hasta que la tenga.

---

## 3. El límite — no es cuántas se abren, es que se cierren

⛔⛔ **NO hay tope de fases 🔨** (Edgar, 2026-11-27). Hubo uno —4, una por dev— del 2026-10-14 al
2026-11-27, y **se retira porque no limitaba nada**.

> ⭐ **La cifra que lo mató, medida el día que se quitó.** En los **90 días** anteriores entraron
> **12 fases a 🔨 y salieron CERO**; en los **30 días**, 8 entraron y 2 salieron (las dos a ⏸️, por
> cupo, no por terminadas). El tope estuvo vigente todo ese tiempo y **se saltó ocho veces** —cada
> una con su renglón «abierta por encima del cupo»— sin que cerrara una sola fase. Un límite que
> todos saltan no es un límite: es papeleo que documenta su propio incumplimiento, y además
> **desplaza la atención** del problema real hacia una discusión sobre el número.

**El cuello nunca fue cuántas hay abiertas. Es que entra más de lo que sale.** Un tope de trabajo en
curso sólo funciona si quien lo firma no se lo puede saltar gratis; acá sí puede, y debe poder —las
prioridades del negocio no esperan a que se desocupe un casillero. Así que se mide la variable
correcta y se publica, en vez de bloquear.

### 3.0 Lo que reemplaza al tope: el FLUJO, publicado (2026-11-27)

```bash
node .claude/skills/pm/tablero.js         # fases por estado + abren vs cierran a 30 y 90 días
node .claude/skills/pm/tablero.js --self  # prueba negativa: 7 controles del flujo
```

El tablero dice, en cada corrida, **cuántas fases entraron a 🔨 y cuántas salieron** en los últimos
30 y 90 días, y el saldo. Si el saldo es positivo, lo dice con todas las letras: *«el tablero CRECIÓ
N: entra más trabajo del que sale»*. **No bloquea a nadie y no hay nada que pedir permiso para
saltar.** Es un termómetro, no una barrera — pero sale en pantalla cada vez que alguien mira el
tablero, que es más de lo que el tope conseguía.

⭐ **Una fase 🔨 que desaparece de la tabla cuenta como cerrada**, no como humo: el 2026-11-06 se
retiraron 23 fases entregadas de una vez. (Medido: de esas 23, **0 estaban 🔨** — el saldo de arriba
no está inflado por eso, y el control que lo comprueba vive en `--self`.)

### 3.0b Lo que SÍ sigue en pie: la caducidad (2026-11-20)

Quitar el tope **no quita la fecha**. Lo que hace que 🔨 signifique algo no es que haya pocas, es
que cada una tenga **dueño** y **cierre comprometido**.

> ⭐ **Por qué hizo falta.** El límite de 4 existía desde el 2026-10-14 y aun así el tablero llegó a
> **9 fases 🔨**. Al medirlo salió la causa: la regla que debía cortar («sin dueño o sin fecha cae a
> ⏸️ sola») **nunca podía dispararse, porque su gatillo era el único campo que nadie llenaba**:
> «Cierre comprometido» estaba en **6 de 64 tarjetas, y en 0 de las 9 fases 🔨**. Un límite de
> trabajo en curso sin condición de término no limita nada: si nada tiene fecha, nada llega tarde
> nunca, y entonces nada se cierra ni se pausa. Es la misma raíz de los 330 🧪.

**1 · Sin fecha no se entra.** Una fase pasa a 🔨 sólo con **dueño** y **cierre comprometido** en su
tarjeta. Sin los dos se queda en «Por hacer». Es el único campo que se vuelve requisito de entrada:
los demás (área, prioridad, dinero, esfuerzo) ya se llenan solos en la mitad o más de las tarjetas.

**2 · La caducidad la ejecuta un script, no una persona.**

```bash
node .claude/skills/pm/caducidad.js            # informe: qué se sostiene y qué cae (NO escribe)
node .claude/skills/pm/caducidad.js --aplicar  # mueve a «En pausa» lo que no se sostiene
node .claude/skills/pm/caducidad.js --self     # prueba negativa: 7 controles, tiene que salir rojo si mide mal
```

⚠️ Se llamaba `cupo.js` y medía dos cosas a la vez. Al quitarse el tope quedó **sólo la caducidad**,
y por eso cambió de nombre: un script llamado «cupo» que ya no mide un cupo manda a la siguiente
persona a buscar una regla que no existe. Uno de sus controles comprueba justamente que **15 fases
con dueño y fecha se sostengan todas** — si alguna vez vuelve a caer una por ser «demasiadas», el
tope volvió por la ventana y ese control se pone rojo.

⛔ **Antes de la primera corrida con `--aplicar`, los dueños ponen su fecha.** Una compuerta que se
dispara sobre un campo que nunca se recolectó no castiga el problema, castiga a la persona: pausaría
trabajo que sí está vivo sólo porque a su tarjeta le falta un dato. Se avisa, se da plazo, y recién
después muerde.

**3 · ⏸️ no borra nada**, sólo dice «hoy no»: la fase pausada conserva su doc intacto.

**4 · 🧪 no es cerrar.** Cierra llegar a ✅ (prod) o a ⏸️/❌ declarados. Esto es a propósito — 330
items 🧪 son exactamente lo que pasa cuando «probado» cuenta como terminado, y es la razón por la
que el flujo de §3.0 cuenta 🧪 del lado de lo abierto.

### 3.1 Qué entra primero — dinero en juego × esfuerzo (Edgar, 2026-10-21)

**Mucho dinero y poco esfuerzo va primero; mucho esfuerzo y poco dinero, al final.** Cada fase o
tarjeta activa del [tablero PM](https://github.com/users/edgarcg-01/projects/2) lleva **Dinero en
juego** (Alto ≥ \$1 M o una cifra que decide dinero · Medio \$100 mil–\$1 M · Bajo), **Esfuerzo**
(S ≤ 1 día · M ≤ 1 semana · L 2–4 semanas · XL > 1 mes) y la **Prioridad** que sale de la tabla:

| | S | M | L | XL |
|---|---|---|---|---|
| **Alto** | 1 | 1 | 2 | 2 |
| **Medio** | 2 | 3 | 3 | 4 |
| **Bajo** | 3 | 4 | 4 | 4 |

- **0 · Riesgo de seguridad** va antes que todo.
- El dinero sale de una **medición** (con su fuente en la tarjeta); el esfuerzo es una **estimación** que corrige el dueño.
- Una tarjeta Alto + L/XL se **parte**: su pedazo S/M que se lleva el dinero sube a prioridad 1.
- Si se decide abrir algo de prioridad 3–4 antes que uno de 1–2, **se escribe por qué** en la tarjeta.
- Detalle y casos en la skill `pm` (`.claude/skills/pm/references/criterios.md` §1).

### 3.2 Todo cambio se comunica (Edgar, 2026-10-21) — regla para todos

**Cada título de commit lleva el código de su tarjeta:** `tipo([CÓDIGO]): qué cambia`
(`feat([CGA-A.16]): …`, `fix([OPS]): …`, `docs([ADR-095]): …`). De esos títulos se genera sola, cada
día a las 19:00, la **[bitácora de cambios del equipo](https://github.com/edgarcg-01/MegaDulces_PM/blob/main/CAMBIOS.md)**:
qué cambió cada persona, por día y por tarjeta. Nadie escribe dos veces.

- **Se cobra, no se pide:** `.githooks/commit-msg` **no deja crear** un commit sin código (y el
  `pre-push` avisa si alguno se coló). Requiere `npm run hooks:install` en cada máquina.
- **¿No hay tarjeta?** Se usa el código del área (`[OPS]`, `[CI]`, `[DOCS]`) o se crea la tarjeta.
- ⛔ **Lo que llegue sin código no se reescribe** (`--amend`/`rebase` están prohibidos en el
  checkout compartido): queda en la bitácora como **«sin tarjeta»**, con su autor.
- Medido al ponerla: ya la cumplía el 91–98 % de los commits de cada persona.

---

## 4. El ciclo de vida de una fase

| # | Paso | Estado | Qué lo cierra |
|---|---|---|---|
| 1 | **Objetivo** | ⬜ | El bloque de §2 completo, con el «HOY» medido |
| 2 | **Plan** | ⬜ | Doc de fase desde [`_PLANTILLA_FASE.md`](IMPLEMENTACION/FASES/_PLANTILLA_FASE.md) + **fila en el roadmap de `CLAUDE.md`**. Sin fila no existe |
| 3 | **Capas** | 🔨 | Items del tracker agrupados por C0→C3, en ese orden |
| 4 | **Ejecución** | 🔨 | Commit con pathspec por item cerrado, `feat([XX.N]): …` |
| 5 | **Aterrizaje** | 🧪→🚀 | CI verde → `ci-green` → `auto-deploy.sh`. Migraciones una por una |
| 6 | **Cierre** | ✅ | La Definición de Terminado de §5, completa |

---

## 5. Definición de Terminado (DoD) — las 7, todas

Una fase se marca ✅ sólo cuando:

1. **La métrica de §2 se midió otra vez** y se publicó el antes/después.
2. **Cada capa quedó verificada o declarada NO MEDIDA.** Nunca cero ni verde dibujado (ADR-056).
3. **Todo endpoint que escribe fue ejercido** por una prueba contra base real con el payload de la pantalla. ⛔ Cero filas por defecto es indistinguible de cero filas por desuso — descartar el defecto antes de culpar a la gente.
4. **Toda compuerta nueva se rompió a propósito una vez** y se verificó el rojo. Un gate sin prueba negativa es una intención.
5. **Todo primitivo genérico inventado vive en `libs/` compartido** o quedó como deuda **con nombre** en el tracker (ADR-056).
6. **Tracker, `03_LOG_REVISIONES.md` y el roadmap de `CLAUDE.md` reflejan el estado real**, y la decisión técnica relevante tiene su ADR.
7. **Está en prod**, o está escrito explícitamente **por qué no** y qué falta.

---

## 6. Qué skill en qué paso

| Paso | Skill | Por qué |
|---|---|---|
| Objetivo vago → fase | `spec` | Convierte intención en spec ejecutable antes de codear |
| Revisar el plan | `plan-eng-review` · `autoplan` | Antes de la primera línea, no después |
| Revisar el plan (diseño, antes de C3) | **`auditoria-diseno` §9** | Un rótulo que miente se corrige en el plan con una línea; en la pantalla, con una reescritura |
| Navegar 181 docs | `graphify` | El repo no cabe en una ventana de contexto |
| Causa raíz de un bug | `investigate` | Investigar el proceso REAL antes de concluir |
| Frontend (C3) | **`diseno`** ⛔ obligatoria | Reemplaza a todas las skills de diseño genéricas |
| Antes de empujar | `code-review` · `security-review` | Más los `check:*` que sólo corren en CI |
| Cierre de sprint | `retro` → `03_LOG_REVISIONES.md` | |
| Aprendizaje nuevo | `learn` → `docs/GOTCHAS.md` | |
| Relevo entre sesiones | `context-save` / `context-restore` | Varias sesiones sobre un solo árbol |
| Alcance acotado | `freeze` / `guard` | El árbol es compartido |

⛔ **Prohibidas acá, por regla del proyecto y no por gusto:**
- `ship` · `land-and-deploy` · `canary` · `setup-deploy` — asumen un flujo de PR y despliegue propios. Acá manda `ci-green` + [`ops/prod/auto-deploy.sh`](../ops/prod/auto-deploy.sh).
- `qa` · `qa-only` · `browse` · `benchmark` · `open-gstack-browser` · `pair-agent` — **exigen levantar la app en local**, que choca de frente con la prohibición medida del 2026-10-02 (6 conexiones a prod desde una laptop; 22 min de candado de migraciones para nada).
- `health` · `devex-review` — duplican las ~25 compuertas `check:*` que ya existen y ya tienen prueba negativa.
- `design-consultation` · `design-html` · `design-shotgun` · `design-review` y las 14 de `.claude/skills-desactivadas/` — las reemplaza `diseno` + [`DESIGN.md`](../DESIGN.md).

---

## 7. Fase 0 — la campaña de aterrizaje (antes de abrir nada nuevo)

⚠️ **Esto ya no bloquea abrir fases** (2026-11-27, con el tope). La frase era «no se abre ninguna
fase nueva hasta terminar esto», y entre el 2026-10-28 y el 2026-11-27 **se abrieron 8** con la
campaña sin terminar. Sigue siendo el trabajo más valioso del tablero —lo construido y no aterrizado
es inversión parada, y por eso es **prioridad 3** en `criterios.md`—, pero se compite por tiempo,
no por un portón.

| # | Item | Salida |
|---|---|---|
| **0.1** | Clasificar los **330 items 🧪**: a prod (🚀), a ⏸️, o a ❌ muerto | Tracker sin 🧪 huérfano |
| **0.2** | Los **271 ⚠️ BLOCKED**: cada uno gana **dueño + causa**, o se cierra | Ningún bloqueo anónimo |
| **0.3** | Los **133 docs de `FASES/` sin fila en el roadmap**: fila, o a `FASES/archivo/` | 1 doc vivo = 1 fila |
| **0.4** | Cada fase 🔨 con su **objetivo medido** de §2, su **dueño** y su **cierre comprometido** | `caducidad.js` en verde |

Al terminar, entrada en [`03_LOG_REVISIONES.md`](IMPLEMENTACION/03_LOG_REVISIONES.md) con las cifras de §0 remedidas.
