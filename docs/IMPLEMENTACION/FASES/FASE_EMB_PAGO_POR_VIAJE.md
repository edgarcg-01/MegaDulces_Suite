# Fase EMB — Pago por viaje cerrado (comisiones, viáticos y maniobras)

> Continúa la Fase EMB (EMB.0–EMB.23, en [`01_TRACKER_PROGRESO.md`](../01_TRACKER_PROGRESO.md)).
> Decisión: **ADR-091**. Sprints **EMB.24–EMB.31**. Planeado el 2026-10-09. **EMB.24/26/27/28/29 🧪 en código y probados en
> local el 2026-10-12** (sin migraciones en prod, sin push). Pendientes: EMB.30 (avisos) y EMB.31 (padrón).

## 1. El pedido

Logística quiere **soltar el dinero de comisiones y viáticos sólo cuando el viaje se cerró y
cuadró**: lo cargado se entregó en las paradas registradas. El cierre de cada parada se toma de
los documentos de Kepler (salida, entrada) siempre que existan. El pago debe seguir el flujo de
**Gastos** que ya está en producción, no un módulo nuevo.

## 2. Cómo se paga hoy (medido en prod, solo lectura, 2026-10-09, últimos 90 días)

Logística ya paga comisión y viáticos **como gasto en Kepler** (solicitud `X-A-15` → gasto
`X-A-10`), con conceptos propios:

| Concepto Kepler | Cuenta | Gastos | Importe | Con vale en la Suite |
|---|---|---|---|---|
| `075` Comisiones logísticas TLMKT | 602-015 | 71 | $107k | 2 |
| `128` Viáticos entrega clientes | 602-015 | 88 | $84k | 3 |
| `189` Hotel viaje logística | 602-015 | 22 | $12k | 2 |
| `123` Casetas entrega mercancía | 602-004 | 66 | $124k | 18 |
| `186` Maniobras clientes | 602-006 | 1 | $2k | 0 |

- **Ritmo:** en CEDIS, **un gasto por persona cada 14 días, en viernes** (17-jul, 31-jul, 14-ago,
  28-ago, 11-sep, 25-sep), con renglones de comisión y de viático. Coincide con el calendario
  catorcenal que ya siembra `logistics_baseline.js` (jueves→miércoles, pago viernes/sábado).
  Además hay lotes semanales («… TLMK MA SEM 37») y algunos por día.
- **Quién:** ~12 personas cobran con regularidad; **5** casan con choferes del padrón
  `logistics.drivers`; **7 no están en el padrón**. Hay pagos a parejas: los dos que viajan
  cobran viático.
- **Cuánto (pagos por persona, 90 d):** comisión $65.5k · viático $34.4k (34%). Lo más repetido:
  **$80 por comida por persona** y ~$500 de hotel por noche.
- **Apoyos fijos sin viaje:** $1,000/semana a una persona y $1,000/mes a un supervisor de ruta.
  No son viáticos de viaje (para el SAT, un monto fijo sin comprobante es ingreso del
  trabajador). Quedan **fuera** de esta fase.
- **Sin respaldo:** 154 de 159 gastos `075`/`128` no tienen vale en la Suite, y ninguno dice qué
  viajes paga. Las personas y los viajes sólo aparecen en el texto libre (`kdm1.c24-c26`).
- ⚠️ **No medido:** el contenido de los PDF adjuntos a los vales «COMISION» de CEDIS del 8 y 9 de
  octubre (probablemente la hoja de liquidación). El almacenamiento de prod no fue alcanzable
  desde la máquina de trabajo. Leerlos antes de EMB.29 para conocer el cálculo actual.

## 3. Qué documento de Kepler cierra cada parada (medido 2026-10-09, embarques de 45 días)

La parada es el embarque `U-D-41`; el viaje es la guía `c86` (ver [`ERP_KEPLER.md` §3.y](../../ERP_KEPLER.md)).

| Tipo (serie / `c10`) | Documento de cierre | Medición |
|---|---|---|
| **Traspaso** (serie 2, `TI###`) | Recepción `U-A-50` en la sucursal destino: `c37=41`, `c38=serie`, `c39=folio del embarque`, `c10` = código `TI` del origen | **927 de 981 (94%)** con recepción; casi todas al mismo importe (±$1). Mediana 0–2 días; p90 ≤ 9 días |
| **Cliente** (serie 1, Telemarketing) | **Ninguno a tiempo.** La factura `U-D-8` sale **15–25 min después** del embarque (antes de salir). El cobro (`kdm5` tipo 5/7) llega **7–21 días después** y sólo en ~50% | Kepler no confirma entregas a clientes |
| **Carga a ruta** (serie 2, `RUTA nn` / `RD 5xx`) | El propio embarque: lo recibe el vendedor de ruta al cargar | No es reparto |

⛔ **Trampa que ya cobró en esta medición: `TI###` NO es el número de sucursal.** La
equivalencia vive en `kepler_ods.pv_suc_ip` (`c1` sucursal → `c7` código TI): `TI000`=00,
`TI001`=01, `TI008`=02, `TI002`=03, `TI003`=04, `TI007`=05, `TI006`=06, `TI009`=07, `TI004`=08.
Cruzando por el número la cobertura salía **5%**; con la tabla, **94%**. El candado de EMB.24 debe
traer esta prueba negativa.

Devoluciones y notas de crédito sobre las facturas de esos embarques (`kdm5` tipo 21/25): 10 en
45 días. Raras, pero son la señal de que una entrega de cliente no fue completa.

## 4. Decisiones (usuario, 2026-10-09)

1. **Faltante en un traspaso → se retiene sólo esa parada.** Interpretación a confirmar: la
   comisión es por viaje (la mayor tarifa de sus rutas, EMB.13), no por parada; el viaje se paga y
   la parada con faltante queda **retenida como diferencia** para su propio aviso.
2. **Cargas a camión de ruta → sí se paga a quienes cargan** (maniobra de carga, `$30` por
   cargador, `config_finance.tarifa_maniobra_carga`).
