# Fase BU — Un solo buscador

> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).

```
OBJETIVO: Que toda caja de búsqueda de la suite busque igual de bien — varias palabras, cualquier
          orden, proveedor + folio + monto en la misma consulta ("delicias 396 248") — y que el
          usuario DESCUBRA que puede hacerlo, sin motores duplicados.
MÉTRICA:  Servicios de búsqueda sobre el motor canónico `applySmartSearch` —
          HOY (medido 2026-11-06): 22 de 47 · 25 con búsqueda cruda `whereILike '%texto%'` ·
          1 duplicado del motor (`contpaqi/busqueda.ts`)
          → META: los de alto uso migrados, 0 duplicados, para <fecha al abrir>
CAPA TOPE: C3
ÁREA:      Plataforma
DUEÑO:     a definir (sugerido: David Cisneros)
ESTADO:    ⬜  (lista; arranca al liberarse cupo — hoy 6 🔨 contra tope 4)
```

⛔ Antes de pasar a 🔨: fila en el roadmap de `CLAUDE.md` **y** cupo (máximo 4 🔨).

---

## 1. Qué problema resuelve

El motor de búsqueda bueno **ya existe**: `applySmartSearch`
([`libs/platform-core/src/lib/search/smart-search.ts`](../../../libs/platform-core/src/lib/search/smart-search.ts)).
Parte la consulta en palabras (cualquier orden, sin acentos, minúsculas), tiene **columnas
numéricas** (monto y folios con ceros a la izquierda matchean por substring de dígitos), fuzzy por
trigramas, sinónimos de dominio y singular/plural. "delicias 396 248" → `delicias`→proveedor,
`396`→folio, `248`→monto. Es exactamente lo que el usuario recuerda y pide.

**El problema no es que falte: es que no está parejo** (medido 2026-11-06):

- **22 servicios ya lo usan** (catálogo, cotizaciones, clientes, cajas, comprobantes,
  cortes-sucursales, mi-trabajo, servicio, admin, usuarios…).
- **25 servicios siguen con búsqueda cruda** `whereILike '%texto%'` (un solo string en pocas
  columnas de texto, sin partir palabras ni tocar números). Entre ellos **el calendario de pagos**
  ([`payment-calendar.service.ts`](../../../libs/finance/src/lib/payment-calendar/payment-calendar.service.ts),
  el `if (q.search)` busca el string entero en 4 columnas) — por eso ahí "delicias 396 248" no
  encuentra nada. Es la pantalla que motivó la fase.
- **1 duplicado del motor**: [`libs/finance/src/lib/contpaqi/busqueda.ts`](../../../libs/finance/src/lib/contpaqi/busqueda.ts)
  reinventó la misma idea aparte (ADR-056 / regla 16).
- **~100 cajas de búsqueda** en la UI; el valor llega cuando la de más uso enseña lo que puede hacer.

Hoy el usuario **no sabe** que puede combinar palabras: la caja dice "Buscar…" y nada más.

---

## 2. Qué NO incluye

- **No toca los 22 servicios que ya usan `applySmartSearch`** — funcionan; migrarlos sería ruido.
- **No es un cambio de datos** (C0): no hay vista nueva ni tabla; el motor opera sobre las columnas
  que ya trae cada consulta.
- **No agrega una pantalla de ayuda, tour, ni modal de "cómo buscar"** — eso viola el estándar
  ("una sola interfaz por flujo"). Se enseña EN la caja y EN el resultado.
- **No pone fuzzy donde el operador escribe exacto** (cotizaciones ya usa `fuzzy:false` a propósito:
  "altos rollo 25 35" no debe traer "alto rollito"). Cada migración decide su modo.
- **No promete los ~100 inputs de golpe**: se migran por tandas de dinero×uso; "todos" es el
  universo, no el trabajo.

---

## 3. Las capas

### C0 · Dato
Sin cambios de dato. El motor opera sobre columnas existentes de cada consulta. — **N/A, declarado.**

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| BU.1.1 | Retirar `contpaqi/busqueda.ts`; su consumidor pasa a `applySmartSearch` | ⬜ | la spec del puente ContPAQi busca "oscar hernandez" y "HERO84" con el motor único |

