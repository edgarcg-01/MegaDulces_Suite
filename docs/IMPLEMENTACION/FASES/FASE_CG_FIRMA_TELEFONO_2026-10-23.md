# CG · Firma desde el teléfono que no falla — entregables (2026-10-23)

> **Pedido de Edgar, 2026-10-23:** *«/finanzas/caja-general tiene un sistema de firma vía
> teléfono, pero está fallando: pide usuario, y no debería pedir iniciar sesión. Los usuarios
> dicen que a veces tienen que firmar hasta 3 veces. Pongamos entregables objetivos para que este
> sistema no falle por nada del mundo.»*
>
> **No es fase nueva** (Fase 0 en curso, §7 del método): son items `[CG.199]`–`[CG.206]` de la
> fase CG, que ya está en prod. Capas C0 → C3, y ninguna sube hasta que la de abajo está verificada.

---

## 1. Lo que se midió hoy (línea base)

### 1.1 El síntoma en el libro — `finance.cash_ledger`, prod, sólo lectura

Movimientos que **requieren firma** (`firma_estado IN ('firmado','sin_firma')`), por día de captura:

| Ventana | Firmados | Sin firma | % firmado | Monto sin firma |
|---|---:|---:|---:|---:|
| 12–16 oct | 36 | 72 | **33 %** | $478,547.08 |
| 17–23 oct | 9 | 146 | **5.8 %** | **$1,795,635.51** |

⚠️ **Lo que esta tabla NO prueba**, declarado:
- `sin_firma` mezcla «el cajero no la pidió» con «la pidió y no llegó». El sistema **no guarda
  ningún rastro del pedido de firma** (vive en la memoria del socket), así que **la tasa de falla
  del canal es NO MEDIDA**. Ése es el primer entregable.
- No se distingue una firma hecha en el teléfono de una hecha en el recuadro de la PC.
- La caída del 17-oct coincide con el periodo de más despliegues (abajo), pero **coincidir no es
  causa**: se confirma o se descarta con el rastro de E0.

### 1.2 Los despliegues cortan cada socket

`kubectl -n prod get rs`: **11 rollouts de `api` del 20 al 23-oct**, casi todos en horario hábil
(09:39–17:40 hora MX). Un rollout cierra **todos** los sockets de `/caja`. Hoy el emparejamiento
vive en `client.data` del socket de la PC, así que cada despliegue mata en silencio todo código
abierto (ver §2, causa C3).

### 1.3 Lo que los logs no dicen

Los pods tienen 2 h de vida y `CajaGateway` **no registra nada en el camino feliz**: no hay forma de
contar pedidos, reclamos ni entregas. Tampoco hay log de acceso HTTP. → E0.

---

## 2. Por qué falla — las cinco causas, leídas en el código

| # | Síntoma | Causa | Dónde |
|---|---|---|---|
| **C1** | **Pide usuario** | `/firmar` es pública, pero la app arranca igual que en cualquier ruta: el initializer `resolverAccesoInicial()` y `refreshAccess()` piden `/users/me/access` **si hay un token en `localStorage`**, aunque esté vencido (`restoreSession()` no mira `exp`). El 401 llega a `authInterceptor`, que hace `logout()` + **redirige a `/login`**. Pasa en todo teléfono que alguna vez inició sesión: el del cajero, el del mostrador. La excepción del interceptor cubre `/finance/captura` pero no esta pantalla, porque el 401 no lo provoca la pantalla sino el arranque. | `app.config.ts:43`, `app.component.ts` (`refreshAccess`), `auth.service.ts:73`, `auth.interceptor.ts:46` |
| **C2** | Firmar otra vez tras bloquear el teléfono | `socket.io` reintenta **5 veces** con 1.5 s (`reconnectionAttempts: 5`) y se rinde. Al desbloquear, el wifi tarda en volver: el socket queda `caido` para siempre y «Enviar» responde `sin_conexion`, que con pase se traduce a **«El QR venció»** — falso. | `caja-socket.service.ts:133` |
| **C3** | El QR de la PC «no existe» | El código vive **sólo** en `client.data.firma` del socket de la PC. Si ese socket se cae (despliegue, wifi, pestaña en segundo plano) y reconecta, el socket nuevo **no trae la marca** y la PC **no se entera**: sigue mostrando un QR muerto. El teléfono escanea → `no_existe`. Con 11 despliegues en 4 días, esto no es raro. | `caja.gateway.ts:173`, `finanzas-caja-general.component.ts` (sin re-apertura al reconectar) |
| **C4** | «Firma enviada» en el teléfono y nada en la PC | La firma viaja por `emit` a la room, **sin acuse de la PC y sin copia en el servidor**. Si la PC está reconectando en ese segundo, la firma se pierde; el teléfono ya dijo «puedes devolver el teléfono». | `caja.gateway.ts:278` |
| **C5** | Se pierde lo firmado al recargar la PC | El PNG vive en un `signal` de la PC hasta que se guarda el movimiento. Recargar la pestaña, o que el service worker aplique una versión nueva en la siguiente navegación, lo borra. | `finanzas-caja-general.component.ts` (`firmaRemotaPng`) |

