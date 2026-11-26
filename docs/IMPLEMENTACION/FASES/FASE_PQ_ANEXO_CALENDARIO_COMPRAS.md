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
| DC22 | Las dos **gerencias de zona con rol de plataforma** ven todo el calendario (modo dios), no sólo su zona. Recortarlas es una regla de usuario en el área `compras`, que es también la de Pedido, donde ese rol aprueba requisiciones a diario: el recorte les cambiaría Pedido. Propuesta: dejarlo así; si se quiere el recorte, se decide para las dos pantallas (§10.7) | ✅ Francisco, 2026-11-21 (aceptó la propuesta) |
| DC23 | El rol `compras` (comprador y auxiliar, 2 personas) **ve y marca**. No estaba en §4.1; se agregó porque el comprador es quien revisa al proveedor | ✅ Francisco, 2026-11-21 (aceptó la propuesta) |
| DC24 | La gerencia de compras de Canindo y Zamora Centro **no se recorta** a 05–06: define reglas para todas (DC8) y un recorte de alcance le quitaría las corporativas. «Abre en 05 y 06» queda como búsqueda («Zamora», «Canindo»); un filtro que se recuerde sería otro item | ✅ Francisco, 2026-11-21 (aceptó la propuesta) |
| DC25 | El conocimiento para definir reglas lo tienen **dos personas**: la jefa actual de compras (`gerente_compras`) y quien llevaba antes la gerencia, hoy en operaciones de compras (`compras_operaciones`, rol de **una** sola persona, que ve y marca pero no define). El resto del equipo ejecuta (Francisco, 2026-11-21). **Define la jefa actual**: no se le da `COMPRAS_CALENDARIO_CICLO` a `compras_operaciones`. Como la clave la tiene otra persona de `gerente_compras` y el modo dios también define, se rastrea **quién definió y quién cambió** cada regla (PQ.3.17). Refina DC8 (§10.9) | ✅ Francisco, 2026-11-22 («Arizbeth o hacer un tracking de quién definió reglas»: las dos) |
| DC26 | **Mantenimiento**: el patrón lo decide la jefa de compras (DC25). Si un comprador no avanzó, **pospone** («hoy no se pide» con nueva fecha) o hace una **revisión extemporánea** (las dos ya existen), o **ajusta la regla sólo para su sucursal o zona** (PQ.3.19: nueva clave por ADR-054, limitada a su alcance de escritura, nunca la corporativa; falta decidir si la de sucursal o zona reemplaza a la corporativa en esas sucursales o se revisa aparte, §10.1). Con el rastro de quién cambió qué (PQ.3.17) | ✅ Francisco, 2026-11-22 |
| DC27 | **Los ocasionales se deciden en bloque** (PQ.3.18 c): a cada proveedor de una o pocas compras en 12 meses, sin día fijo y sin regla, se le define una regla para todas las sucursales «cada 180 días» y queda **fuera de ciclo 26 semanas** con el motivo «Ocasional: una o pocas compras en 12 meses». Así no amanecen rezagados y en esa fecha regresan solos a «Por revisar», para ver si siguen siendo ocasionales. Son 94 proveedores, el 1.8 % de la compra. Alternativa descartada: «cada 90 días» sin sacarlos del ciclo, porque muchos amanecerían rezagados el primer día | 🟡 Claude, 2026-11-22 (Francisco: «continúa» sin elegir; se tomó la recomendada). Se puede revertir: cada regla se cambia o se da de baja |
| DC28 | **Varias zonas o sucursales en una captura** (PQ.3.21): casillas en vez de una lista, y se guarda **una regla por lugar**, todas a la vez o ninguna. Cada una se atiende con lo de su lugar, así se ve si a una zona no se le pidió; cada encargado ve la suya, y la base no cambia. Descartado: una regla que cubra varias zonas (una OC en cualquiera daría por atendida a todas y no se vería la zona sin revisar) | ✅ Francisco, 2026-11-24 |
| DC29 | **La cadencia de «días de la semana»** (PQ.3.15): cada semana · cada 2 · cada 3 · una vez al mes · cada 6 semanas, en el orden en que la pidieron los usuarios. «Cada N semanas» cuenta desde «a partir del» y no se mueve con la actividad de Kepler. «Una vez al mes» = el 1º, 2º, 3º, 4º o último de ese día en el mes (12 al año). Descartado «cada 4 semanas»: 13 al año, y se corre de semana del mes. Reemplaza el alcance de PQ.3.15 (que decía 2, 3 o 4) | ✅ Francisco, 2026-11-24 |
| DC30 | **El responsable de una regla** (PQ.3.22): una persona activa con la llave efectiva de marcar que escribe en **todas** las sucursales de la regla (así siempre la ve y la atiende), con el filtro «Mis revisiones». Sin las cuentas de sistema (superadmin, admin), como en `receipt-devueltas` | ✅ Francisco, 2026-11-24 |
| DC31 | Las cinco mejoras van en **un PR** (tocan los mismos archivos; el PR separa cada una con su item) | ✅ Francisco, 2026-11-24 |

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

