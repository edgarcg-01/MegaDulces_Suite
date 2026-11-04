# Fase FC · Anexo FCT — Rentabilidad del viaje de Telemarketing: la hoja «RENTABILIDAD TLMKT 2026», con nuestra verdad

```
OBJETIVO: dejar de usar la hoja «RENTABILIDAD TLMKT 2026 – desgloce de gastos por ruta» y que la
          rentabilidad de cada viaje de entrega TM salga de Kepler (venta) + el cierre del viaje en
          la Suite (costo), con lo que no se pudo medir DECLARADO.
MÉTRICA:  viajes TM del mes con su costo cerrado en la Suite — HOY (octubre 2026, medido
          2026-11-04): 0 de 206 guías TM de Kepler (`logistics.shipments` tiene 9 viajes en total,
          `finance.trip_pay_lines` 0, `logistics.fuel_transactions` 0). → META: ≥ 95 % de los viajes
          TM de Hidalgo y Morelia Abastos, 2 meses seguidos.
CAPA TOPE: C3
ÁREA:      Comercial (Telemarketing) · Logística (cierre del viaje)
DUEÑO:     (PM asigna)
ESTADO:    🔨 — anexo de FC (fase ya en curso), no fase nueva. Pedido de Edgar el 2026-11-04:
           «analiza y complementa /comercial/comisiones» → «complementemos entonces con nuestra verdad».
```

> Lo medido para escribir esto: sesión del 2026-11-04, sólo lectura en prod (`system_identifier`
> 7688376744939610156). Scripts de la medición: el análisis de la hoja y el cruce con Kepler
> (fuera del repo). Memoria del proyecto: `project_hoja_rentabilidad_tlmkt`.

---

## 1. Qué es la hoja (y qué NO es)

Una fila = un viaje de entrega de venta TM. «ZONA» es la sucursal: **PADRE HIDALGO = Sucursal
Hidalgo (01)**, **MORELIA ABASTOS = Sucursal Morelia Abastos (08)**. 257 viajes, 23-abr → 22-oct.
Gasto corriente ≈ 1.7 % de la venta.

**No es una hoja de comisiones comerciales.** No trae la comisión del vendedor TM; trae lo que se
le paga al **chofer y al auxiliar** por viaje (desde el 9-jun), viáticos, combustible y el costo de
la camioneta. Por eso no se mete en `/comercial/comisiones` (nómina de Ruta Directa): mezclaría la
nómina de Logística con la de RD. La comisión del vendedor TM sigue siendo la pregunta abierta
`rd.tlmk.tabulador` de la fase DP.

**Defectos de la hoja** (por qué no se importa, además de la regla de cero importers): 17 filas con
`#VALUE`/`#DIV/0`; una venta de $1,324,608.94 (Pénjamo, 2-jun, 10× lo normal) y otra ilegible
(«156.725.00»); 24 fechas sin año o mal tecleadas y 2 con año 2023/2025; 6 ventas redondas
(estimadas); precios por litro y rendimientos imposibles; 16 grafías de chofer y 36 de auxiliar;
Hidalgo **nunca** carga el costo de la unidad (FALSE) y Morelia sí → sus % no son comparables.

## 2. Lo que hace la hoja → de dónde sale en el sistema

| Columna de la hoja | Fuente en el sistema | Estado hoy (medido) |
|---|---|---|
| Viaje, fecha, ruta/destino, vendedor | Guía `c86` de embarques `U-D-41` **serie 1 «Embarque Telemarketing»** de `kdm1` → `analytics.v_tlmk_trip_stops` (FCT.0.1) | 🧪 55/55 viajes cotejados casan; fecha de la hoja = embarque + 1 día |
| Venta del viaje | Σ `c16` de los embarques de la guía | 🧪 ±$10, diferencia media $2.02; placebo +3 % → 0 |
| Unidad | ⛔ **No de Kepler**: la unidad de la guía TM contradice a la hoja en la mayoría (dice «MOTOCICLETA» o «FORD 450» donde la hoja dice Nissan) → del cierre del viaje (EMB, `shipments.vehicle_id`) | 🔴 sin captura |
| Chofer / auxiliar | ⛔ Kepler vacío en ~80 % → EMB `delivery_guides.driver_id/helper1_id` | 🔴 sin captura |
| Km recorridos | GPS del vehículo **del cierre** (`shipments.actual_km`), no de la unidad de Kepler. La F-450 de Hidalgo (UNIDAD 10) no tiene GPS → lectura de odómetro (FCU.0.8) | 🔴 |
| Comisión chofer / auxiliar | EMB: tarifa por destino (`logistics.routes`) → `delivery_guides.driver_commission/helper1_commission` | ⚠️ **contradicción**, ver D2 |
| Viáticos | EMB `delivery_guides.per_diem_total` | 🔴 sin captura |
| Combustible (litros, $, $/litro) | `logistics.fuel_transactions` (vacía) o el rubro combustible del costo por unidad (FCU) | 🔴 NO MEDIDO |
| Otros gastos ($3,815 fijo a Pátzcuaro, $1,000 a Cd. Hidalgo) | `shipment_expenses.other` en el cierre; qué es el fijo de Pátzcuaro: preguntar | ⚠️ sin regla |
| Costo día chofer / auxiliar | Sueldo capturado por unidad (FCU, D3) prorrateado por día | 🟡 FCU sin aplicar |
| Costo de la unidad por km | FCU.1.2 ($/km = costo ÷ km GPS) | 🟡 FCU sin aplicar en prod |
| % de la operación sobre la venta | Cálculo (C1) con procedencia por rubro: lo que falta, «sin dato», nunca $0 | ⬜ |