3. **Tarifa de comida: $100** (no los $80 que se pagan hoy).
4. **Pedido de cliente: lo cierra la REMISIÓN FIRMADA que sube Logística al regreso** (opción A,
   2026-10-12). Se descartó la pantalla del chofer: el vale de entrada ya cubre los traspasos y para
   clientes la remisión es la única prueba firmada por el cliente. Una devolución posterior genera
   aviso (EMB.30), no retiene.
   ⚠️ **Enmienda 2026-10-12: la FOTO de la remisión se quitó «por el momento».** La parada de cliente
   se cierra con el resultado que registra Logística (entregado con quién recibió, o no entregado con
   motivo). El servidor acepta la foto si llega (se valida y se guarda), pero la pantalla ya no la pide.
   **Lo que se pierde:** el cierre de cliente deja de tener prueba firmada por el cliente; libera pago
   con la palabra de quien lo registra. Al volver a exigirla: `erroresDeCierreDeParada` (contrato),
   la condición `proof_photo_url IS NOT NULL` en `v_trip_stop_closure` y el campo de archivo del diálogo.
5. **El pago va por Gastos** (vale por persona y por corte), no por `/logistica/payroll`.
6. **Viáticos a todos los que viajan** (chofer y ayudantes), por la regla de horario de EMB.19.
7. **El cargador cobra cuando Kepler registra el embarque que cargó** (no espera al cierre del viaje:
   cargar no depende de la ruta). Kepler sólo guarda UN responsable de embarque; los cargadores se
   registran en la Suite.

## 5. Diseño

```
Embarque U-D-41 (parada) ──► cierre de parada
   traspaso   → U-A-50 en destino, mismo importe ........ cerrada | faltante | pendiente
   cliente    → entrega del chofer en la Suite ......... cerrada | no_entregada (motivo) | pendiente
   carga ruta → al embarcarse ........................... cerrada
Guía (viaje) ──► cerrada cuando NINGUNA parada está pendiente
   → libera, por persona: comisión (075) · viáticos (128) · maniobra de carga (186)
Corte de 14 días ──► un vale de Gastos por persona = sólo viajes liberados
   → firma de quien autoriza (nadie aprueba lo propio) → X-A-10 en Kepler → expediente
```

- **Quien confirma no es quien cobra.** En traspasos el cierre lo da la sucursal que recibe.
- **Una guía-persona-concepto sólo se paga una vez** (llave única en la liga pago↔viaje).
- **Lo no cerrado no se pierde:** pasa al siguiente corte con su motivo por parada.
- **Lo que no se puede medir se declara** (ADR-056): una parada sin documento es `pendiente`,
  nunca `cerrada` por omisión.
- **La Suite no escribe en Kepler** (ADR-086): la solicitud `X-A-15` la sigue capturando
  Logística y se casa por folio, como el resto de Gastos.

## 6. Sprints

| Sprint | Qué | Estado |
|---|---|---|
| **EMB.24** | Vista `analytics.erp_shipment_stop_closure` (traspaso↔`U-A-50` con `pv_suc_ip`, carga a ruta, cliente) + índice parcial `ix_kdm1_recepcion_traspaso` (CONCURRENTLY) + `logistics.v_trip_stop_closure` | 🧪 local. 0.3 ms por parada con el índice. Candado: 40 recepciones contra kdm1 crudo; traducir `TI###` por número da 25 contra 184 (prueba negativa) |
| ~~EMB.25~~ | ~~Entrega por parada en el celular del chofer~~ | ❌ descartado por decisión: la remisión la sube Logística (EMB.24) |
| **EMB.26** | `logistics.v_trip_state` + `v_trip_pay_items` + pestaña **Cierre y pago** del embarque (paradas, cargadores, lo que se libera por persona) + `POST /logistics/trip-closure/paradas/:id/cierre` (foto de remisión opcional, en el bucket privado) | 🧪 local, recorrido en navegador |
| **EMB.27** | Cargadores: `PUT /logistics/trip-closure/shipments/:id/cargadores` (tarifa `tarifa_maniobra_carga`, sin tarifa no se registra; si ya se pagó no se cambia) | 🧪 local |
| **EMB.28** | Tarifas de viáticos (café 50 · desayuno 100 · comida 100 · cena 100) | ✅ capturadas en prod el 2026-10-12 (café $25 · desayuno, comida y cena $100; carga $30) |
| **EMB.28.1** | **Tarifas fijas.** Capturar una tarifa en $0 es de quien configura; cambiar, borrar, renombrar o desactivar una ya fijada (comisión por ruta, viático, maniobra) exige `LOGISTICS_TARIFAS_AUTORIZAR` (repartido a `direccion`; `superadmin` por rol). Historia en `logistics.tariff_changes` (sin UPDATE/DELETE). Mig `20261012154157`. Arregla de paso que editar un monto **no guardaba lo tecleado** (`aNumero`: Postgres manda `numeric` como texto) | 🧪 local: 8 casos de punta a punta (403 a quien configura sobre una fijada, 200 al autorizador, historia con usuario) |
| **EMB.32** | **Alta rápida de ayudante y cargador** donde se necesita: «+ Nuevo ayudante» al pie de las listas de la guía y «+ Nuevo cargador» en «Cierre y pago». Sólo nombre completo; `POST /logistics/fleet/drivers/alta-rapida` abierto también a `LOGISTICS_GUIDES_GESTIONAR` (el repartidor completa guías y no tiene el permiso de flota). **Nunca duplica**: mismo nombre (sin acentos, mayúsculas ni espacios) → usa a esa persona y le agrega el papel; dada de baja → la reactiva. Medido en prod 2026-10-13: 0 ayudantes y 0 cargadores activos | 🧪 local: alta, «ya existía», papel agregado, reactivada, nombre incompleto → 400; recorrido en navegador |
| **EMB.33** | **Rutas sin comisión** (traslados locales): `logistics.routes.sin_comision`. La guía se completa con comisión $0 (sólo viáticos y cargadores) en vez de quedarse con «Falta la tarifa de …». Mig `20261013120220` marca SANTA ANA PACUECO (R0024, 811 viajes/90 d), SANTA ANA (R25, 36) y LA PIEDAD (323) si siguen en $0, y lo deja en `tariff_changes`. Un viaje local + una ruta con tarifa paga la tarifa; local + ruta sin tarifa sigue frenando. La marca cuenta como tarifa fijada (EMB.28.1). **Por qué no se derivaron montos del historial:** en la catorcena 11–24 sep el chofer de CEDIS con 93 viajes cobró $954 (~$10/viaje) y los 5 choferes que sólo van a Santa Ana Pacueco no cobran comisión — en CEDIS la comisión es por persona, no por viaje ni ruta; la única tarifa con evidencia es Canindo→Zamora ($180/$120) | 🧪 local: viaje real de Santa Ana Pacueco tomado y guía completada en $0 (viáticos $200) |
| **EMB.29** | `finance.trip_pay_lines` (índice único parcial = no se paga dos veces) + `/finanzas/comisiones-logistica` (corte catorcenal jue→mié, pago viernes; reproduce los 6 viernes que Kepler ejerció) + vale de Gastos con hoja PDF, sin folio (se casa después) | 🧪 local: vale en 1.5 s; quien lo arma recibe 403 al aprobar; otro usuario lo valida |
| **EMB.30** | Avisos: gasto `075`/`128` en Kepler sin vale · importe Kepler ≠ suma · viaje abierto > N días · persona en dos viajes · devolución sobre parada pagada | ⬜ |
| **EMB.31** | Padrón: alta de las 7 personas que cobran y ligar `logistics.drivers` ↔ `identity.users` (0 de 56) | ⬜ |

