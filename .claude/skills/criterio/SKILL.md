---
name: criterio
description: El análisis OBLIGATORIO antes de escribir código en esta suite. Clasifica el pedido por capas (C0 Dato · C1 Dominio · C2 API · C3 Interfaz · C4 Plataforma), lee la fuente de verdad de cada capa, recorre el impacto, cruza las 20 reglas de CLAUDE.md y entrega una FICHA corta con plan, verificación y decisiones antes de tocar nada. Se carga ANTES de cualquier pedido que cambie código, datos, migraciones, permisos, pantallas o infraestructura — agrega, cambia, arregla, corrige, crea, implementa, quita, mueve, migra, refactoriza, optimiza, "haz que", "no funciona", bug, feature, endpoint, vista, tabla, columna, pantalla, botón, permiso, deploy. También para revisar el plan de otro antes de construir. No se salta por ser un cambio "chico" — la ficha de un cambio chico mide tres renglones.
---

# Criterio — pensar antes de tocar

> **Por qué existe.** El método ([`docs/METODO_DE_TRABAJO.md`](../../../docs/METODO_DE_TRABAJO.md))
> midió que el cuello no es la calidad del código: **330 items quedaron 🧪 «probados y sin
> aterrizar»**, en buena parte pantallas construidas sobre datos que nunca cerraron. Eso pasa
> cuando un pedido se ejecuta tal como llega. Esta skill es el paso que falta entre **leer el
> pedido** y **escribir la primera línea**: entender, ubicar, medir el impacto y decidir cómo se
> va a comprobar.
>
> Esta skill **no repite reglas**: las enruta. La ley vive en [`CLAUDE.md`](../../../CLAUDE.md),
> el método en `METODO_DE_TRABAJO.md`, los tropiezos en [`docs/GOTCHAS.md`](../../../docs/GOTCHAS.md)
> y la verdad del dato en [`docs/VERDAD_ABSOLUTA.md`](../../../docs/VERDAD_ABSOLUTA.md). Si esta
> skill y uno de ellos se contradicen, **gana el documento** y se corrige aquí.

---

## Las cinco capas

Las cuatro primeras son las del método (C0→C3) y **secuencian**: una capa no sube hasta que la de
abajo está verificada. La quinta (C4) no secuencia: **atraviesa** a todas, porque nada está
entregado hasta que llega a prod.

| Capa | Qué es en este repo | Skill que se carga | Verificada cuando… (resumen; el texto que manda está en el método §1) |
|---|---|---|---|
| **C0 · Dato** | Vistas `derive-no-copy` sobre `kepler_ods.*` / `wincaja.*`, migraciones | [`capa-datos`](../capa-datos/SKILL.md) | Origen documentado, unidad probada, cifra arbitrada contra un testigo |
| **C1 · Dominio** | `libs/<dominio>`, tipos en `libs/contracts` | [`capa-dominio`](../capa-dominio/SKILL.md) | La regla tiene prueba; consumidores de `contracts` recorridos |
| **C2 · API** | Endpoint NestJS, permiso, `tenant_id` + RLS | [`capa-api`](../capa-api/SKILL.md) | Si escribe: probado contra base real con el payload de la pantalla |
| **C3 · Interfaz** | Pantallas Angular (`view`, `vendor`, `portal`) | [`capa-interfaz`](../capa-interfaz/SKILL.md) → `diseno` | `check:pantalla` antes y después, permiso propio, carga <500 ms |
| **C4 · Plataforma** | CI, `ci-green`, k3s en `md`, migraciones en prod, feeds, secretos | [`capa-plataforma`](../capa-plataforma/SKILL.md) → `entrega` | `/api/health` confirma el commit; migraciones aplicadas una por una |

⛔ **Regla de la capa (método §1):** si C0 no está arbitrada, **no se escribe C3**. Lo que no se
pudo verificar se declara (`unknown`, `measured:false`, NO MEDIDO), nunca se dibuja como cero.

---

