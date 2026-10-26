# Fase FC · Anexo FCU — Costo por unidad: lo que hace la hoja «TRANSPORTES 2026», en el sistema

```
OBJETIVO: dejar de usar la hoja «TRANSPORTES 2026 - COSTOS DE TRANSPORTE» y que Logística vea el
          costo real de cada unidad (gasto de Kepler + km del GPS), contra lo presupuestado.
MÉTRICA:  gasto de flota de Transportes del mes ASIGNADO Y CONFIRMADO a una unidad — HOY
          (2026-10-26): 0 % (no existe la asignación). Lo que el texto de Kepler ya sugiere:
          $1,162,139 en ene–sep a las 14 unidades, más $341,267 que nombran un modelo sin decir
          cuál → META: ≥ 95 % del mes cerrado, 2 meses seguidos.
CAPA TOPE: C3
ÁREA:      Logística
DUEÑO:     (PM asigna) · operación: Leonardo Cazares / Juan (embarques)
ESTADO:    ⬜ — sin cupo (4/4 🔨: AB · CGA · RH · PQ). Ver D1.
```

> Pedido (Edgar, 2026-10-26): *«este Excel se dejará de usar, pero necesitamos abarcar todo lo que
> hace para poder cambiar de usar el Excel a este sistema con más control»*.
> Lo medido para escribir esto: sesión del 2026-10-26, sólo lectura en prod (`system_identifier`
> verificado). La revisión de la hoja está en `FASE_EMB_ANEXO_AUTOMATIZACION_PAGO_2026-10-24.md`
> (EMB.37) y en la memoria del proyecto.

---

## 1. Qué problema resuelve

La hoja calcula, para 14 unidades (15 bloques: la unidad 12 está repetida), el **costo anual**
por rubro y lo reparte en 6 meses, 4 meses, mes, «periodo» (1/13 de año), día y **por km**
(anual ÷ km supuestos). Todo es **captura a mano y supuestos**, y se midió que no aguanta:

- **Los km son supuestos y están 2–4× arriba de lo real.** GPS (40–89 días, anualizado):
  International 1 42,684 contra 80,000; F-350 25,041 contra 100,000. El $/km real es 1.7–4×
  el de la hoja.
- **Errores propios:** el total de fijos omite la comisión en 4 unidades (−$80,000 c/u; el Kodiak
  también en $/km: 11.47 debería ser 14.67); unidad 12 duplicada; F-350 y F-450 con el mismo VIN;
  seguros con fecha 2023–24 o vacíos; placas que no son las de Kepler.
- **No trae lo que más cuesta en la calle:** combustible, casetas, viáticos, carga. La comisión
  es un supuesto ($80,000/unidad) y lo pagado en 2026 va a un ritmo de ~$1.40M/año contra $1.14M.
- **Ya se cargó al sistema y nadie lo usa:** los 14 $/km están en `logistics.config_finance`
  (`costo_km_*`, 27-may) y `shipment_expenses` tiene **0 filas**; además sólo el Hino casaría con su
  clave, las otras 13 caerían en `costo_km_estandar` ($8.50) sin avisar.

⭐ **Lo que hace posible reemplazarla:** el gasto real ya está en Kepler, con un concepto para cada
rubro de la hoja, y **la unidad viene escrita en el texto** del gasto («DISEL HINO 500 LA ROSA
MORELIA», «INTERNATIONAL 3 RUDO SERVICIO X CHEMA», «HINO 500 SEGURO QUALITAS ANUAL»). No hay centro
de costo por unidad (Logística carga a `1-08-12-00 LOGISTICA GENERAL`, `1-09-63 FLETES` o al centro
del destino), así que la unidad sólo se puede **sugerir** por el texto y **confirmar** una persona.

---

## 2. Lo que hace la hoja → de dónde sale en el sistema

