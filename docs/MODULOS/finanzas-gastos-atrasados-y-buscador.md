# Finanzas › Gastos — Atrasados y buscador de gastos (GX.88)

## Problema

Quienes aprueban reportaron que «hay gastos que se subieron y no les aparecen». La auditoría en
producción (2026-10-30) encontró dos reglas de «sólo hoy» que escondían trabajo:

1. **Aprobación sólo mostraba el día de hoy.** La bandeja traía lo *sin firmar* de cualquier
   fecha, pero un vale ya aprobado (`aprobada`) o con el comprobante subido después
   (`revision`) sólo aparecía en la pestaña del día en que se levantó, que no se podía volver a
   abrir. Ese día había **5 vales ($78,804.91)** esperando que alguien los diera por comprobados
   sin aparecer en ningún lado.
2. **Al dar de alta un gasto, buscar el folio sólo encontraba solicitudes de HOY** (`[GX.18]`).
   Una solicitud de Kepler de ayer no tenía camino si además el «solicitante» de Kepler no
   casaba con ningún usuario (errores de dedo, `FINANZAS`, `DIRECCION GENERAL`): desde el 2-oct,
   **104 solicitudes** no tenían vale y **53** no le aparecían a nadie en «Mis gastos».

Además no había forma de **buscar** un gasto por folio, nombre, quién lo levantó o quién lo
aprobó.

## Solución

- **Pestaña «Atrasados»** en Aprobación: todos los vales de días anteriores que siguen abiertos
  (sin firmar, con el comprobante por revisar o aprobados esperando su evidencia), **del más viejo
  al más nuevo**. Cada uno dice cuántos días lleva, **qué le falta** y **a quién le toca**
  («te toca» / «espera a quien lo levantó»). La bandeja queda sólo con lo de hoy.
- **Buscador de gastos** UNA vez, **arriba de las pestañas** de Gastos (Aprobación · Mis gastos · Expediente · Historial), sólo para quien tiene permiso de aprobar. Lo escrito se conserva al cambiar de pestaña. Busca en
  **todos los vales** (cualquier fecha y estado) por folio, proveedor, quién lo levantó, quién lo
  cerró, quién subió la evidencia, departamento y quién lo pidió en Kepler, y aparte en las
  **solicitudes de Kepler que nunca se subieron**. Palabras en cualquier orden, sin acentos y
  tolerando errores de dedo. Un vale encontrado se abre en el visor con sus acciones.
- **Alta del gasto:** el folio **exacto** encuentra también la solicitud de días anteriores que
  todavía no tiene vale. Lo parcial, el monto y el texto siguen siendo sólo de hoy.

## Cómo se implementó

- `libs/finance/.../etapas-del-dia.ts`: `ESTADOS_CERRADOS` (validada, rechazada), `queFalta()`
  (texto + a quién le toca) y `diasDeAtraso()` (días de calendario; fecha ilegible = `null`).
- `expense-proofs.service.ts`:
  - `delDia()` devuelve `atrasados` (de otro día y no cerrados, `ORDER BY created_at ASC`) con
    `atrasados_total` y `atrasados_truncada`; `filas` queda sólo con el día.
  - `buscarGastos()` (nuevo): busca en `analytics.expense_requests` **desde el primer vale de la
    Suite** con `applySmartSearch` (el primitivo de búsqueda que ya usa Caja General) y en
    `finance.v_expense_proofs` por sus campos o por estar ligado a una solicitud que coincidió.
  - `searchSolicitudes()`: el folio exacto busca desde el inicio de la Suite y sin vale.
  - El armado del renglón (columnas + Kepler por punto + archivos firmados) se sacó a
    `columnasDelDia()` / `detallarDelDia()`, que comparten el día, los atrasados y el buscador.
- `GET /finance/expenses/proofs/buscar?q=` con `FINANCE_EXPENSES_COMPROBAR`, declarado antes de
  `GET :id`.
