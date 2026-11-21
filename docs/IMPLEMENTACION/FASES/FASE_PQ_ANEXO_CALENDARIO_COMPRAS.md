# Fase PQ · Anexo C — Calendario de compras: que ningún proveedor se quede rezagado

> Anexo de [`FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md`](FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md), frente **F2** (agenda de
> proveedores). Reemplaza el alcance de **PQ.3** y lo parte en **PQ.3.1–PQ.3.14**; absorbe la pestaña Ciclo
> de **PQ.4** y la fuente del aviso de **PQ.5**. Método: [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Las decisiones de este anexo se numeran **DC1–DC24** para no confundirlas con las D del plan base.
> ⭐ **Cómo se revisa (reglas por alcance: corporativo, zona o sucursal) y las visitas por WhatsApp: §10.**

```
OBJETIVO: sustituir la hoja «2026» del Excel de Compras (la brújula del equipo para no dejar
          proveedores rezagados) por un calendario en la Suite donde todos los proveedores tienen
          ciclo y el estado de cada uno sale de Kepler, no de un color puesto a mano.
MÉTRICA:  proveedores con compra en los últimos 12 meses y ciclo DEFINIDO por la gerencia de compras, HOY
          (2026-11-10): 0 de 356 (sin las 9 claves de sucursal propia; la Suite no tiene captura de
          ciclo usada: 0 manuales).
          → META: 356 de 356 (DC5: todos entran en ciclo) y la hoja 2026 deja de usarse.
CAPA TOPE: C3 (pantalla Compras › Calendario de compras)
ÁREA:      Compras (operan) · Dirección (consulta) · sucursales (compras locales)
DUEÑO:     Francisco (negocio)
ESTADO:    🔨 — PQ.3.1–PQ.3.6 🧪 (vista, base, dominio, API, pantalla, permisos y alcance); dentro de PQ (🔨), no abre fase.
```

Medido en `pg-prod` (`system_identifier` 7688376744939610156), **sólo lectura**, usuario nominal,
2026-11-10. La hoja de Excel se leyó fuera del repo (no se importa: regla 1; sirve de **testigo**).
⚠️ Repo público: aquí van conteos y puestos, nunca nombres de personas ni montos.

---

## 1. Qué problema resuelve

La hoja 2026 es un bloque por día hábil (219 días, 1,487 renglones, 293 nombres de proveedor): debajo
de cada fecha, los proveedores a los que toca pedirles y, por sucursal, un **color** (se pasó · no se
pasó · requisición · traspaso). Al pedir, el comprador **escribe al proveedor en su siguiente fecha**;
por eso la hoja ya llega al 28-dic. En la hoja (la revisión corporativa) es «cada N días», no día
fijo: de 118 proveedores con 4+ apariciones, sólo 12 caen ≥ 70 % el mismo día de la semana. En la
compra local de cada sucursal sí hay día fijo (§10.2).

La Suite ya tiene la agenda por proveedor (PQ.4, pestaña Ciclo de Pedido) y el aviso «hoy te toca»
(PQ.5), y **no la sustituyó**:

| Medido | Valor |
|---|---|
| Uso de la agenda (`worklist/proveedores`, 30 d) | 39 consultas en 9 días |
| Ciclos capturados a mano en la Suite | 0 (proveedores y canales) |
| Ciclo de la agenda (entregas por almacén) contra el del Excel | razón mediana **0.59**: marca vencido antes de tiempo |
| Ciclo por rondas de órdenes de Kepler (X-A-35, toda la red; la vista PQ.3.1) contra el del Excel | razón mediana 0.82; **42 %** dentro de ±30 %, 74 % dentro de ±50 % |
| «Se pasó el pedido» (verde) con documento X-A-30/35 de Kepler a ±3 días | **67–70 %** (tres sucursales), 57 % (la cuarta); el rojo, 30–39 % |
| Lo mismo contra requisiciones de la Suite | 27 % (el pedido se arma también fuera de la Suite) |

Conclusión: el **estado** del día se puede derivar de Kepler; el **ciclo** no se puede adivinar (Kepler
lo propone, Compras lo confirma: es la D5 ya firmada).

## 2. Qué NO incluye

- El plan comercial con proveedores (TOP semanal, folleto, eventos): es de Mercadotecnia (Francisco,
  2026-11-10). Las temporadas siguen en PQ.94.
- Cambiar la cantidad sugerida con el ciclo confirmado: va en **PQ.6** con antes/después (DC3).
- Importar la hoja de Excel (regla 1). Se usa como control en el paralelo (PQ.3.7).
- Escribir en Kepler.
- Las **citas de entrega** en el almacén: son operación y viven en el WMS (`FASE_WMS` WMS.9, «Citas de
  recepción, muelles, ASN»). Las citas de este calendario son de **relación con el proveedor** (§9).
- El detalle del plan de Mercadotecnia (TOP semanal, folleto, eventos): vive en su acuerdo MKTN001
  (`commercial.promo_agreements`). Aquí sólo el plan de trabajo anual y sus acuerdos, **ligados** (§9).

## 3. Las capas

### C0 · Dato
- **Derivado (vista `commercial.v_purchase_calendar_proposal`, PQ.3.1 🧪):** sobre
  `analytics.erp_purchase_orders` (el decode canónico de la OC X-A-35), por clave de proveedor de
  Kepler y sin las claves de sucursal propia (`TI*`): las **rondas** de OC vivas en 365 días (una ronda
  = las OC dentro de 4 días desde la PRIMERA; elegido contra la hoja entre varias ventanas), el
  **ciclo propuesto** (mediana entre rondas, con 4+ rondas; `compra_continua` si las rondas van
  pegadas), la última ronda por sucursal y la próxima fecha.
  Medido (2026-11-10): 338 claves con OC viva; 241 con ciclo propuesto, 4 en compra continua, 47 con
  2–3 rondas y 46 con una (esos 97 los define a mano la gerencia de compras). ~200–300 ms.
- **Dato propio (tabla nueva, `tenant_id` + auditoría):** las **reglas de revisión** que define la
  gerencia de compras (DC8): proveedor × alcance (corporativo · zona · sucursal) × patrón (días de la
  semana · días del mes · cada N días) × quién revisa (§10.1), quién y cuándo; y el «hoy no se pide»
  con motivo y nueva fecha. Nada se copia de Kepler.

### C1 · Dominio
- Próxima fecha **por regla** (§10.3): el siguiente día de la semana o del mes de la regla, o la última
  ronda de Kepler + N días; la propuesta de Kepler sin confirmar se marca «sin confirmar».
- **Rezagado** = próxima fecha vencida y sin X-A-30/35 del proveedor desde entonces. Medición inicial
  con el ciclo propuesto de la vista PQ.3.1, **sin validar**: 63 rezagados (> 3 d), 39 (> 14 d); 46
  tocan esta semana (±3 d).
  Incluye proveedores de temporada y los que dejaron de surtir: el calendario los distingue.
- «Hoy no se pide» recorre la fecha y deja el motivo; nunca borra al proveedor del calendario.

### C2 · API
- `GET` calendario (día, semana, mes) en una sola respuesta, con el estado por sucursal ya calculado
  en SQL (sin una llamada por proveedor). < 500 ms.
- `POST` ciclo confirmado y `POST` «hoy no se pide». ⛔ Regla 13: probados contra base real con el
  payload de la pantalla (CI, `pruebas-db`).

### C3 · UI (skill `diseno`; cinco preguntas, §0b)
1. **Qué ve y en qué orden:** los **rezagados** (días de atraso), después **los que tocan hoy**,
   después los próximos 7 días. Por proveedor: sucursales y su estado en palabras («OC 00/0007265 del
   10-nov», «requisición», «sin pedido», «por traspaso»), ciclo y si está confirmado.
2. **Qué no ve:** los colores a mano; la historia completa del proveedor (a un clic); las cantidades
   (están en Pedido).
3. **Accesibilidad:** por nombre de proveedor y de sucursal, nunca por código; buscable; el estado con
   palabra, no sólo color.
4. **Ligado a otro proceso:** **«Armar pedido» abre Pedido con el proveedor y sus sucursales ya
   puestos** (ya existe en PQ.4: se reutiliza); el aviso de Pedido «hoy te toca» lee este calendario.
5. **¿Le toca a este proceso?** Sí: confirmar ciclo, posponer con motivo y armar. El pedido se hace en
   Pedido, no aquí.

**Dónde vive:** menú Compras, grupo **Compra**, renglón propio **«Calendario de compras»** entre Alertas
de abasto y Pedido (se mira antes de pedir; D2 ya pedía la agenda como entrada). Reemplaza la pestaña
Ciclo de Pedido: una sola agenda.

## 4. Decisiones

| # | Decisión | Estado |
|---|---|---|
| DC1 | Las columnas del Excel son las sucursales (antes se revisaba por almacén). Con Pedido la compra se concentra: el calendario es **por proveedor** y el estado por sucursal es información derivada, no captura | ✅ Francisco, 2026-11-10 |
| DC2 | El ciclo se captura **en el calendario** | ✅ Francisco, 2026-11-10 |
| DC3 | El ciclo confirmado **no** cambia la cantidad sugerida hasta PQ.6 (antes/después, commit aparte). Por eso vive en su propia tabla, no en `catalog.suppliers.cadence_days_override` ni en `replenishment_channel`, que ya alimentan al motor | 🟡 Claude, por regla 15; Francisco puede revertirla |
| DC4 | Desde el calendario, «Armar pedido» abre Pedido con el proveedor ya seleccionado | ✅ Francisco, 2026-11-10 |
| DC5 | **Todos** los proveedores entran en ciclo. Universo: los que tienen compra en Kepler en los últimos 12 meses, sin las claves de sucursal propia (356 hoy; 338 con OC viva salen de la vista PQ.3.1, las otras 18 se agregan con ciclo a mano); uno nuevo entra con su primera compra | ✅ Francisco (todos) · universo propuesto por Claude |
| DC6 | Quién entra (ver §4.1) | ✅ Francisco, 2026-11-10 · faltan 3 puestos por confirmar |
| DC7 | Permisos nuevos (ADR-054, una clave por acción): `COMPRAS_CALENDARIO_VER` (consultar), `COMPRAS_CALENDARIO_GESTIONAR` (posponer con motivo) y `COMPRAS_CALENDARIO_CICLO` (definir el ciclo). `COMPRAS_PEDIDO_VER` ya lo tienen 29 roles (cajeros, rutas…), demasiado ancho para esto. «Armar pedido» sigue gateado por los permisos de Pedido | 🟡 Claude |
| DC8 | **Los ciclos los define la gerencia de compras** (rol `gerente_compras`), también los de compra local. Los demás puestos no definen ciclo: consultan, posponen y arman | ✅ Francisco, 2026-11-10 |
| DC9 | El calendario también lleva la **agenda con el proveedor**: citas con ejecutivos, revisiones de negocio y planes de trabajo (§9). Compras, Mercadotecnia y Finanzas agendan, todas en la misma agenda | ✅ Francisco, 2026-11-20 |
| DC10 | **Revisión de negocio trimestral** para los proveedores que hacen el 80 % de la compra (47 de 340, medido 2026-11-20); el resto, cuando se pida. La periodicidad por proveedor la fija la gerencia de compras, como el ciclo | ✅ Francisco, 2026-11-20 |
| DC11 | La ficha de la revisión de negocio incluye **share, desempeño por categoría, principales clientes, pisos de venta y canales**, además de compra, surtido, rezago, deuda y acuerdos (§9.2) | ✅ Francisco, 2026-11-20 |
| DC12 | **Plan de trabajo anual** por proveedor, con acuerdos por área; lo de Mercadotecnia se liga a su acuerdo MKTN001 | ✅ Francisco, 2026-11-20 |
| DC13 | Las reuniones mandan **invitación de calendario** a los participantes | ✅ Francisco, 2026-11-20 |
| DC14 | El seguimiento del día es **por proveedor** (compras locales, por sucursal); «hoy no se pide» con motivo de lista (ya hay pedido · en cotización · bloqueado · no hace falta · importación · otro); **sin cierre de día**: lo no resuelto amanece rezagado | ✅ Francisco, 2026-11-20 (aceptó la propuesta) |
| DC15 | El **tiempo de entrega** se mide desde Kepler (OC X-A-35 → entrada X-A-40), no se captura; absorbe la medición de PQ.77 | ✅ Francisco, 2026-11-20 (aceptó la propuesta) |
| DC16 | Por Finanzas entran **Tesorería o el Analista de Egresos**, para la revisión de **cartera y pagos** con el proveedor (§9.6) | ✅ Francisco, 2026-11-20 |
| DC17 | La revisión va **por regla de calendario con alcance**: corporativo (todas las sucursales), zona o sucursal. Un proveedor puede tener varias reglas, una por alcance, y cada regla dice quién revisa (§10.1). Refina DC1 y DC14 | ✅ Francisco, 2026-11-20 |
| DC18 | Tres patrones de regla: **días de la semana** (cada miércoles), **días del mes** (el 15 y el último) y **cada N días** (la propuesta de Kepler, §3) | ✅ Francisco, 2026-11-20 (los dos primeros, con sus ejemplos; el tercero ya estaba) |
| DC19 | En «días del mes», si la fecha cae en sábado o domingo **se adelanta al viernes**, para que «el último» no se pase al mes siguiente. Los días de la semana pueden incluir el sábado si el proveedor pasa ese día. Los feriados se mueven a mano mientras no haya calendario de días inhábiles (§10.3) | ✅ Francisco, 2026-11-20 (aceptó la propuesta: «me gustó»); se puede cambiar a «al lunes» por regla |
| DC20 | Las **visitas** se coordinan por WhatsApp en los dos sentidos: el proveedor la pide y se le ofrecen fechas y horas; Compras la pide después de una revisión, con motivo. La Suite arma el mensaje con los horarios libres y abre WhatsApp con el texto escrito (`wa.me`), sin BSP (§10.4) | ✅ Francisco, 2026-11-20 (el proceso; aceptó la propuesta sin BSP) |
| DC21 | Quien recibe visitas declara su **horario de visitas**. Los horarios que se ofrecen son ese horario menos sus reuniones; sin horario declarado, la Suite no inventa huecos | ✅ Francisco, 2026-11-20 (aceptó la propuesta) |
| DC22 | Las dos **gerencias de zona con rol de plataforma** ven todo el calendario (modo dios), no sólo su zona. Recortarlas es una regla de usuario en el área `compras`, que es también la de Pedido, donde ese rol aprueba requisiciones a diario: el recorte les cambiaría Pedido. Propuesta: dejarlo así; si se quiere el recorte, se decide para las dos pantallas (§10.7) | 🟡 Claude, 2026-11-20 · falta Francisco |
| DC23 | El rol `compras` (comprador y auxiliar, 2 personas) **ve y marca**. No estaba en §4.1; se agregó porque el comprador es quien revisa al proveedor | 🟡 Claude, 2026-11-20 · falta Francisco |
| DC24 | La gerencia de compras de Canindo y Zamora Centro **no se recorta** a 05–06: define reglas para todas (DC8) y un recorte de alcance le quitaría las corporativas. «Abre en 05 y 06» queda como búsqueda («Zamora», «Canindo»); un filtro que se recuerde sería otro item | 🟡 Claude, 2026-11-20 · falta Francisco |

### 4.1 Quién entra (DC6), medido contra los roles de prod

| Puesto (Francisco) | Rol en prod | Permiso propuesto |
|---|---|---|
| Gerencia de compras (define los ciclos, DC8) | `gerente_compras` | ver · gestionar · **ciclo** |
| Compras Morelia | `compras_operaciones` (almacén 08) | ver · gestionar |
| Compras Canindo y Zamora Centro | `gerente_compras` (✅ Francisco 2026-11-10) | ver · gestionar · ciclo (por rol); el calendario abre en 05 y 06 con una regla de alcance del área (PQ.3.6) |
| Recepción de mercancía Padre Hidalgo | `auxiliar_compras` (✅ Francisco 2026-11-10) | ver · gestionar |
| Gerentes de zona (3) | rol de plataforma, puesto `jefe_zona` (✅ Francisco 2026-11-10) | ver. Su zona en el calendario con una regla de alcance del área, como `[COT.20]`: 07–08 · 05–06 · 01–04 |
| Dirección General y Dirección Comercial | `direccion` | ver |
| Encargados de sucursal (compras locales) | `encargado_tienda` | ver · gestionar, sólo los proveedores de su sucursal |
| Almacenistas de sucursal (compras locales) | `almacenista` | ver · gestionar, sólo los proveedores de su sucursal |

DC8 se sostiene con la **bitácora**, no sólo con el permiso: la tabla de ciclos guarda quién lo definió
y la pantalla lo muestra («definido por gerencia de compras» o por otro puesto). Los dos puestos con
`gerente_compras` pueden definir ciclo.

Compras locales: en Kepler sólo 5 claves compran en una sola sucursal fuera del CEDIS;
las compras de tienda en Wincaja (`WIN_C`) **NO MEDIDAS** todavía para el calendario.

## 5. Riesgos y bloqueos

- **R1** El ciclo de Kepler no reproduce el del Excel en 60 % de los proveedores: por eso se confirma.
  Mientras no se confirme, el calendario lo dice («sin confirmar»), no lo calla.
- **R2** Rezagado incluye proveedores de temporada o dados de baja: necesitan «fuera de ciclo hasta
  <fecha>» con motivo, no quedarse rojos para siempre.
- **R3** ~~Los 3 puestos sin rol claro~~ — contestado por Francisco el 2026-11-10 (§4.1). Queda: las
  reglas de alcance por área para la gerencia de Canindo/Zamora y los 3 gerentes de zona.
- **R4** 24 claves con OC viva en Kepler sólo tienen una ficha **borrada** en la Suite: la
  consolidación de duplicados del 2026-07-20 dejó viva otra ficha con otra clave. La vista lo declara
  (`supplier_record`), no casa por nombre. El arreglo del catálogo toca más módulos: dueño por decidir.
- **R5** En 62 de las 314 claves con ficha viva, el proveedor de la OC no es el `supplier_id` de esos productos en Pedido:
  «Armar pedido» lo resuelve en PQ.3.5.
- ~~**R6** Compras locales sin documento en Kepler~~ — **cerrado** (Francisco, 2026-11-20: el proveedor
  de botanas *«era un ejemplo ficticio»*, así que sus 2 recepciones en Yurécuaro y 0 en Canindo no son
  un hueco). Queda la regla general de §10.3: si una compra no deja documento en Kepler, la marca quien
  revisa («se pidió fuera de Kepler»).
- **R7** En el CEDIS, el día fijo es el de **recepción**: 28 de los 31 proveedores con entrega
  concentrada caen en miércoles, pero sólo el 37 % de sus OC sale ese día. No se propone como día de
  revisión; las citas de entrega son del WMS (§2).

## 6. Items (en el tracker como PQ.3.1–PQ.3.14)

| # | Entregable | Capa |
|---|---|---|
| PQ.3.1 | Vista derivada: rondas de OC por proveedor, ciclo propuesto, última ronda por sucursal y próxima fecha. Control contra la hoja 2026: ±30 % en ≥ 40 % | C0 |
| PQ.3.2 | Tablas de **reglas de revisión** (proveedor × alcance × patrón × quién revisa, §10.1) y de «hoy no se pide»; migración generada | C0→C1 |
| PQ.3.3 | Próxima fecha **por regla** (tres patrones y corrimiento de fin de semana, §10.3), rezagado y posponer, en dominio; estado del día por regla (control: el verde de la hoja con documento de Kepler ≥ 67 %); prueba con negativa (un rezagado que no lo es; dos sucursales con dos días distintos; el «último» que cae en domingo) | C1 |
| PQ.3.4 | API del calendario y las dos escrituras, probadas contra base real con el payload de la pantalla | C2 |
| PQ.3.5 | Pantalla «Calendario de compras» (Hoy · Semana · Mes · Sin ciclo), «Armar pedido» hacia Pedido; reemplaza la pestaña Ciclo; el aviso de Pedido lee el calendario | C3 |
| PQ.3.6 | Permisos repartidos según §4.1 (regla 20) y alcance por sucursal para compras locales | C2/C3 |
| PQ.3.7 | Paralelo de 2 semanas contra la hoja 2026: cada día, lo que lista el Excel sale en el calendario; con eso se retira la hoja | — |
| PQ.3.8 | **Agenda con el proveedor** (§9.1): reuniones (cita con ejecutivo · revisión de negocio · plan de trabajo) con participantes internos y del proveedor, temas y minuta; periodicidad de la revisión por proveedor (DC10). Pestaña «Agenda con proveedores» | C0→C3 |
| PQ.3.9 | **Ficha de la revisión de negocio** (§9.2), derivada sin capturar: cada bloque con su fuente medida antes de pintarse; lo que no se pueda medir, se declara | C0→C3 |
| PQ.3.10 | **Acuerdos** con área, responsable y fecha (§9.3) sobre el contrato único de tareas (OR.4, sin quinta tabla); aparecen en «Mi trabajo»; la reunión siguiente abre con los pendientes. Pestaña «Acuerdos» | C0→C3 |
| PQ.3.11 | **Plan de trabajo anual** por proveedor (§9.4): sus acuerdos por área; los de Mercadotecnia ligados a MKTN001 | C1→C3 |
| PQ.3.12 | **Invitación de calendario** (§9.5): `.ics` por correo (Google Workspace / Outlook) con el puerto de correo existente | C2 |
| PQ.3.13 | **Visitas por WhatsApp** (§10.4): horario de visitas por persona, «Ofrecer horarios» y «Pedir visita» (con motivo); el mensaje sale por `wa.me` con el ayudante que ya existe, movido a `libs/`; el contacto del ejecutivo es dato propio | C0→C3 |
| PQ.3.14 | La vista propone **día fijo por sucursal** donde la entrega y la OC caen el mismo día de la semana (16 pares medidos, 84 %). En el CEDIS no lo propone: ahí es día de recepción (37 %, R7) | C0 |

## 7. Definición de Terminado

1. 356 de 356 proveedores del universo con al menos una regla de revisión definida (o «fuera de ciclo»
   con motivo).
2. El estado de hoy por sucursal sale de Kepler y concuerda con la hoja en el paralelo.
3. Permisos repartidos en prod a los puestos de §4.1.
4. La hoja 2026 se deja de usar (lo confirma la gerencia de compras).
5. Lo no medido se declara.

## 8. Bitácora

| Fecha | Qué | Quién |
|---|---|---|
| 2026-11-10 | Lectura de la hoja 2026 y cruces contra Kepler y la Suite; DC1, DC2, DC4–DC6 y DC8 de Francisco; plan escrito | Francisco + sesión Claude |
| 2026-11-10 | **PQ.3.1 🧪**: vista `commercial.v_purchase_calendar_proposal` (mig `20261110015037`, sin aplicar). Primera versión: rondas ENCADENADAS (cada OC contra la anterior), 48 % en ±30 % contra la hoja. La primera versión tardaba 106 s (CTEs unidos); se reescribió | sesión Claude |
| 2026-11-10 | **Revisión independiente** (otro agente) antes del PR: la ronda encadenada juntaba a quien se le pide a diario en UNA ronda de 313 días («una compra» con 366 OC) y dejaba próximas fechas antes de la última OC; 9 claves eran sucursales propias (`TI*`); 4 huecos en la prueba. Corregido: la ronda se acota desde su INICIO (recursión sobre los días de cada proveedor), `compra_continua` sin ciclo para rondas pegadas, fuera las `TI`, `last_order_date`. Contra la hoja con la regla corregida: 42 % en ±30 %, 74 % en ±50 % (la versión encadenada ganaba en el control porque fallaba justo con proveedores que la hoja no tiene). Universo 338 (de 356); 241 propuesto · 4 compra continua · 47 pocas · 46 una; 24 fichas borradas; ~200–300 ms. Prueba 17/17 contra prod, 8 mutantes + 1 del cruce de fichas en rojo | sesión Claude |
| 2026-11-20 | **Alcance ampliado** (DC9–DC15, §9): el calendario lleva también la agenda con el proveedor —citas con ejecutivos, revisiones de negocio y planes de trabajo entre proveedor, Compras, MKT y Finanzas—; las citas de entrega se quedan en el WMS. Medido: 10 proveedores = 50 % de la compra, 47 = 80 %, 89 = 90 % (de 340); 0 acuerdos MKTN001 capturados; el puerto de correo no admite adjuntos | Francisco + sesión Claude |
| 2026-11-20 | **Cómo se revisa** (DC17–DC21, §10): reglas de calendario por alcance (corporativo · zona · sucursal) con tres patrones, y visitas por WhatsApp en los dos sentidos. Medido: 159 de 329 proveedores reciben en más de una plaza; 16 pares (proveedor, sucursal) con día fijo, y su OC cae ese día en el 84 % de los casos; en el CEDIS el día fijo es de recepción (37 %); el proveedor de botanas del ejemplo casi no deja documento en las dos sucursales (R6) | Francisco + sesión Claude |
| 2026-11-20 | **PQ.3.2 🧪 · PQ.3.3 🔨** (§10.5): tablas de reglas y marcas (mig `20261120130156`, sin aplicar) probadas contra Postgres real, 44 ✔ y 4 mutantes en rojo; la trampa del NULL en el CHECK cazada antes de salir. Dominio de fechas y estado en el contrato, 22 ✔ y 5 mutantes en rojo. R6 cerrado: el proveedor de botanas era un ejemplo | sesión Claude |
| 2026-11-20 | **PQ.3.3 🧪 · PQ.3.4 🧪** (§10.5): la actividad de Kepler por alcance, elegida contra la hoja (OC también canceladas + entrada: 67 % del verde, 38 % del rojo; cumple el control), 445–494 ms en prod; la API (6 rutas, 3 permisos declarados) probada con el repositorio real como `app_runtime`, 26 ✓ y 3 mutantes en rojo. Hallazgo: hay proveedores quincenales en sucursal (PQ.3.14 debe proponer el periodo) | sesión Claude |
| 2026-11-20 | **PQ.3.6 🧪** (§10.7): las tres claves repartidas por migración (sin aplicar) y el alcance por sucursal en la API: cada quien ve y escribe sólo las reglas que caben en sus sucursales; el almacenista queda recortado a la suya sólo en Compras (medido: ninguno usó una ruta de Compras en 60 días). Tres decisiones propuestas (DC22–DC24) | sesión Claude |
| 2026-11-20 | **PQ.3.5 🧪** (§10.6): la pantalla, con las preguntas de diseño escritas antes; probada en local contra Docker en los tres perfiles (escritorio, Fold 7 abierto, celular) y en oscuro, con las cuatro escrituras hechas desde la pantalla. Hallazgo en la base: los privilegios por defecto de `commercial` le daban DELETE a `app_runtime`; la migración ahora lo revoca (sin el REVOKE, la prueba se pone en rojo) | Francisco (autorizó levantar los servidores) + sesión Claude |

---

## 9. Agenda con el proveedor (alcance ampliado, 2026-11-20)

Francisco: *«aquí entrarían las citas con ejecutivos, revisiones de negocios y planes de trabajo entre
proveedor, compras, mkt y finanzas; las citas del wms ya son parte del proceso de operación»*.

El calendario queda en tres capas, en la misma entrada del menú:

| Capa | Qué resuelve | Pestañas |
|---|---|---|
| 1. Cadencia y seguimiento del día (§1–§6) | A quién toca pedirle y quién va rezagado (sustituye la hoja 2026) | Hoy · Semana · Ciclos |
| 2. Agenda con el proveedor (§9.1–§9.2) | Citas con ejecutivos, revisiones de negocio y planes de trabajo | Agenda con proveedores |
| 3. Acuerdos y seguimiento (§9.3–§9.4) | Que lo pactado tenga dueño, fecha y se cierre | Acuerdos |

### 9.1 Las reuniones

| Tipo | Para qué | Quién participa | Cuándo |
|---|---|---|---|
| **Cita con ejecutivo** | Visita o llamada: precios, lanzamientos, problemas de surtido | Compras (+ MKT o Finanzas si hace falta) | Cuando se agenda |
| **Revisión de negocio** | Cómo vamos con ese proveedor, con números (§9.2) | Compras, MKT y Finanzas | Trimestral para los 47 proveedores del 80 % de la compra; el resto a pedido (DC10) |
| **Plan de trabajo** | Qué se compromete cada área con el proveedor en el año | Compras, MKT y Finanzas | Anual (DC12) |

Cada reunión: proveedor (clave de Kepler, como la vista PQ.3.1), tipo, fecha y hora, participantes de la
Suite (usuarios) y del proveedor (nombre y contacto del ejecutivo), temas; después, una **minuta corta**
y sus **acuerdos** (§9.3). Agenda cualquiera de las tres áreas (DC9). Dato propio de la Suite (las
reuniones no dejan rastro en Kepler): tabla con `tenant_id` + auditoría; los datos de contacto del
ejecutivo viven en la base, nunca en un `.md` (repo público).

### 9.2 La ficha de la revisión de negocio (DC11) — se deriva, no se captura

Cada bloque se mide contra su fuente **antes** de pintarse; el que no se pueda medir sale declarado,
nunca en cero (regla 11).

| Bloque | De dónde sale | Estado al 2026-11-20 |
|---|---|---|
| Compra de 12 meses y tendencia | `analytics.erp_purchase_orders` (OC vivas) | medido para el corte del 80 % |
| Venta y margen de su línea, **por categoría** | venta canónica `U-D` 8 / 10 / 12 con sus excepciones (`VERDAD_ABSOLUTA` §4), producto → proveedor y → categoría | por medir. ⚠️ En 62 de 314 claves el proveedor de la OC no es el del producto (R5): hay que decidir con cuál se cuenta |
| **Share** | Participación del proveedor en la venta de su categoría **dentro de Mega Dulces**. El share de mercado externo sólo si el proveedor lo trae, como dato suyo y marcado así | interpretación por confirmar |
| **Principales clientes** | Venta por cliente en los documentos de Kepler que traen cliente (mayoreo, telemarketing, ruta); el ticket de mostrador no trae cliente | por medir |
| **Pisos de venta** | Venta por sucursal y tienda | por medir |
| **Canales** | Canal canónico (`VERDAD_ABSOLUTA` §23: el canal del presupuesto ya se arbitró una vez) | por medir |
| Cumplimiento de surtido | Fill rate OC ↔ vale (`[RA-DYN.U5]`, ya existe) | existe |
| Rezago en el calendario | Vista PQ.3.1 + reglas de PQ.3.3 | con PQ.3.3 |
| Tiempo de entrega real | OC X-A-35 → entrada X-A-40 (DC15) | por medir |
| Cartera y pagos (la revisa Tesorería, DC16) | ECA, los pagos programados (Calendario de Pagos) y la condición pactada de PGP | existe |
| Acuerdos de Mercadotecnia y su avance | `commercial.promo_agreements` + su avance de sell-out | existe; **0 acuerdos capturados** |
| Acuerdos pendientes de la reunión anterior | §9.3 | con PQ.3.10 |

### 9.3 Los acuerdos

Cada acuerdo: reunión de origen, área (Compras · MKT · Finanzas · proveedor), responsable, fecha
compromiso, estado y cierre con nota. Le aparece al responsable en «Mi trabajo». ⛔ **No es una tabla
de tareas nueva**: el contrato único de tareas (`[OR.4]`, `libs/contracts/src/work/task.contract.ts`)
prohíbe la quinta, y una compuerta la detecta. Antes de C0 se mide si una de las cuatro existentes la
recibe o si el contrato se extiende declarándola; la decisión va a un ADR. Los acuerdos de cada área
se **ligan** a lo que ya existe: MKT → su MKTN001; Finanzas → la condición de pago pactada; Compras →
ciclo, mínimos y precio del proveedor.

### 9.4 El plan de trabajo anual

Uno por proveedor y año (DC12): la reunión de plan de trabajo y sus acuerdos, agrupados por área. El
avance se lee de los acuerdos (cerrados contra el total) y, para MKT, del avance de sell-out de cada
MKTN001. No se re-captura nada que ya tenga casa.

### 9.5 La invitación de calendario (DC13)

La organización opera Google Workspace (`@megadulces.com.mx`) y la Suite ya tiene un puerto de correo
con adaptador SMTP (`libs/contracts/src/ports/mailer.port.ts`). La invitación sale como **`.ics` por
correo**, que abren Google Calendar y Outlook. Hace falta:
- extender `MailMessage` con un adjunto opcional (aditivo: los que ya mandan correo no cambian);
- **NO MEDIDO**: si el SMTP está configurado en prod. Son credenciales (regla 7): lo confirma Edgar.

Sin correo configurado, la reunión se guarda igual y lo dice («invitación no enviada: correo apagado»),
nunca finge que avisó.

### 9.6 Permisos

Los de §4.1, más Mercadotecnia (`jefe_marketing`, `marketing`) y Finanzas (DC16): consultar la
agenda, agendar sus reuniones y responder sus acuerdos. Regla 20: no está entregado hasta que esté
repartido.

| Puesto (Francisco) | En prod (2026-11-20) | Permiso |
|---|---|---|
| Tesorería | rol `tesoreria`, puesto `tesoreria` («Jefe de Tesorería»): 1 persona | ver · gestionar |
| Analista de Egresos | puesto `analista_egresos` (departamento Tesorería): **0 personas y sin rol propuesto** | ⚠️ quien ocupe el puesto necesita el rol `tesoreria` o el permiso por persona; se reparte al asignarlo |

---

## 10. Cómo se revisa: reglas por alcance y visitas (2026-11-20)

Francisco: *«la revisión se hace por calendario, y ese calendario funciona por corporativo, por zona o
por sucursal»*. Sus ejemplos:

- La gerencia de compras revisa a un proveedor grande de confitería **dos veces al mes, el 15 y el
  último día**, para **todas** las sucursales. La fecha se mueve para caer de lunes a viernes.
- Un proveedor de botanas pasa **cada miércoles a Yurécuaro** y ahí se le pide. **Sólo** Yurécuaro lo
  revisa, sea fin de mes o no. El mismo proveedor pasa **los martes a Canindo**, y sólo Canindo lo
  revisa.

### 10.1 La regla (DC17, DC18)

Una regla es **proveedor × alcance × patrón × quién revisa**:

| Pieza | Valores |
|---|---|
| Alcance | **Corporativo** (todas las sucursales) · **Zona** (las sucursales de una zona) · **Sucursal** (una) |
| Patrón | **Días de la semana** (cada miércoles) · **Días del mes** (el 15 y el último) · **Cada N días** (lo que propone Kepler, §3) |
| Quién revisa | Corporativo: la gerencia de compras · Zona: la gerencia de zona · Sucursal: la propia sucursal (encargado o almacenista, compra local) |

- Un proveedor puede tener **varias reglas**, una por alcance. El de botanas tiene una el miércoles en
  Yurécuaro y otra el martes en Canindo, además de la corporativa si la hay. Las reglas no se suman:
  cada una se revisa por separado, y la sucursal sólo ve las suyas.
- DC8 sigue vigente: todas las reglas las define la gerencia de compras, incluidas las de sucursal. La
  regla dice quién **revisa**, no quién la define.

### 10.2 Lo que dice Kepler (medido 2026-11-20, recepciones y OC vivas de 12 meses)

| Medido | Valor |
|---|---|
| Proveedores que reciben en más de una plaza | **159 de 329** (93 en tres o más): la regla por plaza es común, no una excepción |
| Pares (proveedor, plaza) con 8 o más días de recepción y ≥ 70 % el mismo día de la semana | **16 de 194 en sucursales** · 31 de 110 en el CEDIS |
| En esos 16 pares de sucursal, días con OC que caen ese mismo día | **84 %** (143 de 171): el proveedor pasa, se le pide y entrega el mismo día. Es el patrón del ejemplo de botanas |
| En los 31 del CEDIS, días con OC que caen ese día | 37 %: en el CEDIS el día fijo es el de **recepción** (28 de 31 caen en miércoles), no el de revisión (R7) |
| El mismo proveedor, otra sucursal, otro día | Tostadas Guadalupe: miércoles en La Piedad Abastos (8 de 8 días) y viernes en Yurécuaro (13 de 13) |
| Proveedor del ejemplo «el 15 y el último» | 28 rondas de OC en 12 meses (≈ 2.3 al mes), coherente con dos revisiones al mes. Pero la OC sale en los días **siguientes** a la revisión, así que el día de la revisión no se ve. La vista propone «cada 8 días»: el patrón «días del mes» se **captura**, no se adivina |
| Proveedor del ejemplo de botanas | Ejemplo **ilustrativo** (Francisco): la medición de ese proveedor no aplica (R6 cerrado) |

### 10.3 Próxima fecha y estado del día (DC19)

- **Días de la semana:** el siguiente día de la lista a partir de hoy. Puede ser sábado si el
  proveedor pasa ese día (un proveedor de bolsas cae en sábado en Canindo el 76 % de las veces).
- **Días del mes:** el siguiente día de la lista; «el último» es el último día del mes. Si cae en sábado
  o domingo, se adelanta al viernes.
- **Cada N días:** la última ronda de OC (vista PQ.3.1) más N, como hoy.
- **Feriados:** la Suite no tiene un calendario de días inhábiles. Presupuestos trae una lista fija en
  una migración y la app del vendedor sólo salta el domingo. Queda como **deuda con nombre**: un
  calendario de días inhábiles compartido en `libs/` (ADR-056). Mientras tanto, la fecha se mueve a mano
  con «hoy no se pide» (DC14).
- **Estado del día, por regla:** si hay documento de Kepler (X-A-30/35) del proveedor en la plaza de la
  regla, cuenta como «se pidió». Si no, quien revisa lo marca: «se pidió fuera de Kepler» o «hoy no se
  pide», con motivo. Lo que nadie marca amanece rezagado.

### 10.4 Visitas por WhatsApp (DC20, DC21)

Francisco: *«cuando un proveedor llama para agendar visita, se hace a través de un mensaje por
WhatsApp y se le dan fechas y horas disponibles; después de una revisión, si uno necesita que el
proveedor venga por alguna causa mayor, se le habla y se le solicita visita»*.

| Flujo | Quién empieza | En la Suite |
|---|---|---|
| **El proveedor pide visita** | El ejecutivo, por WhatsApp | «Ofrecer horarios»: la Suite toma los huecos libres de quien recibe (su horario de visitas menos sus reuniones), arma el mensaje con los tres siguientes y abre WhatsApp con el texto escrito. Cuando el ejecutivo contesta, se marca el horario que eligió: la visita queda en la agenda y sale la invitación (§9.5) |
| **Mega Dulces pide visita** | Quien revisa, después de una revisión | «Pedir visita» desde la revisión o desde un acuerdo: el motivo es obligatorio y el mensaje lleva los mismos horarios. La visita queda «por confirmar» hasta que el ejecutivo elige |

- **Sin BSP.** El proveedor de WhatsApp sigue sin decidirse (ADR-006, Fase F ⏸️). El mensaje sale del
  WhatsApp de quien agenda, con un enlace `wa.me` y el texto ya escrito. La Suite **no lee** la
  respuesta: la persona marca el horario elegido. El ayudante ya existe (`linkWhatsApp` en
  `apps/vendor/src/app/modules/vendor/cotizacion.ts`); se **mueve a `libs/`** para que lo usen las dos
  apps, en vez de copiarlo (ADR-056).
- **Contacto del ejecutivo** (nombre y WhatsApp): es dato propio de la Suite. Kepler trae un número en el
  catálogo de acreedores (`kdxd.c7`) para 69 de los 340 proveedores con compra, **sin probar** que sea
  el del ejecutivo (puede ser el conmutador). Se muestra como «teléfono en Kepler» para copiarlo, pero
  nunca se usa solo. Los contactos viven en la base, nunca en un `.md`.
- **Horario de visitas** por persona que recibe (por ejemplo, martes y jueves de 10 a 14), con una
  duración por tipo de reunión. Sin horario declarado, «Ofrecer horarios» lo dice en vez de inventar
  huecos.

### 10.5 Cómo quedó (PQ.3.2 🧪 · PQ.3.3 🧪 · PQ.3.4 🧪, 2026-11-20)

**Base** (migración `20261120130156`, sin aplicar en prod):
- `commercial.purchase_review_rules`: proveedor por **clave de Kepler** (como la vista PQ.3.1; un FK a
  la ficha dejaría fuera las 24 claves con ficha borrada), alcance (`corporate` · `zone` · `branch`),
  patrón (`weekdays` ISO 1–7 · `month_days` 1–31 + «el último» · `every_n_days` 1–365), corrimiento de
  fin de semana (`friday` por defecto · `monday`), quién revisa (opcional), «fuera de ciclo hasta» con
  motivo, y baja con `deleted_at`/`deleted_by` (nunca DELETE). **Una regla viva por proveedor y
  alcance.** La zona es el `zona_code` de `analytics.v_branch_zone` (medido: LP = PH, 8 Esquinas, La
  Piedad Abastos, Yurécuaro · ZAM = Zamora Centro, Canindo · MOR = Madero, Abastos).
- `commercial.purchase_review_marks`: una marca por regla y fecha, «se pidió fuera de Kepler» u «hoy no
  se pide» con motivo de lista (DC14), nota obligatoria si es «otro», y la nueva fecha si se pospone.
- ⚠️ **El DELETE que llega por defecto (2026-11-20, PQ.3.5):** los privilegios por defecto del esquema
  `commercial` le dan a `app_runtime` `arwd` (también DELETE). El `GRANT SELECT, INSERT, UPDATE` no lo quita:
  hacía falta `REVOKE DELETE, TRUNCATE`. La primera prueba no lo vio porque corrió en una base temporal sin esos
  privilegios por defecto; contra la base local de Docker, `app_runtime` borraba reglas y marcas (2 ✘). Con el
  REVOKE: 44 ✔ en esa misma base.
- ⚠️ **La trampa del NULL:** un CHECK que da NULL deja pasar la fila. La primera versión aceptaba «días
  de la semana» sin días; el CHECK del patrón va envuelto en `COALESCE(…, false)`. La prueba lo intenta
  a propósito y demuestra en la misma base que la versión ingenua da NULL.
- Prueba `test-newdb-pq3-2-reglas-revision.js`: 44 ✔ contra Postgres real como `app_runtime` (up dos
  veces, down, y NO MEDIDO sin tablas); **4 mutantes en rojo** (sin COALESCE entran 5 reglas inválidas;
  un motivo de menos; DELETE concedido; sin el índice único).

**Dominio** (`libs/contracts/src/http/purchase-calendar.contract.ts`, funciones puras para la API y
para la vista previa de la pantalla), con decisiones técnicas de Claude:
- Un día que el mes no tiene (31 de noviembre, 30 de febrero) **se salta**; para fin de mes está «el
  último».
- Un pedido atiende primero la última fecha vencida si quedó sin atender (**pedido tarde**) y, si no, la
  siguiente a **≤ 3 días** (pedido adelantado).
- El estado lo decide la fecha más reciente: un fallo viejo ya cubierto **no** es rezago de hoy.
- Una regla no debe fechas de antes de existir (`vigente_desde`); la búsqueda mira 62 días atrás.
- «Cada N días» sin ancla no inventa fecha: sale `sin_ancla`.
- Prueba `purchase-calendar.spec.ts`: 22 ✔, **5 mutantes en rojo**. `sumarDias` y `diasEntre` se
  reusan de los contratos que ya los tenían (ADR-056).

**Actividad de Kepler por alcance** (`libs/commercial/src/lib/purchase-calendar/purchase-calendar.sql.ts`).
Qué cuenta como «atendido», elegido contra la hoja (por celda sucursal-día, jul–nov, documento a ±3 días):

| Fuente | Verde (n = 1,382) | Rojo (n = 312) |
|---|---:|---:|
| OC viva (X-A-35, estatus ≠ C) | 54 % | 30 % |
| OC incluidas las **canceladas** | 66 % | 34 % |
| OC viva + entrada aplicada (X-A-20) | 57 % | 34 % |
| Requisición (X-A-30) o vale (X-A-37) | no suman ni un caso | — |
| **Elegida: OC (también canceladas) + entrada** | **67 %** ✅ (control ≥ 67 %) | 38 % |
| La misma, con la ventana del dominio (3 días antes, tarde hasta la siguiente) | 74 % | 43 % |

- La OC **cancelada** cuenta: cancelarla no deshace que se revisó al proveedor (12 puntos del verde son
  OC canceladas después). La fuente viaja con el dato (`oc_cancelada`), así que la pantalla lo puede decir.
- El 67 % del 10-nov salía de `kdm1` crudo (X-A-30/35), que incluye las canceladas: se reproduce con las
  vistas canónicas (`erp_purchase_orders`, `erp_goods_receipts`) sin tocar `kdm1`.
- ⏱ La OC cuesta 41 ms con un año completo y la entrada 1.7 s con un año, pero 0.36 s con 62 días. La OC
  se lee un año (ancla de «cada N días») y la entrada sólo en la ventana: **445–494 ms** con las 340
  claves (medido en prod, sólo lectura). La propuesta de Kepler (~270 ms) va en su propio endpoint.
- La zona de una regla son las sucursales de su `zona_code`; el nombre sale de `zona_origen` («La Piedad»),
  no de `zona_nombre` («LA PIEDAD RD»).
- **Hallazgo para PQ.3.14:** Tostadas Guadalupe en Yurécuaro entrega **un viernes sí y otro no** (2, 16 y
  30 de octubre, 13 de noviembre). «Cada viernes» la marcaría rezagada la mitad de las semanas: la propuesta
  de día fijo tiene que proponer también el periodo (semanal = días de la semana; quincenal = cada 14 días).

**API (PQ.3.4)** — `compras/calendario`, módulo `PurchaseCalendarModule`:

| Ruta | Permiso | Qué hace |
|---|---|---|
| `GET /compras/calendario` | VER · GESTIONAR · CICLO | Reglas con su estado de hoy, alcance en palabras, quién revisa, última actividad (con fuente) y última marca; resumen por estado y la fuente dicha |
| `GET /compras/calendario/propuestas` | igual | Lo que Kepler propone (vista PQ.3.1) para los proveedores sin regla |
| `POST …/reglas` | CICLO | Define la regla; si ya hay una viva en ese alcance, **reemplaza** su patrón (mismo id, conserva marcas) |
| `POST …/reglas/:id/baja` | CICLO | Baja con quién y cuándo (UPDATE, nunca DELETE) |
| `POST …/reglas/:id/fuera-de-ciclo` | CICLO | Sale del ciclo hasta una fecha, con motivo (R2); `hasta: null` la regresa |
| `POST …/reglas/:id/marcas` | GESTIONAR | «Se pidió fuera de Kepler» u «hoy no se pide» con motivo; la misma fecha otra vez la **corrige** |

- Permisos nuevos en el enum (DC7): `COMPRAS_CALENDARIO_VER` · `_GESTIONAR` · `_CICLO`. ⚠️ **Declarados,
  no repartidos**: eso es PQ.3.6 (regla 20), junto con el alcance por sucursal de quien marca.
- Quién escribió se guarda por **id de usuario**, no por username (un username se puede renombrar, AU.34).
- Pruebas: `purchase-calendar.domain.spec.ts` (9) y `purchase-calendar.arranque.spec.ts` (12: registro,
  método, camino y permiso de las 6 rutas, con negativa) · `test-newdb-pq3-4-calendario-api.js` (regla 13):
  26 ✓ (29 ✓ con PQ.3.5) contra Postgres real como `app_runtime` con el payload de la pantalla, 3 mutantes del repositorio en
  rojo; en una base sin ODS de Kepler la consulta de actividad sale NO MEDIDO (se midió en prod).

**Falta:** PQ.3.6 (repartir permisos y alcance por sucursal), PQ.3.14 (proponer día fijo y periodo), aplicar
la migración en prod (Edgar). La pantalla (PQ.3.5) quedó en §10.6.

### 10.6 La pantalla (PQ.3.5): las preguntas antes de construir (skill `diseno` §0a/§0b)

1. **Propósito.** El acto que cierra: *¿a qué proveedor le debo la revisión hoy, y dónde?* (una pregunta,
   sin «y» de otra). Definir reglas es el acto de la gerencia, en su propia vista.
2. **Quién entra.** §4.1. Ruta nueva: sin uso que medir en `ui_usage`.
3. **El estado real (prod, 2026-11-20).** 0 reglas (la tabla todavía no existe en prod) y 340 claves con compra
   en Kepler sin regla. El primer día el trabajo **no** es revisar: es definir reglas. Por eso, sin reglas, la
   pantalla abre en «Sin regla»; con reglas, en «Por revisar».
4. **Qué se ve primero (nivel 0).** La respuesta en una línea («Se deben N revisiones: R rezagadas, la más
   atrasada desde el …; T tocan hoy. K proveedores con compra no tienen regla»), las cuentas por estado y la
   lista de lo que se debe, **el más atrasado arriba** (el orden lo da la API).
5. **Qué no se ve.**

   | Pieza | Decisión | Por qué |
   |---|---|---|
   | Los colores a mano de la hoja | fuera | el estado se deriva de Kepler o de la marca |
   | Cantidades del pedido | fuera | viven en Pedido; «Abrir en Pedido» lleva ahí |
   | Historia completa de marcas | fuera (nivel 3, pendiente) | la fila dice la última atención y la última marca |
   | Reglas al día, en «Por revisar» | fuera | están en «Semana», «Mes» y «Reglas» |
   | Quién revisa (persona) en el formulario | fuera en esta entrega | sin elegir, revisa el puesto del alcance (§10.1); elegir a la persona va con el alcance por sucursal (PQ.3.6) |

6. **Mapa de desglose.**

   | Cifra | Se abre en | Contiene | Fuente |
   |---|---|---|---|
   | Rezagadas · tocan hoy · sin fecha base | «Por revisar» | una fila por regla, con desde cuándo se debe | `GET /compras/calendario` |
   | Al día | «Semana» / «Mes» | las fechas que vienen, por día | el mismo, con `fechasDeLaRegla` en la vista |
   | Fuera de ciclo | «Reglas» | hasta cuándo y por qué | el mismo |
   | Sin regla | «Sin regla» | lo que propone Kepler por proveedor | `GET /compras/calendario/propuestas` |
   | Última atención de una regla | la fila | OC, OC cancelada, entrada o marca, con fecha | el mismo |

7. **Accesibilidad.** Proveedor por nombre (la clave de Kepler debajo) y sucursal o zona por nombre, nunca por
   código. Un buscador para todas las vistas (proveedor, clave o lugar). El estado lleva palabra, no sólo
   color. Documento fuente: la OC o la entrada se nombran con su fecha y su tipo; el folio no viaja todavía
   en la respuesta (pendiente con nombre).
8. **Ligas.** Viene de Kepler (OC y entradas) y de la vista PQ.3.1 (propuesta). Va a **Pedido**: «Abrir en
   Pedido» deja puestos al proveedor y las sucursales del alcance (`?supplier_id=&warehouse_ids=`). Si la clave
   de Kepler no tiene productos en Pedido (R5), el botón no se ofrece y la fila lo dice.
9. **¿Le toca a esta pantalla?** Sí: ver lo que se debe, marcar el día, definir reglas, sacarlas del ciclo y
   darlas de baja. El pedido se arma en Pedido. La pestaña Ciclo de Pedido y su aviso siguen hasta el
   paralelo (PQ.3.7): reemplazarlas antes sería quitar algo que funciona por algo sin probar con uso.
10. **Maqueta.** La del artefacto (Ciclos), con las vistas Por revisar · Semana · Mes · Reglas · Sin regla.
11. **Criterios.** Objetivos táctiles de 44 px en `pointer: coarse`; nada se sale a 390 px; la tabla se apila;
    los tres perfiles de prueba (escritorio, Fold 7 abierto, celular); claro y oscuro.
12. **Lo que la interfaz no resuelve.** La migración sin aplicar en prod; los permisos sin repartir (PQ.3.6);
    el folio de la OC en la fila; R5 (clave de Kepler sin productos en Pedido).

**Cómo quedó (PQ.3.5 🧪, 2026-11-20).** `/compras/calendario`, renglón «Calendario de compras» en Compras ›
Compra, justo antes de Pedido (ruta y menú aceptan VER, GESTIONAR o CICLO).

| Pieza | Qué hace |
|---|---|
| Respuesta + cifras | «Se deben N revisiones: R rezagadas (la más atrasada, … desde el …) y T tocan hoy…»; cada cifra abre su vista |
| Por revisar · Semana · Mes · Reglas · Sin regla | Semana y Mes usan `fechasDeLaRegla` del contrato (las mismas fechas que la API); sin reglas abre en «Sin regla» |
| Detalle (side-peek) | estado, patrón, las 4 siguientes, quién revisa, última atención y última marca, quién definió; acciones |
| Definir / corregir / otra regla | alcance (todas · zona · sucursal, por nombre), patrón con días tocables, vista previa de las siguientes 4, aviso si reemplaza otra regla o si al cambiar de lugar se crea una nueva; conserva quién revisa |
| Marcar | fecha (hasta 14 días adelante), «se pidió fuera de Kepler» u «hoy no se pide» con motivo de lista y nueva fecha |
| Sacar del ciclo / regresar · Dar de baja | con motivo; la baja va aparte, en rojo, con confirmación |
| Abrir en Pedido | `?supplier_id=&warehouse_ids=` (Pedido ya leía `warehouse_ids`; ahora también `supplier_id`, y una regla corporativa abre con todas las sucursales). Sin productos en Pedido para esa clave, el botón no sale y la pantalla lo dice |

API: el calendario trae además las zonas con sus sucursales (las mismas con que valida), la nota de la regla y,
por regla, la ficha y los almacenes para Pedido. Pruebas: `calendario-compras-reglas.spec.ts` 15 ✔ (vista) ·
dominio 11 + arranque 12 ✔ · `test-newdb-pq3-4-calendario-api.js` **29 ✓** (zonas, almacenes por alcance —un
mutante que devuelve todos los almacenes se pone en rojo— y la consulta de actividad ya corre también en local).

**Prueba visual** (Docker local, API en :3338 y vista en :4204, autorizado por Francisco esta vez; datos
sembrados en local con 8 reglas en los cinco estados y deshechos al terminar):

| Perfil | Resultado |
|---|---|
| Escritorio 1440×900, claro y oscuro | sin desplazamiento lateral, nada fuera; las cuatro escrituras desde la pantalla (definir una regla de sucursal, marcar, sacar del ciclo con fecha tecleada, dar de baja) guardaron y la respuesta se recalculó |
| Fold 7 abierto 750×832, táctil | **encontró**: la tabla medía 62rem y los botones quedaban fuera; Marcar/Definir de 28 px; buscador y campos del diálogo de 35–38 px. Corregido (tabla de 40rem, 44 px en táctil) y vuelto a medir: limpio |
| Celular 390×844, táctil | la tabla se apila; limpio tras las mismas correcciones |
| Consola | sin errores en los tres |

**Declarado, sin resolver aquí:**
- La «×» de cerrar de los diálogos mide 36 px en táctil: es de todos los diálogos de la Suite, no de esta pantalla.
- En celular, la respuesta y las seis cifras ocupan la primera pantalla; la lista empieza abajo.
- «Abrir en Pedido» **sin validación visual**: la base local no tiene productos en Pedido, así que el enlace no
  se ofreció; la lectura de `supplier_id` en Pedido no se ejerció en el navegador.
- Elegir a la persona que revisa no está en el formulario (revisa el puesto del alcance; se conserva la que
  hubiera). La pestaña Ciclo de Pedido y su aviso siguen hasta el paralelo (PQ.3.7).
- Observación fuera de esta pantalla: en local, tras entrar, el token desaparece del navegador a los pocos
  segundos y una recarga pide entrar otra vez. No se investigó.

### 10.7 Quién lo ve y dónde (PQ.3.6 🧪, 2026-11-20)

**La regla del alcance.** Una regla del calendario se ve y se escribe si **cabe completa** en las sucursales de
la persona (`ScopeService`, área `compras`, la misma de Pedido). Es lo de §10.1, «la sucursal sólo ve las suyas»:

| Quién (alcance) | Ve y marca |
|---|---|
| Todas las sucursales (`all`) | todas las reglas, también las corporativas |
| Una zona (sus sucursales) | las de su zona y las de cada una de sus sucursales; no la corporativa |
| Una sucursal (`own`) | sólo las de su sucursal; ni la de su zona ni la corporativa, que revisan otros |
| Sin sucursal en su ficha | nada, y la pantalla lo dice («tu ficha no tiene sucursal»), no «no hay reglas» |

El resumen y la respuesta cuentan sólo lo que la persona ve, y una línea bajo la respuesta dice que la lista
está recortada («Ves sólo las reglas de Yurécuaro…»). Marcar, sacar del ciclo, dar de baja o definir fuera del
alcance de escritura se rechaza con 403 y el nombre del alcance. Sin alcance dicho, el repositorio no supone
«todas»: falla (fail-closed).

**Permisos** (migración `20261120180734`, sin aplicar; va **después** de `20261120130156`; la gente vuelve a
entrar para recibirlos). Personas activas medidas en prod (sólo lectura) el 2026-11-20:

| Rol | Personas | Ver | Marcar | Ciclo |
|---|---:|:-:|:-:|:-:|
| `gerente_compras` | 2 | ✓ | ✓ | ✓ |
| `compras` (DC23) | 2 | ✓ | ✓ | |
| `compras_operaciones` | 1 | ✓ | ✓ | |
| `auxiliar_compras` | 5 | ✓ | ✓ | |
| `encargado_tienda` (su sucursal) | 10 | ✓ | ✓ | |
| `almacenista` (su sucursal) | 9 | ✓ | ✓ | |
| `direccion` | 3 | ✓ | | |

**El alcance que ya tenían, medido** (`identity.role_scopes` / `user_scopes`):
- `encargado_tienda`: `own` en todas las áreas, y los 10 tienen sucursal en su ficha. Nada que cambiar.
- `almacenista`: `all` en todas las áreas, así que habría visto y marcado las reglas de las 9 sucursales. La
  migración le pone `own` **sólo en Compras**. Ninguno usó una ruta de Compras en 60 días (`analytics.ui_usage`;
  Pedido no lo tienen), así que el recorte no les quita nada de hoy. ⚠️ 4 de los 9 no tienen sucursal en su ficha
  (entre ellos jefatura de CEDIS y un auxiliar de logística): no ven reglas hasta que se les asigne.
- Gerencias de zona: la de Morelia ya tiene sus dos sucursales en todas las áreas, así que ve la zona Morelia y
  las reglas de Madero y Abastos. Las otras dos tienen rol de plataforma (modo dios) y ven todo (DC22).
- La gerencia de compras de Canindo y Zamora Centro ve y define en todas (DC24).

**La pantalla** (skill `diseno`, las cinco preguntas de §0b):
1. *Qué ve y en qué orden:* lo de PQ.3.5, recortado a sus sucursales, con la línea del alcance pegada a la respuesta (terciaria).
2. *Qué no ve:* quien no define ciclos ya no tiene la vista «Sin regla» ni su cifra, ni por URL: son proveedores
   sin regla de toda la empresa, que no puede atender. La propuesta de Kepler (~0.3 s) tampoco se le pide.
3. *Accesibilidad:* sin cambios contra PQ.3.5.
4. *Ligas:* el alcance es el de Pedido (misma área), así que «Abrir en Pedido» lleva a lo que también puede ver ahí.
5. *¿Le toca?:* sí; los puestos de §4.1.

**Pruebas:**
- Dominio y arranque, 33 ✔: reglas que caben por alcance (sucursal, zona, todas, sin sucursal), recorte del
  resumen y el 403. Un mutante que deja pasar con compartir UNA sucursal pone 4 en rojo. El build de la API
  emite `ScopeService` en los `design:paramtypes` del servicio (`#414`).
- Vista, 18 ✔: el texto del alcance, con negativa (sin sucursal no se lee como «no hay reglas»).
- `test-newdb-pq3-4-calendario-api.js` **38 ✓** contra Postgres real como `app_runtime`: ver sólo su sucursal o
  su zona, y marcar, sacar del ciclo, dar de baja y definir fuera de alcance rechazados sin escribir. Un mutante
  que no revisa el alcance al escribir pone 5 en rojo. La base local tiene una sola sucursal en su zona: «la de su
  zona no la ve» se probó en el dominio, no en Postgres.
- `test-newdb-pq3-6-calendario-permisos.js` **18 ✓**: el reparto, idempotente, sin pisar una clave en `false` ni
  una regla puesta a mano; el almacenista `own` sólo en Compras con la precedencia real (`elegirRegla`); el
  `down` quita exactamente lo suyo. Un mutante que también recorta su regla general pone 2 en rojo.

**Prueba visual de punta a punta (2026-11-20, pedida por Francisco antes del PR).** Se hizo contra la API y la
base LOCALES de Docker (nunca prod), con las dos migraciones aplicadas por su `up()` real y un usuario de prueba
local por puesto. Hubo tres perfiles para quien trabaja en piso: escritorio 1440×900, Fold 7 abierto 750×832
táctil y celular 390×844 táctil.

| Puesto (prueba) | Lo que vio |
|---|---|
| Gerencia de compras | las 8 reglas, sin línea de alcance, con «Sin regla» |
| Encargado de Yurécuaro (04) | 1 regla (la suya) y la línea «Ves sólo las reglas de Yurécuaro…»; sin «Sin regla», tampoco con `?vista=sin_regla` |
| Encargado de Zamora Centro (05) | «Todavía no hay reglas de revisión para Zamora Centro…» |
| Compras con alcance 05+06 | sólo la regla de zona Zamora; «Ves sólo las reglas de Zamora Centro y Canindo…» |
| Almacenista sin sucursal | una sola frase (ver el arreglo 3) |
| Almacenista de Morelia Madero (07) | su regla (fuera de ciclo), sin botón para marcar |
| Dirección | las 8 reglas, sin un solo botón de marcar y sin «Sin regla» |

**El flujo de punta a punta:** el encargado marcó su revisión con la pantalla («se pidió fuera de Kepler»), le quedó
«Hoy no se debe ninguna revisión», y la gerencia vio esa regla «Al día» con la marca del viernes. Con la URL a
mano, el encargado intentó marcar la regla de todas las sucursales: **403** con el mensaje que nombra el alcance.

Ninguna vista ni diálogo desborda en ningún perfil. Los campos del diálogo «Marcar» miden 44 px en táctil. La
línea de alcance en oscuro: zinc-400 sobre `#09090b`.

**Lo que la prueba encontró y se arregló en este mismo item:**
1. **«Sin regla» salía por la API a quien no define ciclos.** La pantalla la escondía, pero
   `GET /compras/calendario/propuestas` pedía sólo VER, y un encargado obtenía los 2 proveedores de toda la
   empresa. Ahora pide `COMPRAS_CALENDARIO_CICLO`. Medido en vivo: encargado y dirección reciben 403 y la gerencia
   200. El arranque lo afirma («NO basta VER ni GESTIONAR»), y un mutante que regresa VER lo pone en rojo.
2. **Los 4 `::ng-deep` de PQ.3.5** subían `check:cascada` de 580 a 584 y frenaban el pre-push de todos.
   - La regla de 44 px ahora apunta a los **anfitriones** (`.cc-form p-select`, `p-datepicker`, `p-inputnumber`),
     en el CSS del componente. Su anfitrión es la caja (`cx('root')`) y lleva el atributo del componente, así que no
     hace falta `::ng-deep`.
   - Medido: escritorio 35 px, sin cambio; Fold 7 y celular, 44 px en la caja, el input y el botón; el texto del
     `p-select` queda centrado.
   - Primero se movió a `styles.css`, pero esa hoja ya trae 6 transiciones de layout. Con `main` en 49 contra el tope
     de 48 de `check:motion` (lo subió `fe1882888`, RH.17.1), el pre-push frena a quien toque `styles.css`, aunque
     no agregue ninguna. Por eso se quedó en el componente.
3. **Sin sucursal, la pantalla lo decía tres veces** (respuesta, línea de alcance y vacío), con cinco ceros y vistas
   que no le sirven. Ahora queda una sola frase, sin tira, sin vistas y sin buscador.

**Hallazgos fuera de este item** (no se tocan aquí):
- La «X» de cerrar de todo `p-dialog` mide 36 px en táctil y no tiene nombre para lector de pantalla.
- **El interceptor cierra cualquier sesión ante cualquier 401** (`auth.interceptor.ts`), también ante el de una
  petición que salió SIN token. Al dar clic en «Iniciar sesión», el aviso de uso de `/login` sale sin token. Si su
  401 llega después del 201 del login, borra la sesión recién abierta y la persona vuelve al login con «tu sesión
  expiró». La prueba lo reprodujo con un robot que entra en milisegundos. **No se midió en prod.**

**Falta:** aplicar las dos migraciones en prod (Edgar) y que la gente vuelva a entrar; DC22–DC24; elegir a la
persona que revisa en el formulario.