| Lo que hace la hoja | Fuente en el sistema | Estado hoy |
|---|---|---|
| Identidad de la unidad: número, nombre, VIN, placas, modelo | `logistics.vehicles` (tiene `vin`, `plate`, `economic_number`, `kepler_code`) | 🟡 existe; falta número/nombre de la hoja y área asignada |
| Vencimiento del seguro | `vehicles.insurance_carrier/policy` | 🔴 falta fecha de vencimiento y prima |
| KM por año | GPS `vehicle_day_summary` (real, no supuesto) | 🟡 8 de 14 con GPS ligado (6 hoy + Hino y Freightliner con EMB.55) |
| Placas, refrendo, verificación | Kepler X-A-10 conceptos 101, 109, 241, 300 | 🟡 dato existe; unidad por texto |
| Arrendamiento / depreciación | arrendadas: Kepler 115; propias: valor de compra + vida útil | 🔴 depreciación no está en ningún lado (no es un gasto en Kepler) |
| Pensión | Kepler 205 | 🟡 |
| GPS (Magnitracking, Salvador) | Kepler 209 | 🟡 |
| Seguro | Kepler 111 (prima anual) | 🟡 |
| Comisiones | Kepler X-A-15 `GNFC002`, conceptos 054/075, por persona → a la unidad por sus guías (`erp_shipment_trips.vehicle_id`) | 🟡 depende de EMB (¿por viaje o por guía?) |
| Salarios del chofer | **no está en el ODS** (nómina) | 🔴 NO MEDIDO |
| Mantenimiento preventivo | Kepler 076, 240, 267 | 🟡 |
| Reparaciones | Kepler 068, 188, 099, 156, 024, 255, 309 | 🟡 |
| Neumáticos | Kepler 044, 045, 200, 025 | 🟡 |
| Lubricantes | Kepler 022 | 🟡 |
| Sueldos administrativos | **no está en el ODS**; prorrateo a decidir (D4) | 🔴 NO MEDIDO |
| Cortes: 6 m, 4 m, mes, periodo, día, $/km | cálculo sobre cualquier rango (mes, catorcena, año corrido, 12 meses) | ⬜ C1 |
| Tabla lateral: reposición (precio +5 %/año, valor residual, $/km por año) | simulador | ⬜ C1/C3, prioridad baja |
| — (no lo trae la hoja) combustible, casetas, viáticos, carga, multas | Kepler 038, 122/123, 027/128, $0.20/caja, 135 | 🟡 dato existe |

**Atribución medida (Kepler X-A-10, ene–sep 2026, por el texto):**

| Unidad | Renglones | Total | Combustible | Mantenimiento | Fijos |
|---|---:|---:|---:|---:|---:|
| U1 International 1 | 93 | $289,718 | $50,637 | $200,303 | $36,611 |
| U2 Hino 500 | 130 | $210,894 | $53,510 | $55,058 | $56,290 |
| U3 International 2 | 118 | $209,681 | $47,599 | $44,435 | $54,690 |
| U4 International 3 | 133 | $192,066 | $79,442 | $54,179 | — |
| U9 F-350 | 38 | $94,442 | $27,363 | $52,851 | $14,027 |
| U5 Freightliner estándar | 57 | $85,019 | $26,239 | $27,359 | $24,439 |
| U6, U7, U8, U11, U12, U13 | 19 | $80,319 | | | |
| **Sin unidad clara** (dice «International», «Freightliner», «Ford 450» o «RAM 4000» sin número) | 49 | **$341,267** | $25,110 | $93,334 | $214,568 |

⚠️ Los $214,568 de fijos «sin unidad clara» son, en buena parte, la renta de una Ford 450
(«ARRENDAMIENTO FORD 450 DISEL», $40,924 al mes) cargada al centro de telemarketing de Padre
Hidalgo: probablemente **no** es de Transportes, y es justo el tipo de renglón que una persona
tiene que decidir. Lo que dice «TLMK» explícito ($277,818) se separó como telemarketing. El resto
del gasto de flota de la empresa ($3.7M en el periodo) no nombra unidad y es, en su mayoría, de
otras flotillas (reparto, ventas, oficinas): **fuera del alcance** de este anexo, aunque el mismo
mecanismo les sirve.

---

## 3. Qué NO incluye

- No escribe en Kepler (la escritura Suite→Kepler está apagada). La unidad se asigna **en la Suite**.
- No calcula nómina: el salario se **captura** por unidad (D3) hasta que exista fuente.
- No reemplaza la conciliación de combustible por litros (eso es FC.0.7–FC.0.9, flotilla de reparto).
- No usa `config_finance.costo_km_*`: se retiran (FCU.0.6) porque son la hoja congelada y con errores.
- No toca el pago a choferes (eso es EMB); sólo **lee** la comisión pagada para costear la unidad.

---

## 4. Las capas