| **C6** | Firmar otra vez tras bloquear el teléfono (aunque el socket aguante) | *Encontrada al hacer `[CG.203]`.* `[SW.2]` aplica la versión nueva del service worker cuando la pestaña se **oculta** — y en el teléfono ocultar es **bloquear la pantalla**. Con una versión pendiente (11 despliegues en 4 días) la página se recargaba y se perdía el trazo dibujado. **Arreglada en `[CG.203]`** para pantallas públicas. ⚠️ La PC de la caja sigue igual: cambiar de pestaña con una firma esperando la recarga — eso es `[CG.205]`. | `app.component.ts` (`visibilitychange`) |

⭐ **El patrón común:** todo el estado de la firma es **efímero** — memoria del socket, memoria de
la pestaña — y no hay **repaso** que lo garantice. El propio `CajaSocketService` lo dice para la
bandeja: *«el socket es el camino rápido; el repaso es el que garantiza»*. La firma nunca tuvo
el repaso.

⭐ **El molde ya existe en el repo y funciona:** la captura de gasto por link (`[GX.9]`) —
`finance.expense_capture_links` + `expense-capture-public.controller.ts` + ruta `captura/:token`
sin guard— autoriza con un token revalidado **contra una fila** en cada uso. La firma se pasa a ese
molde; no se inventa un primitivo nuevo (ADR-056).

---

## 3. Los entregables

Cada uno cierra con **prueba automática contra Postgres real** (regla 13) y **prueba negativa**
(regla 12: se rompe a propósito y se ve el rojo). Ninguno cierra con «se probó a mano».

### C0 — Dato

**`[CG.199]` E0 · El pedido de firma es una FILA, no un recuerdo del socket.**
Tabla `finance.cash_signature_requests` (dato propio, no del ODS — permitido): `tenant_id` UUID NOT
NULL + audit fields; `codigo`, `token_hash` (nunca el token), `contexto` (tipo, monto,
beneficiario, documento — los mismos cuatro campos de hoy), `estado`
(`abierta · tomada · firmada · usada · cancelada · vencida`), `expira_at`, `firma_png`,
`firma_nombre`, `firmada_at`, `usada_en` (FK al movimiento), `intentos_envio`, `ultimo_fallo`.
RLS por tenant. Migración generada con `nueva-migracion.js`, aplicada sola.
- ✅ **Criterio:** tras una semana en prod se puede responder con un `SELECT`: pedidos, firmados,
  firmados al primer intento, fallos por motivo. Hoy esa respuesta es **NO MEDIDO**.

### C1 — Dominio

**`[CG.200]` E1 · Las transiciones de estado son una función pura con pruebas.**
`abierta → tomada → firmada → usada`, más `cancelada` y `vencida`. Reglas: un solo teléfono por
pedido; **re-tomar desde el mismo teléfono no es un segundo uso** (bloqueo de pantalla); enviar dos
veces la misma firma devuelve el mismo resultado (**idempotente**, sin duplicar); una firma sobre
un monto distinto al que se guarda no vale (`firmaSigueValiendo`, ya existe).
- ✅ **Criterio:** prueba por transición válida **y** por cada transición prohibida
  (doble envío, otro teléfono, vencida, cancelada, otro tenant).

### C2 — API

> ⭐ **Decisión de Edgar, 2026-10-23 (`[CG.207]`, ya hecho):** *«no necesitamos el código, solo
> el qr»*. Se firma **sólo escaneando**: la PC no muestra el código y el teléfono no tiene campo
> para teclearlo. Simplifica E2: el token del QR es la única llave, no hay búsqueda por código
> tecleado ni intentos que contar, y el código de seis puede desaparecer del modelo.

