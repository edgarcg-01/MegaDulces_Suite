# Administración › Personas › Cambiar usuario

> `[AU.34]` · 2026-11-09 · 🧪 en código y probado, sin PR

## El problema

En `/admin/users` no había forma de corregir el usuario de una cuenta (un error de dedo al darla de
alta, por ejemplo): la ficha lo dejaba de sólo lectura con el aviso *«el usuario no se renombra»*.

Al revisarlo apareció lo contrario de lo que decía la pantalla: **la API sí renombraba**. El
`PUT /users/:id` general aceptaba `username` y sólo revisaba que no estuviera repetido. No lo dejaba en
la bitácora, no cerraba las sesiones y no revisaba si algo dependía del nombre. Cualquiera con permiso de
gestionar usuarios podía hacerlo sin rastro, llamando a la API directamente.

Y el usuario sí importa más allá de entrar: en varias tablas se guarda **en texto** y después se busca o
se cruza con Kepler. Renombrar una cuenta que aparece ahí no da error; deja de encontrar lo suyo:

| Dónde | Qué se rompe |
|---|---|
| Código de cajero de Kepler (`analytics.pos_cashiers`, `analytics.cash_cuts`, `reconciliation.blind_counts`) | La cajera pierde sus cortes y su arqueo |
| «Solicita» de gastos de Kepler (`analytics.expense_requests`) | Deja de ver los vales que tiene asignados |
| Vales, comprobantes de pago, presupuestos (`created_by`, `evidencia_por`, `validated_by`) | Pierde su historia y **puede aprobar lo propio**: la regla compara el texto guardado con el usuario de hoy |
| Entregas de compras (`recipient_username`) | Nadie puede aceptar las entregas abiertas |
| Tareas de Maat, capturas de visita | Su historia queda partida en dos nombres |

Además el token de sesión lleva el usuario adentro: después de un cambio, la sesión abierta seguiría
firmando con el nombre viejo hasta que expire (días, en una cuenta de dispositivo).

## La solución

Se puede cambiar el usuario **sólo si nada lo usa como llave**, y el cambio es una acción aparte del
formulario de la ficha:

- En la ficha, junto al usuario, aparece **«Cambiar usuario»** para quien puede resetear contraseñas
  (`USUARIOS_PASSWORDS`), nunca en la propia ficha. Pide el usuario nuevo y el motivo, y avisa lo que va a
  pasar: se cierran sus sesiones, entra con el usuario nuevo y la misma contraseña.
- Si el usuario aparece en alguna de esas tablas, **no se cambia** y la ficha dice dónde aparece. Si alguna
  tabla no se pudo revisar, tampoco: no haber podido medir no es lo mismo que estar limpio.
- El usuario **nuevo** tampoco puede ser llave de otra persona: renombrarse al código de un cajero de
  Kepler sin cuenta le heredaría sus cortes y sus vales.
- Si pasa, se cierran sus sesiones y queda en la bitácora con el antes, el después, el motivo y quién lo
  hizo.
- El `PUT` general deja de renombrar (acepta el mismo nombre, para no romper a quien manda el formulario
  completo).

## Cómo se implementó

- **`libs/trade/src/lib/users/username-history.ts`**: el catálogo de las 10 columnas donde el usuario es
  llave y la función que las revisa. Cada consulta filtra `tenant_id` explícito (la conexión del servicio
  salta RLS) y corre en su propio savepoint. Una columna legada que ya no existe en la base nueva
  (`daily_captures.captured_by_username`) se marca opcional: si no existe, no puede guardar el nombre.
- **`UsersService.rename()`** y **`POST /users/:id/rename`** (`RenameUserDto`, mismas reglas de formato
  que el alta). En una transacción, con la fila de la cuenta bloqueada (`FOR UPDATE`, para que dos cambios
  a la vez no se pisen): revisa que el nombre esté libre, revisa el catálogo con el nombre nuevo y con el
  viejo, cambia el usuario, escribe el corte de sesión con `clock_timestamp()` (`now()` sería la hora en
  que empezó la transacción, y un token emitido durante las revisiones sobreviviría) y escribe el evento
  `username_renombrado` directo, sin el `recordEvent` que se traga errores (dentro de la transacción, un
  evento fallido la abortaría y el COMMIT se volvería ROLLBACK sin avisar). Después del commit corta otra
  vez las sesiones, invalida el caché y **repite la revisión** del nombre viejo: lo que la persona haya
  confirmado mientras corría con su sesión todavía viva no lo veía la primera, y si aparece algo el cambio
  se deshace (`username_renombre_revertido`, 409 `renombre_revertido`). Al navegador sólo va qué y dónde;
  el error de la base, que trae el SQL, se queda en el log.
