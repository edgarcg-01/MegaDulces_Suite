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
| **D1** ✅ (conceptos) | Concepto y centro de costo por tipo de viaje | (a) todo a 075/128/186 como hoy · (b) por tipo | **(b)**: traspaso → **054/027**, centro de costo = piso de la sucursal destino; cliente → **075/128**, TLMK de la plaza; flete a terceros → 075/128 en `1-09-63`; hotel → 189. Es lo que Logística ya captura; (a) clasifica mal $97k al mes. **Conceptos firmados por Edgar el 2026-10-24** («hagamos lo que mencionaste»): traspaso 054/027, cliente 075/128, **carga por caja → 054** en los dos, mixto como traspaso (EMB.47). ⚠️ El **centro de costo** sigue sin derivarse: el reporte da el destino por nombre |
| **D2** | ¿Quién crea el viaje? | (a) «Nuevo embarque» a mano · (b) **cada guía Kepler en alcance aparece sola** | **(b)**. El viaje es de Kepler (vista, sin copia); la Suite guarda sólo tripulación, horas y cargadores por `(sucursal, guía)`. Chofer por default = Kepler `c84` → `drivers.kepler_code` |
| **D3** ✅ | Pago por cargar el camión | (a) $ fijo por persona por embarque (hoy $30) · (b) $ por caja del embarque, repartido entre cargadores · (c) mixto | **Firmada por Edgar, 2026-10-24: «se pagarán 20 centavos por caja», con una configuración que se pueda cambiar.** Se implementó (b): cajas del embarque × $0.20, **repartido en partes iguales** entre quienes cargaron (el reparto igual es interpretación de esta sesión, por el precedente de EMB.18; confirmar). Ver EMB.39 |
| **D4** | Tarifa de viático | (a) por horario con la config actual (café $25, desayuno/comida/cena $100) · (b) lo que dice la liquidación | (a) con las tarifas **cuadradas contra la liquidación** (EMB §2 midió «$80 por comida por persona»; la config dice $100). Se cuadra en EMB.37, no se cambia a ojo |
| **D5** | Identidad de la persona | texto libre de Kepler (`c24`: «BRANCON CORONA», «RAUL GALVAL») · padrón `logistics.drivers` | Padrón (**EMB.31**). El texto de Kepler queda sólo como testigo para casar el pago |
| **D6** ⛔ superada | Cierre de catorcena | (a) «Armar vale» persona por persona · (b) borradores de todos al cerrar el corte | **Superada por Edgar el 2026-10-24**: *«solo necesitamos decirles cuánto les toca de cada operación… y generarlo a forma de reporte para que ellos hagan sus solicitudes de gasto»*. No hay vale en la Suite: el gasto se pide en Kepler con el reporte (EMB.47) |
| **D7** ✅ (b) | Captura en Kepler | (a) a mano como hoy · (b) la Suite entrega los renglones exactos (concepto, centro de costo, importe) y después casa el folio sola · (c) escribir en Kepler | **(b), mitad entregada en EMB.47**: el reporte da los renglones (concepto × destino × importe) en PDF y Excel. Falta casar el folio `X-A-15` solo (EMB.42). (c) queda fuera: escribir en el ERP es otra fase (PGP) |
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

### EMB.43 · El módulo «Logística › Pagos de viaje» — cómo quedó (🧪, 2026-10-24)

Pedido de Edgar: *«rediseñemos el frontend y démosle un módulo específico en logística»*. Tres
trabajos, tres pestañas (cada una contesta UNA pregunta):

| Pestaña | La pregunta | Lo que hace |
|---|---|---|
| **Por completar** (`/logistica/pagos/viajes`) | ¿A qué viajes de Kepler de la catorcena les falta algo para pagarse? | Los viajes **aparecen solos** desde Kepler (traspaso y cliente; las cargas a ruta se cuentan y quedan fuera). Panel lateral en 3 pasos: tomar el viaje (sólo el tipo de entrega) → tripulación y horario → quién cargó y cierre de paradas (`app-cierre-viaje`, el mismo bloque del detalle del embarque) |
| **Por persona** (`/logistica/pagos/personas`) | ¿Cuánto cobra cada quien esta catorcena, y por qué? | Lo liberado sin vale, lo retenido con su motivo y lo ya en vale; «Armar vale» para Gastos. ⭐ **Es la MISMA pantalla** que Finanzas › Comisiones de logística (antes eran dos implementaciones; la vieja se retiró) |
| **Tarifas** (`/logistica/pagos/tarifas`) | ¿Con qué se paga y desde cuándo? | Carga por caja, viáticos y comisión por ruta, con el **historial** de cada cambio (la bitácora existía y no tenía pantalla). Se cambian en Configuración, que lleva el candado |

