# Finanzas › Gastos — aviso de las rondas de revisión (GX.86)

## Problema

La gente sube sus gastos a lo largo del día y no sabe cuándo se los van a revisar. Se probó primero bloquear el alta
fuera de dos horarios (8:30–10:00 y 17:00–18:00): medido, el 81 % de los vales de un mes se levantaba fuera de ese
horario, y la decisión fue no bloquear — subir debe seguir siendo libre durante el día.

## Solución

Un aviso en cada pantalla de alta que dice primero **«Puedes subir tus gastos a cualquier hora del día, sin
problema»** y, en la segunda línea, **en qué ronda se revisa el gasto de esa persona**: «ahorita estamos revisando, el
tuyo entra en esta ronda», «se revisa en la ronda de hoy a las 5:00 pm», «… del lunes a las 8:30 am». El horario
completo va abajo, en gris. Al mandar el gasto, el acuse repite la ronda.

## Cómo se implementó

- `libs/contracts/src/finance/rondas-revision-gastos.contract.ts`: rondas (lunes a viernes, 8:30–10:00 am y
  5:00–6:00 pm), próxima ronda, textos y `horaAmPm`. La hora sale siempre de la zona de México.
- `apps/view/.../finanzas/components/aviso-ronda-gastos.component.ts`: la pieza compartida. Se recalcula cada 30 s;
  quien aprueba no la ve; en el link público (`[publico]`) se ve siempre.
- Se usa en `/finanzas/gastos`, en el link de captura y en el diálogo «Adjuntar evidencia». El acuse va en el toast
  de la captura y en la pantalla «Listo» del link.
- No hay nada en el servidor: no se bloquea ni se valida la hora.

## Por qué así

- Un cartel fijo deja de leerse en pocos días; uno que habla del gasto de cada quien («el tuyo se revisa hoy a las
  5:00 pm») contesta su pregunta real y se sigue leyendo.
- Lo primero que se lee es que subir es libre, para que nadie lo tome como prohibición.
- Una sola regla en `libs/contracts` y una sola pieza visual: tres pantallas no pueden decir horarios distintos.
- Supuesto declarado: que en esas horas de verdad se revisa y que el fin de semana no hay ronda. Si cambia, se
  cambia sólo el contrato.
