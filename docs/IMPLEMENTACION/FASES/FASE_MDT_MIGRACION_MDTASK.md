# Fase MDT — Migración de MDTask a la Suite

```
OBJETIVO: MDTask (la app de tareas por puesto, con pagos de servicios, promociones, vales de servicio,
          flotilla y su bot de WhatsApp) deja de ser una app aparte en Railway + Firebase + Cloudinary:
          cada dominio que se USA pasa a su dueño natural en la Suite, y lo que no se usa se retira.
MÉTRICA:  Dominios de MDTask que escriben fuera de la Suite
          HOY: 19 dominios en 3 almacenes externos (Postgres `eajd`, Firestore, Cloudinary/Firebase
               Storage) — medido en CÓDIGO el 2026-11-13 (HEAD `3aa3297`); volumen por dominio NO MEDIDO
          → META: 0, con MDTask apagado — fecha a fijar tras MDT.0
          Guarda: entregas de tareas por día NO bajan con el corte (HOY NO MEDIDO; la última cifra
          conocida es «1 a 11 por día sobre ~200 emitidas», bitácora de MDTask, sep-2026, a re-medir)
CAPA TOPE: C3
ÁREA:      Plataforma (toca RH, Finanzas, Comercial/Mercadotecnia y Logística)
DUEÑO:     Edgar firma · dueño técnico POR ASIGNAR (propuesta: David, autor de MDTask)
ESTADO:    🔨 — abierta por Edgar el 2026-11-13 («implementemos todo») POR ENCIMA DEL CUPO
           (7ª 🔨 contra 4). Las recomendaciones D0–D14 quedan aceptadas por esa orden,
           salvo D11 y D13, que esperan la medición de uso (MDT.0.1)
```

**Con qué se midió:** inventario del repo `IngeDavid2209/mega-dulces-app` (clon de sólo lectura,
nada ejecutado) + cruce contra el código de la Suite en `main`, 2026-11-13. **La base `eajd` NO se
midió**: el único camino era la cadena de conexión de Mega Talento (`MT_DATABASE_URL`), que no está en
el pod `api` de prod ni en el `.env` local. Medirla es `[MDT.0.1]` y va primero.

---

## 0. En una pantalla

MDTask nació como «checklist-control de empleados» y creció a **19 dominios**: tareas del manual por
puesto (el núcleo), evidencia con foto, pagos de servicios de sucursal, promociones (formato MKTN001)
y venta de promos, vale de servicio operativo, flotilla, personal/plantilla/turnos, tableros de
control, y un asistente de WhatsApp con 28 herramientas que toca casi todas las tablas.

| Evidencia | Valor | Fuente |
|---|---|---|
| Tamaño | ~80k líneas de frontend · ~15k de API (49 rutas) · 44 tablas, **0 llaves foráneas** | inventario 2026-11-13 |
| Base | schema `eajd` en el Postgres de Railway **que comparte con Mega Talento** y otros 3 sistemas | `FASE_RH` §2.3 |
| Escritura doble | Además de Postgres, sigue escribiendo en **12 colecciones de Firestore** (22 archivos del front usan Firebase); la divergencia **nunca se midió** | inventario; bitácora de MDTask, paso 0.2 pendiente |
| Uso | **15 de 149** personas abrieron la app en 24 h; 60 de 97 con puesto llevaban >30 días sin entrar | bitácora de MDTask (sep-2026) — **a re-medir** |
| Personas | 159 fichas; **sin número de empleado**; la tarea se asigna por **nombre en texto** | inventario |
| Sucursal | texto libre que mezcla sucursales y departamentos, con un comodín «acceso total» | inventario |
| Último commit en GitHub | 2026-09-23. Se despliega con `railway up` desde una laptop: **GitHub puede no ser lo que corre** | bitácora de MDTask |

⭐ **Lo que ya existe en la Suite y NO se reconstruye:**

| Dominio de MDTask | Ya en la Suite |
|---|---|
| Organigrama (89 puestos) | `identity.positions` — vino de MDTask en `[AU.23]` (2026-09-15) |
| Promociones, formato MKTN001 y expediente | `[MKT.1]` `commercial-promo-agreements` |
| «¿La promo vendió?» (en MDTask: foto del ticket + importe tecleado) | `[MKT.6]` medición desde el ERP · `[MKT.18]` quién vendió, desde el arqueo |
| Personas | `identity.users` (`[OR.0]`: el usuario ES la persona) + el cruce de RH (`mapeo-personas-mega-talento.json`) |
| «A tu nombre» | contrato único de tarea `[OR.4]` (`libs/contracts/src/work/task.contract.ts`) + Mi trabajo |
| Gasto recurrente autorizado | `budget.expense_obligations` (única puerta de captura) → Calendario de Pagos (TP) |
| Fotos y archivos | `ObjectStorageService` (bucket privado, URL firmada) |
| LLM, dictado, WhatsApp | `AnthropicService` · `speech-to-text.service.ts` · `libs/whatsapp` (RH.3 ya lleva ahí el bot de Mega Talento) |

---

## 1. Cómo cambió el pedido

| # | Lo que se pidió | Efecto |
|---|---|---|
| 1 | «hay que migrar mega-dulces-app a suite. generemos un plan de implementación» (Edgar, 2026-11-13) | Esta fase, ⬜ |
| 2 | «la mesa de servicio es muy independiente» (Edgar, 2026-11-13) | El **vale de servicio operativo** de MDTask (`mdtask_tickets`) **no** lo absorbe Mesa de Servicio (MS): migra como dominio propio (D8) |
| 3 | «sigamos con lo demás y dejemos esto para después» (Edgar, sobre medir `eajd`) | `[MDT.0.1]` queda como primer item, NO MEDIDO; el plan no espera esa cifra |

---

## 2. El universo y el trabajo

- **Universo:** 19 dominios, 44 tablas, 159 fichas, ~95k líneas.
- **Trabajo:** lo que se **usa**, más lo que tiene dinero. No se puede cerrar hasta `[MDT.0.1]`, pero el
  código ya descarta una parte:

| Grupo | Dominios | Qué pasa |
|---|---|---|
| **Muerto en código** (UI retirada; algunos con backend vivo) | bloques de trabajo · rutinas viejas · áreas · calendario · `/turnos` · tareas únicas | **No se migra.** Se apaga el backend que sigue corriendo (bloques: generador cada 15 min) |
| **Sin datos** | plantillas (0 capturadas) · credenciales/login de plaza (0) · norma en tabla (`mdtask_tareas_puesto` = 0; la norma vive en el código) | No hay datos que cargar; la funcionalidad, si se quiere, se diseña en su fase dueña |
| **Ya construido en la Suite** | promociones/MKTN001/expediente · medición de la promo | **Corte**, no construcción (D9) |
| **Va a otra fase** | personal, pase de lista, turnos, descansos, plantilla | **RH** (D12) |
| **Trabajo real de MDT** | tareas del manual + evidencia + control · pagos de servicios · vale de servicio · flotilla (si se usa) · asistente/WhatsApp · agenda (si se usa) · Espacio TEC (si se usa) | Frentes 2–7 |

---

## 3. Lo que se podía suponer y no es

