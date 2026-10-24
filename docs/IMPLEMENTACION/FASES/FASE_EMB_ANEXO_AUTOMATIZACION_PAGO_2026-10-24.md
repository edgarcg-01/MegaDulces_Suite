# Fase EMB · Anexo — Comisiones, viáticos y carga de Logística en automático

> Anexo de [`FASE_EMB_PAGO_POR_VIAJE.md`](FASE_EMB_PAGO_POR_VIAJE.md) (EMB.24–EMB.33, 🧪). **No es un
> plan rival**: EMB construyó el motor (tarifas, cierre por `U-A-50`, vale por catorcena); este anexo
> corrige lo que la medición del 2026-10-24 tumbó y quita la captura manual que hoy impide usarlo.
> Medido contra prod `md` (`192.168.0.222:5434`, `system_identifier 7688376744939610156`), sólo
> lectura, el **2026-10-24**.

```
OBJETIVO: que la comisión, el viático y el pago por carga de cada persona de Logística se calculen
          solos desde el viaje de Kepler; que sólo se capture lo que Kepler no sabe (ayudantes,
          cargadores, horas sin GPS); y que cada catorcena el cálculo cuadre contra lo que Kepler pagó.
MÉTRICA:  % del pago de la catorcena (Kepler X-A-10, conceptos 054/027/075/128) que el sistema
          reproduce por persona × concepto × centro de costo (±$1)
          HOY: 0 % — finance.trip_pay_lines tiene 0 filas; la hoja cubre 6 viajes   (2026-10-24)
          META: ≥ 90 % de la catorcena que se paga el 2026-11-19, el resto declarado  (propuesta)
2ª MÉTRICA: viajes en alcance con tripulación completa
          HOY: 6 de 438 guías Kepler del 12 al 24-oct (1.4 %)                         (2026-10-24)
          META: ≥ 95 %                                                                 (propuesta)
CAPA TOPE: C3     ÁREA: Logística + Finanzas     FIRMA: Edgar     OPERA HOY: Leonardo Cazares
ESTADO:   ⬜ propuesto — ver D8 (cupo)
```

---

## 1. En una pantalla

Logística paga a sus choferes y ayudantes **cada 14 días, en papel**: Leonardo Cazares arma la
liquidación por persona, la captura en Kepler (`X-A-15` → `X-A-10`) con un renglón por concepto y
**centro de costo de la sucursal destino**, y la sube a Gastos con el comentario «Comisión». La
Suite ya tiene el motor para calcularlo por viaje (EMB), pero **nadie lo usa** porque exige crear
cada hoja a mano, y aunque lo usaran, **mandaría el 71 % del dinero a la cuenta equivocada**.

| Evidencia (2026-10-24) | Cifra |
|---|---|
| Pagado a Logística CEDIS (00) en octubre, 2 pagos (8 y 22-oct), 12 personas | **$137,344** |
| … de eso, en cuenta **514** (054 comisión arrastre + 027 viáticos traspaso) | **$97,062 (71 %)** |
| … en 602 (075 comisión TLMK + 128 viáticos entrega), que es lo único que la hoja sabe generar | $40,282 (29 %) |
| … en 186 «maniobras clientes», el concepto que la hoja usa para la carga | **$0** |
| Hojas en `/logistica/shipments` | **8** (1 prueba de junio, 1 cancelada, 4 de 5 cargas a «Chofer Demo») |
| Guías Kepler del 12 al 24-oct | **438** |
| Pagos de la hoja que llegaron a un vale (`finance.trip_pay_lines`) | **0** |
| Líneas de cuenta 514 en `analytics.expense_entries` | **0** (el importer filtra `c3='511' OR c3 LIKE '6%'`) |

---

## 2. Cómo se paga hoy, renglón por renglón (el árbitro)

El `X-A-10` de cada persona trae un renglón por **concepto × centro de costo** (`kdm6.c12` concepto,
`kdm6.c16` centro de costo → `kepler_ods.kdc3`). Ejemplo: Francisco García, pago del 8-oct, $6,110:

| Concepto | Cuenta | Centros de costo (destino) | Importe |
|---|---|---|---:|
| 054 Comisión arrastre mercancía | 514-001 | Padre Hidalgo, Morelia Abastos, Canindo, Ocho Esquinas, La Piedad Abastos, Yurécuaro | $3,810 |
| 027 Viáticos traspaso de mercancía | 514-001 | ídem | $1,355 |
| 075 Comisiones logísticas TLMK | 602-015 | TLMKT PH, Servicio de fletes transportes | $840 |
| 128 Viáticos entrega clientes | 602-015 | ídem | $105 |