### C0 · Dato
| # | Item | Estado | Verificado contra |
|---|---|---|---|
| FCU.0.1 | Vista `analytics.v_fleet_expense_lines`: renglones X-A-10 (sin cancelados) con los conceptos de flota de §2, rubro de la hoja y **unidad sugerida** por alias (`derive-no-copy` sobre `kdm1`/`kdm6`) | ⬜ | Σ por concepto contra Kepler, mismo periodo; muestra a ojo de 40 renglones sugeridos |
| FCU.0.2 | Alias por unidad editables (`vehicles.aliases text[]`: «INTERNATIONAL 1», «C. SECA», «55AB1M»…), en vez de regex en código | ⬜ | la vista da lo mismo que la medición de hoy (73 %) |
| FCU.0.3 | Asignación confirmada renglón → unidad (tabla propia, HITL: clave del renglón de Kepler, `vehicle_id`, quién, cuándo, «no es de flota») con `tenant_id` + auditoría | ⬜ | ningún renglón asignado dos veces; un renglón cancelado en Kepler sale solo |
| FCU.0.4 | Ficha de la unidad completa: número y nombre de la hoja, área (Transportes / reparto / TLMK…), propia o arrendada, valor y fecha de compra, vida útil, aseguradora, póliza, prima, **vence**, salario mensual del chofer (capturado) | ⬜ | las 14 de la hoja con ficha; las 2 que viajan y no están (Ford 450 NC-1134-D, Ford 550) dadas de alta o descartadas |
| FCU.0.5 | Presupuesto anual por unidad × rubro (lo que hoy dice la hoja), carga única desde el CSV y luego editable (D5) | ⬜ | Σ por unidad = la hoja **corregida** (sin el error de la comisión) |
| FCU.0.6 | Retirar `config_finance.costo_km_*` (14 claves de la hoja + `costo_km_estandar`) y su lectura en `logistics-expenses` | ⬜ | `shipment_expenses` sigue en 0 filas; nada más los lee (grep) |

⛔ Sin importer: el gasto se lee en vivo de `kepler_ods`; lo único propio es la asignación, la ficha y el presupuesto.

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| FCU.1.1 | Costo de una unidad en un rango: real por rubro (asignado) + fijos prorrateados por día (seguro, refrendo, depreciación, salario) + comisión por sus guías; **cada rubro con su procedencia** (medido · capturado · estimado · sin dato) | ⬜ | casos con rubro faltante → «sin dato», nunca $0 |
| FCU.1.2 | $/km = costo ÷ km GPS del mismo rango; sin GPS → «sin km», no se divide entre un supuesto | ⬜ | prueba negativa: unidad sin GPS |
| FCU.1.3 | Real contra presupuesto por rubro y por unidad | ⬜ | |
| FCU.1.4 | Simulador de reposición (la tabla lateral de la hoja) | ⬜ | reproduce la hoja corregida |

### C2 · API
| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| FCU.2.1 | `GET` costo por unidad y rango (tabla + detalle por rubro y renglón) | ⬜ | no | sólo lectura en prod, < 500 ms |
| FCU.2.2 | `PUT` asignación renglón → unidad (una o en lote) | ⬜ | **sí** | ⛔ obligatoria, payload de la pantalla |
| FCU.2.3 | `PUT` ficha de la unidad y presupuesto | ⬜ | **sí** | ⛔ obligatoria |

### C3 · UI
| # | Item | Estado | `check:pantalla` |
|---|---|---|---|
| FCU.3.1 | **Flotilla › Costo por unidad**: veredicto arriba (costo del mes, $/km, % asignado), tabla por unidad (real · presupuesto · km · $/km), detalle por rubro hasta el renglón de Kepler | ⬜ | |
| FCU.3.2 | **Gastos sin unidad**: bandeja con la sugerencia ya puesta; asignar en lote | ⬜ | |
| FCU.3.3 | Avisos: seguro por vencer, unidad sin GPS, unidad sin viajes (hoy City Star, Kodiak y Nissan JV05705: 0 guías en 2026), gasto sin unidad del mes | ⬜ | |
| FCU.3.4 | Ficha y presupuesto editables (sustituye capturar la hoja) | ⬜ | |

⛔ Skill `diseno` antes del primer archivo; observaciones de diseño al plan antes del primer C3.

**⭐ Dónde vive en el sidebar (pedido de Edgar, 2026-10-26: «recuerda adjuntarlo a un módulo del
sidebar»).** Una sola entrada en **Logística › Costos y reportes**, junto a «Costos» y «Gasto de
ruta» (`logisticaNavGroups` en `apps/view/src/app/modules/dashboard/layout/layout.component.ts`),
con pestañas como «Pagos de viaje» (`*-tabs.ts`):

| Entrada del sidebar | Pestañas | Ruta |
|---|---|---|
| **Costo por unidad** (`pi pi-truck`) | Por unidad · Gastos sin unidad · Fichas y presupuesto | `/logistica/costo-unidad/…` |

