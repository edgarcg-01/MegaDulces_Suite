---
name: relevo
description: Guardar y recuperar el contexto de una sesión para que la siguiente (u otra máquina, u otro dev) siga sin perderse ni suponer. Escribe un RELEVO en .claude/relevos/<CÓDIGO>.md con objetivo, estado por capa, lo verificado con evidencia, lo leído, decisiones, lo NO MEDIDO y el siguiente paso. OBLIGATORIO al pausar un trabajo, antes de /clear, cuando la conversación ya es larga, al cambiar de tarea y al cerrar el día; y al RETOMAR, leer el relevo completo antes de hacer nada. Se invoca con relevo, guardar contexto, retomar, continuar donde quedamos, "¿en qué íbamos?", pausa, mañana sigo, /clear, cambio de tarea, handoff, context-save, context-restore.
---

# Relevo — la sesión siguiente no empieza en blanco

> **Por qué existe.** La memoria personal de Claude no se comparte entre máquinas ni entre
> sesiones (`CLAUDE.md`, «Modo de trabajo»). Varias sesiones trabajan sobre el mismo árbol, y
> una conversación larga se **compacta** y pierde detalle. Lo que la sesión no tiene escrito,
> lo reconstruye de memoria, y ahí es donde se inventa.
>
> El hook `scripts/hooks/contexto-al-iniciar.js` le muestra a cada sesión nueva los relevos de
> las últimas 72 h. Esta skill es cómo se escriben para que sirvan.

## Dónde vive

- **`.claude/relevos/<CÓDIGO>.md`**, un archivo por objetivo (`CGA-A.33.md`, `VND.1.md`). Si no
  hay código de tarjeta, usa el del área (`OPS-feeds.md`) o pide la tarjeta.
- La carpeta está en `.gitignore`: es **memoria de trabajo**, no documentación. Lo que el equipo
  debe saber al final va al tracker, al log, a `GOTCHAS.md` o a un ADR (skill
  [`cierre-por-capas`](../cierre-por-capas/SKILL.md)).
- Un archivo por objetivo, no por sesión: dos sesiones con objetivos distintos no se pisan.

## Guardar — el formato

Escríbelo **completo**, aunque sea corto. La próxima sesión no vio esta conversación.

```markdown
# Relevo — [CÓDIGO] título corto

Actualizado: 2026-11-18 13:40 · Quién: <dev> · Rama: main @ <sha>
Objetivo: <una frase: qué cambia para quién>
Capa tope: C3 · Plan maestro: <doc:sección, si viene de uno>

## Estado por capa
- C0: ✓ verificado — <evidencia: consulta + resultado + fecha>
- C1: 🔨 a medias — <qué falta>
- C2: — no aplica
- C3: ⬜ sin empezar

## Hecho (con evidencia)
- <qué> — <archivo:línea | comando | commit sha>

## Fuentes leídas
- <ruta:sección> — <qué se sacó de ahí>

## Decisiones
- Tomadas: <qué, por qué, quién>
Decide: D1 <pregunta abierta para Edgar> — recomiendo <A>

## NO MEDIDO / dudas
- <lo que no se pudo verificar y por qué>

## Archivos tocados (sin commitear)
- <ruta> — <qué cambió>

## No tocar
- <archivos o temas que son de otra sesión, o que esperan una decisión>

Siguiente paso: <la PRIMERA acción concreta de la próxima sesión, con archivo o comando>
```

Reglas del contenido:

- **Solo hechos con evidencia.** Lo que crees pero no comprobaste va en «NO MEDIDO / dudas»,
  nunca en «Hecho».
- **El siguiente paso es una acción**, no un tema: «cambiar `.chipbar .chip` a `min-height:
  var(--tap-min)` en `vendor-take-order.component.ts:731`», no «seguir con los chips».
- **Reescribe, no acumules.** El relevo es el estado actual; la historia vive en git y en el log.

## Cuándo guardar

- Al **pausar** o al terminar el día, aunque falte mucho.
- **Antes de `/clear`** y cuando la conversación ya es larga (antes de que se compacte).
- Al **cambiar de objetivo** en la misma sesión.
- Justo **después de una decisión** importante o de un hallazgo que cambia el plan.

## Retomar

1. El hook ya te mostró los relevos recientes. Si el usuario dice en qué trabajar, **lee ese
   relevo completo** con Read; si no lo dice, **pregunta** cuál. No elijas tú una tarea.
2. **Verifica que el relevo siga siendo cierto** antes de confiar en él: ¿los archivos que dice
   «tocados» siguen así (`git status`, `git diff`)? ¿Alguien commiteó encima (`git log` desde el
   sha del relevo)? Si algo cambió, dilo y ajusta el plan.
3. Si el relevo viene de un **plan maestro**, relee su sección (objetivo, DoD, dependencias).
4. Arranca por el «Siguiente paso». Si ya no aplica, explica por qué.

## Después de una compactación

Si el hook avisa «SE COMPACTÓ LA CONVERSACIÓN»: relee el relevo de tu objetivo y los archivos
que estabas tocando **antes** de la siguiente edición. Si no habías escrito relevo, escríbelo
ahora con lo que puedas verificar en el árbol, y marca como duda lo que solo recuerdas.