**Lo que los viajes dicen** (3 choferes, 24-sep → 21-oct, `analytics.erp_shipment_trips` ⋈
`erp_shipment_stop_closure`): José María Flores, Raúl Galván y Rafael González hacen **casi sólo
traspasos** (U-D-41 serie 2 → `TI###`) a 01, 03, 05, 06, 07, 08. ⇒ **054/027 es el pago por traspaso,
cargado al centro de costo de la sucursal que recibe**; 075/128 es entrega a cliente (TLMK) y flete a
terceros (`1-09-63`).

⚠️ **NO MEDIDO:** la tarifa exacta por traspaso que usa el papel. La hoja de liquidación está
adjunta a cada vale (`files[0]`, imagen o PDF en el almacenamiento de prod) y no se pudo leer desde
la máquina de trabajo. **EMB.37 la reconstruye contra el dato** antes de escribir el cálculo.

### Universo en dinero (90 días, todas las sucursales, `X-A-10` sin cancelados)

| Concepto | Qué es | 90 días |
|---|---|---:|
| 054 | Comisión por traspaso | $243,397 |
| 075 | Comisión entrega a cliente / flete | $133,417 |
| 128 | Viáticos entrega a cliente | $94,403 |
| 027 | Viáticos traspaso | $94,233 |
| 189 | Hotel viaje logística | $11,058 |
| **Pago a personas (alcance)** | | **$576,508** (~$2.3 M al año) |
| 121 / 122 / 123 | Combustible y casetas | $352,692 — **fuera** (HV2) |
| 250 | Maniobras y descargas de compras (contratistas en CEDIS, «Maniobras de la Rosa», Gonac, Aproza) | $113,843 — **fuera** (no es pago por persona) |

**El universo no es el trabajo:** el trabajo son los **$576,508** a personas. Combustible, casetas
y descarga de compras quedan fuera (§5).

---

## 3. Lo que creíamos y cayó

| # | Lo que decía | Lo que midió prod (2026-10-24) |
|---|---|---|
| 1 | EMB §2: «Logística paga comisión y viáticos con 075/128» | Eso es el **29 %**. El 71 % va a **054/027 en cuenta 514**. EMB midió sólo 602 porque leyó `expense_entries`, que no trae 514 |
| 2 | La carga se paga por caja | El código paga **$30 fijos por persona por embarque** (`tarifa_maniobra_carga`). Las tarifas por caja (`tarifa_maniobra_descarga` $1, `tarifa_maniobra_caja` $5) **no las lee ningún código** |
| 3 | El costo de logística está en `analytics.expense_entries` | Cero líneas de 514. Todo lo construido encima (`v_logistics_expense_channel`, el costo Kepler del panel del embarque) **no ve el 71 %** |
| 4 | Las «maniobras» que paga Logística son de carga | Son **descarga de compras** (250), en bloque a contratistas: «MANIOBRAS DE DESCARGA CEDIS» $61,700 en 90 d |
| 5 | «Nadie usa la hoja» = falta de adopción | Es un **piloto**: 4 de 5 cargas a «Chofer Demo» (semilla), hojas de 1 renglón y $213–$966. Y además pedía crear cada hoja a mano: con 438 guías en 12 días, nadie lo haría |

---