**El universo es mayor que la hoja.** Octubre: 206 guías TM en Kepler (Hidalgo 73, Morelia
Abastos 87, **Canindo 46**) contra 21 filas de la hoja. La serie 1 también lleva vecinal, piso y
e-commerce (p. ej. Hidalgo `00002` E-COMMERCE, 232 paradas desde septiembre).

## 3. Las capas

### C0 · Dato
| # | Item | Estado | Verificado contra |
|---|---|---|---|
| FCT.0.1 | Vista `analytics.v_tlmk_trip_stops`: una fila por parada (embarque serie 1) con guía, fecha, destino, vendedor (nombre canónico de `vendor_identity`), total; claves crudas de transporte/chofer de Kepler con sufijo `_kepler` y **sin** resolver a vehículo | 🧪 mig `20261104130802`; SQL del archivo ejercido en prod sólo lectura (sonda 28 ms; 4 meses 46 ms); `up()` **no** ensayado en base (Docker local caído) | contra `erp_shipment_headers` serie 1 jun–nov: 556/556 guías iguales en paradas y total; contra la hoja: 55/55 |

⛔ Sin importer. El costo del viaje NO va en la vista (las tablas de EMB tienen RLS; una vista del
dueño lo saltaría): se cruza en el servicio.

### C1 · Dominio
| # | Item | Estado | Prueba |
|---|---|---|---|
| FCT.1.1 | Viaje TM = paradas agrupadas por (sucursal, guía); venta = Σ total; estado del costo: `sin_cerrar` (no hay viaje de EMB con esa guía) · `cerrado` · `incompleto` | ⬜ | un viaje sin cierre sale `sin_cerrar`, nunca con costo $0 |
| FCT.1.2 | Costo del viaje desde el cierre (comisiones, viáticos, gastos, km × $/km de FCU) con procedencia por rubro; % sobre la venta sólo si todos los rubros mayores están medidos | ⬜ | rubro faltante → «sin dato» |

### C2 · API
| # | Item | Estado | ¿Escribe? |
|---|---|---|---|
| FCT.2.1 | `GET` viajes TM por rango y sucursal, con su estado de costo (< 500 ms) | ⬜ | no |

### C3 · UI
| # | Item | Estado |
|---|---|---|
| FCT.3.1 | Pantalla de rentabilidad TM por viaje (ver D1), con enlace al cierre del viaje en Logística para los `sin_cerrar` | ⬜ |
| FCT.3.2 | Que el cierre de viaje de Logística (EMB) ofrezca las guías TM de Hidalgo y Morelia Abastos para cerrarlas (hoy se cierran 9 viajes en total) | ⬜ |

## 4. Decisiones (las firma el PM)

| # | Decisión | Recomendación | Estado |
|---|---|---|---|
| D1 | ¿Dónde se ve la rentabilidad TM? | Una pantalla junto a la rentabilidad de Ruta Directa (`comercial-ruta-directa-rentabilidad`, mismo molde), con un enlace desde `/comercial/comisiones`. No como pestaña de comisiones: no es nómina de RD | propuesta |
| D2 | Comisión chofer / auxiliar en viaje TM. **La tabla de Logística contradice a la hoja**: Degollado $51.60 / $30.40 en `logistics.routes` contra $120 / $100 en la hoja; Guanajuato $113.52 / $76 contra $200–$505 / $310–$500. En León la del chofer cambia viaje a viaje ($284–$711) | No se adivina: pregunta como parámetro en Definiciones (fase DP), dueño Logística. La hoja sugiere tarifa fija por destino para el auxiliar (Pénjamo/Penjamillo/Degollado $100, Yurécuaro $260, León/Guanajuato $310 o $500) | abierta |
| D3 | ¿Quién cierra el viaje TM en la Suite (Hidalgo, Morelia Abastos)? | Quien hoy llena la hoja | abierta (persona) |
| D4 | Universo: ¿entra Canindo? ¿Entran las paradas de vecinal, piso y e-commerce de la serie 1? | Entran todas las guías serie 1; el vendedor va a la vista y se filtra, no se esconde | decidida (Claude) |
| D5 | ¿Qué es el «otros gastos» fijo de $3,815 por viaje a Pátzcuaro (y $1,000 a Cd. Hidalgo)? | Preguntar a Morelia Abastos; hoy explica la mitad del costo de esa ruta (3.2 % de la venta, la peor) | abierta |

## 5. Cuándo se deja de usar la hoja

Cuando dos meses seguidos ≥ 95 % de los viajes TM de Hidalgo y Morelia Abastos salgan `cerrado`
en la Suite, y la venta de cada uno siga casando con Kepler.

## 6. Bitácora

- **2026-11-04** — Análisis de la hoja y cruce con Kepler (sólo lectura). FCT.0.1 en código (🧪).
  ⛔ Migración sin aplicar en prod.
