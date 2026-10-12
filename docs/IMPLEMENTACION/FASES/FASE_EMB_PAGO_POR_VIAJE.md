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
| **EMB.28** | Tarifas de viáticos (café 50 · desayuno 100 · comida 100 · cena 100) | ⚠️ se capturan en Logística › Configuración; en prod **siguen en 0 filas** (medido 2026-10-12) |
| **EMB.29** | `finance.trip_pay_lines` (índice único parcial = no se paga dos veces) + `/finanzas/comisiones-logistica` (corte catorcenal jue→mié, pago viernes; reproduce los 6 viernes que Kepler ejerció) + vale de Gastos con hoja PDF, sin folio (se casa después) | 🧪 local: vale en 1.5 s; quien lo arma recibe 403 al aprobar; otro usuario lo valida |
| **EMB.30** | Avisos: gasto `075`/`128` en Kepler sin vale · importe Kepler ≠ suma · viaje abierto > N días · persona en dos viajes · devolución sobre parada pagada | ⬜ |
| **EMB.31** | Padrón: alta de las 7 personas que cobran y ligar `logistics.drivers` ↔ `identity.users` (0 de 56) | ⬜ |

**Para probar en local:** aplicar las 2 migraciones a `platform_local`, levantar API y vista, y correr
`node database/scripts/dev-seed-emb-pago.js --api http://127.0.0.1:<puerto>`: toma 5 guías reales de la
copia local (traspasos recibidos, clientes con remisión, viaje abierto, faltante), registra cargadores de
PRUEBA y crea el usuario `aprobador_prueba` (rol tesorería). Prueba de base:
`node database/tests/test-newdb-emb-pago-por-viaje.js` (23 aserciones, 3 negativas, mutación verificada).

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