## 4. Decisiones a firmar

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **D1** | Concepto y centro de costo por tipo de viaje | (a) todo a 075/128/186 como hoy · (b) por tipo | **(b)**: traspaso → **054/027**, centro de costo = piso de la sucursal destino; cliente → **075/128**, TLMK de la plaza; flete a terceros → 075/128 en `1-09-63`; hotel → 189. Es lo que Logística ya captura; (a) clasifica mal $97k al mes |
| **D2** | ¿Quién crea el viaje? | (a) «Nuevo embarque» a mano · (b) **cada guía Kepler en alcance aparece sola** | **(b)**. El viaje es de Kepler (vista, sin copia); la Suite guarda sólo tripulación, horas y cargadores por `(sucursal, guía)`. Chofer por default = Kepler `c84` → `drivers.kepler_code` |
| **D3** ✅ | Pago por cargar el camión | (a) $ fijo por persona por embarque (hoy $30) · (b) $ por caja del embarque, repartido entre cargadores · (c) mixto | **Firmada por Edgar, 2026-10-24: «se pagarán 20 centavos por caja», con una configuración que se pueda cambiar.** Se implementó (b): cajas del embarque × $0.20, **repartido en partes iguales** entre quienes cargaron (el reparto igual es interpretación de esta sesión, por el precedente de EMB.18; confirmar). Ver EMB.39 |
| **D4** | Tarifa de viático | (a) por horario con la config actual (café $25, desayuno/comida/cena $100) · (b) lo que dice la liquidación | (a) con las tarifas **cuadradas contra la liquidación** (EMB §2 midió «$80 por comida por persona»; la config dice $100). Se cuadra en EMB.37, no se cambia a ojo |
| **D5** | Identidad de la persona | texto libre de Kepler (`c24`: «BRANCON CORONA», «RAUL GALVAL») · padrón `logistics.drivers` | Padrón (**EMB.31**). El texto de Kepler queda sólo como testigo para casar el pago |
| **D6** | Cierre de catorcena | (a) «Armar vale» persona por persona · (b) borradores de todos al cerrar el corte | **(b)**: el jueves se generan los vales en borrador; una persona aprueba. Nunca se paga sin aprobación |
| **D7** | Captura en Kepler | (a) a mano como hoy · (b) la Suite entrega los renglones exactos (concepto, centro de costo, importe) y después casa el folio sola · (c) escribir en Kepler | **(b)**. (c) queda fuera: escribir en el ERP es otra fase (PGP) |
| **D8** | Cupo (4/4 🔨: AB, CGA, RH, PQ) | (a) esperar a que cierre una · (b) C0 ya, dentro del aterrizaje de EMB · (c) pausar una | **(b)**: C0 son vistas de sólo lectura y una reproducción de catorcena; no estrena fase, aterriza EMB (🧪). **C1–C3 entran cuando se libere un cupo**, o Edgar decide qué pasa a ⏸️ |

---

## 5. Qué NO incluye

- Combustible y casetas (121/122/123): es costo del viaje, no pago a personas → HV2.
- Maniobras de descarga de compras (250): se pagan en bloque a contratistas.
- Ingreso por flete a terceros (CFDI emitidos) → HV3.
- Carga a camión de ruta (`RUTA nn`/`RD 5xx`) → fuera por decisión D-A de HV.
- Prueba de entrega a cliente → EMB.30 / HV5.
- Escribir en Kepler (D7c) y nómina o apoyos fijos sin viaje.
- `/logistica/payroll`: no se enciende (EMB.20/EMB.23); se declara como camino muerto (EMB.45).

---

## 6. Orden y capas

| Orden | Frente | Por qué va ahí |
|---|---|---|
| 1 | **C0 · el árbitro y el universo** (EMB.34–EMB.37) | Sólo lectura, barato, y sin él no se sabe si el cálculo paga bien. Destapa el 71 % hoy invisible |
| 2 | **C1 · el cálculo corregido** (EMB.38–EMB.39) | Depende de D1, D3 y D4 y de la tarifa reconstruida en EMB.37 |
| 3 | **C2 · catorcena automática** (EMB.40–EMB.42) | Escribe: prueba contra base real con el payload de la pantalla |
| 4 | **C3 · bandeja de viajes por completar** (EMB.43–EMB.44) | La única captura que queda: ayudantes, cargadores y horas sin GPS |
| — | Limpieza (EMB.45–EMB.46) | Independiente; dos piezas necesitan autorización por tocar datos de prod |

### C0 · Dato — vistas `derive-no-copy` sobre `kepler_ods`, cero escritura

| # | Item | Verificado contra |
|---|---|---|
| EMB.34 | `analytics.v_logistics_pay_paid`: lo pagado. `X-A-10` (`kdm1`⋈`kdm6`, `btrim(c1)=sucursal`, sin cancelados) con conceptos 054/027/075/128/189, persona (`c24`), centro de costo (`c16`→`kdc3`), solicitud (`c39`) y catorcena | Octubre, sucursal 00 = **$137,344** (medido hoy). Prueba negativa: el vale 0010446, cancelado en Kepler, **no** entra |
| EMB.35 | `analytics.v_logistics_trip_pay_universe`: cada guía en alcance con tipo (traspaso/cliente/flete), destino, centro de costo, chofer Kepler → padrón, tarifa sugerida y estado de cierre. Reusa `erp_shipment_trips`/`stops`/`stop_closure` | Σ guías = `erp_shipment_trips` del periodo (sin join que infle: `kdmm` ×9) |
| EMB.36 | Resolver concepto/centro de costo por tipo de viaje (D1) en `libs/contracts` — lo usan la hoja, la catorcena y la vista | Prueba: un traspaso a 06 sale 054/027 · `1-03-50-00`; una entrega TLMK de PH sale 075/128 · `1-01-10-70` |
| EMB.37 | **Reproducir una catorcena** (8 → 21-oct) para los choferes con viajes en Kepler: calcular con las tarifas de `logistics.routes` y comparar contra EMB.34 por persona × concepto × centro de costo | Es la métrica HOY con dato real. Lo que no cuadre se lista con su causa (tarifa faltante, ayudante sin registrar, viaje sin chofer) |