## El procedimiento — siete preguntas, en orden

### 1 · ¿Qué se pide de verdad?

- Escribe **el pedido literal** en una línea, y aparte **lo que entiendes que resuelve**: quién
  lo usa, qué cambia para esa persona y cómo se nota.
- Si el pedido trae una solución («pon un botón que…»), busca el problema detrás. A veces la
  solución pedida es la correcta; a veces el problema ya está resuelto en otra pantalla.
- **¿Ya existe?** Antes de proponer nada: `grep` en el código, el roadmap de `CLAUDE.md`, el
  tracker (`01_TRACKER_PROGRESO.md`) y `docs/IMPLEMENTACION/FASES/`. Construir dos veces lo mismo
  es la forma más cara de no entender el pedido.

### 2 · ¿Qué capas toca, y cuál es la más alta?

Recorre el pedido de abajo hacia arriba: **¿de dónde sale el dato? → ¿qué regla lo transforma? →
¿qué endpoint lo sirve? → ¿qué pantalla lo muestra? → ¿cómo llega a prod?** Marca cada capa como
*toca*, *lee* o *no aplica*. La **capa tope** es la más alta que se toca.

Un pedido que suena a C3 («la pantalla muestra mal el total») casi siempre se origina en C0 o C1.
**Diagnostica en la capa donde nace el error, no donde se ve.**

### 3 · ¿Cuál es la fuente de verdad de cada capa tocada?

Lee **antes de opinar**, y cita lo leído con ruta y línea:

| Capa | Leer primero |
|---|---|
| C0 | `REGISTRO_CANONICO_COMPLETO.md` (de dónde sale) + `VERDAD_ABSOLUTA.md` por su índice (con qué se arbitra) + la definición real de la vista |
| C1 | El servicio en `libs/<dominio>` y su `.spec.ts` + el tipo en `libs/contracts` |
| C2 | El controller, su `@RequirePermissions`, y `GOTCHAS.md` §1–§4 |
| C3 | La pantalla, su ruta en `app.routes.ts`, `DESIGN.md` vía la skill `diseno` |
| C4 | `CLAUDE.md` «Datos del entorno», skill `entrega`, `ops/README.md` |

Los documentos grandes (`VERDAD_ABSOLUTA.md`, `GOTCHAS.md`, el tracker) **se leen por índice y
por rango**, nunca enteros.

### 4 · ¿Qué se rompe si cambio esto?

Recorre a los **consumidores reales**, no a los que recuerdas:

```bash
# quién usa un tipo, servicio, endpoint, vista o columna
grep -rn "NombreDelTipo\|nombre_columna\|/api/ruta" apps libs database --include=*.ts --include=*.html --include=*.js --include=*.sql
```

Incluye **plantillas HTML** (un tipo cambiado en `contracts` rompe un template que TypeScript no
revisa), **migraciones posteriores** que dependan de la tabla, **feeds y crons** que escriban en
ella, y la **app del vendedor offline** (Dexie guarda formas viejas en el celular). Lo que no
pudiste recorrer se lista como NO RECORRIDO, no se omite.

### 5 · ¿Qué reglas están en juego?

Recorre las 20 de `CLAUDE.md` contra el plan. Las que **detienen** el trabajo y obligan a
preguntar antes de seguir:

- Necesitas un dato que no se deriva del ODS → **regla 1**: parar y decirlo, no crear un importer.
- La solución pide copiar una tabla → **regla 2**.
- La verificación «necesita» levantar el backend local o invocar Python → **reglas 3 y 4**: hay
  otro camino (CI, lectura de prod, `node`).
- Borrar tablas, columnas o migraciones aplicadas; tocar CORS o credenciales; push o PR; ramas →
  **reglas 5–8**: solo con autorización explícita.
- Escritura pesada (matview, índice, backfill) en horario hábil → **regla 9**.

Si el pedido choca con una regla, **se dice y se propone la alternativa**. La regla gana sobre el
pedido, venga de quien venga.