**Acceso (firmado por Edgar):** permiso propio `LOGISTICS_PAGOS_VER` / `_GESTIONAR`. Migración
`20261024114154` lo reparte: VER+GESTIONAR a `encargado_bodega` (sólo Leonardo Cazares) y
`coordinador_embarques` (sólo Juan Arellano); VER a `finanzas` y `direccion`. ⛔ Hallazgo que lo
motivó: **Leonardo, quien arma hoy la liquidación, no tenía NINGÚN permiso de logística**, y las 8
hojas piloto las creó un desarrollador (superadmin). Todo endpoint que usa el módulo acepta el permiso
propio (bandeja, cierre, tomar viaje, completar guía, cargadores, alta rápida, catorcena, vale,
lectura de tarifas e historial); **ninguna escritura de tarifas** se abre al módulo (prueba negativa).

**Backend nuevo:** `GET /logistics/trip-closure/bandeja` — viajes de Kepler en vivo + lo que la Suite
sabe de cada uno. ⛔ No usa `logistics.v_trip_state` (se pasó de 60 s en prod); lo que falta sale de
la guía y de `load_details`. Medido en prod con el SQL exacto: 436 guías, ~400 ms (la vista de viajes
de Kepler es lo lento); controles EMB-5 completo, EMB-4 sin horario, EMB-2 sin chofer. La catorcena
(`corteDe`) se mudó al contrato: la usan dos pantallas y el servidor.

**Verificado:** logistics 85 ✓ · finance 20 ✓ · contracts+authz 107 ✓ · view (logística, finanzas,
guards, layout) 1,271 ✓. `check:pantalla -- logistica`: las 3 páginas nuevas cumplen las 10 reglas.
Compuertas `templates`, `tokens`, `motion`, `estilos`, `teclado`, `busqueda`, `tables`, `track`,
`migrations`, `mig-colisiones`, `wiring`, `primeng`, emojis y reactividad en verde.
⚠️ Al construir, la compuerta `primeng` cazó dos defectos que habrían salido en producción: botones
`pButton` con `label`/`icon` (en v22 salen **vacíos**) y `styleClass` en `p-table` (v22 lo ignora).

**NO MEDIDO / pendiente:**
- ⛔ Las escrituras desde el panel (tomar, completar guía, cargadores, vale) **no se ejercieron contra
  una base real** con el payload de la pantalla. Reusan endpoints existentes; el permiso es lo nuevo.
- ✅ Las dos migraciones (`20261024110354`, `20261024114154`) **se aplicaron en prod el 2026-10-24**
  (18:36 y 18:37 UTC; verificado en `public.knex_migrations`, columnas, tarifa y reparto a los 4 roles).
  ⛔ Lo que decía aquí —«aplicarla antes de empujar»— era falso: `aplicar-migracion.sh` se niega si el
  archivo no está en `origin/main`. Las personas tienen que volver a entrar.
- **Sin validación visual**: no se levantó la app. Lo más probable de ajustar: el ancho del panel
  lateral (40–44rem) y la densidad de la tabla en pantallas angostas.
- `MATRIZ_ACCESOS.md` se regenera desde prod **después** de aplicar el reparto.
- **Descarga en recepción/entrada** (Edgar: la carga por caja aplica a «traspasos, clientes, recepción,
  entrada»): falta el modelo, porque una recepción no tiene embarque. Es el siguiente item: medir cajas
  en `U-A-50` / `X-A-40` y dónde se captura quién descargó.

### EMB.47 · El módulo es un REPORTE de reparto — cómo quedó (🧪, 2026-10-24)