### C1 · Dominio
| # | Item | Prueba |
|---|---|---|
| EMB.38 | El cálculo por persona × viaje × concepto × centro de costo con D1 aplicado (reusa `guia-calculada.logic` y el contrato `cierre-viaje`) | Reproduce la muestra de EMB.37 al peso |
| EMB.39 🧪 | Regla de carga según D3: **$0.20 por caja**, configurable y con vigencia (detalle abajo) | Prueba negativa: un embarque sin cajas en `CJA`/`BTO` no paga por caja; lo declara |

### C2 · API
| # | Item | ¿Escribe? |
|---|---|---|
| EMB.40 | `GET` corte con **calculado vs pagado en Kepler** por persona y su diferencia | no |
| EMB.41 | Cierre de catorcena: borradores de vale para todas las personas con pago liberado (D6) | **SÍ** → prueba contra base real con el payload de la pantalla; recorrer **todos** los caminos que insertan en `finance.expense_proofs` y `finance.trip_pay_lines` |
| EMB.42 | Renglones para capturar en Kepler (D7b) y casado automático vale ↔ `X-A-15`/`X-A-10` por persona + importe + fecha | no (casa en lectura); el enlace se guarda sólo si lo confirma una persona |

### C3 · UI (skill `diseno` antes del primer archivo; `check:pantalla` antes y después)
| # | Item |
|---|---|
| EMB.43 | Bandeja **«Viajes por completar»**: las guías de Kepler aparecen solas; la captura es en lista (ayudantes, cargadores, horas) y lo que viene de Kepler o del GPS llega lleno |
| EMB.44 | `/finanzas/comisiones-logistica`: columnas «pagado en Kepler» y «diferencia», y el cierre de catorcena en un botón |

### Limpieza
| # | Item | Nota |
|---|---|---|
| EMB.45 | Declarar `/logistica/payroll` como camino muerto (o retirarlo): paga de las mismas guías sin enlace con `trip_pay_lines` y con otra regla de viático | Riesgo de pago doble; hoy `liquidations` tiene 0 filas |
| EMB.46 | Sacar del padrón activo «Chofer Demo» y «Ruta Local Demo» (semilla `06_mega_dulces_logistics_baseline.js`, activa con $150 de comisión); revisar «JUANITO LOPEZ». Arreglar que «Nuevo embarque» descarta `freight_revenue` y `actual_km` al crear | ⛔ **Toca datos de prod: necesita autorización de Edgar.** Se marca inactivo; no se borra |

---

## 7. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Tarifa real por traspaso y regla de carga | Leonardo Cazares (Logística) | Vive en la hoja de liquidación en papel | Una foto de la liquidación de una catorcena, o 20 min con él. EMB.37 la verifica contra Kepler |
| C1–C3 sin cupo | Edgar | 4/4 🔨 | D8 |
| 33–41 % de las guías sin chofer en Kepler y ningún ayudante | Logística | Kepler sólo guarda chofer (`c84`) | La bandeja EMB.43; la métrica 2 mide cuánto falta |

---

## 8. Definición de Terminado

- [ ] Métrica remedida con la misma consulta: 0 % → N % de la catorcena reproducida
- [ ] EMB.41 ejercido contra base real con el payload de la pantalla
- [ ] El resolver de D1 y el reparto por caja (si D3 = b) en `libs/` o declarados como deuda con nombre
- [ ] Prueba negativa de cada compuerta vista en rojo
- [ ] Permiso de la bandeja repartido en prod, no sólo declarado
- [ ] Pantallas < 500 ms y `check:pantalla` sin fallas nuevas
- [ ] Tracker, log y ADR (D1 y D2 cambian ADR-091)

### EMB.39 · La carga por caja, configurable — cómo quedó (🧪, 2026-10-24)

