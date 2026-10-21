# Recursos Humanos › Asistencia — relojes y personas

## RH.1.15 · Lo que Mega Talento cambió en octubre: marca sin pareja, varios horarios y «Descanso» (2026-10-21)

### Problema

Mega Talento siguió cambiando su cálculo de asistencia después de que lo trajimos (13 y 15 de octubre). Si la Suite
se quedaba con la versión vieja, el día del corte RH vería números distintos de los que ve hoy:

- Cuando el reloj no leía una de las checadas de en medio (por ejemplo, la salida a desayunar), la que quedaba sola era
  siempre la última, y el regreso del desayuno se emparejaba con la salida a comer: una «comida» de 4 horas que le
  descontaba de 3 a 5 horas a la persona. En un mes fueron 40 días.
- Hay personas de piso de venta que trabajan unos días de mañana y otros de tarde. Con un solo horario, todos los días
  del otro turno salían mal medidos.
- RH no tenía cómo decir «este día también descansa» sin mover su descanso de siempre, ni cómo quitarle a unas
  vacaciones el domingo que de todos modos descansaba.
- La tabla semanal decía las horas extra ganadas, pero no las que usó ni cuántas le quedan.

### Solución

- La checada sin pareja ahora es la que deja los descansos más cortos (una «pausa» de menos de 10 minutos no cuenta:
  es checar dos veces). La pantalla y la alerta de desayuno usan la misma regla.
- RH puede ponerle a una persona hasta 4 horarios. Cada día se mide contra el más cercano a la hora en que entró, y el
  día dice contra cuál se midió.
- Incidencia nueva «Descanso» (DSC): esos días son descanso, sin mover el de siempre, aunque caigan en vacaciones.
- La tabla, el PDF y el Excel traen «HE ganó · HE usó · HE saldo».

### Cómo se implementó

- Lógica en `libs/hr/.../logic/` (`horario-deducido.ts::marcaSinPareja`, `detalle-dia.ts`, `reglas.ts`,
  `asistencia-persona.ts`, catálogo de `incidencias.ts`), copiada de Mega Talento `8dd5521` y `8396d3c`.
- Columna nueva `hr.person_schedules.shifts` (migración `20261021090942`), con la misma forma que la de Mega Talento,
  para que la carga única la copie tal cual. El tope de entradas por persona pasa de 3 a 4.
- El saldo de la tabla sale del mismo banco de horas extra de la pestaña Horas extra, al último día del periodo. Si no
  se puede leer, la columna queda vacía y lo dice; no se pinta un cero.
- Pruebas con los ejemplos de Mega Talento (con personas inventadas), comprobadas rompiendo el código a propósito nueve
  veces. La comparación contra los números reales de Mega Talento queda pendiente: necesita su base.

### Por qué así

La Suite tiene que dar el mismo número que Mega Talento el día del corte; si no, RH deja de confiar en la pantalla
nueva. Por eso se copió la regla tal cual, sin «mejorarla». La migración va antes del código porque el cálculo ya lee la
columna nueva. No se trajo la lista de 52 semanas de Mega Talento: la Suite ya elige la semana con flechas y atajos.

## RH.1.12 · Ligar los códigos de reloj a sus personas (2026-10-15)

### Problema

Un reloj checador sólo sabe «el número 214 de Zamora checó»; quién es el 214 lo decide la Suite. Hasta hoy ese enlace
sólo lo hacía la carga única de Mega Talento: en la Suite no había dónde hacerlo. En Mega Talento entran de 3 a 11
personas nuevas por semana. Después del corte, cada una habría aparecido como «Empleado 214»: sin faltas, sin sección y
fuera del reporte de RH, sin que nadie pudiera arreglarlo.

### Solución

- En **Relojes** hay una sección nueva, «Códigos sin persona», con cada número que checa y no tiene dueño: de qué plaza
  y reloj es, el nombre que trae el reloj y cuándo checó por última vez.
- Para cada uno, la Suite **sugiere** a quién podría pertenecer: el mismo número ya ligado en otro reloj de la plaza, o
  una persona con el mismo nombre. RH confirma con un clic; **nunca se liga solo**.
- Si no aparece entre las sugerencias, se puede **buscar** a la persona por nombre o **darla de alta** (sin contraseña ni
  acceso a la Suite) con su sección del reporte.
- Si ese número ya era de otra persona, la Suite lo dice y pide confirmar antes de cambiarlo.

### Cómo se implementó

- El motor que decide quién es quién se pasó de la carga a `libs/hr/.../logic/personas.ts`, para que la bandeja proponga
  con las mismas reglas. La carga conserva su copia porque corre dentro del servidor, donde no está `libs/`; una prueba
  exige que las dos decidan igual.
- `HrAttendanceEnrollmentsService` y la ruta `/api/hr/attendance/enrollments/*`: listar, buscar, ligar (en todos los
  relojes de la plaza), desligar con motivo y dar de alta. Cada cambio queda en la bitácora de personas
  (`identity.user_events`) con quién lo hizo.
- Usa el permiso de administrar relojes, que RH ya tiene: no hubo que repartir uno nuevo ni crear migraciones.
- Pruebas de las reglas, de la bandeja completa contra la base (hasta comprobar que la asistencia ya reconoce a la persona
  con su sección) y de la pantalla, comprobadas rompiendo el código a propósito (siete veces).

### Por qué así

Un enlace equivocado le pasa las faltas de una persona a otra, y eso termina en la nómina: por eso la Suite sólo sugiere
y una persona confirma. Como la asistencia se calcula al momento de consultarla, ligar a alguien días después recupera
todo lo que ya checó. Por eso el corte no tiene que esperar a esto, aunque debe estar listo en su primera semana.