Edgar, al ver EMB.43: *«la finalidad del módulo es sacar los gastos y la repartición de las
cantidades mencionadas. Sabemos cuántas cajas, cuántos procesos. Sólo necesitamos decirles cuánto les
toca de cada operación. No necesitamos más, y generarlo a forma de reporte para que ellos hagan sus
solicitudes de gasto»* — y después: *«hay que darle la opción aquí de agregar chofer y agregar
cargadores»*. O sea: fuera el flujo (tomar el viaje, cierre de paradas, armar vale); queda **quién
fue** y **cuánto le toca a cada quien**.

**Lo medido antes de rediseñar (prod, sólo lectura):**
- Cómo se paga hoy: **un `X-A-10` por persona por catorcena** (octubre en Oficinas: 12 personas × 2
  pagos, 5–16 renglones cada uno); cada renglón es **concepto × centro de costo de la sucursal
  destino** (`kdm6.c12`/`c16`). Textos de 90 días: 054 «COMISION ARRASTRE MERCANCIA» (384), 027
  «VIATICOS TRASPASO DE MERCANCIA» (336), 075 «COMISIONES LOGISTICAS TLMKT» (155), 128 «VIATICOS
  ENTREGA CLIENTES» (142), 186 «MANIOBRAS CLIENTES» (1).
- Lo único que Kepler no sabe es **quién fue**: el chofer viene en 58 de 103 guías de Oficinas (14
  días); los ayudantes, nunca. Los 17 choferes de Kepler (30 días) **sí** están en el padrón; el
  padrón activo tiene **25 choferes, 1 ayudante y 0 cargadores** → dar de alta ayudantes y cargadores
  desde el reporte no es un extra: sin eso no se puede repartir.
- Viajes mixtos (traspaso + cliente): 4 de 314 guías que pagan (8–21 oct) → se piden como traspaso.

| Pestaña | Lo que hace ahora |
|---|---|
| **Operaciones** (`/logistica/pagos/viajes`) | Cada traspaso o entrega a cliente de Kepler con sus **cajas**, quién fue y cuánto se repartió. En el panel: **chofer y ayudantes** (con horario: de ahí salen comisión y viático), **cargadores** (cajas × $0.20 en partes iguales, con la vista previa) y **«Agregar ayudante/cargador nuevo»** (alta rápida de EMB.32). La hoja de la Suite **nace sola** al guardar la primera captura: ya no hay «tomar el viaje» |
| **Por persona** (`/logistica/pagos/personas`) | La **solicitud de gasto de cada quien**: renglones concepto × destino sumados en la catorcena (como se captura el X-A-15), de dónde sale cada peso, y **PDF** (una hoja por persona con firma) y **Excel**. Es la misma pantalla en Finanzas › Comisiones de logística |
| **Tarifas** | Sin cambio |

**Backend:** `GET /logistics/trip-closure/reporte` reemplaza a `bandeja` (que nunca llegó a prod).
Tres lecturas en paralelo, cada una con su conexión. Medido en prod (8–21 oct, todas las sucursales):
viajes 322 ms; paradas 65 ms + cajas de 1,341 documentos en lote 240 ms. Acepta las mismas llaves
con que Finanzas leía el corte (`FINANCE_EXPENSES_COMPROBAR`, `LOGISTICS_SHIPMENTS_GESTIONAR`), para
no dejar fuera a quien ya entraba a Comisiones de logística. **No se agregó ninguna escritura**: la
captura reusa `from-kepler`, `guides/:id/complete`, `cargadores` y `alta-rapida`.

**Cambio de regla:** las cajas de una carga a camión de ruta **en la misma guía** ya no se pagan
(antes `cajasDe` sumaba todas las paradas). Es la decisión del 2026-10-24 («no camiones de ruta»)
aplicada también donde se guarda: `cajasPorGuia` es una sola función para el reporte y para
`setCargadores`.

**Verificado:** logistics 44 ✓ · contracts 33 ✓ · view (logística + guards) 169 ✓ · tsgo 0 errores.
Mutación en rojo: quitar la exclusión de las cargas a ruta → 2 rojas. `check:pantalla`: las 3
pantallas cumplen las 10 reglas y tipan; `templates`, `tokens`, `estilos`, `teclado`, `busqueda`,
`tables`, `track`, `wiring`, `primeng`, emojis y reactividad en verde.