- **Ficha** (`persona-detalle`): el bloque «Cambiar usuario» con sus validaciones (las mismas del
  servidor), el botón que se apaga en el primer clic y, cuando el servidor lo rechaza, dónde aparece y qué
  no se pudo revisar. Esc cierra sólo ese bloque (no la ficha). La página actualiza la fila y el
  encabezado sin cerrar la ficha, y la ficha conserva lo editado sólo cuando lo único que cambió es el
  usuario; recargada o con otro dato distinto, se reinicia como siempre.
- **Sin migración y sin permiso nuevo.**

## Diseño: las cinco preguntas (`diseno` §0b)

1. **Qué ve y en qué orden:** en la ficha, junto al usuario de sólo lectura, una línea que dice para qué
   sirve el usuario y el botón «Cambiar usuario». Al abrirlo: cómo entra hoy, el usuario nuevo, el motivo
   y, en una línea, lo que va a pasar. Una sola acción.
2. **Qué no ve:** quien no tiene la llave no ve el botón (se le dice quién puede); en la propia ficha
   tampoco. La lista de las 10 tablas no se muestra antes de intentar: sólo dónde aparece **este**
   usuario si el servidor lo rechaza, que es lo que decide.
3. **Accesibilidad:** a un clic desde la ficha; Enter envía, Esc cancela; el botón dice qué falta en vez
   de quedarse gris; se apaga en el primer clic.
4. **Ligado a otro proceso:** sí. Cierra las sesiones (`[ID.38]`) y deja el evento en la bitácora de la
   misma ficha, que se recarga y muestra el antes → después.
5. **¿Le toca a esta pantalla?** Sí: es acceso a la cuenta, junto a la contraseña y cerrar sesiones, con
   la misma llave. Lo que no le toca (renombrar en Kepler o reescribir la historia) se pide a Sistemas.

## Por qué así

- **Revisar y rechazar, en vez de reescribir las columnas viejas al nombre nuevo.** Reescribir historia de
  vales y cortes es tocar registros de dinero de otros módulos, y en Kepler no se puede. El caso real (un
  error de dedo) casi siempre se nota antes de que la cuenta tenga historia.
- **El mismo permiso que cerrar sesiones.** Cambiar con qué entra otra persona es de la misma familia, y
  esa llave ya está repartida en los roles que corresponden: no hay un permiso nuevo que nadie tenga.
- **Nadie se cambia su propio usuario**, como pasa con el rol y la baja.
- **La deuda de fondo queda con nombre:** esas columnas deberían guardar el `user_id`, y el código de
  Kepler vivir en una tabla que lo ligue con la persona. Mientras tanto, una cuenta con historia la
  renombra Sistemas a mano.

## Cómo se probó

- `database/tests/test-newdb-users-rename.js`: el servicio real contra una base real, con el payload de la
  pantalla, dentro de una transacción que se deshace. **28/28**: incluye el corte medido contra el reloj de
  la base (cae al final del cambio), el nombre nuevo que es llave ajena, el `PUT` con el mismo nombre que
  sigue guardando, que al navegador no llega SQL, y la reversa (un disparador de prueba crea un registro
  con el nombre viejo durante el cambio). **Pruebas negativas:** con la revisión desactivada, 4 rojos; con
  el corte en `now()`, sin revisar el nombre nuevo y sin la reversa, 12 rojos.
- `persona-detalle.renombre.spec.ts`: **14/14** (quién ve la acción, qué deja enviar, los tres rechazos,
  lo no revisado se dice, Esc no cierra la ficha —probado que sin el arreglo falla—, el doble clic, cuándo
  la ficha conserva lo editado y cuándo no). Módulo `admin` completo: **35/35**.
- `check:pantalla`: `admin-personas` sigue cumpliendo las 10 reglas; `persona-detalle` sin fallas nuevas.
- **Auditoría** (revisión de código del PR #519): de 15 hallazgos se corrigieron 12; los 3 que no, en
  «Lo que queda fuera».
- **Sin validación visual en producción**: falta revisarlo en la pantalla viva después del despliegue.
  **NO MEDIDO:** cuánto tardan las revisiones con el volumen de prod (las columnas que no son «persona» ya
  comparan sin expresiones regulares, pero siguen siendo recorridos completos).

## Lo que queda fuera

- **`RenameUserDto` copia las reglas del alta en vez de usar `PickType`.** Se dejó así porque el mismo
  módulo ya tuvo un error de arranque con las clases que genera `@nestjs/swagger` (ver `webpack.config.js`
  de la API); la prueba compara las dos reglas, así que si divergen se pone roja.
- **`revokeSessions` (cerrar sesiones, de antes) tiene el mismo error de diagnóstico** que se corrigió en el
  renombre: cualquier falla de su `UPDATE` la reporta como «falta la migración [ID.38]». Es código anterior
  a este cambio.
- **El campo se llama `motivo` y no `reason`**, igual que en `POST /users/:id/revoke-sessions`, el endpoint
  hermano del mismo controlador.
