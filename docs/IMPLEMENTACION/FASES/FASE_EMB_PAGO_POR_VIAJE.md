# Fase EMB — Pago por viaje cerrado (comisiones, viáticos y maniobras)

> Continúa la Fase EMB (EMB.0–EMB.23, en [`01_TRACKER_PROGRESO.md`](../01_TRACKER_PROGRESO.md)).
> Decisión: **ADR-091**. Sprints **EMB.24–EMB.31**. Planeado el 2026-10-09; sin código.

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
4. **Pedido de cliente: basta con la entrega que registra el chofer** en la Suite; una devolución
   posterior genera aviso, no retiene.
5. **El pago va por Gastos** (vale por persona y por corte), no por `/logistica/payroll`.
6. **Viáticos a todos los que viajan** (chofer y ayudantes), por la regla de horario de EMB.19.

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

| Sprint | Qué | Notas |
|---|---|---|
| **EMB.24** | Vista `analytics.erp_shipment_stop_closure` (derive-no-copy): tipo de parada + cierre Kepler (traspaso↔`U-A-50` con `pv_suc_ip`, carga a ruta, señal de devolución/NC por `kdm5`) | Candado con prueba negativa del cruce por número; ancla `btrim(c1)=sucursal` |
| **EMB.25** | Entrega por parada en la Suite: el endpoint de entrega exige evidencia (foto, quién recibe, GPS) y acepta `no_entregado` con motivo | Hoy `recipients/:id/deliver` se llama con `{}` y no guarda nada |
| **EMB.26** | Estado del viaje: abierto · cerrado · con diferencias, con motivo por parada | Resuelve EMB.23 por decisión: la guía pasa a cerrada por sus paradas |
| **EMB.27** | Maniobra de carga: cargadores por carga (incluye camión de ruta), $30 c/u | Usa `logistics.load_details`; depende de GP.5 para registrar quién cargó |
| **EMB.28** | Viáticos: tarifa de comida $100, a chofer y ayudantes, por horario | Configurar `config_finance` categoría `viatico` (hoy 0 filas en prod) |
| **EMB.29** | Vale de Gastos por persona y corte, armado con viajes liberados; liga pago↔viaje con llave única; hoja PDF de respaldo con firma de quien recibe | Reusa `finance.expense_proofs`; antes leer los PDF de §2 |
| **EMB.30** | Avisos: gasto `075`/`128` en Kepler sin vale · importe Kepler ≠ suma de viajes · viaje abierto > N días · persona en dos viajes a la vez · devolución/NC sobre una parada pagada | A la bandeja de hallazgos existente |
| **EMB.31** | Padrón: dar de alta a las 7 personas que cobran y ligar `logistics.drivers` ↔ `identity.users` (hoy 0 de 56) | Sin esto no pueden firmar el vale |

## 7. Fuera de alcance y pendientes

- **Apoyos fijos** ($1,000 por semana o por mes): sin decisión; no dependen de un viaje.
- **Tratamiento fiscal:** pagar comisiones y viáticos fijos sin comprobante como gasto (602-015)
  en vez de nómina puede ser ingreso gravado del trabajador. Confirmar con Contabilidad; si cambia,
  sólo cambia el destino del corte.
- **`/logistica/payroll`** (`logistics.liquidations`) no se enciende: EMB.20 y EMB.23 quedan
  resueltos por esta decisión cuando EMB.29 esté en uso.
- **Descarga de regreso ($1/caja) y maniobra LAB** (EMB.18): no se decidieron aquí.