**Para probar en local:** aplicar las 2 migraciones a `platform_local`, levantar API y vista, y correr
`node database/scripts/dev-seed-emb-pago.js --api http://127.0.0.1:<puerto>`: toma 5 guías reales de la
copia local (traspasos recibidos, clientes entregados, viaje abierto, faltante), registra cargadores de
PRUEBA y crea el usuario `aprobador_prueba` (rol tesorería). Prueba de base:
`node database/tests/test-newdb-emb-pago-por-viaje.js` (24 aserciones, 3 negativas, mutación verificada).

**Pruebas unitarias (2026-10-12):** `trip-closure.spec.ts` (16: cierre sin/con foto, carrera → 409 que
borra la foto, traspaso no se cierra a mano, cargadores, permisos de las 3 rutas) · `trip-pay.spec.ts`
(11: el vale lleva SÓLO lo liberado y sin pagar, a nombre de quien lo prepara; 23505 → 409 sin hoja
huérfana; permisos) · montaje de `cierre-viaje` (4), de la página de comisiones (5) y de las pestañas del
embarque (2). Las dos reglas de dinero se rompieron a propósito y las pruebas se pusieron en rojo.

**Revisión del 2026-10-12 (pantalla del embarque):** «Cierre y pago» pasa a ser la primera pestaña y la que
abre; se quitaron la pestaña Costos (se captura en Logística › Costos), la pestaña Carta Porte (el backend
queda; no hay otra pantalla que timbre) y el panel «Preparación del viaje».

**Hallazgos de la construcción:**
- ⛔ Mi prueba negativa de «sin foto no se cierra» pasaba **con la regla rota**: miraba el estado del
  VIAJE, que seguía abierto por otra parada. Se corrigió para mirar la PARADA y se verificó en rojo
  rompiendo la vista a propósito.
- Retractado: «los traspasos del CEDIS no tienen ruta» era un artefacto de la copia local; en prod el
  100% de las paradas de 30 días tienen ruta.
- `logistics.*.created_by/updated_by` son `uuid` (el id del usuario), no el nombre.
- La hoja «Paradas» de Kepler (EMB.12) sigue mostrando «Pendiente» en los traspasos aunque la recepción
  ya los cerró: lee el estado del destinatario, no el cierre. Pendiente alinearla con `v_trip_stop_closure`.

## 7. Fuera de alcance y pendientes

- **Apoyos fijos** ($1,000 por semana o por mes): sin decisión; no dependen de un viaje.
- **Tratamiento fiscal:** pagar comisiones y viáticos fijos sin comprobante como gasto (602-015)
  en vez de nómina puede ser ingreso gravado del trabajador. Confirmar con Contabilidad; si cambia,
  sólo cambia el destino del corte.
- **`/logistica/payroll`** (`logistics.liquidations`) no se enciende: EMB.20 y EMB.23 quedan
  resueltos por esta decisión cuando EMB.29 esté en uso.
- **Descarga de regreso ($1/caja) y maniobra LAB** (EMB.18): no se decidieron aquí.

---

## 8. EMB.56 — La guía de reparto: la hoja de ruta del chofer ⬜ (requisito, 2026-11-09)

**Pedido del PM (2026-11-09):** la guía de reparto que imprime Kepler trae por parada el folio del
**pedido** (`U-D-40`) y el del **embarque** (`U-D-41`); hay que agregar el de la **factura TLMK**
(`U-D-8`).

**Quién la usa (PM, 2026-11-09):** **la imprime y la lleva el chofer: es su hoja de ruta.** **El
chofer no cobra**: sólo el vendedor puede cobrar. La guía es para entregar, no para cobrar.

**Dónde vive: Logística** (PM, 2026-11-09: *«el chofer interactúa al 100 % con Logística»*). Se
consideró Telemarketing (`/telemarketing/documentos`, que ya liga factura ↔ embarque, `[AX.17]`) y
se descartó: el chofer no es usuario de ese módulo. Es otra vista sobre los **mismos datos** que ya
usa «Viajes del ERP» (`/logistica/shipments`, `ErpShipmentsService`,
`analytics.erp_shipment_headers`), sin una segunda consulta ni copia. La lista de viajes de
Logística **no se toca**: la usa `coordinador_embarques` (13 de 30 días, medido en
`analytics.ui_usage` el 2026-11-09) y cubre los tres tipos de viaje.

