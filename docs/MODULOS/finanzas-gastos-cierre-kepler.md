# Finanzas › Gastos — el vale se cierra cuando Kepler lo aplica (GX.85)

## Problema

La Suite y Kepler llevaban el estado del vale por separado. Kepler podía tener la solicitud en `F`
(«Autorizado y aplicado — el dinero salió») mientras la Suite seguía mostrando el vale como pendiente:
por aprobar, pendiente de comprobación o en revisión. Medido el 2026-10-13: 13 vales abiertos ya estaban
pagados en Kepler, y la gente no sabía cuál de los dos sistemas creerle.

## Solución

La `F` de Kepler cierra el círculo: el vale pasa a `validada` (Historial) sin que nadie tenga que hacer
nada en la Suite. Lo que la Suite rechazó se queda rechazado.

## Cómo se implementó

- `cierre-kepler.ts`: la regla pura. Cierra `recibida`, `aprobada` y `revision` cuando Kepler dice `F`,
  cruzando por `(sucursal, folio)` porque el folio se repite entre plazas.
- `cierre-kepler.service.ts`: un `@Cron` cada 10 minutos. Lee los vales abiertos, busca sólo esos folios
  en `analytics.expense_requests` y actualiza con la condición de estado repetida en el `UPDATE`. Fija el
  tenant (`set_config`) porque la tabla tiene RLS forzado y el cron no tiene request. Firma
  `Kepler: autorizado y aplicado (el dinero salió)` y deja su latido `gastos_cierre_kepler`, con umbral en
  `CRON_JOBS`.
- `cierre-kepler.spec.ts`: la regla, el cruce por plaza, y una prueba negativa (meter `rechazada` entre los
  estados que se cierran la pone en rojo).

## Por qué así

- La `F` acierta 7,949 de 7,949 solicitudes que tienen su gasto: no hay falsos positivos que temer.
- Se escribe el estado (no sólo se pinta distinto) porque el usuario pidió que el estado se base en esto:
  las bandejas, los conteos y el Historial leen `status`, y pintar distinto dejaría los conteos mintiendo.
- `rechazada` no se toca: es una decisión de la Suite. Si Kepler pagó algo que aquí se devolvió, eso lo
  tiene que ver una persona.
- Lo que no hace, declarado: un vale provisional que Kepler aplica se cierra sin su factura, y el cierre
  automático no avisa a quien levantó el vale.