| # | Suposición | Lo que mide el código |
|---|---|---|
| 1 | «MDTask es la app de checklists» | Son **19 dominios**; uno de ellos mueve dinero (pagos de servicios) y otro lo documenta (promos con proveedor) |
| 2 | «Los tickets de MDTask son tickets de soporte → Mesa de Servicio» | Son el **vale de servicio operativo** en papel (tres firmas, materiales, folio). Y MS no lo absorbe (Edgar) |
| 3 | «La base de MDTask es Postgres» | Escribe en **Postgres y Firestore** a la vez; el robot de corte mensual leía Firestore y **borraba** lo enviado (lo detuvieron el 31-ago) |
| 4 | «Las personas ya están resueltas porque el organigrama vino de MDTask» | El organigrama sí; las **personas no**: uid de Firebase, nombre en texto y teléfono, **sin número de empleado**. El cruce es trabajo con revisión humana |
| 5 | «Las promos hay que migrarlas» | La Suite ya tiene MKTN001 + expediente (`[MKT.1]`) y mide la venta desde el ERP (`[MKT.6]`): se **cortan**, no se reescriben |
| 6 | «RH no toca a MDTask» (`FASE_RH` §8) | MDTask **lee `horarios_sucursal` de la base de Mega Talento** para emitir tareas y para Productividad, y RH decidió **no trasladar** esa tabla (`FASE_RH` §5.1). Apagar Mega Talento rompe MDTask (riesgo R1) |

---

## 4. Decisiones a firmar

| # | Decisión | Opciones | Recomendación (y porqué) | Firma |
|---|---|---|---|---|
| **D0** | ¿Se cierra **ya** la seguridad de MDTask, antes de migrar? | a) sí, lo mínimo · b) esperar a la migración | **a)**. La migración tarda semanas y hoy **cualquier sesión válida lee las contraseñas en claro de todo el personal** (un «espejo» que guarda la ficha). Va antes que todo (criterio 0). Lo mínimo: borrar el espejo y no devolverlo, firma obligatoria del webhook, límite de intentos en el login con PIN, y que el dueño **rote la cadena de conexión** (la bitácora dice que se filtró dos veces) y **haga privado el repo** (trae nombres y teléfonos reales). Es en el repo de MDTask: lo hace David; Claude no toca credenciales | Edgar + David |
| **D1** | ¿Dónde vive cada persona? | `identity.users` · tabla propia | **`identity.users`** (`[OR.0]`). Cruce uid de Firebase → `users.id` por correo, teléfono y nombre, **reusando el mapeo de RH**; lo que no cruce se revisa a mano y lo que quede sin identificar **se declara** (`PersonaRef` con `label` y sin `id`), nunca se adivina | Edgar |
| **D2** | ¿Se migran las contraseñas? | ninguna · los hashes de Firebase | **Ninguna.** Cada persona entra con su cuenta de la Suite o por invitación. El espejo en claro se destruye en D0 | Edgar |
| **D3** | ¿Quién crea la tarea del día? | a) un emisor periódico (como hoy: cada 10 min + medianoche) · b) **se deriva al leer** | **b)**. La tarea del día = norma × persona × fecha, calculada al consultar; **la fila nace cuando la persona entrega** (evento). Hoy MDTask corre 5 procesos por horario dentro del servidor web; la regla del proyecto es **ningún cron**. Los recordatorios por WhatsApp («resumen a las 8, aviso 30 min antes») **no se migran en el corte**: si se quieren, son una excepción con ADR | Edgar |
| **D4** | ¿Dónde vive la norma (el manual por puesto)? | en código (como hoy, 96 KB de catálogo) · como dato | **Como dato**, colgada de `identity.positions`, capturable por el jefe. Es lo que la propia bitácora de MDTask planeaba («la norma como dato») y nunca cerró | Edgar |
| **D5** | ¿Con qué motor de checklist? | un 3er motor · generalizar uno de los dos que ya hay (`trade` visitas/capturas · `logistics-checklists`) | **Generalizar uno**, subido a `libs/` (ADR-056: un primitivo de fase no cierra la fase). Antes de escribir código, `[MDT.1.1]` mide los dos y elige. Prohibido un tercero sin ADR | Equipo, Edgar firma |
| **D6** | ¿Qué historial se carga? | todo · últimos N días · nada | **Todo lo de `eajd`** (17,754 entregas / 43 MB al 22-sep, según la bitácora — chico) por **carga única por corte**, que no es importer: no se agenda ni se repite (precedente: RH D4). Las fotos de lo cargado pasan al bucket propio | Edgar |
| **D7** | ¿Y Firestore? | fuente · descartado | **Descartado.** Antes del corte, un control: conteo de entregas Firestore vs `eajd` en la misma ventana, publicado. Si diverge, se declara qué se pierde; no se fusiona | Edgar + David |
| **D8** | ¿Dónde va el vale de servicio operativo? | Mesa de Servicio · dominio propio | ✅ **Dominio propio** — Edgar, 2026-11-13. La tabla **no se llama `tickets`** (ADR-081). Área dueña y si sigue el formato de tres firmas: preguntas abiertas | ✅ Edgar |
| **D9** | ¿Promociones y venta de promos? | migrar las pantallas de MDTask · cortar a lo que ya hay | **Cortar a `[MKT.1]`/`[MKT.6]`/`[MKT.18]`** y cargar los folios vivos. La venta de promos que en MDTask se **teclea** (piezas, importe) **no se migra como captura**: sale del ERP (regla principal). Antes, `[MDT.0.3]` revisa si «luz verde» y «encargos» tienen equivalente o son un hueco | Edgar + Mercadotecnia |
| **D10** | ¿Pagos de servicios? | pantalla propia · `budget.expense_obligations` + Calendario de Pagos + comprobante | **El carril de Finanzas que ya existe**: el servicio recurrente es una obligación autorizada; el pago y su comprobante, del calendario. Se valida con Finanzas que el aviso al responsable de sucursal tenga lugar sin cron | Edgar + Finanzas |
| **D11** | ¿Flotilla (reservas de vehículos)? | migrar a `logistics-fleet` · retirar | **Según uso** (`[MDT.0.1]`): hoy su pantalla está retirada y vive sólo en el bot, con 3 vehículos de semilla. Con uso ~0, se retira | Edgar |
| **D12** | ¿Personal, plantilla, plazas, coberturas, pase de lista, turnos, descansos? | MDT · RH | **RH.** Plantillas y credenciales tienen 0 filas, y el pase de lista duplica a los relojes. MDT no los migra; RH decide si los necesita | Edgar |
| **D13** | ¿Espacio TEC (alumnos), agenda personal? | migrar · retirar | **Según uso.** Si no hay escritura en 30 días, se retiran con un export | Edgar |
| **D14** | ¿El asistente de WhatsApp (28 herramientas)? | todo · por herramienta · nada | **Al final y por herramienta**: sólo las de dominios ya migrados, dentro de `libs/whatsapp` (como RH.3). Falta saber qué número usa (pregunta abierta) | Edgar |

### ⚠️ Dos premisas refutadas al investigar (2026-11-14, lectura de código de los dos repos, sin base)

**D9 suponía que promociones ya estaba construido en la Suite y bastaba un corte. No es así**
(`MDT.0.3`):

- `/mkt/acuerdos` **sólo lista y muestra**: no hay pantalla para crear, editar, autorizar ni fijar
  canales de un acuerdo (el servicio del frontend tiene esos métodos y ningún componente los llama), y
  la evidencia se sube **tecleando un enlace**, no un archivo.
- `commercial.promo_agreements` tenía **0 filas** en prod (medido por la fase PU el 2026-10-10) y sus
  códigos **0 filas** (fase MKT, 2026-11-11).
- La medición de `[MKT.6]` mide sólo códigos con producto ligado, y ningún camino escribe esa liga: los
  21 canales salían `sin_alcance` en su propia prueba.