**Medido contra prod** (sólo lectura, `system_identifier 7688376744939610156`) sobre la guía impresa
de Kepler `0000969` (Padre Hidalgo, 23-jul-2026, unidad `008`, 12 paradas, todas serie 1):

1. **La columna «Pedido / Embarque» del papel trae casi siempre sólo el pedido.** El embarque aparece
   en 1 de 12 renglones (`0000689 / 0000670`), el único con hora de captura (`c69`) antes de la hora
   de impresión. **INFERIDO:** Kepler imprime la guía antes de capturar los embarques.
2. **El importe impreso es el de la FACTURA, no el del embarque:** coincide al centavo con la factura
   en 9 de 12 (los embarques difieren de centavos a $2). Kepler ya consulta la factura al imprimir,
   pero no imprime su folio.
3. **Un embarque puede tener varias facturas.** El embarque `0000694` tiene tres: dos canceladas en
   $0 (`c43='C'`) y una vigente que factura **$188.84 más** que lo embarcado.
4. **Chofer vacío en las 12 paradas** (`c84`), igual que el «Repartidor» en blanco del papel.
5. Las horas `c69` **no ordenan** pedido → embarque → factura (hay facturas con hora anterior a la de
   su embarque). No sirven para saber si la factura existía al imprimir. **NO MEDIDO.**

**Liga factura → embarque:** `U-D-8` con `c37=41` + **serie** `c38` + folio `c39`, misma sucursal
(`c1`). ⚠️ `analytics.erp_shipment_billing` liga sólo por sucursal + folio (sin serie) y **no descarta
canceladas**: para la guía hay que filtrar `c43<>'C'` y ligar con serie, o corregir la vista. Más de
una factura vigente: se listan todas. Sin factura todavía: «sin factura»; `c43='N'`: «no se factura».
Sólo la entrega a cliente (serie 1) tiene factura; el traspaso y la carga a ruta no (ERP_KEPLER §3.y).

**Las cinco preguntas de `diseno` §0b** (2026-11-09):

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | Qué ve y en qué orden | Encabezado: fecha, unidad, **chofer**, número de paradas y total de bultos. Después, una parada por bloque **en el orden de visita**: número de parada, cliente y **domicilio de entrega** (calle, población, teléfono; `c85` → `kdudent`), qué entrega (cajas y paquetes), la instrucción para él si la hay, y los folios de **factura** (la que entrega, la más visible), embarque y pedido. Al pie del bloque, espacio para la firma de recibido |
| 2 | Qué no ve | **Nada de dinero**: ni la columna «Cobranza» (en Kepler vale $0.00 en las 12 paradas de la `0000969`, y el chofer no cobra), ni Descuento (0 en las 12, una con «-0.00»), ni importes ni total de la guía. La diferencia facturado ≠ embarcado (el `0000694`, $188.84) es para Facturación TM, no para el chofer. Tampoco la clave interna del cliente como dato principal, ni la nota `CJ/PQ/UB` como texto: los bultos se calculan (suma por unidad de `[AX.13]`) y la ubicación de espera es de quien carga (`[GP.4b]`) |
| 3 | Accesibilidad | Se lee en papel, en blanco y negro y dentro del camión: domicilio y bultos en letra grande; cada parada numerada y separada; la factura identificable por su folio para entregarla |
| 4 | Ligas | Pedido `U-D-40` → embarque `U-D-41` → factura(s) `U-D-8`, los tres folios en el bloque. El cobro (`U-A-7`) es del vendedor, con la Guía de Cobranza (`[GT]`): no se mezcla aquí. El viaje es el mismo que Logística toma para la comisión (`[EMB.12]`) |
| 5 | ¿Le toca a esta pantalla? | Logística, en una vista propia y chica para el chofer: **los viajes de hoy en su sucursal → escoge el suyo → imprime**. No la lista de «Viajes del ERP», que es del coordinador y trae costo y comisión |

**Lo que la interfaz no puede resolver (va primero):**

1. ⛔ **El chofer no tiene usuario en la Suite.** En la matriz de accesos (generada el 2026-11-04) el
   puesto «Chofer» no tiene rol propuesto ni personas con acceso. ✅ **Decidido (PM, 2026-11-09):** rol
   `chofer` con **un solo permiso** de Logística: ver e imprimir las guías de reparto de su sucursal.
   El item no se entrega hasta que el rol esté **repartido** en prod a los choferes reales (regla 20):
   darles usuario es un acto de la sucursal / RH, no de código.
2. **Kepler no sabe qué viaje es de qué chofer:** el chofer (`c84`) viene vacío en las 12 paradas de la
   `0000969`, y la unidad `00008` lo trae en el 0.2 % de sus embarques. La unidad (`c83`) sí viene. El
   chofer escoge su viaje por unidad, y **al imprimir queda registrado quién lo imprimió**: ese es el
   chofer que hoy falta. Guardarlo es dato propio de la Suite (tabla real, como las guías de cobranza
   archivadas de `[GT.12]`).
3. ✅ **El orden de visita SÍ está en Kepler** (medido 2026-11-09, sólo lectura). El `| n` del papel es
   **`kdm_rutas2.c4`**, ligado por embarque → domicilio de entrega (`c85`, vacío = `1`) → `kdudent.c13`
   (ruta) → `kdm_rutas2` (sucursal, ruta `c1`, cliente `c2`, domicilio `c3`). En la guía `0000969`
   casa en las **9 de 9** paradas distintas (3, 4, 5, 6, 7, 9, 11, 12, 13), aunque cruzan tres rutas
   (`R0005`, `R0006`, `R0036`): la numeración es una sola secuencia. **Cobertura**, embarques de
   Telemarketing (serie 1) de los últimos 30 días: **1,198 de 1,246 (96.1 %)** con orden (Padre
   Hidalgo 470/477, Canindo 405/414, Morelia Abastos 323/355), 0 con orden duplicado. Las 48 sin orden
   van **al final, rotuladas «sin orden en Kepler»**, nunca intercaladas a ciegas. ⚠️ Es un solo
   papel de control: la liga se probó contra una guía impresa, no contra varias.