**NO MEDIDO / pendiente:**
- ⛔ La captura encadenada (crear la hoja → releer → completar la guía / guardar cargadores) **no se
  ejerció contra una base real**; las pruebas la recorren con HTTP de mentira. Los endpoints ya
  existían; lo nuevo es el orden.
- El tiempo del endpoint completo en prod (se midieron sus consultas, no la respuesta).
- **Centro de costo** del renglón: el reporte da el destino por nombre, no la clave de `kdc3`. Las
  claves de piso coinciden con los códigos `MD-NN` (`1-01-42-00` = La Piedad Abastos = `MD-42`), pero
  `TI###` no traduce limpio a sucursal (`receiving-origin.ts`): queda para EMB.36.
- El viático sigue saliendo del horario con la config (café $25, comidas $100); Kepler muestra
  montos de $60–$80 por destino. **D4 sin firmar.**
- Los vales de `finance.trip_pay_lines` (EMB.29) quedan sin pantalla; el backend no se tocó.
- Sin validación visual.

### EMB.48 · «Todos los viajes salen en 0» — lo que el reporte ya sabía y callaba (🧪, 2026-10-26)

Edgar, al probarlo en local con la catorcena 22-oct → 4-nov: *«todos los viajes salen en 0»*. Eran
**dos ceros distintos**, medidos en prod (sólo lectura):

| Cero | Causa | Qué se hizo |
|---|---|---|
| **«Repartido $0.00» en las 85** | Nadie había capturado a nadie, y la pantalla sólo pintaba lo ASIGNADO. Callaba lo que ya sabía: la carga (cajas × tarifa) y la comisión de la ruta | Cada fila dice **Carga** y **Comisión chofer** (la tarifa de la ruta, `comisionSugerida`, la misma regla de la guía). La comisión se **asigna sola al chofer de Kepler** (casado con el padrón por `kepler_code`: los 15 choferes de la catorcena casan) como renglón `fuente: 'kepler'`; al completar la guía la reemplaza la capturada, mismo monto. Ruta sin tarifa → «Ruta sin tarifa», no $0 |
| **«Cajas 0» en muchos traspasos** | **7 de 85 guías llevan SÓLO tiempo aire** (SKU 00022, saldo de recarga: 1,025 «piezas» a $0.81 a cada sucursal). Además 9 llevan mercancía sin ninguna caja (1,090 unidades en paquete/pieza/kilo) y 27 llevan 7,559 unidades sueltas junto a sus cajas | Las de puro tiempo aire **salen del reporte y se cuentan** (`solo_tiempo_aire`). Las unidades sueltas se muestran («+N sueltas») y **no pagan por caja**: D3 dice «por caja» — convertirlas a cajas es decisión pendiente |

**Lo que muestra ahora la catorcena (verificado con SQL independiente del código):** 78
operaciones; 8,646 cajas → **$1,729.20 de carga**; **$5,882.16 de comisión de choferes** en 43
operaciones; **35 van a rutas sin tarifa** en el catálogo (156 rutas, 98 con tarifa). ⚠️ El SQL de
verificación aproxima el emparejamiento por nombre; el código usa `nombreNormalizado`.

**Verificado:** logistics 50 ✓ (6 nuevas de EMB.48) · contracts 33 ✓ · view logística 127 ✓ · tsgo 0
errores · `check:pantalla` 3/3. Mutaciones en rojo: sin el filtro de tiempo aire → 1 roja; comisión
de Kepler sumada aunque la guía esté completa → 5 rojas. ⚠️ Al escribirlo se cazó un error propio:
«guía completa» se detectaba por la comisión no nula, pero la columna es `NOT NULL DEFAULT 0` y la
guía que nace al tomar el viaje la trae en 0 — ahora es chofer + salida + llegada
(`pendientesDeLaGuia`).

**NO MEDIDO:** el tiempo del endpoint completo (se suman ~110 ms del tiempo aire, medido aparte);
sin validación visual de las columnas nuevas.

**Decisiones abiertas que esto destapa:** (a) **35 rutas sin tarifa** esta catorcena: alguien tiene
que ponerles comisión en Configuración (Leonardo) o no se sabe cuánto pagan; (b) ¿las unidades en
**paquete/pieza** cuentan como caja (convertidas con su factor) o no pagan carga?