- **El folio no se puede heredar:** la Suite numera el acuerdo `MK-AAAA-NNNN` al autorizar, con **el
  mismo contador que los pedidos**; MDTask continúa el folio entero del papel.
- La fase MKT **no tiene fila en el roadmap**, y sus items `[MKT.7]`–`[MKT.23]` están todos en 🧪.

Lo que sí queda resuelto por diseño: «leer ticket con IA» y las piezas tecleadas **no se migran**, porque
la venta sale del ERP (`analytics.v_kepler_sales_lines`), siempre que cada promo del piso sea un código
de Kepler. MDTask no guarda ese código: **no determinado**.

**D10 suponía que el pago de servicios cabía en `budget.expense_obligations` + Calendario. Tiene tres
choques** (`MDT.1.6`):

- **Doble conteo:** la CFE ya llega al Calendario como documento de Kepler (acreedor `G*`,
  `X-A-10`), y el plan de presupuesto ya propone obligaciones de luz por sucursal. Cargar además el
  servicio de MDTask pondría **el mismo recibo dos o tres veces**.
- **Otro proceso:** el Calendario es el circuito de Tesorería (asignar día → preparar → autorizar →
  ejecutar contra el banco). En MDTask **paga la sucursal en el lugar** y manda la foto del recibo; para
  eso la Suite ya tiene un carril hermano, el vale de gasto (`finance.expense_proofs`), que el
  encargado de tienda sí ve.
- **No hay dónde vivir la norma del servicio** (periodicidad, día límite, responsable, número de
  servicio) ni llave de sucursal en la obligación; el comprobante del Calendario exige un pago de Kepler.

**El vale de servicio en MDTask, leído en su código** (`MDT.1.5`, sin volumen: `MDT.0.1` pospuesto):
una tabla sin llaves ni CHECK; folio = el mayor + 1 **fuera de transacción** (dos altas a la vez → la
segunda da error 500), arrancando en 513 para continuar el talonario; estados abierto → en proceso →
completado, más cancelado y reabrir; **cualquiera con acceso hace cualquier transición y firma en
cualquier casilla**; las 3 firmas son un trazo en el teléfono + nombre tecleado, **ninguna
obligatoria y se pueden quitar ya cerrado**; el cambio pisa la fila (no hay historial). Avisos por
evento (WhatsApp al asignar y al cerrar), ningún proceso por horario. Aparte existe la «Orden de
Mantenimiento» dentro del checklist de MDTask, con prioridad y foto, que parece muerta en pantalla pero
tiene historia.

**Modelo propuesto para la Suite** (no escrito): `platform.work_orders` (en pantalla «Vale de
servicio»; `tickets` lo prohíbe ADR-081, `requests` es de la Mesa y «vale» ya es el de caja) con folio
entero corrido por tenant desde `platform.work_order_sequences` asignado **dentro** de la transacción
del alta (el patrón de `servicedesk.request_sequences`, con contador propio para que el talonario sea
consecutivo); `platform.work_order_signatures` (realizado · revisado · recibido, trazo al bucket con la
validación por firma de bytes que ya vive en `libs/`, quitar = apartar); `platform.work_order_events`
(sólo insertar: reabrir ya no borra el cierre anterior). **No cabe en el motor de checklist**: el vale
no tiene plantilla, ni plazo, ni responsable al nacer, y una persona atiende varios al día. Entra a
Mi trabajo con su adaptador en `FUENTES_TAREA` (sin vencimiento: se declara). Tres llaves:
`VALE_SERVICIO_LEVANTAR` / `_ATENDER` / `_GESTIONAR`.

**Decisiones nuevas** — ✅ **resueltas el 2026-11-14 por Claude, con delegación expresa de Edgar** («resuelve esas dudas a tu consideración»); la resolución va debajo de la tabla:

| # | Decisión | Opciones | Recomendación (y porqué) | Firma |
|---|---|---|---|---|
| **D9b** | ¿Quién construye la captura del formato de promoción? | a) la fase MKT (sus pantallas, su dueño) · b) MDT la construye para poder cortar · c) MDTask conserva promociones hasta que MKT cierre | **c)**, con **a)** como el camino. Construirla dentro de MDT duplica el dueño de un dominio que tiene fase propia; mientras tanto MDTask sigue siendo donde se captura el formato. Antes, MKT necesita su fila en el roadmap | ✅ c) — Claude, por delegación de Edgar |
| **D8b** | Vale de servicio: ¿qué área lo atiende y qué exige para cerrarse? | a) Mantenimiento · b) Sistemas · c) cualquiera con la llave de atender; y por separado: firmas obligatorias o no al cerrar, quién puede levantar (todos o sólo quien lo hacía en MDTask), si continúa el folio de MDTask y si el talonario de papel sigue vivo | **El modelo está propuesto (abajo) y no se escribe la migración hasta firmar esto**: el reparto de llaves (regla 20) sale del área, y «firma obligatoria» es un CHECK que no conviene cambiar después. Recomendación para el folio: continuar el de MDTask y retirar el talonario el día del corte (dos fuentes del mismo número se cruzan) | ✅ ver resolución — Claude, por delegación de Edgar |
| **D10b** | ¿Quién paga un servicio y cuál es su obligación? | a) Tesorería, por el Calendario, y la obligación es el documento de Kepler · b) la sucursal, por el vale de gasto · c) las dos, según la forma de pago | **Medir primero** (`MDT.0.1`): cuántos servicios paga la sucursal en efectivo o tarjeta y cuántos Tesorería. Ninguna carga del historial antes de decidir cuál registro **es** el recibo, para no contarlo dos veces | ✅ medir primero + regla fija — Claude, por delegación de Edgar |

**Resolución (2026-11-14):**

- **D8b · vale de servicio** (hecho medido en prod, sólo lectura: el puesto *Jefe de Mantenimiento*
  tiene **1 persona** y ningún rol por defecto; *Sistemas*, 3 personas con superadmin; no existe un rol
  de mantenimiento).
  - **Atiende** quien tenga `VALE_SERVICIO_ATENDER`, como en MDTask, donde atendía una persona y no un
    área. Reparto inicial **derivado en la migración**: el rol de quien ocupa `jefe_mantenimiento`;
    si ese rol lo comparten puestos que no son de mantenimiento, la migración **se detiene y lo declara**
    en vez de repartir de más. `VALE_SERVICIO_GESTIONAR`: ese mismo rol, Dirección y superadmin.
  - **Levanta** cualquiera con personas a su nombre (el mismo universo que entrega tareas del manual):
    en MDTask era una bandera por persona porque no había roles; adivinar quién la tenía cerraría la
    puerta a alguien sin avisar.
  - **Firmas: ninguna obligatoria para cerrar**, como en MDTask; cerrar exige el detalle del trabajo.
    Es la opción reversible: volverla obligatoria después es una regla del servicio; quitar un CHECK,
    no. Lo que sí cambia: **una firma no se quita de un vale completado** (en MDTask sí se podía).
  - **Folio:** continúa el de MDTask; el contador se fija en la carga con el mayor folio de `eajd`, y
    el **talonario de papel se retira el día del corte**.
  - **Órdenes de Mantenimiento del checklist de MDTask: se retiran.** Están muertas en pantalla; su
    historia va en el export del retiro, no como dominio.
  - **Frontera con la Mesa de Servicio:** el vale es la constancia de un servicio que una persona
    atiende y firma; la Mesa es la cola de solicitudes a un área. No se cruzan.