### C2 · API
| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| BU.2.1 | **Calendario de pagos** → `applySmartSearch` (texto: beneficiary, concept, doc_ref, payee_code · numérico: folio, monto) | ⬜ | no | consulta real: "delicias 396 248" trae el renglón; cada token por separado también |
| BU.2.2 | Migrar los 25 services crudos en tandas por dinero×uso (bancos, caos, gastos, movimientos, fiscal, logística, RH…) | ⬜ | no | por service: una búsqueda multi-token devuelve lo esperado |

### C3 · UI
| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| BU.3.1 | **Placeholder que enseña**: "Proveedor, folio o monto — ej. delicias 396 248" en cada caja migrada | ⬜ | sin fallas nuevas |
| BU.3.2 | **Resaltar el token que pegó** en la fila del resultado (el resultado enseña la capacidad; es el "valor extra" de D3) | ⬜ | sin fallas nuevas |
| BU.3.3 | (opcional) línea de ayuda bajo la caja vía `aria-describedby` ya existente | ⬜ | sin fallas nuevas |

⛔ Cargar la skill `diseno` antes de tocar el primer archivo. <500 ms por búsqueda.

---

## 4. Decisiones (→ ADR)

| # | Decisión | ADR | Fecha |
|---|---|---|---|
| D1 | Arreglo chico de calendario-pagos: ¿ya o a la agenda de David? | — | pendiente Edgar |
| D2 | Fase BU completa: ¿abrir ahora (qué 🔨 se cierra/pausa) o ⬜ hasta liberar cupo? | — | pendiente Edgar |
| D3 | Valor extra priorizado: resaltar token · sinónimos por dominio · monto±tolerancia | — | pendiente Edgar |
| D4 | El motor único es `applySmartSearch` (platform-core); `contpaqi/busqueda.ts` se retira (ADR-056) | candidato | 2026-11-06 |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Cupo 🔨 excedido (6 vs 4) | Edgar | no abre fase nueva sin cerrar/pausar | decisión D2 |
| `fuzzy` mal elegido mete ruido | dueño fase | trigramas donde se escribe exacto | cada service declara su modo; prueba con caso real |
| El resaltado del token rompe densidad de tabla | dueño fase | marcar texto cambia alto de fila | validación visual, estándar |

---

## 6. Definición de Terminado

- [ ] 1. Métrica remedida: servicios sobre el motor único, antes/después publicado
- [ ] 2. Cada capa verificada o declarada NO MEDIDA (ADR-056)
- [ ] 3. (no aplica: ningún endpoint de esta fase escribe — declarado)
- [ ] 4. Compuerta nueva (si la hay) rota a propósito una vez, rojo verificado
- [ ] 5. `contpaqi/busqueda.ts` retirado; 0 duplicados del motor
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. En prod, o escrito por qué no y qué falta

---

## 7. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-06 | Doc creado. Medido: 22/47 services en `applySmartSearch`, 25 crudos (incl. calendario de pagos), 1 duplicado. Plan en 2 tramos: arreglo chico de calendario-pagos + fase BU. Pendientes D1–D3 de Edgar. | Claude (PM) |
| 2026-11-06 | **BU.2.1 codificado**: calendario de pagos pasa a `applySmartSearch` (columns beneficiary/concept/doc_ref/payee_code/original_amount, numeric original_amount/available_amount). **BU.3.1 codificado**: placeholder «Proveedor, folio o monto — ej. delicias 396 248». Typecheck 0 err; `check:pantalla` 0 fallas nuevas. **Verificado contra prod (sólo lectura, system_identifier 7688376744939610156)**: «bolsas 303 1591» (proveedor+folio+monto) → 1 fila correcta (ACREEDOR BOLSAS DE LOS ALTOS, folio 0000303, $1,591,000); el ILIKE viejo de frase entera → 0. Edgar: aplicarlo a TODOS los buscadores. Rollout iniciado en 3 oleadas (finance / commercial / logistics+fiscal+hr+trade), ~23 services, a revisar diff antes de empujar. BU.3.2 (resaltado) declarado pendiente. | Claude |
