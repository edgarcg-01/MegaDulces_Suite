# Finanzas › Gastos — horario para dar de alta un vale (GX.86)

## Problema

Los vales de gasto se daban de alta a cualquier hora del día. La decisión del usuario fue concentrar el alta
en dos ventanas para quienes dan de alta sus gastos. Medido antes del cambio (30 días al 2026-10-22): 972 vales
de 46 personas, y el 81 % se levantaba fuera del horario nuevo; la hora pico era las 10:00.

## Solución

Quien sólo da de alta puede hacerlo de **lunes a viernes, de 8:30 a 10:00 y de 17:00 a 18:00** (hora de
México). Fuera de eso el servidor rechaza el alta y la pantalla lo avisa antes de que se llene nada. Subir la
factura de un vale aprobado no tiene horario, y los aprobadores tampoco.

## Cómo se implementó

- `libs/contracts/src/finance/horario-alta-gastos.contract.ts`: las ventanas, los días, la próxima apertura
  («hoy a las 17:00», «el lunes a las 8:30») y quién está exento. Lo leen el servidor y la pantalla.
- `libs/finance/src/lib/expense-proofs/horario-alta.ts`: `asegurarHorarioAlta()`, que responde 403 con el
  mensaje. Se llama en `create()` (usuarios con cuenta) y en el `submit` del link de captura. Si el llamador no
  dice que está exento, no lo está.
- `expense-proofs.controller.ts`: decide la excepción con los permisos del token (`COMPROBAR` o rol de
  plataforma).
- `finanzas-capturar-gasto.component.ts` y `captura-gasto-link.component.ts`: aviso arriba, botón que dice
  cuándo abre, reloj de 30 s y recálculo al enviar.

## Por qué así

- El bloqueo va en el servidor: esconder el botón no basta, una pestaña abierta desde antes o la API lo saltan.
- Una sola regla en `libs/contracts` para que la pantalla y el servidor no digan cosas distintas.
- El aviso va arriba porque avisar hasta el botón haría llenar el vale completo para nada.
- La hora sale siempre de la zona de México, nunca del servidor ni del navegador.
- Lo que no se contempla, declarado: días festivos, tolerancia al cierre, y el horario vive en código.
