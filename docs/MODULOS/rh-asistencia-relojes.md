# Recursos Humanos › Asistencia — relojes y personas

## RH.1.8 · Que Salud BD sepa juzgar los latidos de asistencia (2026-10-21)

### Problema

La entrada de checadas y el agente de alertas ya avisan cada vez que trabajan (escriben su «latido»), pero el tablero
de Salud BD no sabía cada cuánto deberían hacerlo. Sin ese dato los mostraba como «no se puede juzgar»: si el lector de
relojes o el agente se caían, nadie se enteraba por el tablero.

### Solución

Se registraron los dos con su ritmo esperado: la entrada de checadas avisa si pasa media hora sin señal del lector
(crítico a las 2 horas) y el agente de alertas, que corre cada 30 minutos, avisa a la hora y media (crítico a las 3).
Un reloj caído no pone roja la entrada: eso ya lo dice el semáforo de Relojes; lo que la pone roja es que el lector
entero deje de hablar.

### Cómo se implementó

- Dos filas en `CRON_JOBS` (`apps/api/src/modules/db-health/db-health.service.ts`): `hr_attendance_ingest` y
  `hr_attendance_agent`.
- La prueba de Salud BD toma las llaves de las constantes que usa el código de RH, así que si alguien las renombra el CI
  se pone rojo. Se comprobó rompiéndola a propósito.
- Va como PR en borrador y **se mergea en el paso 7 del corte**: antes, los dos saldrían en amarillo («declarado y nunca
  reportó») con alerta, porque todavía no corren.

### Por qué así

Un latido sin umbral es una alarma desconectada: existe, pero no suena. Y se espera al corte porque un tablero amarillo
dos semanas por algo que todavía no debe correr enseña a ignorar el tablero.

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
