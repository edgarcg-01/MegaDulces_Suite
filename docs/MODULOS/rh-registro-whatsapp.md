# Recursos Humanos › Reclutamiento — el registro por WhatsApp

## RH.3.3.2 · Revisar que el CV sea un CV (2026-10-14)

### Problema

Cuando el bot pedía el CV, cualquier archivo que llegara se tomaba como CV. En Mega Talento eso dejó expedientes con
recibos de luz, credenciales y fotos en lugar del currículum, y la postulación se daba por completa.

### Solución

- Antes de completar la postulación, se revisa el archivo con visión. Sólo pasa un CV o una hoja de solicitud de empleo
  llenada (aunque sea a mano).
- Si es otra cosa, se le dice qué parece («un comprobante — es un recibo de CFE») y qué sirve. Si no se alcanza a leer,
  se le piden consejos para otra foto, sin decirle que mandó lo incorrecto.
- Si la revisión no se puede hacer (la IA está caída, por ejemplo), el CV se acepta y queda marcado para que RH lo vea.

### Cómo se implementó

- `validar-cv.ts` tiene la regla y los mensajes; `validar-cv.service.ts` le pregunta a Claude (Haiku, con visión) qué
  es el archivo.
- El resultado queda en la ficha del candidato (`portal_data.validacion_cv`), con la marca de «revisar» cuando hubo duda.
- Pruebas comprobadas rompiendo el código a propósito.

### Por qué así

Rechazar un CV de verdad le cierra la puerta a alguien que ya contestó doce preguntas; por eso, cuando no se puede
revisar, se acepta y se avisa a RH en lugar de rechazar. Lo ilegible no se acepta porque tampoco lo podría leer RH. En
la Suite el CV en Word no se acepta (sólo PDF o foto, igual que en la página de empleo).

## RH.3.3.1 · Notas de voz (2026-10-14)

### Problema

Mucha gente contesta por audio: es más rápido y hay quien escribe con dificultad. El bot no entendía las notas de voz,
así que la persona se quedaba atorada en la misma pregunta.

### Solución

- La nota de voz se convierte en texto y cuenta como si la persona lo hubiera escrito: sirve para contestar, para los
  comandos y para corregir.
- Siempre se le repite lo que se entendió («🎤 Escuché: …»), para que lo corrija si quedó mal.
- Si el audio no se entiende, se le pide que lo repita más cerca, más corto o por escrito, según el caso.

### Cómo se implementó

- Se usa el servicio de transcripción que la Suite ya tenía (Groq Whisper), con tres opciones nuevas que no cambian lo
  que ya hacía: el nombre del archivo (para que reconozca el formato de WhatsApp), una lista de palabras de la casa
  («anaquelista», «CURP») y temperatura 0.
- `libs/hr/src/lib/talent/bot/voz.ts` descarta las frases que Whisper inventa cuando hay silencio («Gracias por ver el
  video») y arma el eco y los mensajes de falla.
- Pruebas comprobadas rompiendo el código a propósito.

### Por qué así

Una transcripción equivocada que se guarda sin avisar deja un dato falso en el registro; repetirla le da a la persona la
oportunidad de corregirla. Y es mejor pedirle que repita que guardar una frase que nunca dijo.

## RH.3.2.1 · Entender mensajes con varios datos y contestar dudas (2026-10-13)

### Problema

El registro preguntaba un dato a la vez y tomaba cada mensaje como la respuesta a esa pregunta. Pero la gente escribe
«hola, soy Ana de Canindo y busco de cajera» en el primer mensaje, o pregunta «¿cuánto pagan?» a media captura. Sin
entenderlo, el bot le volvía a pedir uno por uno datos que ya había dado, o tomaba la pregunta como si fuera su nombre.

### Solución

- Del mensaje se sacan los datos que la persona menciona, y se guardan los que estén bien. Luego se le pide sólo lo que
  falta.
- Si pregunta algo, se le contesta primero, con datos reales de las vacantes publicadas (sueldo, horario, requisitos) y
  de las sucursales. Si el dato no está, se le dice que Capital Humano se lo confirma. Nunca se le promete la plaza.
- Si la IA no está disponible, el registro funciona igual que antes, pregunta por pregunta.

### Cómo se implementó

- `libs/hr/src/lib/talent/bot/interprete-registro.service.ts`: consulta a Claude (Haiku) con el cliente compartido de
  la Suite, pidiendo sólo los campos que faltan. Si falla o tarda más de 8 segundos, no responde nada y se sigue sin IA.
- `registro.ts` decide cuándo consultar y revisa cada dato propuesto con los mismos validadores de la captura a mano
  (RFC, NSS, correo, puesto y ciudad claros). Lo que no pasa no se guarda.
- El servicio consulta a la IA sin tener la base ocupada mientras espera, y descarta la propuesta si la conversación
  cambió entretanto.
- Pruebas de la lógica, del intérprete y dos casos contra la base, comprobadas rompiendo el código a propósito.

### Por qué así