- `components/buscador-gastos.component.ts`: el buscador, UNO para las tres pantallas. Busca y muestra; al
  elegir un vale lo EMITE y la página decide qué se puede hacer: en Aprobación se decide; en
  Historial y Expediente sólo se consulta y se puede sumar evidencia (ahí no se firma).
- `finanzas-aprobacion-gastos.component.ts`: pestaña Atrasados, buscador con espera de 350 ms
  (Enter busca ya), y **un solo renglón** (`<ng-template #fila>`) para bandeja, atrasados y
  resultados.

## Por qué así

- **Kepler se busca sólo desde el primer vale de la Suite.** Medido en prod: la misma búsqueda
  sobre la vista entera tardó **20–30 s** (recorre `kepler_ods.kdm1`, 751 mil filas); con la
  fecha acotada usa el índice `ix_kdm1_compra_fecha` y tarda **~130 ms**. Y una solicitud de
  antes de la Suite «sin vale» no es trabajo pendiente: es historia. La pantalla dice desde qué
  fecha busca.
- **Atrasados se ordena del más viejo al más nuevo** y dice a quién le toca: un atrasado que no
  dice de quién depende se queda atrasado.
- **Lo cerrado se excluye con `whereNotIn(ESTADOS_CERRADOS)`**, no con una lista de pendientes:
  un estado nuevo cae a la vista en Atrasados en vez de desaparecer.
- **Un solo buscador compartido**: tres copias del mismo buscador se separan a la primera corrección.
- **El buscador es sólo para quien aprueba** (componente y servidor; el Historial se abre también con `VER`, y ahí no aparece): deja ver el gasto de
  toda la empresa, que es lo que `COMPROBAR` ya concede en el Expediente.

## Medido en producción (sólo lectura, 2026-10-30)

| Qué | Resultado |
|---|---|
| `delDia` | 212–247 ms · Atrasados = los 5 vales ($78,804.91), del de 66 días al de 1 |
| Buscador | 75–253 ms (folio, nombre con y sin errores de dedo, texto, nada) |
| Alta, folio exacto de otro día sin vale (`10570`) | ahora aparece |
| Alta, folio exacto con vale (`10287`) | no aparece |
| Alta, parcial / texto | sólo hoy, como antes |

## Pendiente / declarado

- Sin validación visual en navegador.
- No cubre los nombres mal escritos en Kepler: eso se corrige donde se captura la solicitud.
- La búsqueda del alta conserva la regla de alcance: quien tiene áreas asignadas sólo ve
  solicitudes donde su nombre coincide con el solicitante.

## Optimización de las cuatro pestañas (GX.90, 2026-11-05)

Medido con el código de producción (`7a399609b`) contra la base de producción, en sólo lectura, 5 vueltas por llamada:

| Llamada al abrir | Antes | Después |
|---|---|---|
| **Expediente** | **20,076 ms** (máx. 25 s) | **768 ms** |
| Mis gastos · tus vales | 779 ms | 419 ms |
| Historial · día | 448 ms | 167 ms |
| Aprobación · bandeja | 201 ms | 184 ms (ya con Atrasados) |

- **Expediente:** buscaba los gastos de Kepler de cada vale con una subconsulta POR VALE sobre `analytics.expense_documents`, donde el folio de la solicitud es un `CASE` y no puede usar índice. Ahora usa `gastosPorSolicitud` (una consulta para todos, ~120 ms), el mismo puente que ya usaban Mis gastos e Historial.
- **Mis gastos / Historial:** `acreedor` de `analytics.expense_requests` es un `LATERAL` sobre `kdxd` sin índice por `btrim(c2)` (~400 ms). Ahora el nombre se trae una vez por clave (`acreedoresPorClave`), con la regla de la vista.
- **Aprobación:** las búsquedas a Kepler, una por sucursal y en serie, pasan a una sola.
- **Sin migraciones.** Y lo más importante: **la respuesta es idéntica** antes y después (Expediente 1,630 vales, Mis gastos 202, Historial 29 y 500), comparada campo por campo; el comparador detecta un cambio de un centavo (control).