| # | Item | Estado |
|---|---|---|
| FCU.3.5 | Permiso propio `LOGISTICS_COSTO_UNIDAD_VER` (ver) y `LOGISTICS_COSTO_UNIDAD_GESTIONAR` (asignar, ficha, presupuesto) — no se reusa `LOGISTICS_EXPENSES_VER` ni `FLEET_VER` | ⬜ |
| FCU.3.6 | Ruta gateada (`permissionGuard`), item del sidebar con `permission`, pestañas en `costo-unidad-tabs.ts`, entrada en `permission.guard.ts` (destino por permiso) | ⬜ |
| FCU.3.7 | **Repartir** el permiso en prod (migración anclada a un hermano, idempotente, con re-login): Leonardo (`encargado_bodega`), Juan (`coordinador_embarques`), jefatura de CEDIS; ver a Finanzas si lo pide | ⬜ |

⛔ El módulo no está entregado hasta que el permiso está **repartido** en prod (regla 20 de `CLAUDE.md`).

---

## 5. Decisiones (las firma el PM)

| # | Decisión | Recomendación |
|---|---|---|
| D1 | **Dónde vive y con qué cupo.** El cupo está 4/4 (AB, CGA, RH, PQ). | Anexo de FC; empezar C0 en el carril de EMB (mismo dato: la comisión por unidad sale de ahí) **cuando EMB pase a ✅** tras su despliegue. Si se quiere antes, hay que pausar una de las cuatro. |
| D2 | **La unidad del gasto.** Kepler no tiene campo de unidad. | Las dos cosas: (a) en la Suite, sugerencia por texto + confirmación humana (FCU.0.3); (b) **cambiar el proceso**: que quien captura el gasto en Kepler escriba la unidad con su clave fija (`U01`…`U14`) al inicio del texto. Con (b) la sugerencia llega casi al 100 % y la bandeja queda para lo raro. |
| D3 | **Salario del chofer.** No está en el ODS. | Capturarlo en la ficha (mensual) con procedencia «capturado», hasta que RH tenga fuente. |
| D4 | **Sueldo administrativo.** La hoja pone $82,000 idéntico en las 15 fichas (no sale de dividir nada). | Capturar la nómina administrativa de Logística del mes y **prorratearla por km del GPS** (o partes iguales si se prefiere); nunca repetirla entera por unidad. |
| D5 | **Presupuesto.** ¿Tabla propia o el motor de Presupuestos (PU)? PU planea por cuenta × sucursal × mes, **sin dimensión de unidad**. | Extender PU con la dimensión «unidad» (aditivo) si PU lo acepta; si no, tabla propia mínima. No dos motores de presupuesto. |
| D6 | **Universo.** La hoja tiene 14 unidades; viajan 8 de ellas + 2 que no están; 3 sin un solo viaje en 2026. | Universo = unidades con área «Transportes» en la ficha; dar de alta Ford 450 NC-1134-D y Ford 550, y que Logística decida qué hacer con City Star, Kodiak y Nissan JV05705. |
| D7 | **Periodo.** La hoja usa 13 «periodos» al año (28 días); el pago va por catorcena (26). | Mes y catorcena; se retira el periodo de 28 días. |
| D8 | **Depreciación de propias.** | Línea recta: (valor de compra − residual) ÷ vida útil, prorrateada por día; residual y vida útil capturables. |

---

## 6. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Comisión por unidad | Leonardo | no se sabe si se paga por viaje o por guía (EMB.54) | su respuesta |
| 6 de 14 unidades sin GPS | Logística / flotilla | no tienen rastreador o no está ligado | instalar o ligar en `/logistica/rastreo` |
| Salarios y sueldo admin | RH / Finanzas | no están en el ODS | D3 y D4 |
| Gasto sin unidad clara ($341,267 ene–sep) | quien captura en Kepler | el texto dice «International», «Ford 450» o «RAM 4000» sin número | D2 (b) |

---

## 7. Cuándo se deja de usar la hoja (criterio de salida)

1. Las 14 unidades (más las 2 que faltan) con ficha completa y presupuesto cargado.
2. ≥ 95 % del gasto de Transportes del mes cerrado asignado a una unidad, dos meses seguidos.
3. $/km con km del GPS en toda unidad que tenga GPS; las que no, declaradas.
4. Un mes en paralelo: Logística llena la hoja y mira el sistema; las diferencias se explican
   renglón por renglón (deben ser errores de la hoja, no del sistema).

---

## 8. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-26 | Plan del anexo. Medido: $1,162,139 del gasto de flota ene–sep atribuible por texto a las 14 unidades (+$341,267 sin unidad clara); 8 de 14 unidades con GPS; la hoja cargada en `config_finance` sin uso. Corrección a lo dicho ese mismo día: el Hino **es arrendado** (su seguro dice «ARREND. HMS»), así que los $1.5M de «arrendamiento/depreciación» pueden ser renta y no el valor del camión — NO MEDIDO: su renta no aparece en el concepto 115 de 2026. | Claude (sesión EMB) |