- **D9b · promociones: c).** MDTask sigue capturando promociones hasta que la fase MKT tenga su
  captura. **No se abre la fila de MKT ahora**: hay 8 fases 🔨 contra un cupo de 4. Consecuencia: el
  retiro de MDTask (`MDT.9`) **excluye promociones** hasta entonces.
- **D10b · pagos de servicios: medir primero, con una regla fija desde hoy.** Nada de MDTask se carga a
  `budget.expense_obligations` (así no se cuenta dos veces la CFE). Con el censo: lo que paga la
  sucursal va al vale de gasto (`finance.expense_proofs`); lo que paga Tesorería ya existe como
  documento de Kepler en el Calendario. Mientras tanto, MDTask conserva pagos de servicios.
- **El censo de `eajd` (`MDT.0.1`) lo corre David**, dueño de esa base, con el script del repo (sólo
  lectura). Claude no busca ni toca credenciales (regla 7).

---

## 5. Qué NO incluye

- **Subir la adopción.** Migrar no cambia que 15 de 149 abran la app: eso es producto, otra fase. Lo
  que sí incluye es **no empeorarla** (la guarda de la métrica).
- Mega Talento (fase RH) ni los otros esquemas de esa base (`cotejo`, `esm`, `conta`).
- Recuperar o fusionar lo que sólo quedó en Firestore (D7: se declara, no se fusiona).
- **Rotar credenciales o tocar CORS** de MDTask: regla 7. Lo hace su dueño (D0).
- Los dominios muertos en código (§2): no se migran ni se rescatan.
- Escribir en Kepler: nada de MDTask escribe en el ERP, y esta fase tampoco.

---

## 6. El orden

| Orden | Frente | Dinero en juego | Esfuerzo | Prioridad | Por qué va ahí |
|---|---|---|---|---|---|
| **0** | Seguridad de MDTask (D0) | — | S | **0** | Contraseñas en claro expuestas hoy. No consume cupo: es en el repo de MDTask |
| **1** | `MDT.0` Medir | — | S | — | Sin uso medido no se sabe qué entra (D11, D13). Lo que no tenga uso no se construye |
| **2** | Promociones → MKT | NO MEDIDO (acuerdos con proveedor) | S–M | 1–2 | Ya está construido en la Suite: es un **corte**. Depende de que MKT esté en prod |
| **3** | Pagos de servicios → Finanzas | NO MEDIDO (pagos reales de sucursal) | M | 1–3 | Mueve dinero, y el carril destino existe |
| **4** | Tareas del manual (norma → motor → Mi trabajo → evidencia → control) | Bajo (beneficio indirecto) | **L–XL** | 4 | Es el núcleo y lo más grande. Se parte: la norma como dato (M) va primero |
| **5** | Vale de servicio | Bajo | M | 4 | Dominio propio chico (D8) |
| **6** | Flotilla · TEC · agenda (sólo si `MDT.0` mide uso) | Bajo | S–M c/u | 4 | Si no hay uso, retirar es el trabajo |
| **7** | Asistente de WhatsApp | Bajo | L | 4 | Depende de que su dominio ya esté migrado (D14) |
| **8** | Retiro | Medio (Railway, Firebase, Cloudinary: costo mensual NO MEDIDO) | S | — | MDTask en sólo lectura 2 semanas, luego se apaga |

⭐ La regla de Edgar pondría al núcleo (frente 4) al final por ser Bajo × XL. Se dice tal cual: la
razón de migrarlo no es el dinero, es **una sola plataforma**, una identidad y apagar tres
proveedores. Si el PM lo quiere antes, se mueve y queda escrito por qué.

---

## 7. Las capas

### C0 · Dato (medir y decidir qué entra)

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| MDT.0.1 | **Censo de `eajd`**: filas por tabla y escrituras en 7/30 días por dominio, con `system_identifier`, en sesión de sólo lectura. Script: [`database/scripts/mdt/censo-eajd.js`](../../../database/scripts/mdt/censo-eajd.js) | ⬜ **NO MEDIDO** — pospuesto por Edgar 2026-11-13 | Cada dominio contra su pantalla: lo que tiene escritura reciente se usa |
| MDT.0.2 | **¿GitHub = producción?** Commit desplegado en Railway contra `3aa3297` | ⬜ | El despliegue de Railway (lo ve David) |
| MDT.0.3 | **Cruce de promos**: cada concepto de MDTask (formato, expediente, leer ticket, venta, luz verde, encargos) contra `[MKT.*]`; lo que falte es un hueco con nombre | ✅ 2026-11-14 — cruce por código: la Suite no tiene la captura del formato y el folio no se hereda. **D9b: MDTask conserva promociones** hasta que MKT tenga su captura (el recorrido de un folio real queda para ese corte) | Un folio real recorrido en las dos apps |
| MDT.0.4 | **Cobertura del cruce de personas** (D1): fichas de MDTask que caen en `identity.users` por correo/teléfono/nombre, y entregas cuyo `assigned` en texto no identifica a nadie | ⬜ | Revisión humana de una muestra (el cruce por nombre necesita control negativo) |
| MDT.0.5 | **Firestore vs `eajd`** (D7): conteo de entregas en la misma ventana | ⬜ | Los dos almacenes, misma ventana y estatus |
| MDT.0.6 | **Organigrama**: catálogo de MDTask en HEAD contra `organigrama-mdtask.json` (snapshot del 15-sep) | ✅ 2026-11-13 — **89 de 90 cruzan por nombre**; falta **«Kileadora de Sucursal»** (`kileadora`, MDTask la agregó el 22-sep, después del snapshot) y TIENE manual. Contra el seed, no contra prod | Puesto por puesto, por nombre normalizado (AST del catálogo, sin ejecutarlo) |

⛔ Ningún frente pasa a C1 sin su fila de MDT.0.1. Lo que no se pudo medir **se declara**.

