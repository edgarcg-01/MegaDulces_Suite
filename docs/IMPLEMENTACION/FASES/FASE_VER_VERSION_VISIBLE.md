# Fase VER — La versión que corre en producción se dice, se lee y se puede nombrar

```
OBJETIVO: que cualquiera —en una sucursal, en Dirección o en soporte— sepa qué versión está
          corriendo, de cuándo es y qué trae, sin preguntarle a un desarrollador.
MÉTRICA:  aplicaciones que muestran su versión a quien las usa —
          HOY: 0 de 3 (medido el 2026-11-19) → META: 3 de 3, con fecha y «qué trae»
CAPA TOPE: C3
ÁREA:      Plataforma
DUEÑO:     por asignar (lo decide el PM al abrirla)
ESTADO:    ⏸️  — NO se abre: hay 8 fases 🔨 contra un tope de 4 (ver §7)
```

> Decisión que la gobierna: **ADR-122** (`02_DECISIONES_ARQUITECTURA.md`).
> Método: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Carril de entrega que toca: skill [`entrega`](../../../.claude/skills/entrega/SKILL.md).

---

## 1. Qué problema resuelve

Hoy la **única** respuesta a «qué está corriendo» es un identificador técnico de nueve caracteres
que devuelve una dirección interna. Medido el 2026-11-19:

| Hecho | Medición |
|---|---|
| Lo que publica producción | `/api/health` → `{"status":"ok","uptime":…,"commit":"9552bf79a"}` |
| Aplicaciones que muestran su versión a quien las usa | **0 de 3** (suite, portal, vendedor) |
| Archivo de versión en el repo | no existe; `package.json` quedó en `1.0.0` |
| Etiquetas de entrega en git | 9 etiquetas, **ninguna** es una entrega (son rescates y respaldos) |
| Entradas del CHANGELOG | **958** |
| …que dicen si están en producción | **232** (57 «en código, sin soltar» · 175 «en prod» · 3 «sin aplicar»). **Las otras 726 no dicen nada.** |
| Cómo se escribe ese estado | **a mano**, por quien se acuerda |

El costo no es estético. El 2026-11-18, al bajar los cambios del día, aparecieron **cinco entradas
duplicadas** del mismo cambio: una decía «en código, sin soltar» y la otra «en prod». Nadie mintió
— dos personas anotaron el mismo hecho en momentos distintos, y la fusión conservó los dos lados.
**Un estado que escribe una persona a mano se contradice solo.**

Y el identificador de commit, que para las máquinas es exacto, para una persona no distingue nada:
no dice si es de hoy o de hace tres semanas, ni qué trae. Quien reporta un problema desde una
sucursal no puede decir qué versión tiene, y quien lo atiende no puede saber si el arreglo ya está
en la máquina de esa persona.

---

## 2. Qué NO incluye

- **No retira el commit.** Sigue en `/api/health` y sigue siendo lo que leen `sellar`,
  `auto-deploy.sh` y el vigía. Es la verdad para las máquinas; lo que se agrega es la capa para
  las personas. (ADR-122, punto 1.)
- **No reescribe el CHANGELOG hacia atrás.** Las 726 entradas sin estado se quedan como están: el
  estado automático empieza desde la fecha de corte. Rellenarlas a mano sería repetir el defecto
  que la fase cierra.
- **No es un sistema de despliegue nuevo.** No toca `sellar`, `soltar.sh` ni el vigía más allá de
  que el acto de soltar escriba el número y la fecha.
- **No promete compatibilidad entre versiones.** La suite tiene un solo cliente; el número de
  producto es un nombre, no un contrato de interfaz (ADR-122, «Rechazado»).
- **No incluye notificar a cada usuario** que hay versión nueva. Es otro trabajo y otra decisión.

---

## 3. El universo y el trabajo

| | |
|---|---|
| **Universo** | 958 entradas de CHANGELOG y 3 aplicaciones |
| **El trabajo** | **3 pantallas** (una por aplicación), **un endpoint** y **un paso del carril de entrega**. Las entradas viejas no se tocan. |

---