### EMB.49 · Los $0.20 por caja rigen desde el 22-oct (🧪, 2026-10-26)

Ya en producción, Edgar: *«sigue en ceros»*. Corrí el código desplegado contra prod (sólo lectura,
591 ms): el total no era cero ($5,882.16 de comisión, $2,386.32 asignado), pero **la tarifa por
caja nació el 24-oct a las 12:36** y la regla de vigencia la aplica desde el día del registro: las
**62 operaciones del 22 y 23 de octubre** (de 78) salían «sin tarifa» y la carga sumaba $449.80
en vez de $1,729.20. Decisión de Edgar: *«aplícala»* — rige desde el 22-oct, inicio de la catorcena.

**Cómo, sin reescribir la auditoría:** `logistics.tariff_changes.effective_from` (mig
`20261026092618`, aditiva): desde qué día aplica un cambio cuando no es el de su registro. Se pone
`2026-10-22` en los dos movimientos de EMB.39 y la decisión queda como un movimiento más
(`rige_desde`, con quién la tomó). `tarifaVigenteEl` usa `diaEnQueRige` (el declarado, o el del
registro); la pestaña Tarifas muestra «Rige desde…». El servicio lee la bitácora con `select *`:
funciona igual antes y después de aplicar la migración (el orden del despliegue no importa).

**Verificado:** logistics 79 ✓ (5 nuevas de vigencia, dos negativas), view logística 127 ✓, tsgo 0,
`check:migrations` y `check:mig-colisiones` verdes. **NO MEDIDO:** la migración no se ejerció contra
una base real (no hay base de prueba con la bitácora); su `UPDATE` toca exactamente las 2 filas que
se leyeron en prod.

**Sigue abierto (no se tocó):** las 3 rutas locales «sin comisión» (EMB.33). Esa decisión se
midió sólo contra el concepto 075; en Kepler los traspasos locales sí cobran por 054 (p. ej. 22-oct:
Antonio Méndez $1,630 al centro de Padre Hidalgo). Espera respuesta de Edgar.

### EMB.50 · El desglose de cada operación (🧪, 2026-10-26)

Edgar: *«que se pueda desglosar el movimiento (cuántas cajas), quién hizo recepciones, etc.»*. En el
panel de cada operación, sección **«Desglose del movimiento»**, documento por documento:

| Qué | De dónde (Kepler, en vivo) |
|---|---|
| Cajas y sueltas del documento | `kdm2.c54`/`c55` — la MISMA regla que el reporte (CJA/BTO; sin tiempo aire; carga a ruta = 0) |
| Productos (cantidad, presentación, cajas) | `kdm2` + nombre de `kdii` |
| Quién **surtió, checó y embarcó** | `erp_shipment_headers.resp_*` contra `v_kepler_responsables` (`resolverPorCodigo`: una clave ambigua NO se adivina) |
| Quién lo capturó y a qué hora | `erp_shipment_stops.usuario_captura` / `hora_captura` |
| La **recepción** del traspaso en destino | `erp_shipment_stop_closure` (U-A-50): folio, día, diferencia y estado; **quién la capturó** = `kdm1.c67` del U-A-50 |

`GET /logistics/trip-closure/operaciones/:sucursal/:guia/desglose` (sólo lee; mismas llaves que el
reporte). **Verificado contra prod (sólo lectura, código real):** el desglose cuadra con el reporte
en **78 de 78** operaciones (cajas y sueltas); máximo 73 ms por operación. Ejemplo real: traspaso a
Padre Hidalgo — surtió RODOLFO LANDEROS, checó LIZBETH MARTÍNEZ, **embarcó DIEGO RODRÍGUEZ**,
recepción 0000518 capturada por el usuario `10RQN`, completa. Pruebas: logistics 88 (9 nuevas),
pantallas 17; mutación de la guarda de respuestas tardías en rojo.

**Lo que NO se puede (declarado):** quién recibió sale como **clave de usuario de Kepler** (`10RQN`),
no con nombre: el ODS no trae catálogo de usuarios (buscado: ninguna tabla). **Oportunidad:** Kepler
ya registra quién **embarcó** cada documento; con eso los cargadores podrían precargarse — pendiente de
que Edgar diga si «embarcó» = quien cargó el camión. **Fuera de esto:** la descarga en la recepción de
compras (entradas de proveedor) sigue siendo el item pendiente.