### 6 · ¿Cómo se va a comprobar cada capa?

Antes de escribir código, escribe **qué prueba va a decir que funciona**, una por capa tocada, y
**qué resultado esperas**. La verificación decidida antes es un criterio; la decidida después es
una justificación.

- La prueba tiene que **poder fallar**. Si no puedes describir el caso en que saldría roja, no es
  una prueba (regla 12).
- Si un número cambia: la consulta del antes, corrida **hoy**, con su fecha (regla 15).
- Si algo no se puede verificar, se dice desde la ficha, no en el reporte final.

### 7 · ¿Qué decido yo y qué decide Edgar?

Según «Notas de operación» de `CLAUDE.md`: las decisiones de **herramienta, diseño y proceso**
las toma Claude y las anuncia con su porqué. Se pregunta **solo** lo que es de Edgar: dinero,
personas, prioridades de negocio, y acciones irreversibles o hacia afuera. Las preguntas van como
**D1…Dn**, cada una con opciones y una recomendación. No se pregunta lo que se puede averiguar
leyendo.

---

## La ficha — lo que se entrega antes de tocar código

Proporcional al tamaño. Un cambio de texto: tres renglones. Una fase: el bloque completo.

```text
PEDIDO      <literal, una línea>
ENTIENDO    <qué resuelve, para quién, cómo se nota>
YA EXISTE   <sí: dónde | no: qué busqué>
CAPAS       C0 toca · C1 lee · C2 toca · C3 toca · C4 migración   → TOPE: C3
FUENTE      <archivos y secciones leídas, con ruta:línea>
IMPACTO     <consumidores encontrados> · NO RECORRIDO: <lo que faltó>
REGLAS      <las que aplican; ⛔ si alguna detiene el trabajo>
PLAN        1. C0 …  2. C1 …  3. C2 …  4. C3 …   (de abajo hacia arriba)
VERIFICO    C0: <consulta + resultado esperado> · C2: <prueba + payload> · C3: <check:pantalla>
RIESGO      <qué puede salir mal y cómo se nota>
DECISIONES  D1 <pregunta> — opciones A/B — recomiendo A porque …   (solo si las hay)
```

Si no hay decisiones abiertas, la ficha **no espera respuesta**: se anuncia y se ejecuta. Si las
hay, se espera solo por las que bloquean; lo demás avanza.

---

## Ayuda para armar la ficha

- **Si retomas un trabajo**, el relevo de `.claude/relevos/<CÓDIGO>.md` es tu punto de partida
  (skill [`relevo`](../relevo/SKILL.md)). Verifica que siga siendo cierto antes de confiar en él.
- **Agentes de solo lectura** (`.claude/agents/`): `investigador` para la fuente de verdad y el
  impacto (preguntas 3 y 4), `auditor` para medir la línea base, `verificador` para intentar
  refutar el resultado. Arrancan sin contexto: pásales la pregunta exacta y las rutas ya
  verificadas.
- Todo lo que pongas en la ficha cumple [`sin-inventar`](../sin-inventar/SKILL.md): nada nombrado
  sin haberlo visto en esta sesión.

## Al terminar

Antes de decir «listo», carga [`cierre-por-capas`](../cierre-por-capas/SKILL.md): revisa capa por
capa contra lo que la ficha prometió, y reporta **verificado / no medido / pendiente** en vez de
«ya quedó». Si el trabajo sigue en otra sesión, deja el [`relevo`](../relevo/SKILL.md).

## Señales de que te saltaste el criterio

- Escribiste código antes de saber de dónde sale el dato.
- El fix vive en C3 pero el número malo nace en C0.
- «Funciona» significa «compiló» o «no dio error».
- Una cifra en el reporte no tiene fecha ni consulta.
- Agregaste un `try/catch` para que «no truene» (ver `GOTCHAS.md` §2: así nacen los 200 OK que no
  guardan nada).
- Preguntaste algo que estaba en el repo.