**La configuración no es un sistema nuevo: es el que ya existía** (EMB.28.1). La tarifa vive en
`logistics.config_finance` como `tarifa_carga_caja` = 0.20 (`mxn/caja`, categoría «tarifa de
maniobra»). Se cambia en **Logística › Configuración › Maniobras**: capturarla en cero es de quien
configura; **cambiar una tarifa ya fijada exige `LOGISTICS_TARIFAS_AUTORIZAR`**, y cada cambio queda
en `logistics.tariff_changes` (quién, cuándo, antes, después).

**Lo que faltaba y se agregó: la vigencia.** La tarifa con que se paga un embarque es la que estaba
puesta **el día del embarque** (hora de México), derivada de la bitácora — no se guarda una segunda
copia de la tarifa (`tarifaVigenteEl`, `libs/logistics/.../tarifas-fijas.logic.ts`). Subirla el día X
paga distinto desde X y **no mueve lo que se cargó antes**. Además, cada renglón de
`logistics.load_details` guarda con qué cajas (`boxes`) y qué tarifa (`rate_per_box`) se calculó, y
`rate` es la parte de esa persona: lo ya registrado no cambia aunque cambie la tarifa o Kepler.
Volver a prender una tarifa apagada ahora también queda en la bitácora (antes no, y la vigencia la
habría dado por prendida hacia atrás).

| Pieza | Dónde |
|---|---|
| Migración: columnas `boxes`/`rate_per_box`, alta de `tarifa_carga_caja` = 0.20 y baja de `tarifa_maniobra_carga` ($30 por persona), ambas en la bitácora | `database/migrations-newdb/20261024110354_emb_carga_por_caja.js` |
| Regla compartida: `totalDeCarga`, `repartoDeCarga` (a centavos; la suma es siempre el total), `erroresDeCargadores` | `libs/contracts/src/http/cierre-viaje.contract.ts` |
| Cajas del embarque (Kepler en vivo, o las capturadas si es manual) y tarifa vigente | `TripClosureService.cargaDe` |
| Pantalla «Cierre y pago › Quién cargó»: cajas × tarifa = total, cuánto le toca a cada quien antes de guardar, y los tres estados (sin tarifa · cajas desconocidas · 0 cajas) | `cierre-viaje.component.ts` |

**Verificado:**
- Unitarias: logistics 47 ✓ · contracts 22 ✓ · view 15 ✓.
- Mutaciones en rojo, una por regla: (1) sin el filtro de paradas → 1 roja; (2) tarifa de hoy en vez de la vigente → 2 rojas; (3) cajas desconocidas tratadas como 0 → 1 roja; (4) `>` → `>=` en la vigencia → 2 rojas. ⚠️ La primera corrida de (1) **no** salió en roja: la prueba negativa pasaba por la razón equivocada (faltaba el cargador en el padrón y el 400 venía de «no existe»). Se corrigió: las negativas llevan el padrón y validan el mensaje exacto.
- SQL de las cajas ejercido **contra prod en sólo lectura**, con controles conocidos: EMB-2026-00005 = 25 cajas, las de piezas sueltas = 0, una guía inexistente = «no se sabe». ⭐ El primer diseño (`LATERAL` sobre `erp_shipment_stop_load`) tardaba **1.7–6 s** en una guía de 13–30 paradas porque no baja serie/folio al índice de `kdm2`; en dos pasos con constantes, **5–26 ms** y el mismo resultado.
- `check:pantalla -- logistica`: mismas 102 fallas antes y después, ninguna nueva. `check:templates`, `check:estilos`, `check:tokens`, `check:motion`, `check:mig-colisiones` en verde.

**NO MEDIDO (falta antes de producción):**
- ⛔ `PUT /logistics/trip-closure/shipments/:id/cargadores` **no se ejerció contra una base real** con el payload de la pantalla (regla 13): Docker local no responde y no se levanta backend local. La prueba de base (`test-newdb-emb-pago-por-viaje.js`) cubre la vista con montos por caja y corre en el job `pruebas-db` del CI (informativo).
- La migración **no está aplicada en prod**. Mientras no se aplique, la pantalla dirá «no hay tarifa de carga por caja vigente».
- Embarques de antes del día en que se aplique la migración: la tarifa no existía → no se registran cargadores (se declara, no se inventa).

## Bitácora

- **2026-10-24** — EMB.39 en código (🧪): carga a $0.20 por caja, configurable con vigencia. D3 firmada por Edgar.
- **2026-10-24** — Medición y anexo. Pedido de Edgar: *«el punto es automatizar y llevar con control
  de comisiones y viáticos de logística, considerando cuando cargan camión su comisión por cargar,
  viáticos, etc.»*. Consultas de sólo lectura en el scratchpad de la sesión (`s15`–`s27`).