### EMB.51 · Todo se abre y cada peso dice de dónde sale (🧪, 2026-10-26)

Edgar, viendo la solicitud de un chofer: *«desglosemos… por qué la cantidad de cada uno, y cliquear
las guías para ver movimientos; pensemos en que todo sea cliqueable y desglosable»*.

| Dónde | Qué se abre |
|---|---|
| Cada renglón (Operaciones y Por persona) | **Su cálculo en llano**, armado en el servidor con lo guardado: «Tarifa de la ruta YURECUARO: $61.92 al chofer», «Salida 05:30, llegada 16:10: café $25 + desayuno $100 + comida $100», «42 cajas × $0.20 = $8.40 entre 2 cargadores». Sin desglose guardado, se dice |
| Por persona › «Para capturar en Kepler» | Clic en un renglón → «De dónde sale» muestra sólo sus operaciones («ver todas» lo quita) |
| Por persona › una guía | Se abre en el mismo panel: lo que la persona tiene de esa guía y su **movimiento** (el desglose de EMB.50); «volver» regresa. Desde Logística, liga «Abrir en Operaciones» |
| Operaciones › una persona | Liga a su solicitud (`?persona=`) |
| Ligas | `?op=SUCURSAL|GUIA&desde&hasta` abre la operación en SU catorcena; `?persona=` abre la solicitud |
| PDF | «De dónde sale» lleva el cálculo de cada peso (es lo que la persona firma) |

El desglose de una operación salió a una pieza compartida (`app-desglose-operacion`): se pinta igual
desde las dos pestañas. **Verificado contra prod (sólo lectura):** el $61.92 es la tarifa de la ruta
YURECUARO; una guía a 5 sucursales cobra la de CANINDO ZAMORA (la mayor de sus rutas). Pruebas:
logistics 64 (5 nuevas de cálculo), pantallas 70 (ligas, filtro, guía abierta y su negativa de
respuesta tardía), contracts 33.

**Pregunta que esto deja a la vista:** una guía a varias sucursales cobra UNA comisión (la de su ruta
más cara), pero en Kepler la comisión se captura por centro de costo de cada destino. ¿Se reparte
entre los destinos o va al de la ruta que puso la tarifa?

### EMB.52 · Filtros y orden (🧪, 2026-10-26)

Edgar: *«faltan filtros en la interfaz principal y ordenamiento en las cards»*. **Operaciones**: además de
estado/sucursal/búsqueda, filtros por **tipo**, **estado** (falta chofer · horario · quién cargó · ruta
sin tarifa · sin cajas de Kepler · lleva sueltas), **persona** (cualquiera que cobra, maneja, ayuda o
carga) y **día**, y un **«Ordenar por»** (lo que más falta · recientes · antiguas · cajas · carga ·
comisión · asignado · guía) que manda también en la vista de tarjetas (en estrecho la tabla se apila y
no hay encabezados que cliquear). A igualdad, sucursal y guía: la lista no baila entre recargas.
**Por persona**: filtro por papel y orden (total · nombre · operaciones · comisión · viático · carga).

### EMB.53 · El formato de la solicitud de gasto, como el X-A-15 (🧪, 2026-10-26)

Edgar: *«hagamos un formato para que pasen sus comisiones a solicitudes de gastos para que se les
pague»*. Antes de diseñarlo se leyó la solicitud real de Logística en Kepler (X-A-15 0010438, Antonio
Méndez, 22-oct) y las de 90 días (sólo lectura):

| Dato del X-A-15 | Medido | En el formato |
|---|---|---|
| Proveedor | **siempre** `GNFC002` «COMISION Y VIATICOS LOGISTICA» | Cabecera |
| Beneficiario (`c24`) · área (`c30`) · moneda | la persona · FINANZAS · PESOS | Cabecera |
| Cuenta por renglón (`kdm6.c8`) | 054 y 027 → **514-001** (429/374); 075 y 128 → **602-015** (193/165; 2 en blanco) | Columna «Cuenta» |
| Centro de costo (`kdm6.c16`) | el **piso de la sucursal destino** (1-01-40-00 = 8 Esquinas) | Columna «Centro de costo», derivado |

