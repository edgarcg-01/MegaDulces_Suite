# Recursos Humanos › Reclutamiento — el registro por WhatsApp (RH.3.2)

## Problema

El bot de reclutamiento de Mega Talento (otro sistema, con su propia base) hace el registro de candidatos por WhatsApp.
Para retirarlo, la Suite necesita hacer lo mismo con las mismas reglas que ya tiene la página de empleo. Además, en Mega
Talento el primer «hola» creaba al candidato: había candidatos cuyo puesto decía «Hola» y fichas de gente que nunca
terminó.

## Solución

- El número de reclutamiento conversa con la persona: 12 preguntas en orden (puesto, nombre, correo, ciudad, traslado,
  disponibilidad, empresa anterior, salario, RFC, NSS, familiar en la empresa, si ya trabajó aquí), un resumen que se
  puede corregir por número y la confirmación.
- Puesto y ciudad son obligatorios y tienen que ser claros; un saludo no cuenta como puesto. El correo se puede omitir;
  RFC y NSS sólo si es practicante. Si no sabe su RFC o NSS, se le da el enlace oficial.
- Al confirmar se revisan las reglas de postulación (un proceso a la vez, 90 días para volver a la misma vacante). Si ya
  está en un proceso se le dice en ese momento, sin pedirle el CV.
- El CV es obligatorio, como en Mega Talento. Al llegar, la persona queda como candidata con todo lo que contestó.

## Cómo se implementó

- Tabla `talent.bot_conversations` (migración `20261013150116`): una conversación por teléfono, separada del candidato.
- `libs/hr/src/lib/talent/bot/registro.ts`: la conversación como lógica pura (sin base ni red), portada de Mega Talento
  con sus textos. `vacante-match.ts`: a qué vacante se refiere lo que escribió la persona.
- `HrRecruitmentBotService`: guarda la conversación con un candado por teléfono y usa `HrTalentIntakeService`, el mismo
  de la web (`revisarPostulacion` al confirmar, `postular` al llegar el CV).
- Pruebas de la lógica, del matcher (los casos de Mega Talento) y una conversación completa contra la base, todas
  comprobadas rompiendo el código a propósito.

## Por qué así

Las reglas de postulación viven en un solo lugar: la web y el bot no pueden decidir distinto. La conversación separada
del candidato evita fichas basura. Revisar las reglas al confirmar ahorra pedirle un archivo a alguien a quien después
se le va a decir que no. Lo que todavía no se porta (interpretar con IA, ofrecer vacantes de su ciudad cuando pide un
puesto que no hay, armarle el CV) queda declarado con su número en el plan de la fase.
