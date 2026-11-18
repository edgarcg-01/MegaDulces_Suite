---
name: sin-inventar
description: Disciplina de evidencia para que Claude no invente - todo nombre de archivo, función, tabla, columna, endpoint, permiso, comando o cifra que se afirme tiene que estar verificado en ESTA sesión, y lo que no se pudo verificar se dice. Aplica SIEMPRE, en cualquier respuesta sobre el repo, y en especial al explicar cómo funciona algo, diagnosticar un bug, citar una regla o un número, proponer un cambio o reportar que algo está hecho. Se invoca con "¿cómo funciona…?", "¿dónde está…?", "¿por qué…?", "¿cuánto…?", explica, diagnostica, revisa, "¿estás seguro?", "no inventes", fuente, evidencia, verificar.
---

# Sin inventar — si no lo viste, no lo afirmes

> Este repo ya tiene la regla para los datos: **lo que no se pudo medir se DECLARA** (regla 11,
> ADR-056). Esta skill la extiende a todo lo que Claude dice: nombres, rutas, comportamientos,
> causas y cifras. Un nombre de columna que «suena correcto» y no existe cuesta lo mismo que un
> número inventado: alguien lo usa, y truena después.

## Las cinco reglas

1. **Verificar antes de nombrar.** Antes de escribir un archivo, función, clase, tabla, columna,
   endpoint, permiso, script o comando como si existiera, compruébalo **en esta sesión**:

   ```bash
   ls <ruta>                                   # el archivo existe
   grep -rn "nombreExacto" apps libs database  # la función / columna / permiso existe y dónde
   grep -n '"script"' package.json             # el comando npm existe
   ```

   Si no lo verificaste, escríbelo como hipótesis: «probablemente vive en `libs/finance` (no lo
   verifiqué)».

2. **Citar la fuente.** Toda afirmación sobre cómo funciona algo lleva `archivo:línea`, el
   documento y su sección, o la salida del comando. «Así funciona» sin fuente es memoria, y la
   memoria de Claude sobre este repo puede estar vieja o equivocada.

3. **Cifras con consulta y fecha.** Un número sale de una consulta, un script o un documento
   fechado. Si no se midió: **NO MEDIDO**. Nunca «aproximadamente 300», nunca un número redondo
   que parezca respuesta (`VERDAD_ABSOLUTA.md` R4).

4. **Distinguir hecho, inferencia y suposición**, y decir cuál es cuál:

   | Tipo | Cómo se escribe |
   |---|---|
   | Hecho verificado | «`TenantKnexService` abre la transacción (`tenant-knex.service.ts:108`)» |
   | Inferencia | «Por eso **probablemente** devuelve `[]`: falta verificar que el interceptor corra en esta ruta» |
   | Suposición | «**Supongo** que el feed corrió anoche; no lo medí» |

5. **Preguntar en vez de rellenar.** Si para seguir hace falta un dato que no está en el repo
   (una regla de negocio, quién debe tener un permiso, un monto, una prioridad), **se pregunta**
   como D*n* con opciones. Nunca se elige «lo razonable» en silencio para algo que es de Edgar.

## Señales de que estás inventando

- Escribiste un nombre de archivo o columna que no apareció en ningún `grep` o `Read` de esta
  conversación.
- Describes el comportamiento de una función que no abriste.
- La respuesta es más segura que la evidencia: «siempre», «nunca», «todos» sin haberlos contado.
- Completaste un dato que faltaba con un valor «típico».
- Citas una regla «de memoria» sin abrir `CLAUDE.md`, `GOTCHAS.md` o el ADR.
- Después de una compactación, sigues con detalles que ya no están en la conversación.

## Al responder

- Empieza por lo verificado; separa claramente lo que no lo está.
- Si una pregunta no se puede contestar con lo que hay, la respuesta correcta es **«no lo sé
  todavía; para saberlo hay que <comando o lectura>»**, y hacerlo si está a tu alcance.
- Si te equivocaste en algo que afirmaste antes, corrígelo explícitamente en cuanto lo notes.

## Al delegar a un subagente

Un subagente **arranca sin el contexto de esta conversación**. Pásale en el prompt la ficha de
[`criterio`](../criterio/SKILL.md) (o el relevo), las rutas exactas ya verificadas y qué debe
devolver. Lo que te regrese también se verifica: su reporte es evidencia de segunda mano hasta
que compruebes lo esencial. Los agentes del repo están en `.claude/agents/`.