### C1 · Dominio

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| MDT.1.1 | **Elegir el motor de checklist** (D5): medir `trade` (visitas/capturas) y `logistics-checklists` contra lo que pide el manual (momento, frecuencia, hora límite, punto con foto obligatoria, evidencia escrita) | ✅ 2026-11-13 — motor genérico en `platform` (ADR-118). `trade.daily_captures` no es checklist (auditoría abierta, 1,331 filas, 40 archivos); `logistics.shipment_checklists` sirve de forma pero cuelga de embarque (0 filas) | Tabla de cobertura por requisito (10 requisitos × 3 candidatos) |
| MDT.1.1b | **Deuda con nombre (ADR-056):** pasar `logistics.shipment_checklists` a este motor (0 filas; 8 archivos consumidores, capa de compatibilidad) | ⬜ | `http-logistics-j8-test.js` |
| MDT.1.2 | **La norma como dato** (D4): `identity.positions` → puntos del manual, versionados; carga de los 391 puntos del catálogo actual | 🧪 2026-11-13 — migración `20261113175536` + siembra dentro de la migración (20 manuales, 51 tareas, 391 puntos; `kileadora` entra a `identity.positions`). **No aplicada a prod** | Conteo del seed contra el catálogo (AST): 51/51, 391/391. La migración la ejerce el job `pruebas-db` (NO MEDIDO en local) |
| MDT.1.3 | **La tarea del día derivada** (D3) + **adaptador en `FUENTES_TAREA`** para que aparezca en Mi trabajo › A tu nombre, sin una quinta tabla de tareas | 🧪 2026-11-13 — `tocaEnFecha` + `platform.checklist_runs` en el contrato de tarea (`assigned_by` NULL) + fuente de Mi trabajo que DERIVA lo pendiente | `checklist.contract.spec.ts` (23 ✓) · `test-newdb-mdt-checklists.js` §1 y §9 (NO MEDIDO en local) |
| MDT.1.4 | **«Hecho» = con evidencia**: llevar las reglas puras de MDTask que ya tienen pruebas a `libs/` con sus specs | 🧪 2026-11-13 — portadas: hecho/justificado/no ejecutado, entregable, avance. **Sin portar** (pendiente): urgencia, productividad, cobertura | `checklist.contract.spec.ts` (23 ✓, con negativas) |
| MDT.1.5 | **Vale de servicio** (D8, D8b): `platform.work_orders` + firmas + historial, folio corrido por tenant asignado DENTRO de la transacción; nada se borra (se cancela) | 🧪 2026-11-14 — migración `20261114094841` con las invariantes en la base (CHECK de estados, trigger del folio, trigger «una firma no se quita de un vale completado»), llaves en PILOTO; contrato `vale-servicio.contract.ts` con `motivoNoPuede` (12 ✓). **No empujada**: espera coordinar quién la aplica en prod | `test-newdb-mdt-vales.js` — NO MEDIDA en local (corre en `pruebas-db`) |
| MDT.1.6 | **Pagos de servicios → `expense_obligations`** (D10): el mapeo servicio-sucursal-proveedor-periodo | ⚠️ 2026-11-14 — mapeo hecho (15 huecos); **D10b: medir primero**, nada se carga a `expense_obligations`; espera el censo que corre David | Un periodo real de MDTask reproducido en el calendario |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| MDT.2.1 | Entregar la tarea del día con evidencia (`/checklists/runs…`: abrir, guardar punto, subir/retirar archivo, entregar) | 🧪 2026-11-13 | **sí** | `test-newdb-mdt-checklists.js` (registrada en `run-all-tests`, ~40 afirmaciones con negativas) — **NO MEDIDA en local** (no hay base segura; el `.env` apunta a prod): la corre el job `pruebas-db` |
| MDT.2.2 | Capturar y versionar la norma por puesto (`POST /checklists/norms/:id/versions`) — desde 2026-11-14 también la **hora límite**, versionada (enmienda de ADR-118) | 🧪 2026-11-14 | **sí** | misma prueba, §8 y §8b (vigencia hacia atrás 400; hora inválida o antes del inicio 400; una versión sin hora conserva la anterior; la entrega abierta conserva su hora; la derivada de hoy toma la nueva) — **NO MEDIDA en local** |
| MDT.2.3 | Vale de servicio: `/work-orders` — levantar, tomar, asignar, capturar el trabajo, completar, cancelar, reabrir, firmar y quitar firma; la regla de quién hace qué es la del contrato, con la fila bloqueada | 🧪 2026-11-14 | **sí** | `test-newdb-mdt-vales.js` (~35 afirmaciones con negativas) — **NO MEDIDA en local**; llaves por endpoint y arranque del módulo: `work-orders.controller.spec.ts` (7 ✓, con negativas) |
| MDT.2.4 | Lecturas de control derivadas (`GET /checklists/team`, `mine`, `norms`) | 🧪 2026-11-13 | no | < 500 ms: **NO MEDIDO** (las tablas no están en prod) |
| MDT.2.5 | Tres llaves (`TAREAS_PUESTO_ENTREGAR`/`_EQUIPO_VER`/`_NORMA_GESTIONAR`), repartidas en la migración (derivado de la cadena de mando, no a mano); el alcance lo calcula el servidor | 🧪 2026-11-14 — **PILOTO**: las tres llaves sólo a Dirección, RH y superadmin. Repartir «entregar» a todos mientras la gente entrega en MDTask haría que Mi trabajo les marque pendiente lo que sí entregaron; el reparto amplio es del corte (`MDT.C1`) | — | `checklists.controller.spec.ts` (5 ✓, con negativa) · `test-newdb-permission-delivery` sólo da verde tras aplicar |

### C3 · UI

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| MDT.3.1 | `/tareas/hoy` + `/tareas/entrega/:id` (móvil primero: cámara directa, foto reducida a 1600 px antes de subir, «Entregar» pegado al pulgar) | 🧪 2026-11-13 | pantallas nuevas: 0 → 0 fallas; `check:templates-types --all` verde. **Sin validación visual** (no se levantó la app; regla 3) |
| MDT.3.2 | `/tareas/manual` — lectura de la norma por puesto | 🧪 2026-11-13 (lectura) | 0 → 0 fallas. **Sin validación visual** |
| MDT.3.2b | Editor de la norma en el panel lateral de `/tareas/manual`: hora límite, puntos (texto, bloque, evidencia, qué pide; agregar, quitar, mover), desde cuándo rige y motivo; sólo con `TAREAS_PUESTO_NORMA_GESTIONAR`; cerrar con cambios sin guardar pregunta | 🧪 2026-11-14 — **sin validación visual** | barrido completo: 0 fallas nuevas (el editor es pieza, vive en `components/`); `check:templates-types --all` verde |
| MDT.3.3 | `/tareas/equipo` — avance de mi gente, por atraso, detalle en side-peek | 🧪 2026-11-13 | 0 → 0 fallas. **Sin validación visual** |
| MDT.3.4 | Vale de servicio: `/vales/lista` (míos · cola · todos, búsqueda en el servidor, tope declarado, «Levantar vale») y `/vales/ver/:id` (estado y acción que toca, el trabajo con «Guardar» y aviso de cambios sin guardar, tres firmas con el dedo, historial) | 🧪 2026-11-14 — **sin validación visual** | barrido completo 0 nuevas; `check:templates-types --all` verde |
| MDT.3.5 | Observaciones de diseño UI — revisión del plan (`auditoria-diseno` §9) | ✅ 2026-11-14 (nivel C, tarde: debía ir antes del primer C3) — 13 observaciones, 3 🔴, al final de este doc | |
| MDT.3.6 | Las 🔴 y 🟠 de la revisión en las pantallas: vencidas que no se pintan en verde y límites a la vista (UI.1, UI.2), lo no guardado dicho en su punto con «Reintentar» (UI.3, UI.4), fotos por punto sin congelar y conservadas al fallar (UI.5), quitar con confirmación y 44 px (UI.6), entrega tardía hasta 7 días (UI.7), orden por momento (UI.8), «una vez al día» en las 7 por evento (UI.9), «—» en vez de 0 % (UI.10), sucursal por nombre en la búsqueda y fecha legible (UI.12) | 🧪 2026-11-14 — **sin validación visual**; UI.11 espera a D11 y UI.13 es la revisión en nivel A | 0 → 0 fallas nuevas; `check:templates-types --all` verde |

⛔ La skill `diseno` se carga antes del primer archivo, y antes del primer item C3 va la sección
«Observaciones de diseño UI — revisión del plan» al final de este doc (`auditoria-diseno` §9).
⛔ **Medir la pantalla que se reemplaza antes de diseñar la nueva**: `/tareas` de MDTask es un solo
componente de 5,614 líneas; no se copia su forma.

### Cortes (uno por dominio, método de RH §6)

