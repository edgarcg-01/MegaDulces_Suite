# P-COM-04 — Bandeja: revisar y poner el costo al día

> Paso 4 de 9 · pantalla `/compras/requisiciones` · [índice](README.md)

## 1. Para qué existe este paso

Es la **sala de espera** entre quien arma y quien autoriza, y el lugar donde una requisición vieja
se vuelve verdad otra vez antes de que alguien la apruebe.

## 2. Quién lo ejecuta

| | |
|---|---|
| Ver la bandeja | `COMPRAS_REQUISICIONES_VER` — 10 roles |
| **Recalcular costos** | `COMPRAS_REQUISICIONES_GESTIONAR` — 9 roles |
| Autorizar / rechazar | **NO es este paso** → [P-COM-05](P-COM-05_autorizacion.md) |

## 3. Disparador y entradas

- **Disparador:** existe algo en `pending_approval`. La bandeja avisa aparte de las **atascadas**
  (más de 30 días).
- **Entrada para el recálculo:** `analytics.replenishment_plan` — el costo de caja **de hoy**.

## 4. Qué se hace

1. Elegir la vista: **por lote** (contesta *«¿qué pedí en ese clic?»*) o **por documento**.
2. Revisar los indicadores por estado y la alerta de atascadas.
3. Abrir el documento y revisar renglones.
4. Si la requisición tiene días encima: **Recalcular** → trae los costos de hoy.
5. Darla de baja si ya no procede (queda `cancelled`).

## 5. Qué queda registrado

- **Recalcular** pisa `unit_cost` y `line_cost` de los renglones medibles, actualiza `total_cost` y
  `total_units`, y sella **`recalculated_at` / `recalculated_by`**.
- ⚠️ **Toca sólo el costo, nunca la cantidad.** Cuánto pedir es decisión del comprador;
  recalcularla por abajo le cambiaría el pedido sin avisar.
- ⚠️ Los renglones que **no se pueden medir** se dejan como estaban y se declaran en el resultado.
  Pisarlos con cero sería inventar un costo.

## 6. Controles

| control | qué hace | por qué |
|---|---|---|
| Estado exigido | sólo se recalcula una requisición `pending_approval` o `approved` | recalcular una recibida reescribiría historia |
| Alerta de atascadas | señala las de más de 30 días con su monto | a esa edad el costo capturado ya no es el de hoy en casi todos los renglones |
| Vista por lote | agrupa lo que salió de un clic | una lista plana obliga a leer 18 renglones para entender UN clic |

## 7. Evidencia medida

- **El freno de vigencia es medido, no una política:** a 31–60 días el **83.5 %** de los renglones
  tiene el costo movido; a 60+, el **98.7 %** *(prod, 2026-10-06)*.
- ⛔ **Y casi nadie lo usa: 1 requisición de 901 tiene `recalculated_at`** *(prod, 2026-10-16)*.
  Eso no dice que el resto esté al día — dice que **el recálculo no es parte de la rutina**, y que
  lo que impide autorizar a precio viejo es el freno del paso siguiente, no este botón.
- Cuando se midió la bandeja por primera vez (2026-10-06) había **610 pendientes por $42.7 M**, 24
  días de promedio y 77 días la más vieja. Hoy quedan **14** `pending_approval` por **$60,431.68**.

## 8. Cuando falla

| síntoma | qué significa | qué hacer |
|---|---|---|
| «Sólo se recalcula una requisición pendiente o aprobada» | el documento ya avanzó | no forzar: si el costo cambió después de ordenar, es tema de la entrada |
| Recalcular no movió nada | ningún renglón tenía costo comparable en el plan de hoy | **declararlo**, no aprobar a ciegas: el resultado dice cuántos tocó |
| El agrupado por lote no muestra nada | son requisiciones anteriores al lote | es correcto; empieza a servir con lo que se arme desde ahora |

---

**Documento oficial de este paso:** ninguno. El recálculo deja sello (`recalculated_at/by`) pero no
**constancia de qué cambió** — ver [P-COM-00](P-COM-00_ACTAS_POR_PASO.md) §4.