4. ⛔ **El domicilio del embarque NO es el de entrega.** `kdm1.c33`/`c34` del embarque traen el
   domicilio **fiscal**: las 5 paradas de un mismo cliente dicen su domicilio fiscal en Zamora, y el
   papel las manda a tres pueblos distintos. El domicilio de entrega sale de
   **`kdudent`** por `c85` (calle `c3`, ciudad `c5`, teléfono `c6`), que es lo que imprime Kepler.
   Leer `c33`/`c34` mandaría al chofer a Zamora.

**Orden de construcción (capas de `METODO_DE_TRABAJO.md`):**

| Capa | Qué | Estado |
|---|---|---|
| C0 dato | Parada de entrega con orden de visita, domicilio de `kdudent` y carga: **ya existía** (`analytics.erp_shipment_stops` + `erp_shipment_stop_load`, EMB.12). Facturas: `analytics.erp_sales_invoices` por `doc_origen` (la liga de `[AX.17]`), sin canceladas. Sin migración de esquema | ✅ 2026-11-09 |
| C1 dominio | `guia-reparto.logic.ts`: parada = cliente + domicilio; orden por `kdm_rutas2.c4` (sin orden al final); factura `facturado` / `sin_factura` / `no_se_factura` / `no_aplica`; instrucción = nota sin el conteo. **Cajas** de los renglones; **paquetes** de la nota (`PQ n`: los arma el checador, no se calculan, FASE_GP §2.5). Ningún importe | 🧪 2026-11-09 |
| C2 API | `GET /logistics/guia-reparto/viajes` y `GET /logistics/guia-reparto/:sucursal/:guia`, clave `LOGISTICS_GUIA_REPARTO_VER`, recortados a la sucursal (fuera de alcance = 404). Rol `chofer` por migración `20261109110110` (⛔ sin aplicar en prod). Sin endpoints que escriban todavía | 🧪 2026-11-09 |
| C1+C2 registro de impresión | Quién imprimió qué guía (el chofer que Kepler no trae): tabla propia + `POST`. Pide prueba contra base real (regla 13) | ⬜ |
| C3 UI | `/logistica/guia-reparto` (en el menú de Logística › Operación y como aterrizaje del rol `chofer`) + la hoja en PDF (`guia-reparto-pdf.ts`, sobre `compras-pdf-comun` y `abrir-pdf`). §8.1 | 🧪 2026-11-09 |
| Entrega | Migración aplicada en prod + rol repartido a los choferes reales (regla 20) | ⬜ espera usuarios |

**Medido contra prod el 2026-11-09** (sólo lectura, el código real del servicio con una conexión
`dev_ro`, guía `01-G0000969`): las 9 paradas salen en el orden del papel (3 → 13), con el
domicilio de entrega, los folios pedido > embarque > factura de los 12 embarques (el `0000694`
sólo con su factura vigente, `0000400`), y **cajas y paquetes iguales al papel** parada por parada
(CJ 4, 28, 8, 7, 10; PQ 1, 9, 2, 1, 1, 1, 3, 8, 1).

**Latencia, antes → después** (el mismo código, mismas filas):

| Consulta | Antes | Después | Por qué |
|---|---:|---:|---|
| Guía de un viaje | 4,907 ms | 143–202 ms | la carga se pide por llave constante (sucursal + serie + folios), no por LATERAL: el agregado de `erp_shipment_stop_load` no recibía el filtro (1,880–2,283 ms → 6–13 ms) |
| Viajes del día (una sucursal) | 3,626 ms | 84–94 ms | sale de cabeceras y paradas filtradas por fecha; `erp_shipment_trips` agrega todas las guías antes de filtrar (4,117–4,787 ms) |
| Viajes del día (todas) | — | 168–174 ms | |
| «Nuevo embarque» (`[EMB.12]`, comparte la carga) | 4,172 ms | 108–136 ms | mismo arreglo; mismas cifras (57 cajas, 12 paradas) |

### 8.1 C3 — la pantalla `/logistica/guia-reparto`: los 12 pasos de `diseno` §0a (2026-11-09)

| # | Paso | Respuesta |
|---|---|---|
| 1 | Propósito | El chofer **imprime la hoja de ruta de su viaje**. La frase: *«¿Qué hoja me llevo hoy?»* (sin «y») |
| 2 | Quién entra | Rol `chofer` (0 cuentas hoy: hay que darlas) y quien ya ve embarques (`coordinador_embarques`, 13 de 30 días en `/logistica/shipments`) para reimprimirle |
| 3 | Estado real | La guía la imprime Kepler, con el embarque en 1 de 12 renglones y el chofer vacío; un día normal tiene ~12 viajes en Padre Hidalgo y 28 en todas las sucursales (07-nov) |
| 4 | Nivel 0 | Titular («Hoy, 12 viajes en Sucursal Hidalgo»), la fecha (hoy por default, para reimprimir otro día) y la lista de viajes **del más reciente al más viejo**: viaje, unidad y placas, paradas, a dónde va, y **un** botón por fila: «Imprimir guía» |
| 5 | Qué no ve | Importes, comisión, GPS, responsables de almacén y el chofer de Kepler (viene vacío): nada de eso le sirve para escoger ni para entregar |
| 6 | Desglose | Viaje → el PDF (nivel 2: paradas en orden, domicilio, bultos, instrucción, folios factura > embarque > pedido, firma). No hay más cifras en pantalla que viajes y paradas |
| 7 | Accesibilidad | Se reconoce por **unidad y placas** (lo que el chofer sabe) y por los pueblos; la sucursal por nombre; el botón tiene el viaje en su `aria-label`; teclado: Tab llega a cada botón. Sin buscador: ~12–28 filas al día |
| 8 | Ligas | El papel lleva pedido `U-D-40` > embarque `U-D-41` > factura `U-D-8`; el viaje es el mismo que «Viajes del ERP» de Embarques |
| 9 | ¿Le toca? | Sí: Logística, donde trabaja el chofer. Costo y comisión se quedan en Embarques / Pagos de viaje |
| 10 | Maqueta | ver abajo |
| 11 | Aceptación | Estados separados (cargando / vacío / error); la edad del dato a la vista; un clic imprime; el doble clic no abre dos pestañas; la hoja dice lo mismo que el endpoint (spec del PDF); sin importes en pantalla ni en papel |
| 12 | Lo que no resuelve | Darles cuenta a los choferes (regla 20) · registrar quién imprimió (C1+C2 pendiente) · los paquetes son los que escribió almacén, no un cálculo |