| # | Item | Estado |
|---|---|---|
| MDT.C1 | **Corte de tareas del manual:** migración que reparte `TAREAS_PUESTO_ENTREGAR` a todo rol con personas y `TAREAS_PUESTO_EQUIPO_VER` a los roles con puestos a cargo (derivado de la cadena de mando); el mismo día, MDTask deja de recibir entregas de tareas (lo hace David) y se avisa al personal | ⬜ — después de validar en prod con el piloto |
| MDT.C2 | **Corte del vale de servicio:** un rol propio de Mantenimiento con `VALE_SERVICIO_ATENDER` (hoy el jefe comparte `administrativo` con 7 puestos), `VALE_SERVICIO_LEVANTAR` a todo rol con personas, la carga única de `eajd` con su folio y el talonario de papel retirado ese día | ⬜ — necesita el censo (`MDT.0.1`) |

1. Ventana corta fuera de horario; MDTask sigue vivo hasta el corte de cada dominio.
2. Carga única idempotente contra destino seguro (`assert-safe-target`) con **reporte de cuadre**:
   filas por tabla, entregas por persona y día, folios. Si no cuadra, no hay corte.
3. El dominio en MDTask queda **de sólo lectura 2 semanas** como vuelta atrás.
4. `[MDT.9]` retiro: servicio de Railway, proyecto de Firebase, Cloudinary y el schema `eajd` (que es
   de otra base: se archiva, no se borra sin autorización).

---

## 8. Riesgos y bloqueos

| # | Riesgo / bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|---|
| R1 | **Apagar Mega Talento rompe MDTask** | Dueño de RH + David | MDTask lee `horarios_sucursal` de la base de Mega Talento para emitir tareas y para Productividad; RH no traslada esa tabla | `[RH.4]` no retira esa tabla mientras MDTask esté vivo, **o** MDTask pasa a leer el horario de la Suite. Avisar a RH ya |
| R2 | Contraseñas en claro expuestas hoy | David | Decisión vieja del cliente («espejo» para soporte) | D0 |
| R3 | No se sabe qué corre en prod | David | Despliegue desde una laptop; la bitácora registró «GitHub 17 commits atrás» | `MDT.0.2` |
| R4 | Cupo excedido | Edgar | 6 🔨 contra 4 | Cerrar o pausar 2 antes de abrir (lo natural: MDT hereda el lugar de RH cuando cierre, con el mismo dev) |
| R5 | Medición de `eajd` pospuesta | Edgar | Decisión del 2026-11-13; además falta la cadena de conexión en un lugar alcanzable | Correr `censo-eajd.js` con `MT_DATABASE_URL` cuando se retome |
| R6 | Personas sin identidad | Dueño técnico | Sin número de empleado; tareas asignadas por nombre | `MDT.0.4` + D1 (declarar, no adivinar) |
| R7 | Procesos por horario dentro del servidor web (amarran MDTask a una réplica) | — | Diseño de MDTask | D3: en la Suite no hay emisor; los avisos son excepción con ADR |

---

## 9. Preguntas abiertas

1. ~~¿Quién es el dueño técnico de MDT?~~ ✅ 2026-11-14: **David** (escribió MDTask y conoce su base). Falta que él lo acepte.
2. ¿Qué número de WhatsApp usa el bot de MDTask? **No se decide: es un hecho que reporta David.**
3. ~~Vale de servicio: área dueña y firmas~~ ✅ D8b, resuelta arriba.
4. ¿Espacio TEC sigue vivo? Lo contesta el censo (`MDT.0.1`, D13).
5. ¿Cuánto cuesta al mes lo que se apaga (Railway, Firebase, Cloudinary)? **Hecho que reporta David** (dueño de las cuentas).

---

## 10. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Toda compuerta nueva **rota a propósito una vez**, rojo verificado
- [ ] 5. El motor de checklist en `libs/` compartido **o** deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod** y MDTask apagado, o escrito por qué no y qué falta

---

## 10b. Diseño de las pantallas — las cinco preguntas (skill `diseno` §0b), antes de maquetar

**Propósito, en una frase cada una (sin «y»):**
- `/tareas/hoy` — ¿qué me pide hoy el manual de mi puesto que todavía no entregué?
- `/tareas/entrega/:id` — ¿qué le falta a esta entrega para darla por hecha?
- `/tareas/equipo` — ¿quién de mi gente va atrasado hoy?
- `/tareas/manual` — ¿qué pide el manual a este puesto?

**Estado real (paso 3):** las tablas nacen vacías; el uso de MDTask NO MEDIDO (`MDT.0.1`). Quién
entra en celular: anaquelista, cajera, almacenista, surtido — los 22 puestos con manual tienen 87
personas en prod. Se diseña **móvil primero** para `/tareas/hoy` y la entrega; equipo y manual son
de escritorio (jefaturas, RH).

| # | Pregunta | `/tareas/hoy` + entrega | `/tareas/equipo` | `/tareas/manual` |
|---|---|---|---|---|
| 1 | Qué ve y en qué orden | Veredicto arriba (pendientes · vencidas · entregadas de hoy); la lista **por hora límite**, lo vencido y lo pendiente primero, lo entregado al final. En la entrega: los puntos en el orden del manual, cada uno con su estado y su botón de evidencia; «Entregar» abajo, pegado al pulgar | Veredicto (personas · con vencidas · % de puntos hechos); la tabla **por atraso** (más vencidas primero), no alfabética | Selector de puesto; sus tareas en orden de hora y momento; los puntos de cada una |
| 2 | Qué no ve | Las tareas por evento (no se pueden anticipar: se declara); el documento completo del manual (sólo su título y versión) | La entrega punto por punto (está a un clic, en el panel) | Las versiones viejas (a un clic, cuando haya editor) |
| 3 | Accesibilidad | 1 toque de Mi trabajo a la lista, 1 a la entrega; foto con la cámara directa; 44 px en táctil; sin color como único portador (cada estado lleva texto) | Buscable por nombre; fila con teclado; el detalle en side-peek | Buscable por texto del punto |
| 4 | Ligas | Viene de Mi trabajo (fuente `platform.checklist_runs`); cada tarea dice de qué documento y versión del manual sale | Cada tarea del panel abre la entrega de esa persona (sólo lectura) | Cada tarea dice su documento, código y versión |
| 5 | ¿Le toca a esta pantalla? | Sí: es la única puerta para entregar | Sí, a jefaturas (`TAREAS_PUESTO_EQUIPO_VER`); la persona sólo ve lo suyo | Lectura para jefaturas y RH; **quien gestiona la norma la cambia en el mismo panel** (`MDT.3.2b`) |

**El editor de la norma (`MDT.3.2b`, 2026-11-14), las cinco preguntas:** ¿qué pide esta tarea a partir
de cuándo, y por qué cambió? **(1)** Ve primero la hora límite y desde cuándo rige (es lo que hoy está
mal en las 51), después los puntos en el orden del manual y al final el motivo; arriba, en una línea,
que se guarda como la versión siguiente y que lo ya abierto no cambia. **(2)** No ve las versiones
viejas (la API sólo devuelve la vigente: deuda con nombre) ni los ids de los puntos. **(3)** Está en el
mismo panel donde se lee la tarea, a un botón; cada control con su rótulo; mover, quitar y agregar con
botón (sin arrastrar), 44 px con dedo; cerrar con cambios sin guardar pregunta. **(4)** Liga con las
entregas: la versión nueva rige desde su fecha, y la tarea derivada de ese día toma su hora. **(5)** Sí,
y sólo para `TAREAS_PUESTO_NORMA_GESTIONAR` (Dirección, RH, superadmin); las jefaturas lo leen.

