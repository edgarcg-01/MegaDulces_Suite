# Agente local de checadas

Corre **dentro de la red del corporativo** y empuja las checadas a la API. Es el
reemplazo de `jalar-en-vivo.bat`.

Las instrucciones de instalación están en [`../COMO-DEJAR-EN-VIVO.md`](../COMO-DEJAR-EN-VIVO.md).
Aquí está **por qué** cada pieza es como es.

---

## Dos orígenes posibles

El agente puede tomar el dato de dos lados, según `config.origen`:

| origen | De dónde lee | Cuándo se usa |
|---|---|---|
| `hr` | el Postgres del sistema del proveedor (`192.168.0.245`) | **el que aplica hoy** |
| `relojes` | los relojes ZKTeco por TCP 4370 | si algún día se libera el puerto |

**Por qué hoy es `hr`.** Los 10 relojes contestan `CMD_ACK_UNAUTH` (commandId
2005) a nuestro saludo. Un ZKTeco acepta **una sola sesión TCP**, y el sistema
del proveedor los sondea cada pocos minutos. Si le peleamos el socket, los dos
leen a medias — que es justo el error que este módulo lleva meses corrigiendo.

El modo `relojes` no es código muerto: es la ruta para una plaza donde no exista
ese sistema, y lleva la lectura verificada (`tools/lectura-verificada.js`), el
stream en vivo y el descubrimiento por serie.

---

## Las piezas

| Archivo | Qué resuelve |
|---|---|
| `index.js` | arranque, config, elige origen, mantenimiento, apagado limpio |
| `origen-hr.js` | el "trigger" de 30 s contra `hr.attendance_logs` |
| `reloj.js` | modo `relojes`: stream en vivo + backfill horario sobre UNA sesión |
| `descubrir.js` | encuentra un reloj por SERIE cuando el DHCP le movió la IP |
| `cola.js` | cola local SQLite: un corte de internet no cuesta checadas |
| `enviar.js` | el único punto que habla con la nube, con backoff |
| `instalar-servicio.js` | servicio de Windows (arranque automático, reinicio) |

---

## Decisiones que parecen raras y no lo son

**Todo se escribe primero a la cola y después se manda.** Al revés (mandar, y
guardar solo si falla) parece equivalente: si el proceso muere entre el evento y
el envío, esa marca no existió nunca y no hay forma de saber que faltó. Con la
cola, el peor caso es mandarla dos veces, y eso la API lo ignora por dedup.

**La marca de agua va sobre `punched_local`, no sobre `imported_at`.** Medido el
17/08/2026: las 129,477 filas del origen tenían `imported_at` de los últimos 3
minutos — ese sistema la reescribe en cada resincronización. Usarla significaría
releer la tabla entera en cada vuelta. A cambio, `punched_local` no ve las
importaciones tardías, y por eso hay dos redes: traslape de 10 min en cada
vuelta, y una pasada de 7 días cada hora.

**La hora se pide a Postgres ya formateada como texto.** `punched_local` es
`timestamp without time zone` y node-pg lo convertiría a `Date` usando la zona
de **la máquina que corre el agente**. Si esa PC estuviera en otra zona —o
cambiara el horario de verano— todas las checadas se recorrerían en silencio.
Pidiendo `to_char(...)` no hay conversión que se pueda equivocar.

**Una vuelta a la vez.** El `setInterval` de 30 s no sabe cuánto tarda la
anterior, y la primera —recuperando el histórico— tarda minutos. Sin candado se
encimarían.

**Un lote vacío también se manda.** Es el latido. Un reloj sin checadas a las
3 de la tarde puede ser "nadie ha checado" o "lleva 6 horas muerto", y la
pantalla tiene que poder distinguirlos.

**Los relojes en pausa no se sincronizan.** `192.168.0.81` (numeración propia sin
traducir) y `192.168.0.196` (sin identificar). Sus marcas se atribuirían a la
persona o a la plaza equivocada, y eso no se nota mirando la pantalla.

**Un 409 o un 202 no se reintentan.** La API ya guardó el lote crudo en
`ingesta_lotes`; el dato no se perdió. Reintentar solo llenaría esa tabla de
copias.

---

## El agente NO tiene `DATABASE_URL`

Solo `apiUrl` + `token`. Antes cada PC de sucursal tenía el string de conexión de
producción en un archivo de texto. Quitarlo era parte del objetivo.