**El centro se deriva sin adivinar:** `TI###` → sucursal (`pv_suc_ip`, la regla de
`erp_shipment_stop_closure`) → piso `1-0P-NN-00` del catálogo `kdc3` con NN = el código MD de la
sucursal (verificado contra los 9 nombres). Si el catálogo da cero o dos candidatos, no hay centro.
**No se resuelve, y se dice:** entrega a cliente (en Kepler va a TLMK o a Fletes según quién sabe
qué) y traspaso a varias sucursales. Con centro, el renglón agrupa por centro: «TRASPASO 8 ESQUINAS»
y «SUCURSAL 8 ESQUINAS» son el mismo renglón, como en el X-A-15.

**Verificado contra prod (código real, sólo lectura):** de 80 operaciones de la catorcena, **48 con
centro**, 25 de cliente y 7 de varios destinos. En la solicitud de Antonio Méndez los dos viajes a
Morelia Abastos salen en UN renglón `054 · 514-001 · 1-02-30-00 · $360`, como lo captura Kepler.
Las dos consultas nuevas cuestan 1–3 ms. ⚠️ La vista de viajes de Kepler (`erp_shipment_trips`, ya
existente) varía en prod de 0.2 a 5 s según la carga (misma consulta: 214 / 4,965 / 419 ms): el
reporte llegó a 3.8 s. NO MEDIDO como arreglarla.

**El formato** (PDF por persona, y Excel): cabecera del X-A-15 (proveedor, beneficiario, área,
moneda, periodo, total), **renglones para capturar** (#, cuenta, concepto, descripción, centro de
costo, importe), «de dónde sale» con el cálculo de cada peso, y firmas **Solicita · Autoriza ·
Recibí**. El Excel trae proveedor, beneficiario, cuenta, concepto, centro y nombre del centro por
renglón.

**Pruebas:** logistics 199 (lib completa; 4 nuevas de centro de costo, 2 negativas), contracts 34,
pantallas 136 (filtros, orden). Mutación en rojo: quitar la regla de «varios destinos» → 1 roja.

**Abiertas:** (a) entregas a cliente: ¿a qué centro va cada una (TLMK de la plaza o Fletes 1-09-63)?
(b) viajes a varias sucursales: ¿la comisión se reparte entre sus centros? (c) la vista de viajes de
Kepler, lenta bajo carga.

## Bitácora

- **2026-10-26** — EMB.52/53: filtros y orden; el formato de la solicitud igual al X-A-15 (proveedor GNFC002, cuenta y centro de costo derivados).
- **2026-10-26** — EMB.51: cada importe con su cálculo; renglones, guías y personas se abren (ligas entre pestañas).
- **2026-10-26** — EMB.50: desglose por documento (cajas, surtió/checó/embarcó, recepción en destino). Pedido: «quién hizo recepciones».
- **2026-10-26** — EMB.49: la tarifa por caja rige desde el 22-oct (decisión de Edgar), con «rige desde» en la bitácora.
- **2026-10-26** — EMB.48: el reporte muestra carga y comisión de ruta sin capturar; tiempo aire fuera (7 guías). Pedido: «todos los viajes salen en 0».
- **2026-10-24** — EMB.47: el módulo pasa a ser un reporte de reparto (Operaciones + solicitudes por persona en PDF/Excel); D1 (conceptos) firmada, D6 superada. Migraciones de EMB.39/43 aplicadas en prod.
- **2026-10-24** — EMB.43: módulo Logística › Pagos de viaje (3 pestañas, permiso propio repartido a Leonardo y Juan).
- **2026-10-24** — EMB.39 en código (🧪): carga a $0.20 por caja, configurable con vigencia. D3 firmada por Edgar.
- **2026-10-24** — Medición y anexo. Pedido de Edgar: *«el punto es automatizar y llevar con control
  de comisiones y viáticos de logística, considerando cuando cargan camión su comisión por cargar,
  viáticos, etc.»*. Consultas de sólo lectura en el scratchpad de la sesión (`s15`–`s27`).