**El vale de servicio (`MDT.3.4`, 2026-11-14), las cinco preguntas.** Lista: *¿qué vales me tocan
ahora?* · Vale: *¿qué falta para cerrar este vale?* **(1)** Lista: arriba cuántos hay en proceso, sin
dueño y míos sin cerrar; la tabla con lo vivo primero (en proceso, abiertos) y el folio más nuevo
arriba; «Levantar vale» como única acción principal. Vale: folio y estado, quién lo pidió y quién lo
atiende; la acción que toca ahora (tomar, completar) arriba; después el trabajo, las tres firmas y el
historial. **(2)** En la lista no van el detalle del trabajo ni las firmas (están en el vale); en el vale
no van los vales de otros. **(3)** Se busca por folio sin ceros («513»), área, lo que se necesita o
quién lo pidió; la fila abre el vale con el teclado; 44 px con dedo; firmar con el dedo en el
celular. **(4)** Mi trabajo › «Vales de servicio a tu cargo» abre la lista en «míos»; cada fila abre su
vale; el historial dice quién hizo cada cambio. **(5)** Quien levanta ve los suyos; quien atiende, además
la cola; quien coordina, todos — lo decide el servidor, no la pantalla. **Niveles:** primario = el estado
y la acción que toca · secundario = el trabajo · terciario = firmas e historial.

**Niveles (§Q.5):** primario = cuántas tareas faltan hoy · secundario = la lista con su hora límite ·
terciario = el documento del manual y el avance por puntos.

**Lo que la interfaz NO resuelve (se dice primero):** los descansos por persona (son de RH); el
historial de MDTask (sin cargar: `MDT.0.1`); las versiones viejas de una tarea (la API sólo devuelve la que rige).

---

## 11. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-13 | Plan inicial: inventario del repo (sólo lectura) + cruce con la Suite. `eajd` sin medir (pospuesto). D8 firmada | Edgar + Claude |
| 2026-11-13 | Edgar: «implementemos todo» → 🔨 por encima del cupo. **D0 hecho como parche** para el repo de MDTask (no se empujó: lo aplica David): la contraseña deja de guardarse y de salir en `/api/usuarios`, SQL `061` borra el espejo existente, el webhook de WhatsApp falla cerrado. Pendiente del dueño: borrar el campo en el respaldo de Firestore, rotar la cadena de conexión, hacer privado el repo | Claude |
| 2026-11-13 | **Tramo 1 del núcleo, 🧪 (nada en prod):** migración `20261113175536` (motor `platform.checklist_*`, `kileadora`, siembra de 51 tareas, 3 llaves repartidas) · contrato `checklist.contract.ts` (23 ✓) · `ChecklistsModule` `/checklists` (5 ✓ de llaves) · fuente de Mi trabajo derivada · 4 pantallas `/tareas/*` (`check:pantalla` 0 fallas, `check:templates-types --all` verde) · prueba contra base real escrita y registrada, **NO MEDIDA en local** · ADR-118. Compuertas rojas AJENAS (no medidas para este cambio): `test-authz-route-coverage` (6 escrituras abiertas en finanzas/RH y 4 llaves invisibles de otras fases) y `lint:boundary` (3 `any` en compras). **Sin validación visual** | Claude |
| 2026-11-13 | Norma extraída del código de MDTask por AST (sin ejecutarlo): **20 manuales, 51 tareas, 391 puntos de control**, evidencia declarada en 38 tareas (la regla de Dirección del 3-sep: todo punto pide foto salvo los declarados como escritos o documento). La bitácora de MDTask decía 377 puntos: el catálogo creció después (kileadora, empaque). `MDT.0.6` cerrado | Claude |
| 2026-11-14 | **Revisión de diseño (`MDT.3.5`, tarde) y sus arreglos (`MDT.3.6`, 🧪):** 13 observaciones, 3 🔴 — las 51 tareas vencen a las 23:00 y el jefe veía «0 vencidas» todo el día; quien descansa salía con todo pendiente y el aviso estaba plegado; lo escrito que no se guardaba se seguía viendo. Corregidas en las pantallas, con la ventana de 7 días y el orden por momento en el contrato. **Investigación de tres frentes en el código de los dos repos** (sin base): D9 y D10 tenían premisas falsas (la captura de promociones no existe en la Suite; el pago de servicios contaría la CFE dos veces y lo paga la sucursal, no Tesorería) → **D9b, D10b**; el vale de servicio tiene modelo propuesto y espera **D8b** | Claude |
| 2026-11-14 | **Editor del manual (`MDT.3.2b`, 🧪):** la hora límite pasa a ser parte de la VERSIÓN de la norma (enmienda de ADR-118), así el jefe pone las 10:00 a la apertura sin reescribir lo ya juzgado. Cambian la migración `20261113175536` (no aplicada en ningún lado), el servicio, la fuente de Mi trabajo (además usa la hora guardada en la entrega abierta) y la prueba (§8b) | Claude |
| 2026-11-14 | **D8b, D9b y D10b resueltas** por Claude con delegación expresa de Edgar («resuelve esas dudas a tu consideración»), con un hecho medido en prod (sólo lectura): *Jefe de Mantenimiento* tiene 1 persona y ningún rol, *Sistemas* 3 con superadmin. Vale: atiende quien tenga la llave, reparto derivado del puesto; ninguna firma obligatoria. Promociones se quedan en MDTask. Pagos de servicios: medir primero y nada a `expense_obligations`. El censo lo corre David | Claude (por delegación) |
| 2026-11-14 | **Entrega a `origin/main`** del núcleo (`9edf79e7f`): CI con build y secretos en verde y `ci-green` sellado; la prueba contra base real del motor de checklists corrió por primera vez en `pruebas-db`: **50 ✓ · 0 ✗ · 0 no medido**. Dos defectos encontrados al soltar, ya corregidos: la migración pedía el JSON de la siembra y el aplicador de prod sólo copia el `.js` (se metió la siembra adentro, `d88bfc45a`, con prueba negativa) · `tareas` no tenía su landing dinámico (`landing-guards.spec`). El rojo de `gastos-tabs.spec` es ajeno (`2861efa03`). La migración la aplica el carril de entrega (esta sesión no tiene acceso a md) | Claude |
| 2026-11-14 | **Vale de servicio construido (🧪, no empujado)**: migración `20261114094841`, contrato, API `/work-orders`, prueba contra base real y dos pantallas. Medido en prod (sólo lectura): el jefe de mantenimiento comparte el rol `administrativo` con 7 puestos, así que «atender» va en piloto y el rol propio queda para el corte (`MDT.C2`) | Claude |

---

## Observaciones de diseño UI — revisión del plan (2026-11-14)