## 4. Decisiones a firmar

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **D1** | Quién mueve el número de producto (`1.4` → `1.5`) | (a) sólo Edgar · (b) cualquier dev al cerrar una fase · (c) automático con los `feat` | **(a)**. Es lo único del esquema que tiene significado humano, y sólo lo tiene si lo da una persona. Automático se vuelve un contador y duplica a la fecha. |
| **D2** | Dónde se ve en la suite | (a) pie de página · (b) menú del usuario + una pantalla «Versión» con qué trae · (c) sólo en la pantalla de ayuda | **(b)**. Un pie de página se ve pero no lleva a nada; la gracia es que el número lleve a su contenido. |
| **D3** | Qué pasa con las 726 entradas sin estado | (a) dejarlas · (b) rellenarlas a mano · (c) inferirlas por la fecha | **(a)**, dicho en el encabezado del archivo. (c) inventa un hecho que nadie midió. |
| **D4** | Qué se hace si en 60 días el número de producto sigue en `1.0` | (a) quitarlo · (b) dejarlo | **(a)**. Un número que nadie mueve miente, y entonces estorba más de lo que ayuda. Se revisa el **2027-01-19**. |

---

## 5. El orden y las capas

Una capa no sube hasta que la de abajo tiene árbitro.

### C0 · Dato — de dónde sale la versión
| # | Item | Estado | Verificado contra |
|---|---|---|---|
| VER.0.1 | El acto de soltar calcula `mayor.menor.parche` y la fecha, y los hornea en la imagen junto al commit | ⬜ | `/api/health` devuelve los mismos valores que el registro de la entrega |
| VER.0.2 | Registro de entregas: una fila por cada vez que `prod-release` se movió (número, fecha, commit) | ⬜ | el historial de `prod-release` en git |

⛔ Sin importer y sin tabla copiada: la fila se escribe en el momento de soltar, no se reconstruye después.

### C1 · Dominio — la regla
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| VER.1.1 | Regla de cálculo del número (parche automático; producto manual) | ⬜ | la prueba la ejerce con dos entregas el mismo día |
| VER.1.2 | Las notas de una versión se derivan de lo que entró entre dos entregas | ⬜ | contra un tramo real ya soltado |
| VER.1.3 | El acto de soltar marca «en prod desde» en lo que entró — ninguna persona lo escribe | ⬜ | prueba negativa: un tramo sin soltar NO queda marcado |

### C2 · API
| # | Item | Estado | |
|---|---|---|---|
| VER.2.1 | La versión, su fecha, el commit y sus notas se publican por API | ⬜ | el commit se conserva tal cual (ADR-122, 1) |

### C3 · Interfaz
| # | Item | Estado | |
|---|---|---|---|
| VER.3.1 | La suite muestra su versión y lleva a «qué trae» (D2) | ⬜ | obligatoria la skill `diseno` |
| VER.3.2 | Portal y vendedor, lo mismo | ⬜ | |

---

## 6. Prioridad, dicha sin maquillaje

Con la regla de Edgar (dinero en juego × esfuerzo):

| | |
|---|---|
| **Dinero en juego** | **Bajo** — beneficio indirecto (orden, soporte, adopción). No hay un peso que se pare hoy por no tenerlo. **NO MEDIDO** en pesos, y no se infla. |
| **Esfuerzo** | **M** (≤ 1 semana) |
| **Prioridad que sale de la tabla** | **4** |

**Eso es exactamente por qué esta fase no desplaza a ninguna de las 8 abiertas.** Dicho de otro
modo: resuelve una molestia real y repetida, pero ninguna de las fases en curso debería cerrarse
antes para hacerle lugar.

---

## 7. Por qué queda ⏸️ y qué la abriría

Medido el 2026-11-19 con `node .claude/skills/pm/tablero.js`: **8 fases 🔨** (LE · RH · GP · PGP ·
PQ · DN · UB · MDT) contra un tope de **4**, y **7 fases 🧪** esperando aterrizar.

Para abrirla tendrían que **cerrarse o pasar a ⏸️ cinco** de las ocho. Ninguna candidata obvia sale
de esta fase: la decisión es del PM. Mientras tanto el documento existe, la decisión está escrita
(ADR-122) y no se gasta cupo.

---

## 8. Bitácora

| Fecha | Qué pasó |
|---|---|
| 2026-11-19 | Edgar pide alternativas al identificador de commit y aprueba combinar las tres capas (número de producto + fecha + notas). Se mide el HOY, se escribe ADR-122 y esta fase queda ⏸️ por cupo. |