```
Guía de reparto
Imprime la hoja de ruta de tu viaje: paradas en orden, domicilio, bultos y folios. Sin importes.

[ 23/07/2026 ▾ ]                                         (datos de hace 1 min)
Hoy, 12 viajes en Sucursal Hidalgo · 61 paradas
┌──────────────┬──────────────────────────────┬─────────┬────────────────────────────┬──────────────────┐
│ Viaje        │ Unidad                       │ Paradas │ A dónde va                 │                  │
│ 01-G0000969  │ FORD 450 GASOLINA · 774H6V   │      12 │ Penjamillo · Zinapáro · …  │ [Imprimir guía]  │
└──────────────┴──────────────────────────────┴─────────┴────────────────────────────┴──────────────────┘
```

**Construida (2026-11-09).** Lo que el papel real enseñó (PDF armado con la guía 0000969 de prod y
mirado página por página):
- **Los kilos salen del papel.** «4 cajas · 60 kg»: lo que se vende por kilo va en bulto y el bulto
  ya cuenta como caja; el chofer buscaría 60 kg de más. La API los sigue dando.
- **Embarque y pedido van en un renglón con su folio corto** (`Emb. 0000684 · Ped. 0000707`), la
  factura completa arriba: con tres renglones por embarque, 9 paradas pedían una segunda hoja.
- **La nota que repite el pueblo del domicilio no se imprime** («ZINAPARO» en Zinapáro).
- **Las notas al pie con margen propio:** el helper compartido reserva 90 pt para las firmas de
  Compras y mandaba una nota sola a otra hoja. Resultado: la guía 0000969 cabe en UNA hoja.

**Segunda vuelta de las cinco preguntas, con la pantalla hecha:** (1) entra y ve el titular, los
viajes del día del más reciente al más viejo y un botón por fila; (2) no hay un solo importe ni en
pantalla ni en papel (candado en la spec); (3) el viaje se reconoce por unidad, placas y pueblos, la
sucursal por nombre, el botón lleva el viaje en su `aria-label`; (4) el papel lleva factura > embarque
> pedido; (5) vive en Logística, la lista de Embarques no se tocó.

Pruebas: vitest de la pantalla y el PDF 14/14 (el PDF se dibuja con jsPDF real y se lee: orden,
folios, una hoja, sin `$` ni centavos); `check:pantalla -- logistica-guia-reparto`: cumple las 10
reglas, tipa; `check:templates` · `estilos` · `tokens` · `teclado` · `motion` · `templates-types` en
verde. ⚠️ En `apps/view` fallan dos specs que no son de esto: `landing-guards` (Alta de clientes,
`COMMERCIAL_ALTA_CLIENTES_KEPLER`) y `container-queries` (201 pantallas con `@media`). **Sin
validación visual de la pantalla** (no se levanta en local); el PDF sí se miró.

**Auditoría como la usaría un chofer (2026-11-09, `auditoria-diseno`).** Evidencia: captura del PM
(superadmin, 19 viajes) para contar; código (nivel C); prod en sólo lectura (nivel B). Sin sesión
de chofer ni navegador: lo visual fino queda NO MEDIDO.

| # | Sev | Hallazgo | Arreglo |
|---|---|---|---|
| 1 | 🔴 | **«Paradas» contaba embarques**: la guía 0000969 decía 12 en la lista y 9 en la hoja (Cruce 2, el rótulo no dice lo que la celda muestra) | Paradas = cliente + domicilio, como la hoja. Medido en prod: lista 9 = hoja 9 |
| 2 | 🟠 | **19 botones primarios naranjas** a la vez: ninguno destaca (Von Restorff: una primaria por pantalla) | Con varios viajes, botones secundarios; con uno (el chofer), primario |
| 3 | 🟠 | **El conteo se repetía**: «19 viajes» en el titular y en la tira | El titular de quien coordina ya no cuenta; el chofer no ve tira (el titular le basta) |
| 4 | 🟠 | **El viaje se nombraba con código de sucursal** («00-G0001474», «01-G0000969») en pantalla y en la hoja | «Guía 0001474» y la sucursal por nombre debajo; la hoja dice «Guía 0000969 · Sucursal Hidalgo» |
| 5 | 🟠 | Botón chico (~32 px) para un chofer que entra del teléfono (Fitts: 44 px en `coarse`) | `min-height: 2.75rem` con `pointer: coarse` |
| 6 | 🟠 | **No se sabe si la guía ya se imprimió** (retrabajo: reimprime sin saber) | Pendiente: el registro de quién imprimió (C1+C2) |

**NO MEDIDO:** contraste de los botones en oscuro y en `forced-colors`; el recorrido con teclado y con
lector de pantalla; la pantalla en un teléfono real; **dónde imprime el chofer** (si entra del
teléfono, imprimir desde ahí no es realista: se pregunta al PM). Veredicto por capa: veracidad ✓
después del arreglo 1; sencillez y comprensión con deuda (6); accesibilidad sin medir.