> **Con qué se miró: el plan y el código de las cuatro pantallas ya construidas, no la pantalla viva**
> (nivel C, más la siembra medida con un script). Como la capa C3 ya estaba en 🧪 cuando se hizo esta
> revisión —debía ir antes, `MDT.3.5`—, cada observación es **un criterio a verificar** en la pantalla,
> no un defecto medido. Nada visual se da por medido. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) y su implementación
> [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso, escondería lo que
> importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro de la fase · 🟡
> mejora; si no entra, deuda con nombre.

**Lo medido para esta revisión** (siembra de la migración `20261113175536`, 2026-11-14): las **51 tareas
vencen a las 23:00** (la ventana del día de MDTask, `06:00–23:00`; la hora real de cada sucursal vive
en Mega Talento, R1) · de los **391 puntos, 383 piden foto**, 4 texto y 4 renglones · **7 tareas se
llenan por evento y se entregan consolidadas una vez al día** (recepción, checado, liberación,
entradas y salidas de CEDIS, liberación de ruta) y **1 es sólo por evento** (entrega de unidad de
flotilla) · momentos: apertura 5, operación 26, administrativo 8, cierre 11, supervisión 1.
Contraste de los tokens de texto de las cuatro pantallas sobre `--card-bg` (script con controles
21.00 y 4.48): `--text-faint` 5.28 claro / 5.25 oscuro, `--text-muted` 6.91 oscuro, `--bad-fg` 4.83
claro — **pasan AA**.

**La pregunta que contesta cada pantalla (prueba de la frase):** las cuatro de §10b son una sola
pregunta cada una. ⚠️ Pero la de `/tareas/equipo` —*¿quién de mi gente va atrasado hoy?*— **no se
puede contestar con la norma de hoy** (MDT.UI.1).

**Jerarquía:** `/tareas/hoy` primario = cuántas tareas faltan · secundario = la lista por momento del
día · terciario = documento y avance por puntos. Entrega: primario = cuántos puntos no tienen
evidencia · secundario = los puntos en el orden del manual · terciario = documento, formato y hora.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| MDT.UI.1 | 🔴 | **«Con tareas vencidas: 0» todo el día.** Las 51 tareas vencen a las 23:00, así que a las 3 de la tarde una apertura sin hacer se ve igual que una al día, y el contador salta cuando la sucursal ya cerró. El jefe lee «nadie va atrasado» justo cuando todavía podía actuar. | Estándar §1 (un cero que no se midió) · DESIGN §Q.2 | Mientras la hora límite sea la del fin del día, el contador no se pinta en verde: la franja dice cuántas personas tienen tareas por entregar, y queda visible (no plegado) *«Todas las tareas vencen al final del día (23:00): la Suite todavía no tiene el horario de cada sucursal, así que no sabe si una apertura va tarde»*. La hora por tarea se captura en el editor de la norma (`MDT.3.2b`) |
| MDT.UI.2 | 🔴 | **Quien descansa aparece con todo pendiente, y a las 23:00 con todo vencido.** Los descansos son de RH y la Suite no los tiene; el aviso existe pero vive en un plegable que nadie abre. El jefe ve a alguien «sin entregar» el día que no trabajó. | Estándar §1.5 (el universo se declara) | En `/tareas/equipo` los límites se leen **sin abrir nada**, junto al veredicto. En mis tareas pueden quedarse plegados: la persona sabe que descansa |
| MDT.UI.3 | 🔴 | **Lo escrito que no se guardó se sigue viendo.** La evidencia escrita se guarda al salir del campo; si falla, aparece un aviso de unos segundos y el cuadro conserva el texto como si estuviera guardado. La persona sale creyendo que quedó, o entrega con justificación algo que sí hizo. | DESIGN §10.8 (estado sucio) | El punto dice en su lugar «No se guardó · Reintentar», con el texto conservado; «Entregar» no se habilita mientras haya un punto sin guardar o guardándose; cerrar la pestaña con algo sin guardar pregunta antes |
| MDT.UI.4 | 🟠 | **La barra cuenta lo que el servidor ya sabe, no lo que se acaba de escribir.** Mientras se escribe el último punto, la barra pide «escribe por qué no se pudo» y ofrece «Entregar con justificación». | Estándar §4 (comprensión) | Mientras haya texto sin guardar, la barra dice «Guardando lo que escribiste…» y no pide justificación |
| MDT.UI.5 | 🟠 | **Una foto que no subió se pierde, y mientras sube una se congela toda la pantalla.** 383 de 391 puntos piden foto y en el piso la señal falla. Hoy, si la subida falla hay que volver a tomarla, y durante cada subida no se puede tocar ningún otro punto. | DESIGN §10.10 (fallo parcial) · Doherty | Cada punto sube lo suyo sin bloquear a los demás; la foto que falló queda en su punto con «Reintentar»; «Entregar» espera a que no haya subidas en curso |
| MDT.UI.6 | 🟠 | **Quitar una foto es un botón de 32 px pegado a la miniatura** (que abre la foto al tocarla), en rojo y sin confirmar. En celular el dedo cae en uno o en otro, y el error cuesta volver a tomar la foto. | Fitts (44 px con dedo) · DESIGN §10 (poka-yoke) | 44 px con `pointer: coarse` y confirmación con `p-confirmDialog` («¿Quitar esta foto?»). Deshacer sin confirmar queda como deuda (el borrado ya es lógico) |
| MDT.UI.7 | 🟠 | **El servidor acepta entregar hasta 7 días tarde y la pantalla sólo llega a «ayer».** Lo de hace 2 a 7 días existe y no se alcanza. | Estándar §2 (alcance) | Además de Hoy y Ayer, «Otro día» con calendario limitado a los 7 días que acepta el servidor (la misma constante, desde el contrato) |
| MDT.UI.8 | 🟠 | **«Por hora límite» no ordena nada y «vence 23:00» se repite en cada renglón.** Con 51 de 51 a la misma hora, la lista cae a orden alfabético: la apertura puede quedar debajo del cierre. | DESIGN §Q.5 · carga (repetir no informa) | Orden: vencidas, en proceso, pendientes, entregadas; dentro, por momento del día (apertura → operación → supervisión → administrativo → cierre). La hora va una vez en el encabezado cuando es la misma para todas, y en el renglón sólo cuando difiere |
| MDT.UI.9 | 🟠 | **Siete tareas se llenan por cada recepción, pedido o ruta y aquí se entregan una vez al día.** La lista no lo dice: quien recibe tres camiones puede creer que entrega sólo el de la mañana. | Estándar §4 (rótulo que dice lo que es) | En el renglón: «Una vez al día: junta todas las de hoy». La nota completa de la norma sigue en la entrega |
| MDT.UI.10 | 🟡 | **Un 0 % cuando no hay nada que medir.** Con un puesto sin tareas ese día, la franja dice «Puntos con evidencia 0 % (0 de 0)» arriba del vacío. | ADR-056 | Con 0 puntos el valor es «—» y la nota dice «sin puntos este día» |
| MDT.UI.11 | 🟡 | **La tarea que sólo ocurre por evento (entrega de unidad) no tiene puerta.** No se deriva y no hay forma de iniciarla. | Estándar §2 | Se decide con D11: si flotilla se retira, sale de la norma; si se queda, un botón «Registrar entrega de unidad» que abre su entrega |
| MDT.UI.12 | 🟡 | **La búsqueda del equipo no encuentra la sucursal por su nombre** (busca en la clave) y la entrega muestra la fecha como `2026-11-13`. | regla PM sucursal por nombre · Estándar §4 | Buscar el nombre de la sucursal encuentra a su gente; la fecha se lee «jueves 13 de noviembre» |
| MDT.UI.13 | 🟡 | **Nada de esto se vio en un celular.** La cámara (`capture`), la foto HEIC de iPhone (se guarda tal cual y un navegador que no es Safari no la pinta en la entrega que abre el jefe), la barra pegada abajo con el teclado abierto y el modo oscuro sólo se comprueban en nivel A. | método §4 | Ninguna pasa a 🚀 sin una revisión en nivel A con `auditoria-diseno` en un Android y un iPhone (390 px, oscuro, `forced-colors`) |

**Lo que esta revisión no cubre:** alto real de fila, pliegue, foco y teclado recorridos, lector de
pantalla y retrabajo medido en producción (no hay uso todavía: las tablas no están en prod).