**`[CG.201]` E2 · El teléfono habla por HTTP con el token del QR; el socket sólo avisa.**
`GET /finance/firma/:token` (contexto) y `POST /finance/firma/:token` (PNG, idempotente por id del
pedido), públicos y exceptuados en `authInterceptor` como `/finance/captura`. El token se revalida
**contra la fila** en cada llamada. El socket queda como **aviso rápido** a la PC
(`firma:recibida`), no como transporte.
- ✅ **Criterio, cinco escenarios automáticos**, cada uno termina con la firma guardada **una sola
  vez**: (a) reinicio del API entre tomar y enviar; (b) teléfono 10 min sin red y vuelve;
  (c) el socket de la PC se cae y reconecta; (d) la PC recarga la pestaña; (e) doble toque en
  Enviar.

**`[CG.202]` E3 · El movimiento se guarda con la firma del SERVIDOR, no con la que manda la PC.**
Al guardar, la PC manda el id del pedido; el servidor copia `firma_png` de la fila, la marca
`usada` y valida que el monto coincida. Mantiene el camino de la firma en el recuadro de la PC.
- ✅ **Criterio:** un `POST` del movimiento con un PNG que no viene de un pedido firmado no queda
  como `firmado` vía teléfono (prueba negativa).

### C3 — Interfaz

**`[CG.203]` E4 · El teléfono NUNCA ve el login.** En las rutas públicas (`/firmar`,
`captura/:token`, la bolsa de trabajo) no corren `resolverAccesoInicial`, `refreshAccess` ni
`arqueoDue`, y un 401 **no redirige**. La lista de rutas públicas vive en **un solo lugar** que leen
el router, el interceptor y el arranque. Arreglo de C1 — **es el más barato y va primero.**
- ✅ **Criterio:** prueba con un token **vencido** en `localStorage` → abrir `/firmar?…` → cero
  peticiones a `/users/me/access`, cero navegación a `/login`. Negativa: quitar la ruta de la lista
  pone la prueba en rojo.

**`[CG.204]` E5 · El teléfono no se rinde y no miente.** Envío con reintento automático hasta
acuse del servidor (con techo visible); **«Firma enviada» sólo cuando el servidor confirmó que la
guardó**. Cada fallo tiene un solo mensaje y una sola acción; «el QR venció» sólo si el servidor
dijo `vencida`. Arreglo de C2.
- ✅ **Criterio:** prueba por cada código de fallo → texto esperado; prueba de que sin acuse no se
  muestra «enviada».

**`[CG.205]` E6 · La PC no pierde una firma que ya llegó.** Mientras hay pedido abierto, la PC
repasa `GET` del pedido cada pocos segundos (el socket sólo adelanta); al recargar, recupera el
pedido abierto del movimiento en captura; si el socket reconecta, no hay nada que re-abrir porque
el pedido no vive en él. Arreglo de C3, C4 y C5.
- ✅ **Criterio:** con el socket de la PC apagado a propósito, la firma aparece en la PC en ≤ 5 s
  por el repaso.

### Cierre

**`[CG.206]` E7 · Verificación en prod y la cifra que lo declara cerrado.**
- Smoke en prod tras desplegar: un pedido real de punta a punta, con un despliegue en medio.
- **Metas (a 2 semanas, contadas con `SELECT` sobre la tabla de E0):**
  - **≥ 99 %** de los pedidos tomados por un teléfono terminan `firmada`.
  - **≥ 98 %** se firman **al primer intento** (un solo trazo por pedido).
  - **0** apariciones de `/login` desde `/firmar` (E4 lo hace imposible por construcción; la
    prueba lo vigila).
- La tasa `firmado / (firmado + sin_firma)` del libro **se sigue, pero no es meta del sistema**:
  depende también de que el cajero la pida. Si sube después de E1–E6, era el canal; si no, es
  proceso y se habla con Caja.

---

## 4. Orden y por qué

1. **E4 (`[CG.203]`) primero, solo**: arregla el «pide usuario» sin tocar el modelo, es chico y
   no depende de nada. Puede salir esta semana.
2. **E0 → E1 → E2/E3 → E5/E6**: el rediseño, capa por capa.
3. **E7**: cierre con la cifra.

⚠️ **Lo que este plan NO incluye:** firma electrónica con validez fiscal (sigue siendo constancia,
como el ticket en papel); cambiar qué movimientos exigen firma; frenar los despliegues en horario
hábil (con E2 dejan de importarle a la firma, pero siguen cortando el resto de los sockets).
