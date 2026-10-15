# Fase XX — <nombre>

> Plantilla. Copiá este archivo a `FASE_XX_<NOMBRE>.md` y borrá esta línea.
> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).

```
OBJETIVO: <una frase: qué cambia y para quién>
MÉTRICA:  <nombre del número> — HOY: <valor MEDIDO, con fecha> → META: <valor> para <fecha>
CAPA TOPE: C0 | C1 | C2 | C3
ÁREA:      Comercial | Finanzas | Logística | RH | Plataforma | Trade
DUEÑO:     <nombre>
ESTADO:    ⬜ | 🔨 | 🧪 | 🚀 | ✅ | ⏸️ | ❌
```

⛔ Sin el «HOY» medido, la fase **no se abre** — queda ⬜ y su primer item es medirlo.
⛔ Antes de pasar a 🔨: **fila en el roadmap de `CLAUDE.md`**. Sin fila, la fase no existe.
⛔ Antes de pasar a 🔨: que haya cupo. **Máximo 4 fases 🔨** en todo el proyecto.

---

## 1. Qué problema resuelve

<El hecho medido que la motiva — no la idea. Un número, una fecha, y qué cuesta hoy.>

---

## 2. Qué NO incluye

<Lo que alguien va a suponer que entra y no entra. Escribirlo ahorra el malentendido.>

---

## 3. Las capas

### C0 · Dato
| # | Item | Estado | Verificado contra |
|---|---|---|---|
| XX.0.1 | <vista `derive-no-copy` sobre `kepler_ods.…`> | ⬜ | <testigo independiente, mismo grano> |

⛔ Sin importer. Unidad probada de ambos lados. Lo que no se pudo verificar **se declara**, nunca se dibuja como 0.

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| XX.1.1 | <regla en `libs/<dominio>`> | ⬜ | |

### C2 · API
| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| XX.2.1 | <endpoint> | ⬜ | sí/no | <⛔ si escribe, obligatoria, con el payload de la pantalla> |

### C3 · UI
| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| XX.3.1 | <pantalla> | ⬜ | <N → N, sin fallas nuevas> |

⛔ Cargar la skill `diseno` **antes** de tocar el primer archivo. Permiso propio + entrada de sidebar. <500 ms.

---

## 4. Decisiones (→ ADR)

| # | Decisión | ADR | Fecha |
|---|---|---|---|

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|

⛔ Un bloqueo sin dueño no es un bloqueo, es un item olvidado.

---

## 6. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Toda compuerta nueva **rota a propósito una vez**, rojo verificado
- [ ] 5. Todo primitivo genérico en `libs/` compartido **o** deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta

---

## 7. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