**Cómo agrupa Kepler (medido 2026-11-09, 30 días, sólo lectura, sucursales CEDIS · Padre Hidalgo ·
Canindo · Morelia Abastos):** la guía (`c86`) la arma almacén al dar la salida por embarque, y Kepler
imprime **una hoja por guía**. Una guía nunca mezcla camiones (0 de 889) y casi nunca días (3 de 889):
**la guía de Kepler es la misma unidad que la lista de la Suite**. Lo que Kepler NO junta es el día del
camión: de 467 camión-día, **148 llevan 2 o más guías** (hasta 18) y **42 llevan guías de dos sucursales**
(CEDIS + la sucursal, desde el corte del 1-oct). Caso: la Ford 450 `774H6V` el 9-nov lleva la guía de CEDIS
`0001470` (traspaso, 7 embarques), la `0001979` de Padre Hidalgo (1 cliente de Telemarketing) y la
`0001980` (traspaso, 3 embarques): el chofer tendría que imprimir **tres hojas** para una salida.
~~Propuesta: agrupar por camión y día.~~ **Descartada con un testigo independiente (GPS, 2026-11-09):**
en los camiones con rastreador, el día que Kepler les pone una guía **el camión no se movió (< 20 km,
con el GPS encendido) en 6 de 19 días con clientes y 20 de 65 con traspasos** — ~1 de cada 3. Casos:
un camión con 6 guías recorrió 1 km; otro con 3, 0 km. O sea que **el par (transporte `c83`, fecha `c9`)
de Kepler no es una salida**: otro vehículo lo llevó, o salió otro día (6 de los 20 traspasos salieron
al día siguiente). Y la `774H6V` (sin GPS) aparece en un mismo día con guías a León y a Morelia, rumbos
opuestos. ⚠️ Muestra chica (19 días con clientes), casi toda de tráilers y camiones de ruta.

**Consecuencias:**
1. **La unidad de la hoja es la GUÍA**, como Kepler: es lo único que Kepler garantiza (un camión, un
   día, armada a propósito por almacén). No se funden guías en una sola lista de paradas.
2. El chofer no debe imprimir N hojas una por una: **«Imprimir todas» = un PDF con una guía por hoja**
   (cada una con su encabezado y su firma), además de imprimir una sola.
3. ⚠️ **Corrige la decisión anterior de filtrar por unidad:** si la unidad de Kepler no dice qué camión
   salió en ~1 de cada 3 días, el chofer asignado a la unidad recibiría viajes que no manejó. La fuente
   buena es el **chofer capturado en el embarque** (`c84`), que Canindo ya llena (41 de 44); la unidad
   queda como respaldo y se marca «asignado por la unidad». Lo que se pide a almacén de Padre Hidalgo
   y Morelia Abastos es **capturar el chofer en cada salida por embarque**, no asignarlo a la unidad.

✅ **Aprobado por el PM y construido (2026-11-09):**
- `asignacionDelChofer` dice POR QUÉ el viaje es suyo (`embarque` | `unidad`); la fila lo trae en
  `asignado_por`, y con `unidad` la pantalla avisa: «Te sale por tu camión: almacén no te capturó como
  chofer en este embarque». El vacío ya no menciona la unidad: pide que almacén lo capture en el embarque.
- **«Imprimir todas (N)»** para el chofer con varias guías: un PDF, una guía por hoja (`pdfGuiasReparto`),
  cada una con su encabezado y su firma. Fallo parcial: se arman las que se leyeron y se dice cuál faltó.
  Es la única primaria; los botones por guía quedan secundarios.
- Contra prod (sólo lectura): Canindo 06-nov, el chofer `00017` ve sus 2 guías, las dos `embarque`.
- Pruebas: 81/81 en `logistics-erp-shipments`, 20/20 en la pantalla y el PDF; prueba negativa: dejar que
  la unidad gane sobre el embarque pone 2 en rojo, y quitar el salto de hoja entre guías pone 1.
  `check:pantalla`, `templates`, `estilos`, `motion`, `templates-types` y `ngc` en verde. Sin validación
  visual de la pantalla.

**Segundo análisis de la hoja (2026-11-09), con guías reales que no son de Telemarketing** (la Ford 450
`774H6V` el 9-nov: traspaso de CEDIS `0001470`, cliente `0001979`, traspaso `0001980`), PDF armado con
el código real y mirado hoja por hoja:

| Sev | Lo que decía | Ahora |
|---|---|---|
| 🔴 | «Sin conteo de bultos» en la `0001979`, que lleva 9 kg sueltos: le decía al chofer que no llevaba nada | «Mercancía suelta · 9 kg» (los kilos sólo cuando no hay cajas que ya los cuenten); «Sin renglones en Kepler» si de verdad no hay |
| 🟠 | En el traspaso, «Traspaso: sin factura» repetido por cada uno de los 7 embarques (14 renglones) | Una línea «Traspaso: no lleva factura» y los folios de embarque y pedido juntos |
| 🟠 | La sucursal con el nombre del catálogo de Kepler («Sucursal Hidalgo», «Cedis Oficinas») y la pantalla con otro («Padre Hidalgo») | El mismo resolvedor de la pantalla (`warehouseName`) |
| 🟡 | «Nota:» para una nota interna de almacén («PASSILO 2 Y3») | «Nota de almacén:»: no hay forma honesta de saber si es para el chofer |
| 🟡 | Notas al pie que no aplicaban (paquetes sin paquetes; «sin orden de visita» con una sola parada) | Sólo las que aplican a esa guía |
| 🟡 | El pie se encimaba con el número de página («p.mPágina») | Pie corto |

⚠️ **Corrección a lo dicho antes en esta conversación:** `TI008` no es Morelia Abastos; Kepler lo nombra
«Traspaso Abastos La Piedad» / «Sucursal Abastos LP». Pruebas: 23/23 de la pantalla y el PDF; compuertas y
`ngc` en verde.

