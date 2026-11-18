---
name: cierre-por-capas
description: La revisión OBLIGATORIA antes de decir "listo", "ya quedó", "terminado" o "funciona" en esta suite. Compara lo hecho contra la ficha de `criterio`, capa por capa (C0 Dato · C1 Dominio · C2 API · C3 Interfaz · C4 Plataforma), intenta refutar el propio resultado, aplica la Definición de Terminado del método, actualiza tracker y log (regla 19), commitea con pathspec y reporta verificado / no medido / pendiente. Se invoca con listo, terminado, ya quedó, cerrar item, cerrar fase, commit, reporte, "¿ya funciona?", "¿qué falta?", resumen de lo hecho, entregar.
---

# Cierre por capas — «listo» se demuestra

> El método midió **330 items 🧪 «probados y sin aterrizar»** contra 395 en prod. «Probado» se
> contaba como terminado. Esta skill existe para que «listo» signifique lo mismo para todos: cada
> capa tocada, verificada o declarada, y el estado real escrito donde el equipo lo lee.

## 1 · Contra la ficha, capa por capa

Saca la ficha de [`criterio`](../criterio/SKILL.md) y, para cada capa que decía *toca*, responde
con **evidencia** (comando, consulta, archivo:línea, resultado), no con memoria:

| Capa | Pregunta | Checklist completo |
|---|---|---|
| C0 | ¿El número se arbitró contra el testigo, con fecha? | [`capa-datos`](../capa-datos/SKILL.md) |
| C1 | ¿La regla tiene prueba con un caso rojo? ¿Consumidores recorridos? | [`capa-dominio`](../capa-dominio/SKILL.md) |
| C2 | ¿Si escribe, se probó contra base real con el payload de la pantalla? ¿Permiso repartido? | [`capa-api`](../capa-api/SKILL.md) |
| C3 | ¿`check:pantalla` sin fallas nuevas? ¿Cinco estados? ¿Auditada? | [`capa-interfaz`](../capa-interfaz/SKILL.md) |
| C4 | ¿CI verde, `ci-green`, migraciones, `/api/health`? | [`capa-plataforma`](../capa-plataforma/SKILL.md) |

Lo que la ficha prometió verificar y no se verificó **se dice**. Lo que apareció a medio camino y
no estaba en la ficha también.

## 2 · Intenta refutarte

Antes de reportar, busca la forma en que tu resultado esté mal (`VERDAD_ABSOLUTA.md` R5–R6). En
un cambio grande, pásale la lista de afirmaciones al agente `verificador` (`.claude/agents/`):

- ¿La prueba podía salir roja? Si nunca la viste fallar, rómpela una vez a propósito (regla 12).
- ¿Probaste con superadmin? Entonces no probaste permisos.
- ¿El número sorprende, o cuadra demasiado bien? Las dos cosas piden otra consulta.
- ¿Mediste en prod o en Railway? Verifica el `system_identifier`.
- ¿«Funciona» significa que compiló, que no dio error o que **hace lo que se pidió**? Solo lo
  último cuenta.

## 3 · La Definición de Terminado

Para un **item** basta lo que aplique; para una **fase**, las siete del método §5:

1. Métrica medida otra vez, antes/después publicado.
2. Cada capa verificada o declarada NO MEDIDA.
3. Todo endpoint que escribe ejercido contra base real con el payload de la pantalla.
4. Toda compuerta nueva rota a propósito una vez.
5. Todo primitivo genérico en `libs/` o como deuda con nombre.
6. Tracker, `03_LOG_REVISIONES.md` y roadmap de `CLAUDE.md` al día; ADR si hubo decisión.
7. En prod, o escrito por qué no y qué falta.

## 4 · Dejarlo escrito

- **Tracker** (`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`): el item avanza de estado
  (⬜→🔨→🧪→🚀→✅) con fecha. 🧪 **no** es terminado.
- **Log** (`03_LOG_REVISIONES.md`) al cerrar sprint o si hubo lección.
- **Relevo** (`.claude/relevos/<CÓDIGO>.md`, skill [`relevo`](../relevo/SKILL.md)) si el trabajo
  sigue en otra sesión; si quedó ✅, bórralo o márcalo cerrado.
- **`docs/GOTCHAS.md`** si aprendiste una trampa nueva; **ADR** en `02_DECISIONES_ARQUITECTURA.md`
  si se tomó una decisión técnica.
- **Commit** solo si te lo pidieron o al cerrar el item, sobre `main`, **con pathspec**:

  ```bash
  git commit -m "tipo([CÓDIGO]): qué cambia" -- <rutas>
  ```

  Nunca `git add -A`, nunca `--amend`. ⛔ Push solo si te lo piden (regla 6), y por el carril de
  la skill `entrega`.

## 5 · El reporte

Corto, en este orden. El detalle va al tracker, no al chat.

```text
HECHO       <qué cambia para quién, una frase>
VERIFICADO  C0 … · C1 … · C2 … · C3 … · C4 …   (cada uno con su evidencia en una línea)
NO MEDIDO   <qué no se pudo verificar y por qué>
PENDIENTE   <qué falta para ✅, y de quién depende>
DECIDE      <D1… si quedó algo que es de Edgar>
```

Nunca «ya quedó» sin la línea de VERIFICADO. Si todo se verificó, NO MEDIDO y PENDIENTE dicen
«nada», explícitamente.
