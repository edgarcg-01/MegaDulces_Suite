# Recursos Humanos › Asistencia — relojes y personas

## RH.13.5 · Asistencia en una sola pantalla · RH.6.6 Visita fuera · RH.6.7 Pago de horas extras · RH.13.7 (2026-11-13)

### Problema

- **Seis páginas para una tarea.** Para revisar la semana de una plaza había que pasar por Checadas, Tolerancia,
  Faltas, Incidencias y Relojes, cada una con su menú y su filtro. En la auditoría del 11 de noviembre, a 1440×900 la
  primera persona aparecía al 76 % del alto de la pantalla y sólo se veían 3 de 7 personas.
- **Las tablas costaban leerlas**: sin rejilla, con columnas que no cabían en una laptop y nada pensado para teléfono.
- **Faltaban dos incidencias de Mega Talento**: Visita fuera y Pago de horas extras.
- **«Corporativo Comida»** seguía como plaza activa aunque su reloj ya estaba unido a Corporativo.

### Solución

- **Una pantalla:** Checadas, con Tolerancia y Faltas como modos, e Incidencias y Relojes en un panel. Las ligas viejas
  siguen funcionando y llevan ahí; quien no ve Asistencia (Contabilidad con Incidencias) conserva su página.
- **Más fácil de leer:** tablas con cuadros, buscador de todas las plazas arriba, calendario para elegir la semana,
  «PDF para firmar» como única exportación, la franja de relojes sólo para quien los administra, y en teléfono una
  vista con lo esencial. La primera persona sube al 49 % del alto, se ven las 7 y cada fila baja de 61 a 44 px.
- **Visita fuera:** justifica el día y suma el lapso de la visita a sus horas, sin tocar su saldo de horas extra.
- **Pago de horas extras:** descuenta del saldo lo que se le pagó; la pestaña Horas extra suma la columna «Pagadas».
- **Corporativo Comida** queda desactivada (no se borra).

### Cómo se implementó

- Las rutas viejas pasan por una guarda que lleva a la pantalla única con lo que traían en la URL; el menú deja de
  repetir Incidencias y Relojes a quien ya los ve dentro de Asistencia.
- La tabla se compacta por el ancho de su contenedor, no de la ventana: el menú lateral abierto o cerrado cambia el
  espacio real.
- Las dos incidencias nuevas no necesitan migración: el tipo es texto y las columnas que usan ya existían. Aun así,
  una prueba contra la base las captura con el mismo cuerpo que manda la pantalla y comprueba que el servidor rechaza
  un pago en dos días o una visita sin quién autorizó.
- La migración de Corporativo Comida sólo desactiva la plaza, deja una marca para poder revertir sólo lo suyo, y se
  niega si hay un reloj activo ahí.

### Por qué así

RH revisa la semana de una plaza de corrido; partirla en seis páginas la obligaba a armarla en la cabeza. Las dos
incidencias nuevas siguen las reglas de Mega Talento para que la paridad con el sistema anterior siga en cero
diferencias.

### Pendiente

- Confirmar con RH que no extrañan el Excel y que no necesitan ver los minutos de desayuno y comida cuando no se pasan.
- `[RH.13.4]`: «Sin dato» en vez de «Falta» día por día cuando el reloj no entregó (más importante ahora que la franja
  de relojes es sólo para administradores).
- `[RH.14.1]`: que la baja en RH quite el acceso a la Suite. Es una decisión de accesos y la toma Edgar.

## RH.13.1 · Un reloj caído ya no sale verde · RH.13.2 · Incidencias con nombre (2026-11-12)

### Problema

- **El reloj.** Si el lector no alcanza a un reloj (sin red, apagado, IP cambiada), sigue avisando cada pocos minutos
  «estoy vivo, pero falló esto». La Suite contaba ese aviso como señal del reloj y lo pintaba **verde**. En la auditoría
  del 11 de noviembre, el reloj de una sucursal no entregaba desde las 11:40 y a las 16:10 seguía en verde, mientras el
  reporte del día le marcaba 23 faltas a su gente. Como el semáforo decía «al día», tampoco salía el aviso de que un día
  sin dato no es una falta.
- **Las incidencias.** La lista y la ficha mostraban sólo el número de la persona («#101»). Para saber de quién era una
  falta antes de calificarla, RH tenía que ir a otra pantalla.

### Solución

- Con error del lector, lo que cuenta es la **última lectura buena** del reloj. Un reloj que no entrega nunca sale verde:
  amarillo mientras la última lectura tenga menos de 2 h, rojo después. La franja dice «última lectura hace 4 h 30 m»
  junto al error que reportó el lector, en vez de «hace 2 min».
- Cada incidencia trae el **nombre de la persona en esa plaza**, junto a su número, en la lista y en la ficha.

### Cómo se implementó

- `semaforoReloj` (`libs/hr/.../logic/relojes.ts`) recibe el error y los segundos desde `last_sync_at`, que sólo se
  actualiza cuando la lectura sale bien. `GET /hr/attendance/devices/status` agrega `ultimaLectura` y
  `segundosSinLectura`. Sin migración: la columna ya existía.
- El nombre sale con la misma regla del directorio de personas: manda el código ligado a una persona de la Suite, si no,
  el nombre con el que está en el reloj; si no hay ninguno, se muestra sólo el número. La bitácora de cada incidencia
  sigue guardando la fila de la tabla, sin el nombre derivado.
- Pruebas de la regla, del texto y de la pantalla, y contra la base el caso exacto de la auditoría (lector vivo, reloj
  caído 4 h 30 m). Cada una se comprobó rompiendo el código a propósito: con la regla vieja, la prueba contra la base
  devuelve «verde», igual que producción.

### Por qué así

La regla de Mega Talento es que la pantalla nunca parezca al día cuando no lo está. Un aviso con error prueba que el
**lector** vive, no que el **reloj** entregue. El nombre viene del servidor porque es la misma regla que ya usan el
directorio y el padrón: calcularlo en la pantalla daría dos respuestas para la misma persona.

### Pendiente

- `[RH.13.4]`: que el reporte diga «Sin dato» en vez de «Falta», día por día, cuando el reloj no entregó. Toca el cálculo
  que hoy da 0 diferencias contra Mega Talento y se mide antes de cambiarlo.

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
