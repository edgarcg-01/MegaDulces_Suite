# Finanzas › CAOS — la ruta y su dinero

## VP.2.3 · El reporte por ruta dice de cuándo es el dato (2026-10-14)

### Problema

El reporte «la ruta y su dinero» (depósito en la caja fuerte CAOS → entrada a Caja General) decía cuándo respondió el
servidor (`generated_at`), pero no declaraba con el formato común de la Suite de cuándo es el dato. La compuerta de
procedencia del CI lo marcó como deuda nueva y dejó roja la revisión «Lint & test» de `main` y de todos los PRs.

### Solución

La respuesta ahora trae la frescura con el formato común: la última sincronización del espejo de CAOS y su veredicto
(al día, atrasado o sin medir).

### Cómo se implementó

- `CaosPorRuta` (y su tipo en la pantalla, `RutaCajaReporte`) ganan `freshness`, armado con `composeFreshness` y
  `evalInput` de `platform-core` a partir de la misma marca que ya calculaba (`datos_al`).
- El umbral es de 1 hora, el mismo con el que Salud BD da por crítico el carril de CAOS (`caos_movimientos`); sin marca,
  queda «sin medir», nunca «al día».
- `datos_al` se conserva porque la pantalla lo lee; los dos salen del mismo cálculo.

### Por qué así

Un servidor que contesta rápido sobre datos de hace horas se ve igual de fresco si sólo dice cuándo respondió. Con el
formato común, la pantalla y cualquier tablero pueden avisar del atraso con la misma regla que el resto de la Suite.
