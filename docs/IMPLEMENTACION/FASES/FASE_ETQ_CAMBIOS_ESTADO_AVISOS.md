# Etiquetera — Cambios de precio, estado del producto y avisos a sucursales

> **Qué es este documento.** El mapa de punta a punta de lo que se hizo en `/tienda/etiquetas` entre el **2026-10-08 y el 2026-10-12**: qué cambió para quien usa la pantalla, por qué, dónde vive en el código, cómo se probó, cómo se despliega y qué queda abierto. **No reemplaza** a los documentos por fase —los enlaza—: es el que se lee primero.
>
> **Estado al 2026-10-13:** los **cuatro PR están fusionados en `main`** (#349 el 10-oct; #350, #351 y #361 el 12-oct). **Prod ya sirve el código** (`/api/health` devuelve `commit: a5223868`, el tip de `main`, medido el 13-oct). **Lo que NO se pudo confirmar desde la máquina de trabajo** (SSH y base de prod cerrados) es si las dos migraciones de #350 están aplicadas: ver la lista de verificación de §7.

Documentos hermanos: [`FASE_ETIQUETAS_ANAQUEL`](FASE_ETIQUETAS_ANAQUEL.md) (la etiquetera en sí: tablas, decode de Kepler, formato de la etiqueta) · [`FASE_ETIQUETAS_CORRECCIONES`](FASE_ETIQUETAS_CORRECCIONES.md) (catálogo de errores de impresión) · [`FASE_ETQ_AVISOS_CAMBIOS_PRECIO`](FASE_ETQ_AVISOS_CAMBIOS_PRECIO.md) (el plan y las decisiones D1–D5 de los avisos).

---

## 1. En una pantalla

| Qué cambió | Para quién | PR | Estado |
|---|---|---|---|
| **Cambios de precio muestra UN código por fila**, no una fila por presentación y por cada movimiento del día | Quien reimprime etiquetas | #349 | ✅ en `main` (2026-10-10) |
| **Se confirma qué precio lleva la etiqueta** (Todos / Pieza / Paquete / Caja) antes de imprimir | Quien reimprime | #349 | ✅ en `main` |
| **Un clic en un producto lo manda a la etiquetera**, con ese precio elegido | Quien reimprime | #349 | ✅ en `main` |
| **Cambios de precio gana ~170 px de alto**: el selector de día pasa a la fila de las pestañas, las 4 tarjetas a una línea y se quita el título repetido (no se pierde ninguna información) | Quien reimprime | #407 | 🧪 PR abierto, sin validación visual |
| **La etiquetera dice POR QUÉ un producto no tiene precio**: no existe en Kepler / existe pero no en esa tienda / precio 0 | Quien carga códigos | #351 | ✅ en `main` (2026-10-12) |
| **Aviso en la campana** a cada sucursal cuando hay cambios de precio (07:30 resume ayer, 14:00 lo de hoy); al tocarlo entra a Cambios de precio de su tienda | Encargados y quien usa la etiquetera | #350 | ✅ en `main` (2026-10-12) · migraciones por confirmar en prod |
| **Compras puede avisar a una o varias sucursales** con una nota (permiso propio) | Compras | #350 | ✅ en `main` · el permiso necesita su migración y re-login |
| ~~Descargar la lista en CSV/Excel~~ | — | #350 | ⛔ **retirado el 2026-10-10 por decisión de Edgar** |

---

## 2. Cómo funciona hoy, de punta a punta

```
Kepler cambia un precio
   └─ bitácora kdpv_bitacora_precios ──► ODS (kepler_ods) ──► vista analytics.v_label_price_changes
                                                                  │
          ┌───────────────────────────────────────────────────────┤
          │                                                       │
   Pantalla «Cambios de precio»                       Generador de avisos (cron 07:30 / 14:00)
   (GET /store/labels/price-changes)                  └─ commercial.price_change_notices (1 fila por plaza, día y corte)
   un código = una fila                                      │
          │                                                  ▼
          │                                       Campana (poll cada 5 min, sólo con STORE_LABELS_VER)
          │                                                  │  clic en el aviso
          │◄──────── /tienda/etiquetas/cambios?plaza=&fecha= ┘
          │
   clic en el producto (o marcar varios + «Imprimir N etiquetas»)
          ▼
   /tienda/etiquetas  { codes, modo }  ──► etiquetera: precio grande según el modo, hoja lista
```

Dos ideas que sostienen todo:
1. **La regla de agrupar es una sola.** `agruparPorCodigo` vive en `libs/contracts` y la usan la pantalla **y** el generador de avisos: lo que la lista cuenta y lo que el aviso dice no pueden divergir.
2. **El aviso no lleva un archivo: lleva un enlace.** Quien lo recibe entra a la lista al día de su tienda y reimprime ahí. Por eso no hay exportación (§6).

---

## 3. Cambios de precio: un código, una fila (`ETQ-CAMBIOS.8`, PR #349)

### El problema
La bitácora de Kepler escribe **una fila por presentación** (pieza, paquete, caja) **y otra por cada vez que se movió el precio**. La pantalla las mostraba tal cual: el 91059 salía tres veces con unidades distintas y la persona creía ver tres productos. La etiqueta es **una por producto**.

### Lo que hace ahora
- **Agrupa por código.** Cada producto es una fila; adentro lleva una línea por presentación que cambió.
- **Colapsa los movimientos repetidos de una misma presentación**: si la unidad `500` pasó de $5,602.87 a $6,523.34 y después a $203.85 el mismo día, se muestra **el primer «antes» del día contra el último «ahora»** (lo que hay en el anaquel contra lo que dice Kepler hoy). Sólo si las horas son completas y distintas; si no hay orden cierto, **no inventa una cadena: devuelve todas las filas**.
- **Un producto que terminó el día en su precio de partida no se lista**, pero se **cuenta** («N volvieron al de antes»): un filtro mudo se lee como «no hubo».
- **Una sola dirección por producto** aunque sus presentaciones se muevan en sentidos opuestos: manda la que cambió **más en proporción**. Así *suben + bajan + sin precio = total de productos*; el resumen cuadra.
- **Orden y tope.** Se ordena por tamaño del cambio, **no por hora** (la hora es texto de hora del día, sin fecha). Tope de **300 productos** (`TOPE_CAMBIOS`, cuenta productos, no renglones: `ETQ-CAMBIOS.7`). Los cambios de **un centavo o menos** (`PISO_DELTA = 0.01`) se ocultan **y se declaran** (`ocultos_centavo`).

### Confirmar qué precio lleva la etiqueta
Barra «Precio en la etiqueta»: **Todos los precios / Pieza / Paquete / Caja** (por defecto *Todos*). La elección viaja con los códigos por `history.state` (`{ codes, modo }`, validado con `esModoPrecio`).

- `todos` imprime el precio grande de siempre más las demás presentaciones debajo.
- `pieza` / `paquete` / `caja` ponen **esa** presentación en grande y **quitan «Otras presentaciones»** (la persona pidió ese precio, no los tres).
- ⚠️ **«Pieza» es la presentación BASE del ERP, no la que se llame `PZA`**: en el 73.5% del catálogo la base es `PAQ`.
- **Un producto que no tiene esa presentación conserva su precio grande de siempre y se DICE** (`sin caja (salen con su precio de siempre): …`). La alternativa —imprimirle otra cosa sin avisar— era peor.
- Si a **ningún** producto le tocó la presentación pedida, no se le quita «Otras presentaciones» a nadie (quedaría con menos información sin haber puesto lo pedido).

---

## 4. Clic en un producto = imprimir su etiqueta (`ETQ-CAMBIOS.9`, PR #349)

Pedido después de abrir #349: **de la lista, un clic lleva a imprimir esa etiqueta.**

- **Clic en la fila** (o **Enter / Espacio** con la fila enfocada) → navega a `/tienda/etiquetas` con `{ codes: [sku], modo }`.
- **Botón «Imprimir» en cada fila**, para quien no sabe que la fila se pulsa. Queda fuera del orden de tabulador (`tabindex="-1"`): una parada por fila.
- **Lo que NO navega:** marcar la **casilla** (sirve para armar un lote); **Enter sobre la casilla**; y un clic **con texto seleccionado** (copiar un código no debe costar la selección).
- **No abre la ventana de impresión sola — decisión consciente.** En la etiquetera la persona todavía ve el aviso de frescura del precio, el precio grande y la hoja **antes de gastar papel**, que es justo lo que esa pantalla existe para que revise. Imprimir directo es un cambio de una línea, pero contradice «el operador decide». **Sigue abierta la pregunta a Edgar** si prefiere imprimir sin pasar por ahí.
- La compuerta de teclado (`check-keyboard-nav`) rechazó la primera versión (fila con `(click)` sin `tabindex`): la fila ahora se enfoca y el botón no duplica paradas.

---

## 5. La etiquetera dice POR QUÉ no hay precio (`ETQ-ESTADO.1`, PR #351)

### El problema
Tres situaciones distintas decían lo mismo: «sin precio en Kepler». Caso real: el **SKU 78180** («500 GR CONF BLANCO/ TURIN», pasó a granel) **no existía en `kdii` en ninguna tienda**; se buscaba un precio en 0 que no estaba. Los códigos nuevos eran 91059, 95597, 95459 y 61002.

### Lo que hace ahora
`POST /store/labels/resolve` agrega **`erp_estado`** por etiqueta:

| `erp_estado` | Qué dice la pantalla | Qué hay que hacer |
|---|---|---|
| `no_existe_en_erp` | «no existe en Kepler (en ninguna tienda)» | Darlo de alta en Kepler con su precio |
| `no_existe_en_plaza` | «existe en Kepler pero no en la tienda NN» | Darlo de alta en esa tienda |
| `sin_precio` | «está en Kepler pero con precio 0 en la tienda NN» | Ponerle precio en Kepler |
| `cotizado` / `null` | mensaje genérico de siempre | — |

- **Dos consultas a `kepler_ods.kdii`, a propósito y sólo para los productos sin precio.** La primera lleva la plaza y usa `ix_kdii_suc_sku`; la segunda (sin plaza) corre **sólo** para los que no aparecieron ahí —son pocos— y es la que separa «no existe en esta tienda» de «no existe en ninguna». **Ninguna filtra por precio:** la pregunta es si la **fila existe**, no si cotiza.
- **La carga masiva lista los códigos que no existen** (no sólo cuántos): «no existen en Kepler 2 (78180, …)» (los códigos concretos, para que se den de alta).
- **Sin tienda o sin SKU el estado es `null`** y la pantalla cae al mensaje genérico — nunca se afirma lo que no se midió.
- **Cambio de comportamiento: ninguno en qué se imprime.** Un producto sin precio sigue sin entrar a la cola. Sin migraciones ni permisos nuevos → sin re-login.

---

## 6. Avisos a sucursales y «Compartir» (`ETQ-AVISOS.1–3`, PR #350)

El plan y las decisiones están en [`FASE_ETQ_AVISOS_CAMBIOS_PRECIO`](FASE_ETQ_AVISOS_CAMBIOS_PRECIO.md); aquí el resumen.

**Decisiones de Edgar (2026-10-09):** **D1** resumen a las **07:30** (ayer) y a las **14:00** (lo de hoy) · **D2** avisar a sucursales *(la parte «descargar la lista» se retiró)* · **D3** permiso propio `STORE_LABELS_COMPARTIR` · **D4** mínimo **1** producto tras filtros · **D5** plaza sin usuario con tienda asignada: el aviso **se ve igual** para quien tenga alcance y **se declara**.

**Qué hay:**
- **Tabla** `commercial.price_change_notices` (RLS forzado, 8 CHECK con prueba negativa dentro de la migración, sin DELETE). **Nunca un aviso vacío, por construcción:** `CHECK (productos >= 1)`.
- **Generador** (cron) con latido a `analytics.cron_runs` y umbral en `CRON_JOBS` (`price_change_notices`, warn 20 h / crit 40 h). **Sin dato no es cero:** si la bitácora de una plaza no llega al día, **no se avisa** y el latido lo dice; si **ninguna** plaza tiene dato, el latido es **error**.
- **Campana:** poll cada 5 minutos, sólo con `STORE_LABELS_VER`, recortado por el alcance del usuario (`ScopeService`). Un precio que el ERP dejó en blanco sube la severidad a *warn*. El aviso lleva `?plaza=&fecha=`.
- **Compartir** (sólo con `STORE_LABELS_COMPARTIR`; se **esconde**, no se deshabilita): Compras elige plazas y agrega una nota; **cada plaza devuelve su estado con el motivo** (`enviado`, `sin_cambios`, `sin_dato`, `repetido`, `plaza_invalida`). Un reenvío accidental (misma persona, plaza y día en 10 min) se frena en el servicio.
- **Sin WhatsApp ni correo, a propósito:** no hay un canal real detrás, y un botón que fingiera enviar sería peor que no tenerlo.

⚠️ **`COMPRAS_VER` no se podía reusar:** está repartido en 0 de 37 roles, así que el botón se habría quedado sin nadie. La migración de reparto deriva el permiso de `STORE_LABELS_VER` y del comprador, **imprime la lista de roles y falla si no hay ninguno**.

### Retiro de la exportación (2026-10-10)
Este PR traía «Descargar CSV». **Edgar pidió quitarlo: no se acepta ningún Excel; a lo mucho PDF; lo ideal es que a quien puede usar la etiquetera le llegue el aviso a la campana y, al tocarlo, reimprima.** Además un archivo exportado se queda viejo en cuanto cambia otro precio; el enlace siempre abre la lista al día.
- Se borró `cambios-csv.ts` (+ spec) y el botón del diálogo, que dejó de recibir la lista.
- Una prueba falla si en el diálogo aparece cualquier botón de descargar/CSV/Excel (comprobada reinsertando uno a propósito).
- **PDF: no se construyó.** Si se pide, va por el Chromium que ya usan Finanzas y el anexo de venta, no con un exportador nuevo.

---

## 7. Cómo se despliega (y qué falta)

| Pieza | Estado | Cómo |
|---|---|---|
| #349 (UI de Cambios de precio) | ✅ en `main` → `auto-deploy` | Sin migraciones |
| #351 (`erp_estado`) | ✅ en `main` → `auto-deploy` | Sin migraciones; sin re-login |
| **#350** | ✅ en `main`; **código en prod** (commit `a5223868` servido) | **Orden que debía seguirse:** (1) fusionar a `main`; (2) **migraciones a prod una por una** con `apply-one-migration-prod.js` dentro de `prod-api`, **nunca `migrate:latest`**: `20261009160146` (tabla) y `20261009160147` (reparto); (3) revisar la lista de roles que imprime la segunda; (4) humo: `POST /store/labels/notices/generate {"corte":"manana"}` y leer `analytics.cron_runs` (`price_change_notices`); (5) **re-login** de quien recibe `STORE_LABELS_COMPARTIR` |

⚠️ La migración de reparto **sólo hace UPDATE**: la compuerta del despliegue la clasifica *NO_MEDIDO* y frena al equipo hasta que alguien la aplique a mano. **Aplicarla antes de fusionar.** Como prod ya sirve el commit de `main`, la compuerta **no frenó el despliegue**, lo que sugiere que alguien las aplicó; **no es una prueba**, y desde aquí no se pudo leer la base.

### Lista de verificación en prod (quien tenga acceso; cada comando es de **sólo lectura** salvo el último)
1. **¿Están aplicadas?** `ssh superoot@192.168.0.222 'docker exec prod-api node /app/database/scripts/apply-one-migration-prod.js --list'` → deben figurar `20261009160146` y `20261009160147` como aplicadas. Si falta alguna: aplicarla **una por una** con `apply-one-migration-prod.js <archivo>.js`, nunca `migrate:latest`.
2. **¿Existe la tabla y tiene RLS?** `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'commercial.price_change_notices'::regclass;` → ambas `true`.
3. **¿Quién recibió el permiso?** `SELECT role_name, permissions->>'STORE_LABELS_COMPARTIR' FROM identity.role_permissions WHERE permissions -> 'STORE_LABELS_COMPARTIR' IS NOT NULL AND deleted_at IS NULL;` → debe haber al menos un rol en `true` (la migración falla si no hay ninguno) y **no** deben ser roles de sucursal.
4. **¿Corrió el generador?** `SELECT job_key, status, last_finish, note, error FROM analytics.cron_runs WHERE job_key = 'price_change_notices';` → **una sola fila** (la tabla guarda la última corrida de cada trabajo) con `last_finish` de hoy a las 07:30 o a las 14:00 (hora de México) y estado `ok`. **Sin fila = el cron nunca ha corrido** (o la tabla del aviso falta).
5. **Humo (escribe):** `POST /store/labels/notices/generate {"corte":"manana"}` con un usuario que tenga `STORE_LABELS_COMPARTIR`; es idempotente (repetirlo actualiza conteos, no duplica).
6. **Re-login** de quien deba ver «Compartir»: el permiso va en el JWT.

---

## 8. Pendientes, con dueño

| # | Qué | Quién |
|---|---|---|
| 1 | ~~CI de #350 y fusión~~ — **hecho** (2026-10-12). Queda **confirmar las migraciones en prod** (lista de verificación de §7) | Quien tenga acceso a prod |
| 2 | **Fase 0 de los avisos, sin correr:** destinatarios por plaza (¿04 y 08 «sin nadie con tienda asignada»?), volumen real por plaza y día, **a qué hora llega la bitácora al ODS** (si es después de las 07:30, mover el corte) | Quien tenga acceso a prod |
| 3 | Aplicar las 2 migraciones y hacer el humo (§7) | Quien tenga acceso a prod |
| 4 | **Validación visual:** columna y botón «Imprimir» de las filas, motivo «sin precio», diálogo de Compartir y campana con avisos | Edgar |
| 5 | **Decisión:** ¿el clic en un producto debe **imprimir directo** sin pasar por la etiquetera? (hoy no, a propósito) | Edgar |
| 6 | **Decisión:** ¿hace falta un **PDF** de la lista? (no se construyó) | Edgar |
| 7 | Una plaza **sin nadie con tienda asignada** no tiene a quién avisar: el aviso lo ve quien tiene alcance total y el diálogo de Compartir lo **declara** (`destinatarios = 0`). Es la limitación D5, no un arreglo: se resuelve asignando tienda a las personas | Edgar / RH |
| 8 | ~~Hacer que el `pre-push` corra el `Boundary type gate`~~ — **hecho en el PR #390** (prueba negativa y medición en su descripción); falta fusionarlo | Edgar |
| 9 | Borrar las ramas remotas que ya cumplieron (el proyecto pide borrarlas al fusionar): `feat/etq-estado-1-v2` (#351), `docs/protocolo-pr-lecciones-etq` (#361) y `feat/etq-estado-1-motivo-sin-precio` (obsoleta, la reemplazó #351). La de #349 ya no existe | Cualquiera, con visto bueno |

---

## 9. Mapa de archivos

| Qué | Dónde |
|---|---|
| Regla compartida (agrupar, colapsar, contar) + DTOs de avisos | `libs/contracts/src/http/price-change-notice.contract.ts` (+ `.spec.ts`) |
| Permiso `STORE_LABELS_COMPARTIR` | `libs/contracts/src/authz/{permissions,permission-meta,authz-tree}.ts` |
| Modo de precio de la etiqueta | `apps/view/src/app/modules/tienda/etiquetas-modo.ts` (+ spec) |
| Pantalla Cambios de precio | `apps/view/.../tienda/pages/tienda-cambios-precio.component.ts` (+ spec, + `tienda-cambios-enlace.spec.ts`) |
| Etiquetera (aplicar modo, motivos «sin precio») | `apps/view/.../tienda/pages/tienda-etiquetas.component.ts` (+ specs) |
| Diálogo Compartir | `apps/view/.../tienda/components/cambios-compartir.component.ts` (+ spec) |
| Texto del aviso en la campana | `apps/view/.../tienda/aviso-precio.ts` · `dashboard/layout/notifications-bell.component.ts` |
| API: lista, diagnóstico `erp_estado`, filas del día | `libs/commercial/src/lib/commercial-labels/commercial-labels.{service,controller}.ts` |
| Generador de avisos | `libs/commercial/src/lib/commercial-labels/price-change-notices.service.ts` (+ spec) |
| Migraciones | `database/migrations-newdb/20261009160146_etq_avisos_cambios_precio_tabla.js` · `…160147_etq_avisos_reparto_compartir.js` |
| Umbral del latido | `apps/api/src/modules/db-health/db-health.service.ts` (`price_change_notices`) |

---

## 10. Lo que costó llegar aquí (y dónde quedó escrito)

Llevar los tres PR a verde dejó seis lecciones, ya en el protocolo previo a enviar un PR (`ONBOARDING.md` §8.0b, puntos **8–13**, PR #361):
1. El `pre-push` **no corría** el `Boundary type gate`; el CI sí (12 + 4 violaciones de `any`/retorno sin tipar). Arreglado en #390.
2. Probar el **directorio entero** del módulo, no un filtro por nombre.
3. Tras fusionar `main`, buscar **lógica duplicada** aunque git no marque conflicto (`agruparPorCodigo` quedó en dos archivos).
4. Los conflictos **entre PR abiertos** se comprueban con `git merge-tree`.
5. Cada cifra y afirmación de la descripción se verifica contra el diff, y se **relee tras el último push**.
6. Una mutación que no se aplicó parece una prueba que pasa (CRLF).

**Rojo heredado, no de esta fase:** `check-primeng-api` marca **273** `styleClass` en `<p-select>` contra un techo de **272** (archivos de `apps/vendor` y `admin-*`, de otros PR). Es informativo; ya estaba en `main` cuando se fusionó #361.

---

## 11. Historia

| Fecha | Qué | PR / commit |
|---|---|---|
| 2026-10-08 | El aviso dice por qué no hay precio (`ETQ-ESTADO.1`) | #351 (entró 2026-10-12) |
| 2026-10-09 | Un código, una fila + confirmar precio (`ETQ-CAMBIOS.8`) | #349 |
| 2026-10-09 | Avisos a sucursales y Compartir (`ETQ-AVISOS.1–3`) | #350 |
| 2026-10-10 | Clic para imprimir (`ETQ-CAMBIOS.9`); #349 fusionado | #349 |
| 2026-10-10 | Se retira la descarga CSV/Excel | #350 `58ad325ab` |
| 2026-10-10 | Tipos del `Boundary type gate` y fusión de `main` en #350/#351 | #350, #351 |
| 2026-10-12 | Protocolo previo a PR: puntos 8–13 | #361 |
| 2026-10-12 | #351 y #361 fusionados; Edgar fusiona `main` en #350 y lo fusiona | `1726a2bb8` / #350 |
| 2026-10-13 | Prod sirve `a5223868` (tip de `main`); migraciones de #350 sin poder confirmarse desde aquí | `/api/health` |
| 2026-10-14 | Barra superior compacta de Cambios de precio (`ETQ-CAMBIOS.10`); `app-metric-strip` gana densidad compacta | #407 |