La IA sirve para entender cómo escribe la gente, pero no decide: cada dato pasa por las mismas reglas que si se hubiera
tecleado a mano, así que un RFC inventado o un «hola» como puesto no entran. Lo que la IA le contesta a una persona sólo
puede salir de datos reales, porque inventar un sueldo o prometer una plaza es peor que no contestar. El mensaje del
candidato viaja a Anthropic, como ya pasaba en Mega Talento.

## RH.3.2.2 · Orientar a quien pide un puesto que no hay (2026-10-13)

### Problema

Cuando alguien pedía por WhatsApp un puesto que no tenemos abierto, el bot le contestaba «no tenemos esa vacante, te
registramos para futuras» y le seguía pidiendo diez datos más. En Mega Talento se midió: de 543 candidatos, 43 estaban
en ese caso, y muchos sí tenían una vacante para ellos (cinco pidieron «RH» con la Jefatura de recursos humanos abierta).

### Solución

- Si no sabemos en qué ciudad quiere trabajar, se le pregunta primero.
- Se le ofrecen hasta tres vacantes reales de su zona, las más parecidas a lo que pidió («atención al cliente» →
  Cajero(a)). Si en su ciudad no hay, se le dice dónde sí y se le pregunta si le queda.
- Puede elegir por nombre o por número, decir que no, o contestar con su ciudad. Si no se le entiende, se le pregunta
  una vez más y luego sigue el registro: nunca se queda atorado.
- Lo que pidió queda guardado en su ficha, junto con lo que se le ofreció y lo que contestó.

### Cómo se implementó

- `libs/hr/src/lib/talent/bot/orientacion.ts`: la orientación como lógica pura, portada de Mega Talento con sus textos.
- `registro.ts` desvía el puesto inexistente a la orientación (estado `orientando_puesto`); la conversación guarda la
  orientación en `talent.bot_conversations.orientation` y al postularse pasa a `candidates.portal_data.orientacion`.
- Una sola lista de ciudades y un solo detector de saludos para todo el bot.
- Pruebas con los 43 casos reales de Mega Talento, el flujo completo y una conversación contra la base, comprobadas
  rompiendo el código a propósito.

### Por qué así

Ofrecer una vacante que no existe, o una a dos horas de su casa, es peor que no ofrecer nada; por eso las opciones salen
sólo de las vacantes publicadas y se filtran por ciudad. Una diferencia con Mega Talento: en la Suite una vacante sin
sucursales aplica en todas (igual que en la página de empleo), así que también se ofrece; portarlo tal cual la habría
dejado fuera siempre. Guardar lo que pidió le dice a RH qué vacantes vale la pena abrir.

## RH.3.2 · El registro por WhatsApp (2026-10-13)

### Problema

El bot de reclutamiento de Mega Talento (otro sistema, con su propia base) hace el registro de candidatos por WhatsApp.
Para retirarlo, la Suite necesita hacer lo mismo con las mismas reglas que ya tiene la página de empleo. Además, en Mega
Talento el primer «hola» creaba al candidato: había candidatos cuyo puesto decía «Hola» y fichas de gente que nunca
terminó.

### Solución

- El número de reclutamiento conversa con la persona: 12 preguntas en orden (puesto, nombre, correo, ciudad, traslado,
  disponibilidad, empresa anterior, salario, RFC, NSS, familiar en la empresa, si ya trabajó aquí), un resumen que se
  puede corregir por número y la confirmación.
- Puesto y ciudad son obligatorios y tienen que ser claros; un saludo no cuenta como puesto. El correo se puede omitir;
  RFC y NSS sólo si es practicante. Si no sabe su RFC o NSS, se le da el enlace oficial.
- Al confirmar se revisan las reglas de postulación (un proceso a la vez, 90 días para volver a la misma vacante). Si ya
  está en un proceso se le dice en ese momento, sin pedirle el CV.
- El CV es obligatorio, como en Mega Talento. Al llegar, la persona queda como candidata con todo lo que contestó.

### Cómo se implementó

- Tabla `talent.bot_conversations` (migración `20261013150116`): una conversación por teléfono, separada del candidato.
- `libs/hr/src/lib/talent/bot/registro.ts`: la conversación como lógica pura (sin base ni red), portada de Mega Talento
  con sus textos. `vacante-match.ts`: a qué vacante se refiere lo que escribió la persona.
- `HrRecruitmentBotService`: guarda la conversación con un candado por teléfono y usa `HrTalentIntakeService`, el mismo
  de la web (`revisarPostulacion` al confirmar, `postular` al llegar el CV).
- Pruebas de la lógica, del matcher (los casos de Mega Talento) y una conversación completa contra la base, todas
  comprobadas rompiendo el código a propósito.

### Por qué así

Las reglas de postulación viven en un solo lugar: la web y el bot no pueden decidir distinto. La conversación separada
del candidato evita fichas basura. Revisar las reglas al confirmar ahorra pedirle un archivo a alguien a quien después
se le va a decir que no. Lo que todavía no se porta (interpretar con IA, armarle el CV) queda declarado con su número en
el plan de la fase.