**Clics medidos con Playwright (2026-11-09, Suite local contra prod en sólo lectura, escrituras
bloqueadas y probado el bloqueo).** Imprimir la guía de HOY, quien coordina: 5 clics (entrar ·
Logística · Guía de reparto · Imprimir guía · imprimir). Reimprimir la `0000969` del 23-jul: **11**, seis
de ellos sólo para llegar a la fecha en el calendario, que además salía en inglés («November 2026»).

✅ **Corregido el mismo día (aprobado por el PM):**
- **«Número de guía» + Enter** (`GET /logistics/guia-reparto/buscar`, mismo alcance y filtro por chofer;
  47–113 ms): número único → se imprime directo (medido: la `1979`, 0.4 s, 1 clic + teclear); número
  repetido → se muestran para escoger, nunca uno a ciegas (la `0000969` está en Padre Hidalgo y en
  CEDIS; medido: 2 clics). Reimprimir la 969 pasa de **6 clics de calendario a 1**. `normalizarNumeroDeGuia`
  acepta «969», «0000969» o «G-969» y rechaza lo que no es una guía.
- **PrimeNG en español para toda la app** (`core/i18n/primeng-es.ts` en `providePrimeNG`): medido después,
  «noviembre 2026», días «D L M X J V S», «Mes anterior». Sólo textos; ni `dateFormat` ni el primer día
  de la semana cambian.
- Pruebas: 83/83 `logistics-erp-shipments`, 26/26 pantalla y PDF; compuertas y `ngc` en verde.

⚠️ **Diferencia declarada de la lista:** una guía con embarques de dos días aparece en los dos
(`erp_shipment_trips` la fecha en el primero). Es el día que el chofer busca.

Pruebas: vitest `logistics-erp-shipments` **71/71** (nuevas: lógica con la guía 0000969 y
controlador con permiso y recorte por sucursal). Prueba negativa hecha: quitar el recorte deja
pasar otra sucursal y la prueba se pone roja. Contratos `authz` 79/79. `tsc --noEmit` sin errores en
lo tocado (los 37 TS1272 de `libs/logistics` son de otros controladores y ya estaban). El
constructor del controlador emite `[ErpShipmentsService, ScopeService]` con metadata encendida
(`ts.transpileModule`). **Arranque de la API no verificado** (no se levanta en local).

**⛔ Cada chofer ve SÓLO sus viajes (PM, 2026-11-09).** Medido ese día (TLMK, 30 días, sólo lectura):

| Fuente posible | Padre Hidalgo | Canindo | Morelia Abastos | Sirve |
|---|---|---|---|---|
| Chofer en el embarque (`kdm1.c84`) | 1 de 61 guías | 41 de 44 | 3 de 88 | sólo donde se captura |
| Tripulación capturada en la Suite (`delivery_guides`) | 0 | 0 | 0 | no existe |
| **Ruta** (`kdudent.c13`) | 26 de 61 guías cruzan 2–4 rutas | 22 de 44 | 10 de 11 rutas las atiende más de una unidad | ⛔ no: una ruta no es de un chofer |
| **Unidad** (`kdm1.c83`) | `00008` hace 57 de 61 | `00017` hace 41 de 44 | `00027` 56 y `00028` 21 de 88 | ✅ casi una unidad por chofer |

En Canindo, donde el chofer sí se conoce, chofer ↔ unidad es 1 a 1 (`00017` ↔ `00017`, 41 guías).
Kepler ya tiene esa liga: el **chofer asignado a la unidad** (`kdm_transporte.c4`) se precarga en
cada embarque (`c84`), y la `00008` de Padre Hidalgo no lo tiene; por eso sale vacío. Propuesta:
el viaje es del chofer si `c84` es él, o si `c84` viene vacío y él es el asignado a la unidad
(`erp_shipment_headers.chofer_asignado_a_la_unidad`). Pide: asignar el chofer a cada unidad en
Kepler (una vez por unidad) y ligar `logistics.drivers.user_id` (0 de 26 ligados hoy).

✅ **Decidido por el PM (2026-11-09): por unidad, con el catálogo de Kepler.** 🧪 Construido ese día:
- `esViajeDelChofer` (`guia-reparto.logic.ts`): suyo si `chofer_clave_kepler` es su clave; si el
  embarque viene sin chofer, si es el asignado a la unidad (`kdm_transporte.c4`). Comparación exacta.
- Quien tiene `LOGISTICS_SHIPMENTS_VER` (o administra la plataforma) ve todos los de su alcance;
  cualquier otro, sólo los suyos (`quienPide`). La guía de un viaje ajeno responde 404.
- Sin ficha ligada o sin clave de Kepler, la lista sale vacía **con el motivo** (`filtro.motivo`) y
  la pantalla dice quién lo arregla: la cuenta se liga en Logística › Flotilla («Cuenta del sistema»);
  la clave de Kepler **no se captura en ninguna pantalla** hoy (se reporta a Sistemas).
- Contra prod (sólo lectura, ficha simulada porque no hay cuentas ligadas): Canindo 06-nov, el chofer
  `00017` ve **2 de 8** viajes (sus dos Ford 450) y abre sólo esos; otra clave ve 0. Una cuenta sin
  ficha recibe `sin_ficha_de_chofer`. Pruebas: vitest 80/80 en `logistics-erp-shipments` y 19/19 en la
  pantalla y el PDF; prueba negativa: abrir el filtro a «todos» o dejar que la unidad gane sobre el
  chofer del embarque pone 6 pruebas en rojo.
- ⚠️ Hasta que almacén asigne el chofer a la `00008` (Padre Hidalgo) y a la `00027`/`00028` (Morelia
  Abastos) en Kepler, esos choferes verán su lista vacía, con el motivo.

**Alcance:** arranca con las entregas de Telemarketing (el pedido del PM). Traspasos y carga a ruta
usan la misma hoja sin factura; **no** entran en este item.