## 6. Items (en el tracker como PQ.3.1–PQ.3.19)

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
| PQ.3.15 | **La cadencia de «días de la semana»** (§10.9, §10.12, DC29): cada semana, cada 2, 3 o 6 semanas a partir de una fecha, o una vez al mes (1º–4º o último); «un lunes sí y otro no» no se mueve con la actividad de Kepler | C0→C3 |
| PQ.3.16 | **La siguiente fecha la pone quien pide** (§10.9), como en la hoja; «cada N días» no cae en domingo; se decide de qué se cuenta «cada N» (OC u OC y entrada), con antes/después | C0→C3 |
| PQ.3.17 | **Quién definió y quién cambió cada regla** (DC25): la regla dice quién la creó y quién la cambió por última vez; el historial de cambios (de qué a qué) se decide en C0 sin inventar una tabla de historial propia (ADR-056) | C0→C3 |
| PQ.3.18 | **El embudo de llenado en «Sin regla»** (§10.10): la lista por escalón (dinero y operaciones), el medidor de adopción en % de la compra y de las OC, y la decisión en bloque para los ocasionales | C2→C3 |
| PQ.3.19 | **El comprador ajusta la regla de su sucursal o zona** (DC26): clave nueva, sólo dentro de su alcance de escritura, nunca la corporativa; con rastro (PQ.3.17) | C1→C3 |
| PQ.3.20 | **El manual de capacitación, dentro de la Suite** (§10.11): botón «Manual» en el encabezado del calendario que abre `assets/manuales/calendario-compras.html` en otra pestaña; primitivo `app-manual-link`; un candado compara los rótulos de la pantalla con los del manual | C3 |
| PQ.3.21 | **Varias zonas o sucursales con casillas** (§10.12, DC28): «Por zona» y «Por sucursal» (antes «Una zona», «Una sucursal»); una regla por lugar, todas o ninguna; corregir no cambia el lugar | C2→C3 |
| PQ.3.22 | **El responsable de la regla y «Mis revisiones»** (§10.12, DC30): sólo quien puede marcar y escribe en todas las sucursales de la regla; la API lo exige al guardar | C2→C3 |

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
| 2026-11-21 | **DC22–DC24 ✅** (Francisco, como se propusieron): las gerencias de zona con rol de plataforma siguen viendo todo el calendario (recortarlas cambiaría también Pedido); el rol `compras` ve y marca; la gerencia de compras de Canindo y Zamora Centro no se recorta a 05–06. |
| 2026-11-21 | **La hoja de las próximas semanas contra la Suite** (§10.9): 27 proveedores (28 reglas), 6 de ellos ubicados por la marca en la descripción del artículo. Simulado con el código real contra Kepler (sólo lectura): 23 de 50 fechas iguales (semanales 21 de 24, quincenales 0 de 7, fecha única 2 de 19). Se abren PQ.3.15 y PQ.3.16; DC25 propuesta | Francisco + sesión Claude |
| 2026-11-22 | **DC25 ✅**: define la jefa actual de compras (no se reparte la clave a `compras_operaciones`) y se rastrea quién definió y quién cambió cada regla → **PQ.3.17**. Las 5 reglas semanales las captura ella desde la pantalla | Francisco + sesión Claude |
| 2026-11-22 | **DC26 ✅** y **PQ.3.19**: el patrón lo decide la jefa de compras; el comprador pospone, revisa fuera de fecha (ya existen) o ajusta la regla sólo para su sucursal o zona (nuevo) | Francisco + sesión Claude |
| 2026-11-22 | **El embudo de llenado** (§10.10): 340 proveedores, 0 reglas; dinero y operaciones no ordenan igual (50 % de la compra = 10 proveedores, 50 % de las OC = 22); escalón 1 = 62 proveedores, 82.8 % de la compra y 65.8 % de las OC. Se abre **PQ.3.18**. PQ.3.14 ✅ (en prod con #591) | Francisco + sesión Claude |
| 2026-11-22 | **PQ.3.18 (c): prueba visual, 0 fallas (35 ✓)** en 3 perfiles + oscuro. Escribió una vez (201, las dos reglas fuera de ciclo). Encontró el botón del escalón 3 en 28 px con el dedo y se corrigió | Francisco (autorizó levantar la API local) + sesión Claude |
| 2026-11-22 | **PQ.3.18 (c) 🔨 · DC27 🟡**: los ocasionales en bloque (regla «cada 180 días» y fuera de ciclo 26 semanas), API y pantalla con pruebas contra Postgres real (50 ✓, 4 mutantes) y de pantalla (18 ✔, 3 mutantes). Falta la prueba visual (pide autorización) | sesión Claude |
| 2026-11-22 | **PQ.3.18 🧪**: el orden y el medidor del embudo en «Sin regla», sin migración. Control en prod con el repo real = medición independiente (0 escalones distintos); dominio 36 ✔ (5 mutantes), vista 26 ✔, componente 14 ✔ (3 mutantes), Postgres real 45 ✓. Falta la decisión en bloque de los ocasionales, la prueba visual y el PR | sesión Claude |
| 2026-11-23 | **PQ.3.20 🧪** (§10.11): el manual de capacitación vive en la pantalla (botón «Manual», otra pestaña) como archivo del repo; `app-manual-link` compartido; el candado de rótulos (65 en `origin/main`, todos en el manual; mutante en rojo), la prueba visual del manual en 3 perfiles + oscuro (0 fallas tras subir a 44 px los objetivos táctiles) y la del botón en la pantalla viva por puesto (0 fallas). Falta el PR (con `main` en rojo por `a9a843a95`) | Francisco (pidió el manual y dónde vive) + sesión Claude |
| 2026-11-24 | **PQ.3.15 🧪 · PQ.3.21 🧪 · PQ.3.22 🧪** (§10.12): las primeras mejoras que pidieron los usuarios al día siguiente de salir a prod: varias zonas o sucursales con casillas (una regla por lugar), la cadencia de los días de la semana (cada 2, 3 o 6 semanas, o una vez al mes) y el responsable con «Mis revisiones». DC28–DC31 de Francisco. Migración `20261124133043` (la prueba contra Postgres real encontró un defecto en ella, ya corregido). 23 ✓ contra Postgres, 7 mutantes en rojo; prueba visual ✔ en 3 perfiles y oscuro | Francisco (lo pidieron los usuarios) + sesión Claude |
| 2026-11-24 | **PQ.3.18 (c) al día con `main`**: rearmado encima de PQ.3.15, PQ.3.21 y PQ.3.22 sin cambiar su código; el manual enseña «Sacar del ciclo a los N» y su diálogo (el candado pasa); re-probado contra Postgres real con todo junto (50 ✓ · 23 ✓ · 18 ✓). Va en su propio PR, sin migración | sesión Claude |
| 2026-11-24 | **PQ.3.15 ✅ · PQ.3.21 ✅ · PQ.3.22 ✅** en prod: `/api/health` sirve `b995d6a2a` (#617) y la migración `20261124133043` está aplicada con sus 3 columnas (sólo lectura). Todavía ninguna de las 16 reglas vivas usa la cadencia nueva ni tiene responsable: se mide el uso, no sólo la llegada | sesión Claude |
| 2026-11-24 | **PQ.3.17 🧪** (§10.13): quién definió, quién cambió y de qué a qué, sin tabla propia: las reglas se suman a `analytics.master_data_history` con un disparador (mig `20261124231747`), cada escritura declara quién, y sin disparador el historial se declara no medido. 13 ✓ contra Postgres real, 8 mutantes en rojo. Falta la prueba visual y su PR (después del de (c)) | sesión Claude |
| 2026-11-25 | **PQ.3.17 · prueba visual ✔** (§10.13): dos gerencias escriben por pantalla sobre la misma regla y el detalle dice las dos, con el de qué a qué; escritorio, Fold 7, celular y oscuro; sin el disparador, la pantalla lo declara. 40/40; con (c) en la misma corrida, lo de un alta en bloque ya no sale como «Cambios». Va en el mismo PR que (c) | sesión Claude |

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

**Falta:** elegir a la persona que revisa en el formulario. Las migraciones ya están en prod (abajo) y DC22–DC24
las aprobó Francisco el 2026-11-21 tal como se propusieron.

**En prod (2026-11-21):** #588 (squash `51a1d9238`); migraciones en los lotes 1230 y 1231; los 7 roles con sus
claves y `_CICLO` sólo en `gerente_compras`. Al soltar: 0 reglas, 0 marcas.

### 10.8 El día fijo por sucursal (PQ.3.14, 2026-11-21)

Con 0 reglas en prod, la gerencia tiene que definir las de ~340 proveedores. «Sin regla» ya trae la propuesta
corporativa de Kepler («cada N días»). PQ.3.14 agrega la propuesta **de sucursal**: donde el proveedor pasa, se le
pide y entrega el mismo día de la semana, la regla ya viene armada y definirla es aceptarla.

**La fuente, sin vista nueva ni migración.** Es la MISMA consulta de actividad del calendario
(`SQL_ACTIVIDAD_KEPLER`: OC también canceladas + entradas, por plaza), leída 12 meses, y una función pura en el
dominio (`diaFijoDeActividad`). Medido en prod (sólo lectura) el 2026-11-21:

| Medido | Valor |
|---|---|
| Costo de la consulta, 340 claves, 12 meses | **1.2 s** (dos corridas) |
| Sólo la OC, sin la entrada | no sirve: no ve 9 de los 16 pares (la compra local entra sin OC), y sin el filtro por clave tarda 95 s |
| Pares (proveedor, sucursal) con ≥ 8 días y ≥ 70 % el mismo día, fuera del CEDIS | 15: 14 con periodo de 7, 14, 21 o 28 días y 1 irregular (cada 49) |
| Con «sigue con ese ritmo» (≥ la mitad de las fechas que tocaban en las últimas 13 semanas) | **12 reglas para 10 proveedores**: 8 cada semana, 2 cada 14 días, 1 cada 21 y 1 cada 28 |

**El criterio, y por qué cada pieza:**
- ≥ 8 días con orden o entrada en 12 meses: con menos, cualquier día «es fijo».
- ≥ 70 % en el mismo día: el umbral con el que se midieron los 16 pares de §10.2.
- El periodo es la mediana entre esos días, si es 7, 14, 21 o 28. Cada 14 cubre al proveedor de tostadas de
  Yurécuaro (13 de 13 viernes, uno sí y otro no), que es el ejemplo de §10.2. Otro intervalo no es un día fijo.
- **Sigue con ese ritmo.** La primera versión pedía sólo «su última vez no tiene más de tres periodos». El
  **control** la tumbó: se corrió cada regla propuesta con `estadoDeRegla` sobre los últimos 180 días. Un par con
  racha semanal en abril y una OC suelta hoy habría amanecido **rezagado 97 de cada 100 días**. Con el ritmo
  reciente queda fuera, igual que un par mensual con 1 de 3. Las 12 que quedan amanecen rezagadas entre el 3 % y
  el 36 % de los días, contando que nadie marcó nada.
- Sólo sucursales con zona. En el CEDIS el día fijo es el de recepción, no el de revisión (R7).
- `cada 7` se guarda como «días de la semana»; 14, 21 y 28 como «cada N días», contando desde la última actividad
  de esa sucursal (la del alcance de la regla, no la corporativa).

**Las cinco preguntas** (skill `diseno` §0b), antes de la plantilla:
1. *Qué ve y en qué orden:* en «Sin regla», bajo lo que Kepler propone para la empresa, una línea por sucursal con
   día fijo («Yurécuaro: un viernes sí y otro no · 5 de 6 viernes en las últimas 13 semanas»). La línea es el
   botón, y abre el formulario ya lleno: sucursal, patrón y fecha base.
2. *Qué no ve:* el CEDIS, los irregulares, los que perdieron el ritmo y el detalle de 12 meses. Ese detalle va en
   el formulario, en una frase.
3. *Accesibilidad:* un clic del renglón al formulario lleno. El formulario muestra las próximas fechas antes de
   guardar. El buscador ya encuentra por nombre de sucursal.
4. *Ligas:* la regla guardada sale en «Reglas» y la ve el encargado de esa sucursal (alcance de PQ.3.6).
   Definir primero la regla corporativa **no** borra la propuesta de sucursal. El proveedor sigue en la lista
   como «ya tiene N reglas» mientras le falte la de esa sucursal, y no cuenta como «sin regla».
5. *¿Le toca?* Sí: «Sin regla» es donde nacen las reglas, y sólo quien define ciclos la ve.

**Si la consulta de 12 meses falla**, por ejemplo en una base sin el ODS de Kepler o por un tiempo agotado:
- Va en un SAVEPOINT.
- La respuesta declara `dia_fijo.measured: false` con su nota, y la pantalla lo dice.
- La propuesta por ciclo se entrega igual, y la causa queda en el registro de la API.
- Probado rompiendo a propósito la columna de plaza dentro de una transacción revertida en Postgres local: se
  declaró «no medido» y la transacción siguió viva.

**Pruebas (🧪, 2026-11-21):**
- **Dominio, 29 ✔.** Controles con pares medidos: un viernes sí y otro no se lee cada 14, y cada 49 días no es un
  día fijo. Bordes exactos: 70 % y 67 %, 8 días, el ritmo reciente con 7 de 13 y con 6 de 13. El CEDIS y una plaza
  que no es sucursal quedan fuera. El reparto `repartirPropuestas` no deja que la regla corporativa borre la de
  sucursal. Cinco mutantes en rojo: umbral de 60 %, sin ritmo reciente, también el CEDIS, cualquier periodo y sin
  filtrar por la regla de sucursal.
- **La función real sobre la actividad de prod** (JSON leído en sólo lectura) da las 12 reglas para 10
  proveedores de la tabla de arriba.
- **Vista, 21 ✔** (el texto del día fijo) y **componente, 8 ✔**. El componente pinta la línea, el clic deja el
  formulario lleno con la fecha base de la sucursal y la vista previa da el viernes 27 de noviembre. El que ya
  tiene regla sigue en la lista y no cuenta como «sin regla». Si no se midió, se dice. Guardar desde «Sin regla»
  no abre el detalle y el aviso dice la sucursal; desde «Reglas» sí lo abre. Tres mutantes en rojo: la
  evidencia que se queda pegada, las pendientes que se pierden y el detalle abierto de nuevo en «Sin regla».
- **`test-newdb-pq3-4-calendario-api.js`, 41 ✓**, contra Postgres real como `app_runtime`. El día fijo se declara
  (`measured` igual a si la base tiene la actividad) y las dos listas salen con las columnas reales.
- **Prueba negativa en Postgres local.** Con la columna de plaza rota dentro de una transacción revertida, el día
  fijo se declara no medido, la propuesta por ciclo sigue y la transacción sigue viva.
- `check:pantalla compras-calendario` tipa y cumple las 10 reglas. `nx build view` (desarrollo) compila.

**Prueba visual de punta a punta (2026-11-21, Docker local, API y vista locales; 0 fallas):**
- **Datos.** Se sembraron OC de prueba en el `kdm1` local para dos proveedores:
  - uno sin regla, con viernes por medio en Yurécuaro (5 de 6 recientes) y cada martes en Morelia Madero;
  - otro con regla corporativa, con cada jueves en Morelia Abastos y cada lunes en el CEDIS, que no debe salir.
  - **Control:** antes de la pantalla, `leerPropuestas` sobre esa base devolvió exactamente esas tres sucursales.
- **Quién lo ve.** Entró la gerencia de compras; el encargado de sucursal pide la propuesta y recibe 403.
- **Tres perfiles:** escritorio 1440×900, Fold 7 abierto 750×832 táctil y celular 390×844 táctil.
  - Sin desplazamiento lateral y nada fuera de la pantalla.
  - Con el dedo, todo mide 44 px o más, salvo la X de cerrar del diálogo, que mide 36 px.
- **El flujo.** Se aceptaron las tres propuestas una tras otra:
  - cada una guardó con 201;
  - el renglón cambió («ya tiene 1 regla; falta la de su sucursal»);
  - al final los dos proveedores salieron de la lista, y «Reglas» muestra las 3 de sucursal con su encargado y «Al día».
- **Teclado.** Tab llega a la línea, con anillo de foco, y Enter abre el diálogo armado.
- **Modo oscuro:** revisado en la captura.
- **Lo que encontró, ya corregido:**
  - **En el celular la celda «Kepler propone» salía en cuatro columnas de una palabra.** La tabla apilada (`.dt-stack`)
    hace flex la celda, y cada línea era un hijo. Ahora las celdas de varias líneas van en un solo hijo
    (`.cc-celda`). Se mide que las líneas queden apiladas: misma orilla y cada una más abajo. Control: al quitar el
    envoltorio en la página, la medición da «no apilado».
  - **Guardar desde «Sin regla» abría el detalle encima de la lista:** un clic más por cada propuesta. Ya no se
    abre ahí. El aviso dice dónde quedó la regla: «Regla creada: … en Yurécuaro, cada 14 días.»
  - «(la última, vie 13 nov) .» traía un espacio de más antes del punto.
- **Lo que no es de esta pieza (declarado):**
  - La X de cerrar los diálogos de PrimeNG mide 36 px con el dedo en todos los diálogos (ya estaba en PQ.3.5/3.6).
    Arreglarla es de la hoja global. «Cancelar» sí mide 44 px.
  - La campana de avisos pide `finance/goods-receipts/devueltas`, y la API local da 404 («Cannot GET»).

### 10.9 La hoja de las próximas semanas contra la Suite (2026-11-21)

Francisco compartió la hoja con las fechas de las próximas semanas (18-nov → 28-dic: 17 días, 30 nombres,
27 proveedores; uno se revisa en dos alcances, así que son 28 reglas) para cargarla y que la gerencia llegue a un calendario con lo que ya conoce. **La hoja no se
importa** (§2, regla 1): se simuló qué reglas la reproducen con el código real del calendario
(`armarCalendario`, cargado por ts-node como en `test-newdb-pq3-4`) contra la actividad de Kepler en prod, en
sólo lectura y sin escribir nada.

**Quién es quién.**
- 21 proveedores salen por el nombre de su ficha.
- 6 nombres son marcas, nombres comerciales o razones sociales viejas: «identificadores cotidianos; lo
  correcto es la línea del catálogo» (Francisco). En Kepler, la «línea» (`kdii.c3` → `kdig`) guarda razones
  sociales viejas, no la marca: la marca vive en la **descripción del artículo**. Por ahí se ubicaron: los
  artículos cuya descripción lleva la marca → a qué proveedor se les compró en 12 meses (líneas de OC).
  - **Control:** dos proveedores conocidos dan su clave.
  - Los 6 salen con un proveedor claro (entre 12 de 14 y 22 de 25 de sus artículos), sin contar las claves
    de sucursal propia ni una clave que aparece en casi todas las marcas.
  - En uno, la ficha con el nombre de la marca no tiene compra en 12 meses: la marca se le compra a otro
    proveedor.
- ⛔ Un cruce por **coincidencia de fechas** (OC a ±3 días de las de la hoja) **no pasó su control** y se
  descartó: a un proveedor de compra frecuente todo le coincide, y los dos conocidos no salían arriba.

**Qué reproduce la Suite** (fechas de la hoja del 21-nov al 28-dic):

| Cómo los revisa la hoja | Reglas | Fechas de la hoja que la Suite da igual |
|---|---:|---:|
| Cada semana, el mismo día | 5 | **21 de 24** (2 a un día; 1 viernes extra de la hoja) |
| Cada 2 semanas, el mismo día | 3 | **0 de 7**: «cada 14 días» cuenta desde la última actividad, que no cae ese día → PQ.3.15 |
| Una sola fecha próxima, que elige el comprador en cada ronda | 20 | **2 de 19** con el ciclo de 12 meses de Kepler → PQ.3.16 |
| **Total** | **28** | **23 de 50 (46 %)** |

- **De qué se cuenta «cada N días».** El §10.3 dice «la última ronda de OC»; el código toma la última OC
  **o entrada** (`actividadDeLaRegla`). Anclar sólo en la OC no cambia el total (23 de 43 sobre las primeras
  22 reglas) pero sí mueve fechas sueltas: la entrada no es la causa del desacuerdo. Se decide en
  PQ.3.16, con antes/después (regla 15).
- **Fin de semana.** Las reglas «cada N días» darían 49 fechas: 8 en sábado y **3 en domingo**. El
  corrimiento de fin de semana (DC19) sólo aplica a «días del mes».
- **Feriados.** Las semanales de viernes marcan el 25-dic. Mientras no haya calendario de días inhábiles
  (§10.3, deuda con nombre), ese día se marca «hoy no se pide».

**Qué se carga.** Sólo las 5 semanales, por la API de la pantalla, con la sesión de quien define reglas
(DC8) y una nota de origen. **Las captura la jefa de compras desde la pantalla** (Francisco, 2026-11-22), así quedan
definidas por ella; al 22-nov, nada se escribió en prod. Las otras 23 esperan a PQ.3.15 y PQ.3.16: cargadas hoy, la Suite mostraría fechas
que contradicen la hoja, lo contrario de lo que se busca. Los nombres y claves viven fuera del repo (es
público), en el scratch de la sesión.

**Quién define (DC25).** `COMPRAS_CALENDARIO_CICLO` lo tiene sólo `gerente_compras` (2 personas, medido
en prod). De las dos personas con el conocimiento, una está en ese rol y la otra en `compras_operaciones`,
que ve y marca pero no define. Decidido (2026-11-22): define la jefa actual, y se rastrea quién definió y quién
cambió cada regla. **Medido:** la base ya guarda `created_by`, `updated_by` y `deleted_by`, pero la pantalla sólo
dice «Definida por» con quien la CREÓ: si otra persona cambia el patrón (guardar sobre una regla viva la
reemplaza), sigue nombrando a la primera, y eso afirma lo que no es. El patrón anterior no se guarda en ningún
lado. El repo no tiene un historial genérico (cada módulo tiene el suyo) → PQ.3.17.

### 10.10 El embudo de llenado (2026-11-22)

Francisco: *«un embudo de decisiones para llevar el avance de adopción del calendario en relación a importancia
económica y número de operaciones, para el rápido llenado; una vez lleno, se estarían editando las reglas como
hoy cada quien llenaba el Drive»*.

**Medido el 2026-11-22 en prod (sólo lectura), con el código real del calendario** (`leerCalendario` y
`leerPropuestas`) y las OC vivas de 12 meses (X-A-35, estatus ≠ C, sin claves de sucursal propia): 340
proveedores, 10,382 OC, **0 reglas vivas**.

**Las dos importancias no ordenan igual:**

| | Para el 50 % | Para el 80 % |
|---|---:|---:|
| De la **compra** (monto) | 10 proveedores | 48 |
| De las **OC** (operaciones) | 22 proveedores | 84 |

De los 22 que hacen la mitad de las OC, sólo 8 pesan en dinero: los otros 14 son compra local de todos los
días, poca plata y mucho trabajo. Ordenar sólo por dinero los dejaría al final.

**El embudo (tres escalones, en este orden):**

| Escalón | Quiénes | Proveedores | % de la compra | % de las OC | Decisión que lo saca |
|---|---|---:|---:|---:|---|
| 1 | Los que hacen el 80 % de la compra **o** el 50 % de las OC | **62** | **82.8** | **65.8** | 55 confirmar el ciclo de Kepler · 3 aceptar día fijo · 4 compra continua (días de la semana) |
| 2 | El resto con compra recurrente | 184 | 15.4 | 32.4 | 177 confirmar el ciclo · 7 aceptar día fijo |
| 3 | Ocasionales (una o pocas compras en 12 meses) | 94 | 1.8 | 1.8 | en bloque: ciclo largo o «fuera de ciclo» con motivo |

- **Avance de la adopción** = proveedores con decisión (regla viva o fuera de ciclo), en % de la compra y % de
  las OC; después, cuántos de ellos están **al día**. Hoy: 0 de 340 (0 %).
- De los 62 del escalón 1, unos 36 aparecen en la hoja 2026 (cruce aproximado por nombre del 10-nov): la
  Suite cubriría proveedores que la hoja no tiene.
- **Lo que no está medido:** cuánto tarda cada decisión en la pantalla (estimado: un diálogo por proveedor).

**Después del llenado (fase 2):** las reglas se mantienen como hoy se llena el Drive. Lo decidió Francisco (DC26, abajo).

**En la Suite: PQ.3.18.** El embudo vive en «Sin regla» para que el avance sea el de hoy y no una foto:
- la lista ordenada por escalón;
- el medidor de adopción («con regla: N de 340 · X % de la compra · Y % de las OC»);
- la decisión en bloque para los ocasionales.

Mientras tanto, la medición se repite a pedido con el script de la sesión, sin escribir en prod.

**PQ.3.18: las preguntas antes de construir** (skill `diseno` §0a, 2026-11-22):

1. **Propósito.** «¿A qué proveedor le defino la regla ahora, y cuánto llevo?». Cierra el acto de *definir la siguiente
   regla que más pesa*.
2. **Quién entra.** Quien define reglas: `gerente_compras` (2 personas) y el modo dios (Francisco, Dirección). Uso
   medido el 21-nov: una consulta al calendario (Dirección), 0 reglas.
3. **Estado real.** 0 de 340 proveedores con regla. El trabajo está detenido en el primer paso: nadie sabe por dónde
   empezar. La lista de hoy va por la siguiente fecha que propone Kepler, no por lo que pesa.
4. **Qué ve primero (nivel 0).** Una línea: «Con regla: N de 340 proveedores · X % de la compra · Y % de las OC».
   Debajo, los tres escalones con su avance. La lista empieza por el escalón 1, de mayor a menor peso.
5. **Qué no ve.** El monto en pesos: el peso va en % de la compra, porque decide igual y no expone cifras. Los
   proveedores con regla no se listan uno por uno: ya están en «Reglas».
6. **Mapa de desglose.**

   | Cifra | Dónde se abre | Qué contiene |
   |---|---|---|
   | Avance total | — | es la suma de los escalones de abajo |
   | Avance de un escalón | un clic: la lista se filtra a ese escalón | sus proveedores sin regla |
   | Peso de un proveedor (% compra · OC) | su renglón | rondas de 12 meses y la propuesta de Kepler |
   | Proveedor | «Definir regla» (ya existe) | el diálogo con la propuesta armada |

7. **Accesibilidad.** Cada escalón es un botón con nombre («Ver sólo el escalón 1»), alcanzable con Tab. El escalón
   también va en texto, no sólo en color. El buscador sigue igual.
8. **Ligas.** Viene de Kepler (OC X-A-35, la vista PQ.3.1) y va a la regla («Definir regla» → «Reglas»).
9. **¿Le toca a esta pantalla?** Sí: «Sin regla» es donde se definen las reglas. No se crea otra pantalla.
10. **Maqueta.**

    ```
    Con regla: 0 de 340 proveedores · 0 % de la compra · 0 % de las OC
    [Escalón 1 · 80 % de la compra o 50 % de las OC]  0 de 62 · 0 de 82.8 % de la compra · 0 de 65.8 % de las OC
    [Escalón 2 · el resto con compra recurrente]       0 de 184 · …
    [Escalón 3 · ocasionales]                          0 de 94 · …
    Proveedor | Peso (% compra · OC · rondas) | Kepler propone | Última orden | Sucursales | Definir regla
    ```

    Cambia contra hoy: el medidor, el orden y la columna «Peso», que absorbe «Rondas en 12 meses». Se conserva todo lo
    demás, incluido el día fijo por sucursal (PQ.3.14).
11. **Criterios.**
    - El medidor cuadra con una consulta independiente.
    - Con cero reglas dice 0 %, no vacío.
    - Una regla dada de baja sale del avance (prueba negativa).
    - Si la compra de 12 meses no se puede leer, se **declara** («el peso no se midió») y la lista sigue en el orden
      de hoy.
12. **Lo que no resuelve.**
    - La decisión en bloque de los ocasionales necesita definir qué regla llevan: ciclo largo, o «fuera de ciclo» con
      motivo (que exige una regla antes). **Queda para después de esa decisión.**
    - El peso es el monto de las OC vivas, no lo recibido.

**Después del llenado (DC26, Francisco 2026-11-22).**
- El **patrón lo decide la jefa de compras**.
- Si un comprador no avanzó, puede:
  - **posponer** («hoy no se pide» con nueva fecha; ya existe);
  - hacer una **revisión extemporánea** (marcar «se pidió fuera de Kepler» en cualquier fecha, o que caiga la OC;
    ya cuenta como atendida);
  - **ajustar la regla sólo para su sucursal o su zona** (nuevo → PQ.3.19).

**Cómo quedó (PQ.3.18 🧪, 2026-11-22): (a) el orden y (b) el medidor. Sin migración ni vista nueva.**
- **API.** `GET /compras/calendario/propuestas` trae `embudo` (avance total y por escalón, en % de la compra y de las
  OC) y el `peso` de cada propuesta (escalón, % de la compra, OC de 12 meses). La lista llega ordenada por escalón y
  peso.
  - La compra de 12 meses es una consulta nueva (`SQL_COMPRA_DOCE_MESES`, OC vivas) dentro de un SAVEPOINT. Si falla,
    se declara `embudo.measured: false` con nota, y la lista queda en el orden de Kepler.
  - El escalón lo calcula una función pura (`armarEmbudo`). Es del proveedor, no de si ya tiene regla.
- **Pantalla.** En «Sin regla» va primero «Con regla: N de 340 proveedores · X % de la compra · Y % de las OC», y
  debajo los tres escalones.
  - Cada escalón es un botón que filtra la lista a ése (`aria-pressed`, y lo dice); otro clic vuelve a todos.
  - La columna «Peso en la compra» absorbe a «Rondas en 12 meses».
  - Sin la compra medida, lo dice en vez de pintar 0 %.
- **Control en prod (sólo lectura).** El repositorio real da lo mismo que la medición independiente de la sesión:
  62/184/94 proveedores, 82.8/15.4/1.8 % de la compra, 65.8/32.4/1.8 % de las OC y **0 proveedores en un escalón
  distinto**. Las propuestas tardan 2.9 s en prod con la compra incluida.
- **Pruebas.**
  - Dominio: 36 ✔. Cinco mutantes en rojo: sólo por dinero, umbral de 70 %, ocasional con día fijo, contar sin reglas
    vivas, y entrar al cruzar el umbral.
  - Vista: 27 ✔. Componente: 14 ✔, con 3 mutantes en rojo (sin orden, filtro que no filtra, escalón que no se suelta).
  - `test-newdb-pq3-4`: 45 ✓ contra Postgres real, con la negativa «definir una regla sube el avance; darla de baja lo
    regresa».
  - Negativa local: con la consulta de la compra rota, el embudo se declara no medido y la transacción sigue viva; sin
    el SAVEPOINT, la prueba se pone roja.
  - `check:pantalla` tipa y cumple las 10 reglas. `nx build view` (desarrollo) compila.
- **Prueba visual de punta a punta (2026-11-22, Docker local, API y vista locales; 0 fallas, 43 ✓).** Francisco
  autorizó levantar los servidores.
  - **Datos.** La base local preparada como en PQ.3.14 (8 reglas de muestra, 9 sucursales con zona, OC sembradas):
    10 proveedores con compra, 7 con regla.
  - **Control.** Antes de abrir la pantalla, el total de la API cuadra con un conteo independiente en la base (7 de 10).
    La línea de la pantalla se compara contra la misma fórmula escrita aparte.
  - **Perfiles:** escritorio 1440×900, Fold 7 abierto 750×832 táctil, celular 390×844 táctil, y escritorio en oscuro.
    Sin desplazamiento lateral, nada fuera de la pantalla, y lo nuevo mide 44 px o más con el dedo.
  - **Flujo.**
    - El escalón 1 filtra la lista a sus 2 proveedores y lo dice; otro clic regresa a los 4.
    - Con teclado, Tab llega al escalón con anillo de foco y Enter filtra.
    - En el celular, el peso queda apilado bajo su rótulo.
    - **Escribe una vez:** definir desde la pantalla la regla del primero de la lista (36.4 % de la compra) da 201, y el
      medidor pasa de «7 de 10 · 58.9 % de la compra · 72 % de las OC» a «8 de 10 · 95.3 % · 78.3 %».
  - **Lo que encontró, ya corregido:**
    - **En el celular el % se separaba de su número** («68.1» en un renglón y «% de las OC» en el siguiente). Ahora va
      un espacio que no se parte (U+00A0), también en el nombre de los escalones. La prueba mide que llegue así al
      DOM. ⚠️ El primer lector de la prueba lo ocultaba: normalizaba con `s`, que también se come ese espacio.
    - **Un escalón vacío decía «0 de 0 proveedores · 0 % de 0 %…».** Ahora dice «Ningún proveedor en este escalón».
    - **El embudo quedaba pegado a la nota de abajo**, y la línea «Viendo sólo el escalón…» quedaba entre dos notas.
      Ahora el embudo tiene aire, y el filtro se dice pegado a la tabla que filtra.
  - **Lo que no es de esta pieza (declarado):** la campana de avisos pide `finance/goods-receipts/devueltas` y la API
    local da 404, igual que en PQ.3.14. No se vio en prod con datos reales.
  - La base local se dejó como estaba: las reglas que escribió la prueba se borraron, y la preparación se deshizo en
    orden inverso.
- **Enviado como #602** (2026-11-22, sin migración). En el CI pasaron las obligatorias; el rojo de Lint & test es heredado de `main` (`f5cf83019`, con los mismos tres rojos).

**Cómo quedó (c), los ocasionales en bloque (DC27, 2026-11-22; va en su propio PR, después de #602):**
- **API.** `POST /compras/calendario/reglas/ocasionales` con `{ supplier_codes }` (las claves que muestra la pantalla).
  - El servidor vuelve a medir el embudo y **sólo toca las que HOY son ocasionales sin regla**. A cada una le pone la
    regla corporativa «cada 180 días» y la saca del ciclo 26 semanas, con motivo y con quién. Las demás las devuelve
    como omitidas, con su motivo.
  - Pide `COMPRAS_CALENDARIO_CICLO` y alcance de escritura en todas las sucursales.
  - Todo en una transacción. Sin el embudo medido, no escribe a ciegas.
- **Pantalla.** En el escalón 3, el botón «Sacar del ciclo a los N» (sólo si hay ocasionales sin regla).
  - Antes de hacer nada, el diálogo dice qué va a hacer: la regla, la fecha de regreso, el motivo y unos nombres.
  - Al guardar, el aviso dice cuántos quedaron, hasta cuándo, y cuántos no se tocaron.
- **Pruebas.**
  - Contrato: 24 ✔. Arranque: la ruta nueva con su permiso.
  - `test-newdb-pq3-4`: 50 ✓ contra Postgres real, con un ocasional sembrado en el ODS dentro de la transacción
    (se revierte). Verifica:
    - la regla y su fuera de ciclo, con quién;
    - la clave no ocasional, omitida y sin tocar;
    - repetir no duplica;
    - en el calendario sale «fuera de ciclo»;
    - sin alcance de todas, 403, también con una lista sin ningún ocasional.
  - Cuatro mutantes en rojo: escribir cualquier clave, no exigir el alcance, no sacar del ciclo, aceptar la lista vacía.
  - Vista: 29 ✔. Componente: 18 ✔, con 3 mutantes en rojo (mandar todas las claves, botón sin ocasionales, cerrar el
    diálogo al fallar).
  - `check:pantalla` cumple; `nx build view` y `nx build api` compilan.
- **Prueba visual de (c), de punta a punta (2026-11-22; Francisco: «inicia prueba visual»; Docker local, API y vista
  locales): 0 fallas (35 ✓).** Se sembraron dos ocasionales de una sola OC en el ODS local.
  - **API.** Salen como ocasionales sin regla. El encargado (sin la clave) recibe 403, y tras el 403 siguen los dos sin
    regla.
  - **Perfiles:** escritorio, Fold 7 abierto y celular táctiles, y escritorio en oscuro.
    - El botón dice «Sacar del ciclo a los 2».
    - El diálogo dice, antes de hacer nada, la regla, la fecha de regreso (hoy + 182 días), el motivo y a quién toca.
    - El diálogo cabe en la pantalla, y Cancelar cierra sin escribir.
    - Con teclado, Tab llega al botón con indicador de foco, Enter abre el diálogo y Escape lo cierra.
  - **Escribe una vez.** Responde 201 con `definidas: 2`.
    - El aviso dice cuántos quedaron, hasta cuándo y con qué regla.
    - El escalón 3 queda «2 de 2» y el botón desaparece.
    - En la API las dos reglas son corporativas, «cada 180 días», fuera de ciclo hasta la fecha y con motivo, y
      «Reglas» las muestra así.
  - **Encontró, ya corregido:** con el dedo, el botón del escalón 3 medía **28 px**, porque vive en el embudo, fuera de
    `.cc-acc`, y no le alcanzaba la regla táctil. Ahora mide 44.
  - **Declarado:** la X de cerrar de PrimeNG mide 36 px con el dedo, como en todos los diálogos.
  - La base local se dejó como estaba.
- **Al día con `main` (2026-11-24).** #602 ya está en prod con (a) y (b), y `main` ya trae PQ.3.15, PQ.3.21 y PQ.3.22
  (#617), que tocan los mismos archivos. (c) se rearmó encima sin cambiar su código: los choques eran métodos nuevos uno
  junto a otro e importaciones reacomodadas.
  - **El manual enseña el botón** (lección G2): el botón en la figura del embudo, el bloque «Los ocasionales, de una
    vez» con lo que hace el diálogo, la fila «Compra una o pocas veces al año» de «¿Cada cuándo?», y sale de las dos
    listas de lo que todavía no está en la Suite. El candado del manual pasa; sin esas líneas se ponía en rojo por
    «Sacar del ciclo a los ocasionales».
  - **Re-probado con todo junto:** `test-newdb-pq3-4` 50 ✓, `test-newdb-pq3-21` 23 ✓ y `test-newdb-pq3-6` 18 ✓ contra Postgres real; `libs/contracts` 45 ✔ y
    `libs/commercial` 53 ✔ (calendario); pantalla, reglas y manual 52 ✔.
  - **Falta:** el PR, su CI, el merge, soltar (sin migración) y verlo en prod.

### 10.11 El manual de capacitación (PQ.3.20, 2026-11-23)

Francisco pidió un manual «muy gráfico para capacitar desde 0 al personal» y, ya hecho, *«¿en qué parte de la Suite va a
vivir el manual?»*.

- **Qué es.** Un HTML en `apps/view/src/assets/manuales/calendario-compras.html`, en dos partes:
  - la **Parte 1**, para todos: palabras, pantalla, estados, rutina, marcar, detalle, «Semana» y «Mes»;
  - la **Parte 2**, para la gerencia: el embudo, qué regla va, definir con los tres patrones, varias reglas, corregir,
    pausar o dar de baja y su revisión semanal.
  - Lleva maquetas con los rótulos exactos de la pantalla, casos, dos autoevaluaciones y la guía para quien capacita.
  - Los proveedores de los ejemplos son inventados. Las cifras son conteos y porcentajes, como en este anexo, sin
    montos ni nombres de personas.
- **Dónde vive** (decisión de diseño, sesión Claude): en la propia pantalla, con el botón «Manual» del encabezado, que lo
  abre en otra pestaña para que la pantalla de trabajo se quede donde estaba. Descartado:
  - **un marco dentro de la Suite:** `nginx.conf` no deja enmarcar la app ni a sí misma (`X-Frame-Options: DENY` y
    `frame-ancestors 'none'`; aflojarlo es la decisión abierta `[AU.33]`, de una persona);
  - **Tareas › «Manual por puesto»:** son las normas de operación de cada puesto, no el uso de una pantalla;
  - **sólo fuera de la Suite:** el personal de compras y de las sucursales no tiene cuenta en la herramienta donde se
    redactó.
- **Cómo se sirve.** nginx lo da por `location /` con `no-cache` (el regex de assets de larga caché no incluye
  `.html`). La CSP ya admite su script en línea y sus fuentes. El service worker lo guarda en el grupo «assets» y lo
  renueva con cada despliegue. Sigue el tema que la persona eligió en la Suite (mismas claves que `ThemeService`).
- **El primitivo (ADR-056).** `app-manual-link`, en `shared/components/manual-link/`: la siguiente pantalla con manual
  pone su HTML en `assets/manuales/` y una línea en su encabezado. Mide 44 px con el dedo, y su nombre accesible dice
  qué manual es y que se abre aparte.
- **Las cinco preguntas** (skill `diseno` §0b):
  1. *Qué ve y en qué orden:* la pantalla no cambia. «Manual» es terciario, junto a «cargado ahora», y no compite con la
     respuesta ni con «Marcar».
  2. *Qué no ve:* ni un recorrido guiado ni un aviso fijo de «¿eres nuevo?» que estorbe a quien ya la usa.
  3. *Accesibilidad:* a un clic, desde la pantalla de la que habla; con teclado (es un enlace); nombre accesible completo.
  4. *Ligas:* con la capacitación (la guía para quien capacita va dentro del manual).
  5. *¿Le toca?:* sí. El manual es de esta pantalla y lo ve quien ve el calendario, con el mismo permiso; no pide clave
     nueva.
- **El candado** (`calendario-compras-manual.spec.ts`). Saca de la pantalla sus rótulos y exige que cada uno esté en el
  manual. Lee de su código las opciones, las cifras, los botones, los rótulos de los formularios, las columnas, los
  títulos de los diálogos, los estados, los motivos y los escalones. En `origin/main` son 65, y todos están.
  - Control: un rótulo inventado no está en el manual.
  - Mutante: un manual sin «Pasa al lunes» y «Fuera de ciclo hasta» da rojo y los nombra.
  - La negativa real la dio el árbol local: el diálogo de PQ.3.18 (c), «Sacar del ciclo a los ocasionales», lo puso en
    rojo solo. **Cuando (c) se envíe, su PR tiene que enseñar ese botón en el manual.** Hecho en ese PR (2026-11-24).
- **Pruebas.**
  - El botón, 3 ✔. El componente del calendario, 18 ✔. El candado, verde contra `origin/main`.
  - `check:pantalla` cumple las 10 reglas. «Sin emojis», plantillas, estilos y tokens, en verde.
  - El «✓» del manual cae en el rango de la compuerta «sin emojis»; se cambió por «Sí» y una palomita de CSS.
  - Prueba visual del manual como archivo, sin servidores: tres perfiles, oscuro y el tema elegido en la Suite mandando
    sobre el del sistema. Las autoevaluaciones aprueban con 8 de 8 y 5 de 6; una respuesta mal manda a su lección; el
    avance sobrevive a recargar.
  - Encontró los objetivos táctiles del índice en 34 px y la liga de regreso en 18; ahora miden 44. Después, 0 fallas.
- **Prueba del botón en la pantalla viva** (2026-11-23; Francisco: «si levanta»; Docker local, API y vista locales):
  **0 fallas**, sin errores de consola.
  - En escritorio, Fold 7 abierto, celular y escritorio en oscuro, el botón va junto a «cargado ahora». Mide 44 px con
    el dedo y 28 con mouse, no empuja nada fuera del ancho y recibe el foco del teclado.
  - Abre el manual en **otra pestaña** y la pantalla de trabajo se queda donde estaba. El manual sale en el tema de la
    Suite, también con el sistema en claro y la Suite en oscuro, y su liga de regreso lleva al calendario.
  - Lo ven también el encargado de tienda, el almacenista sin sucursal y Dirección.
  - Para que la vista compile con `main` en rojo, durante la prueba hubo un archivo vacío **temporal** en lugar de
    `./http/autoabasto-ordenes`. Se borró al terminar, y la base local quedó como estaba.
- **No medido.** `nx build view`: `main` está en rojo desde `a9a843a95`, porque el índice de contratos exporta
  `./http/autoabasto-ordenes`, un archivo que no está en el repo. Las pruebas unitarias corrieron con ese import
  reemplazado por un módulo vacío, fuera del árbol.
- **Mantenimiento.** El archivo del repo es la fuente. Si un PR cambia un rótulo de la pantalla, el candado pide
  cambiarlo en el manual en el mismo PR.

### 10.12 Las primeras mejoras de los usuarios (PQ.3.15, PQ.3.21, PQ.3.22 · 2026-11-24)

Al día siguiente de salir a prod, los usuarios pidieron, por Francisco:

1. *«Cuando la revisión se hace por zonas, hay ocasiones que se hacen de dos zonas: La Piedad y Zamora, o Morelia y La
   Piedad. Hoy sólo deja elegir una zona; con casillas sería mejor.»* Lo mismo con las sucursales.
2. Bajo los días de la semana, la cadencia: *«cada semana, cada 2 semanas, cada 3 semanas, 1 vez al mes y cada 6 semanas»*.
3. *«Un responsable de la revisión, para dar seguimiento.»*
4. Los rótulos «Por zona» y «Por sucursal».

**Medido en prod** (sólo lectura, 24-nov): 9 reglas vivas, todas capturadas ese día, de las que 6 eran de zona y 3 de
todas las sucursales; ninguna con responsable y 0 marcas. Un proveedor ya tenía dos reglas iguales (martes), una en La
Piedad y otra en Zamora: era el rodeo para «dos zonas». Las decisiones son DC28–DC31 (§4).

**Decisiones de diseño** (sesión Claude):
- **«Corregir la regla» ya no cambia el lugar:** lo muestra fijo. Antes, cambiarlo creaba otra regla y dejaba viva la
  anterior (había un aviso para eso); con casillas sería todavía más confuso. Para otro lugar está «Otra regla para este
  proveedor».
- **El día fijo «un viernes sí y otro no»** ahora abre como viernes cada 2 semanas, a partir de la última orden o entrada
  de esa sucursal (antes, «cada 14 días»). Es el criterio de PQ.3.15.

**Las cinco preguntas** (skill `diseno` §0b):
1. *Qué ve y en qué orden:* el formulario conserva su orden (dónde → cuándo → nota). Las casillas van donde estaba la
   lista, la cadencia pegada a los días y el responsable antes de la nota.
2. *Qué no ve:* la cadencia sólo con días de la semana; «A partir del» sólo con cada N semanas; «¿Cuál del mes?» sólo
   con una vez al mes; «Mis revisiones» sólo si eres responsable de alguna regla.
3. *Accesibilidad:* casillas reales (`p-checkbox` con su etiqueta, así que el renglón entero es objetivo: 44 px con el
   dedo); el filtro es un botón con `aria-pressed`; el responsable se busca por nombre.
4. *Ligas:* la regla queda ligada a una persona, y «Mis revisiones» lleva a cada quien a lo suyo.
5. *¿Le toca?:* sí, en el formulario de la regla y en la lista; no hace falta pantalla nueva.

**Cómo quedó:**
- **C0.** Migración `20261124133043`: `week_interval` (2, 3, 6), `week_anchor` (date) y `month_week` (1–5),
  con un CHECK con las mismas listas que el contrato. Sólo valen en «días de la semana».
- **C1, el contrato.**
  - `fechasDeLaRegla` respeta la cadencia: no hay fechas antes de la ancla, y las semanas van de lunes a domingo.
  - `validarCaptura` y `reglasDeLaCaptura` arman una regla por lugar.
  - `puedeSerResponsable` hace la misma cuenta que `reglaEnAlcance`.
  - `patronDelDiaFijo` guarda cada 2, 3 o 6 semanas con su ancla.
- **C2, la API.**
  - `POST reglas` acepta `zone_codes` y `branch_codes`. Revisa el alcance de **todos** los lugares antes de
    escribir el primero y devuelve `reglas` (una por lugar).
  - El responsable se exige al guardar: activo, con la llave efectiva (`permisoEfectivoSql`) y escribiendo en todas
    las sucursales. Su alcance lo resuelve `ScopeService.forUser` fuera de la transacción.
  - `GET responsables` (pide CICLO) lista a quién se puede ofrecer.
- **C3, la pantalla.** Casillas por zona y por sucursal, «¿Cada cuánto?» con «A partir del» o «¿Cuál del mes?»,
  «Responsable (opcional)», «Mis revisiones (N)», y «Responsable:» en la lista y en el detalle. El manual se puso al día
  en el mismo cambio (su candado lo exigía).

**Pruebas:**
- **Contrato:** 45 ✔ (21 nuevas), con fechas reales; por ejemplo, diciembre de 2026 trae cinco martes, así que el cuarto no es el último.
- ⭐ **El criterio de PQ.3.15, cumplido:** las 3 quincenales de día fijo de la hoja de Compras (§10.9) dan **7 de 7** fechas iguales; con «cada 14 días» daban 0 de 7. Queda como prueba del contrato.
- **Comercial:** 53 ✔, incluida la ruta nueva en el arranque.
- **Pantalla:** `calendario-compras-captura.spec.ts` y `compras-calendario.mejoras.spec.ts`, 16 ✔; el componente, 18 ✔.
- **`test-newdb-pq3-21-calendario-mejoras.js` contra Postgres real, como `app_runtime`: 23 ✓.**
  - ⭐ **Encontró un defecto de la migración:** reusar el mismo `knex.schema` para varios `hasColumn` acumula las
    instrucciones, y `week_anchor` no se creaba. Ya está corregido.
  - Dos negativas: un lugar fuera de alcance y no se escribe ninguno; un responsable sin llave, sin ver el lugar o sin
    alcance resuelto se rechaza.
- **`test-newdb-pq3-4`:** 50 ✓; ahora aplica también la migración nueva.
- **Siete mutantes en rojo:**
  - sin la revisión previa del alcance;
  - el responsable no tiene que ver los lugares;
  - sin la llave;
  - el CHECK acepta cualquier cadencia;
  - la cadencia no filtra semanas;
  - la pantalla manda una sola zona;
  - la pantalla ofrece a cualquiera como responsable.
- **`check:pantalla` cumple.** «Sin emojis», plantillas, estilos y tokens, en verde.
- **Prueba visual** (24-nov): la pantalla viva contra la API local, sobre la base local con el catálogo real y la
  migración aplicada con su `up()` real; escritorio, Fold 7 abierto y celular, más el modo oscuro; 0 errores de consola.
  - *Escritorio, gerencia de compras:*
    - el día fijo «un viernes sí y otro no» abre en «Por sucursal», viernes, «Cada 2 semanas»; al guardar dice «Regla
      creada: … en Yurécuaro, cada 2 semanas, en viernes.»;
    - dos zonas marcadas dicen «2 reglas de …, cada martes: zona La Piedad (nueva) y zona Zamora (nueva).», y en la base
      quedan las dos;
    - con La Piedad y Zamora marcadas, «Responsable» sólo ofrece a quien escribe en las dos;
    - al corregir, el lugar se ve fijo; con «Una vez al mes · Último» y el encargado de esa sucursal como responsable
      dice «Regla actualizada: … el último viernes de cada mes.».
  - *Negativas en la pantalla:* sin sucursal marcada, «Elige al menos una sucursal.»; con un responsable que no ve todas
    las sucursales, «… no ve todas las sucursales de esta regla: elige a otra persona o quítala.» y «Guardar la regla»
    apagado.
  - *Negativas en la API directa:* 400 con un responsable que no ve la zona; 400 «Elige al menos una zona.»; 403 a un
    encargado en `GET responsables`. La lista de responsables trae al encargado sólo con su sucursal y deja fuera a
    quien no tiene la llave de marcar.
  - *Celular, encargado de sucursal:* «Mis revisiones (1)» filtra a su regla, con 44 px al dedo y sin desplazamiento
    lateral. En el Fold 7 y en el celular el diálogo cabe, con casillas, días y opciones de 44 px.
  - *El manual:* el botón «Manual» abre el que ya enseña «Por zona», «¿Cada cuánto?» y «Mis revisiones».
  - El último paso del guion falló por el guion (el panel de detalle tapaba el botón «Manual»); se midió aparte, con la
    pantalla limpia: ✓.

### 10.13 Quién definió, quién cambió y de qué a qué (PQ.3.17 · 2026-11-24)

**El problema (DC25).** El detalle de una regla decía «Definida por X el Y» con quien la CREÓ. Si otra persona cambiaba
el patrón (guardar sobre una regla viva la reemplaza), seguía nombrando sólo a X: la pantalla afirmaba lo que no era. Y el
patrón anterior se perdía: la regla sólo guarda el último `updated_by` / `updated_at`, que además se mueven igual al
sacarla del ciclo que al cambiar el patrón.

**Medido en prod (sólo lectura, 2026-11-24):**
- 16 reglas vivas de 2 personas; 2 se tocaron después de crearse (las dos por quien las creó); ninguna la cambió otra
  persona; ninguna dada de baja.
- `analytics.master_data_history` (VP.3.1) ya existe y ya vigila 14 tablas (precios, reorden, caja, libro de efectivo)
  con un disparador genérico al que se le pasan las columnas. `app_runtime` tiene INSERT, SELECT, la secuencia y el
  esquema; la función no es SECURITY DEFINER.

**Decisión (técnica, de Claude): sin tabla de historial propia (ADR-056).** Las reglas se suman al log compartido con
un disparador (migración `20261124231747`, sólo `CREATE TRIGGER`). Cada escritura de la API declara quién es
(`app.actor`, local a la transacción, como los importers en VP.3.2). Se vigila también `updated_at`: así toda escritura
deja su fila, aun la que guarda lo mismo, y «el último cambio no está en el historial» sólo puede querer decir que es
de antes de la migración.

**Las preguntas antes de construir** (skill `diseno` §0b):
1. *Qué ve y en qué orden.* En el detalle de la regla, sección «La regla»: quién la definió y cuándo; si alguien la tocó
   después, «Último cambio: quién, el día»; debajo, «Cambios», el más nuevo primero: día · quién, y qué cambió en
   palabras (el patrón entero antes → después, el responsable por nombre, fuera de ciclo con su motivo, la nota, la baja).
2. *Qué no.* Ni ids, ni nombres de columna, ni JSON, ni la hora; nada en la lista principal (al revisar no se busca eso).
3. *Accesibilidad.* A un clic (abrir la regla); una lista ordenada, cada renglón su propio elemento; sin color; nombres
   de personas, no ids; «sin nombre declarado» cuando una escritura no dijo quién; los 10 más recientes y cuántos hay.
4. *Ligas.* DC25 (define la jefa de compras) y PQ.3.19 (el comprador ajusta la regla de su sucursal): el rastro que
   PQ.3.19 necesita es éste.
5. *¿Le toca?* Sí: el detalle de la regla es donde ya se dice quién la definió.

**Cómo quedó (🧪; viaja en el mismo PR que (c), que toca los mismos archivos):**
- **Migración** `20261124231747`: el disparador sobre `commercial.purchase_review_rules` (patrón completo, responsable,
  fuera de ciclo, nota, baja y `updated_at`). Verifica que existan las columnas y el log antes de crearlo; `down()` lo
  quita y la historia escrita se queda. ⚠️ Sólo crea un disparador: la compuerta del despliegue la clasifica NO_MEDIDO,
  así que se aplica ANTES de soltar.
- **API.** `GET /compras/calendario` trae por regla `ultimo_cambio` (de la regla misma: quién y cuándo) y `cambios` (los 10
  más nuevos del log, con `antes` / `despues` y los nombres de los responsables), más `historial: { measured, note }`. La
  lectura va en un SAVEPOINT y primero mira que el disparador esté activo: si no, el historial se DECLARA no medido y no
  se manda `cambios` (nunca «sin cambios» por defecto). Guardar, sacar del ciclo y dar de baja declaran quién.
- **Contrato.** `historialDeLaRegla` reconstruye la regla entera antes y después de cada cambio (hacia atrás desde la de
  hoy; lo que el cambio trae manda sobre lo reconstruido) y `ultimoCambioSinHistorial` dice si el último cambio es de
  antes del historial.
- **Pantalla.** «Último cambio: …, el …» y la lista «Cambios» en el detalle. Un último cambio sin fila se dice: «Ese último
  cambio es de antes de que se guardara el historial: se sabe quién y cuándo, no de qué a qué.» Las 2 reglas tocadas en
  prod lo van a decir así.
- **Manual.** La figura del detalle con «Último cambio» y «Cambios», su leyenda, el consejo «Quién la definió», y sale de
  «Lo que viene para la gerencia».
- **Pruebas.**
  - `test-newdb-pq3-17` contra Postgres real, como `app_runtime`: **13 ✓**. Una regla recién definida no tiene último
    cambio; otra persona cambia el patrón y la regla nombra a las dos, con el antes y el después; una tercera escritura de
    otra persona se le atribuye a ella (el actor no se hereda de la anterior); guardar lo mismo deja su fila; sin declarar
    quién queda en `null`; la baja queda con quién; NEGATIVA: sin el disparador, se declara no medido.
  - Sin regresión: `test-newdb-pq3-4` 50 ✓, `pq3-21` 23 ✓, `pq3-6` 18 ✓.
  - Contrato 51 ✔, dominio 56 ✔, vista y pantalla 78 ✔ (con el candado del manual).
  - **8 mutantes en rojo:** fuera de ciclo sin declarar quién; sin disparador dice «medido»; la migración sin
    `updated_at`; el dominio manda cambios sin historial medido; el «antes» sin reconstruir; sin último cambio dice que
    falta historial; la vista pinta sin historial medido; la pantalla sin «Último cambio».
  - `check:pantalla` cumple.
  - **Prueba visual (2026-11-25), 40/40**, contra la API local y Postgres de Docker con la migración aplicada por su `up()`
    real y usuarios de prueba locales:
    - Controles antes de escribir: la regla nunca cambiada sólo dice «Definida por»; la cambiada antes del disparador
      dice quién y cuándo y la frase «de antes de que se guardara el historial», sin inventar «Cambios».
    - Escritura real por pantalla de **dos gerencias** sobre la misma regla: una corrige el patrón y pone responsable, la
      otra la saca del ciclo. La base guarda dos filas escritas por `app_runtime`, cada una con su actor; el detalle dice
      «Último cambio» de la segunda, «Definida por» sigue siendo quien la creó, y «Cambios» trae los dos pasos, el más
      nuevo primero, con el paso viejo leyéndose igual (patrón de martes y viernes a jueves y viernes; responsable de
      nadie a la gerencia).
    - Fold 7 y celular táctiles: los pasos caben (sin desplazamiento lateral), letra ≥ 12 px, botones del detalle ≥ 44 px.
      Escritorio oscuro: contraste de «Cambios» ≥ 6.9:1.
    - **Negativa:** sin el disparador, la API declara `historial.measured: false` (sin `cambios`, no una lista vacía) y
      la pantalla muestra «Último cambio» con el aviso; al reponerlo, los dos cambios vuelven.
  - **Con (c) en la misma corrida:** «Sacar del ciclo a los N» define la regla y la saca del ciclo en UNA transacción, y
    el detalle mostraba «Cambios» (la salida del ciclo) sin «Último cambio»: dos piezas de la pantalla contestaban
    «¿se cambió?» con reglas distintas. Ahora lo escrito en la misma transacción del alta es parte del alta, con la misma
    regla que «Último cambio» (`changed_at > created_at + 1 s`); la fila se queda en el log. `test-newdb-pq3-17` **14 ✓**
    y su mutante (sin el filtro) en rojo; la prueba visual de (c) lo confirma en la pantalla.
  - **Revisión independiente** (otra sesión, sin mis conclusiones), sin bloqueantes. Encontró que un usuario sin nombre en
    `identity.users` salía como «sin nombre declarado», que en la pantalla quiere decir «escrito fuera de la Suite»: ahora
    `null` es SÓLO la escritura que no dijo quién, y un usuario sin nombre dice «sin nombre registrado».
    `test-newdb-pq3-17` **15 ✓** y su mutante en rojo.
- **Deuda con nombre** (de la misma revisión; de borde, y sin código que no se pueda probar de forma determinista):
  - `[PQ.3.17.d1]` «Último cambio» sale de la regla y «Cambios» del log: una escritura a mano (SQL fuera de la API, que
    no mueve `updated_by`/`updated_at`) los puede desalinear. Con historial medido, «Último cambio» podría salir del log.
  - `[PQ.3.17.d2]` Lo cambiado antes del disparador no está en el log. Hoy son 2 reglas en prod: cuando se vuelvan a
    cambiar, el aviso «de antes del historial» se va y la lista no dice que le faltan los cambios de antes.
  - `[PQ.3.18.c1]` Concurrencia en «Sacar del ciclo a los N»: si otra gerencia define la regla de un ocasional entre la
    lectura y la escritura, se reemplaza en vez de omitirse. Pide dos gerencias en el mismo segundo sobre el escalón 3.
  - `[PQ.3.18.c2]` Si la actividad de 12 meses (día fijo) no se pudo medir y la compra sí, un proveedor de pocas compras
    con día fijo cae al escalón 3. El diálogo lo nombra antes de guardar.
  - `[PQ.3.18.c3]` La fecha del diálogo sale de la carga de la pantalla: abierta pasada la medianoche promete un día
    antes; el aviso final dice la fecha real del servidor.
- **Falta:** el merge (va en el mismo PR que (c)), la migración `20261124231747` antes de soltar y verlo en prod.
