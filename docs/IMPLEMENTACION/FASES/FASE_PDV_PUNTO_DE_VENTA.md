# Fase PDV — Punto de venta de mostrador en la Suite

> Plan pedido por Edgar el 2026-10-31. Método: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Maquetas, benchmark y plan visual: lienzo privado de Edgar en claude.ai («Punto de Venta Suite»);
> quien lo necesite se lo pide para que lo comparta.

```
OBJETIVO: que la cajera de mostrador cobre en una caja de la Suite al menos igual de rápido que en Kepler,
          que todo lo que pase en la caja (quitar, cancelar, descontar, abrir el cajón) quede registrado
          con quién, qué y por qué, y que cada ticket llegue a Kepler idéntico al que hoy graba su caja.
MÉTRICA 1 (rastro):    eventos de caja registrados con autor, autorizador y motivo
                       HOY (2026-10-31): 0 — Kepler no guarda F10 ni la «Baja» de ticket, y
                       commercial.pos_line_voids tiene 0 filas → META: 100 % en las cajas de la Suite
MÉTRICA 2 (gemelo):    tickets de Kepler reproducidos al centavo por el motor de la Suite
                       HOY: NO MEDIDO (el motor para mostrador no existe) → META: ≥ 99.5 % de los
                       90,428 tickets del 3 al 30 de octubre, con el residuo clasificado por causa
MÉTRICA 3 (velocidad): tickets por caja-hora en el pico
                       HOY: p50 15 · p90 37 · p99 61 (28 d, resolución de minuto) → META: no bajar en el
                       piloto, y los segundos por ticket medidos desde el primer día (PDV.8 da la línea base)
CAPA TOPE: C3
ÁREA:      Comercial (Tienda / Sucursales)
DUEÑO:     Edgar (decisiones y fase) · desarrollo: NO ASIGNADO · operación del piloto: encargado(a) de Yurécuaro
ESTADO:    ⬜ planeada — no se abre: hay 6 fases 🔨 contra un tope de 4 (`tablero.js`, 2026-10-31)
```

**Con qué se midió.** `pg-prod` (`system_identifier 7688376744939610156`), usuario de sólo lectura con
`SET default_transaction_read_only = on`, el 2026-10-31 entre 11:34 y 12:07. Ventana: 3 al 30 de octubre
de 2026 (28 días), por fecha de valor `kdm1.c9`. **Mostrador** = `U-D-10` con `c1 = sucursal`, sin ruta
vecinal ni ruta (la misma clasificación de `analytics.v_kepler_ticket_count`). Las consultas están en el
§14. Además se leyó el fuente de la caja de Kepler en la caché del cliente de desarrollo
(`D:\K95_Dev\temp\pv_tk.kpl`, `PV_abre_caja.kpl` y las cuatro de promociones, fechadas 2026-10-31).

**Prioridad (criterios del PM).** Dinero en juego **Alto**: todo el efectivo del mostrador pasa por la
caja, y el motor de precio decide lo que se cobra. Esfuerzo **XL** (~13 semanas de construcción más
piloto y despliegue). Prioridad **2**. Su pedazo **M** que se lleva el dinero —el gemelo y el motor de
precio único— ya existe como deuda con nombre, **`[VAC.L2]` «resolver único»** (⏸️ en el tracker): se
puede trabajar como ese item **sin abrir fase**, con PDV.4 como árbitro.

---

## 1. En una pantalla

Hoy las 8 sucursales cobran en la caja de Kepler (programa `pv_tk.kpl`, «Ventas 1.39/1.42»). Funciona,
pero: lo que se borra en la caja no deja rastro, el «contado» del corte lo pone el propio sistema, el
cliente casi nunca se identifica, la caja depende del servidor de Kepler de cada sucursal, y nada de eso
se puede corregir desde la Suite porque el proveedor re-descarga sus programas en cada apertura
([`FASE_BP`](FASE_BP_BITACORA_POS.md) §4). La propuesta es una caja de la Suite que vende sin red, deja
rastro de todo y **sigue mandando a Kepler el mismo ticket**: Kepler continúa siendo el libro de
inventario, cartera, contabilidad y factura global.

| Hecho medido (28 d salvo que se diga) | Cifra |
|---|---|
| Tickets de mostrador | **90,428** · 3,230 por día · 8 sucursales |
| Cajas con venta / usuarios que capturan | **37** cajas (5·5·5·3·3·4·5·7) · **61** usuarios |
| Tickets por día por sucursal | Zamora Centro 154 · Yurécuaro 169 · Canindo 253 · La Piedad Abastos 320 · Morelia Madero 339 · Morelia Abastos 586 · Padre Hidalgo 650 · 8 Esquinas 759 |
| Renglones por ticket (24–30 oct, 25,352 tickets) | promedio **4.85** · mediana 3 · p90 11 · máximo 135 · 4,017 SKUs |
| Presentación vendida (renglones) | paquete **67.0 %** · pieza 25.1 % · kilo **7.0 %** (12.6 % del dinero) · gramajes fijos 0.9 % · caja 0.04 % |
| Renglones con 3 o más | **19.6 %** (el mayoreo arranca en 3) |
| Ritmo por caja-hora | p50 15 · p90 37 · **p99 61** · máximo 76; pico de la red a las 13 h; operación de 6 a 21 h |
| Forma de pago (24–30 oct, por dinero) | efectivo **80.2 %** · crédito 9.7 % · débito 9.2 % · transferencia 0.9 % · cheque 0 |
| Tickets con cambio / con pago combinado | **80.8 %** / 0.5 % |
| Tickets a «CONTADO» (sin cliente) | **99.2 %** |
| Facturas hechas desde ticket (`U-D-5`) | 1,613 (+66 canceladas) — ~58 por día en la red |
| Factura global (`U-D-6`) | 271: una diaria por sucursal (dos en algunos días) |
| Notas de crédito/devolución de mostrador | `U-A-21` 204 (+15 canceladas) · `U-A-25` 161 |
| Cortes de caja cerrados (`analytics.cash_cuts`) | 957 · **65 %** abiertos por una persona y cerrados por otra · **92.2 %** con «contado» = esperado al centavo |
| Tickets `U-D-10` cancelados (`c43='C'`) | **0** |
| Capturas de la bitácora manual de la Suite (`commercial.pos_line_voids`) | **0** (todas las semanas) |

---

## 2. El pedido, literal, y cómo se interpretó

> «genremos un punto de venta para suite, podemos usar como infromaicon el de kepler. pero consideremos
> todos los putnos de evnta del mundo e invesiguremos como hace hace el mejor punto de evnta del mundo.
> analiza cada paron, visualiza cada apartado o punto. necesito un plan de impleemntacuino muy concreto»
> — Edgar, 2026-10-31, con captura de la «Apertura de Caja» de Kepler.

| # | Lo que se pidió | Qué se entregó |
|---|---|---|
| 1 | Punto de venta para la Suite, tomando el de Kepler como información | Este plan, ⬜, con el decode de la caja de Kepler (§5, §6) |
| 2 | Investigar los POS del mundo y el mejor | Benchmark de 13 sistemas en 17 patrones (§11) + requisitos de México (§12) |
| 3 | Analizar cada patrón | Cada patrón: quién lo hace mejor, qué hace Kepler, qué hará la Suite (§11 y lienzo) |
| 4 | Visualizar cada apartado | 13 pantallas maquetadas en el lienzo; venta y cobro operables |
| 5 | Plan de implementación muy concreto | Capas C0→C3 con items `PDV.N`, árbitro, compuertas y piloto (§9) |

No se escribió código ni se abrió la fase: el tablero tiene 6 🔨 contra 4.

---

## 3. El universo y el trabajo

- **Universo:** 8 sucursales, 37 cajas, 61 usuarios; en 28 días 90,428 tickets de mostrador, 2,904 de
  ruta vecinal cobrados en caja y 203 de ruta (Canindo).
- **Trabajo de la primera versión:** el **mostrador de contado** (los 90,428). La ruta vecinal y la ruta
  siguen en la caja de Kepler (D10).
- **Trabajo del piloto:** **una caja de Yurécuaro** (la sucursal de menor volumen después de Zamora
  Centro: 169 tickets al día en 3 cajas, 97.6 % efectivo).

---

## 4. Lo que se suponía y lo que midió prod

| # | Se suponía | Lo que se midió (2026-10-31) |
|---|---|---|
| 1 | El ticket de Kepler no guarda la forma de pago | Sí la guarda en `kdm1`: `c83` efectivo neto, `c84` crédito, `c85` débito, `c86` cheque, `c87` transferencia, `c88` otro, `c97` = «efectivo recibido\|cambio». **Suman `c16` en 25,582 de 25,582 tickets** (24–30 oct) |
| 2 | Un ticket cancelado queda como `c43='C'` | **0** tickets `C` en 28 días. El fuente tiene dos caminos: `Cancela()` «deja huella» (`k_opeCancela`) y `Baja()` «borra totalmente… no deja huella» (`k_opeDel`) |
| 3 | La caja de Kepler graba con SQL | Graba con **`kdb.sp("k_opeIns", …)`**, un procedimiento del servidor de aplicación de Kepler que mueve documento, inventario y folios. No existe como función de Postgres (0 funciones `k_*` en la réplica `kepler_md_04`) |
| 4 | El mayoreo depende de que la cajera lo aplique | En 5 SKUs de Yurécuaro (1–30 oct) **todos** los renglones con 3 o más se cobraron al peldaño de `kdpv_prod_util` (p. ej. 96505: 24 de 24 a $5.97 contra $6.55 de lista) |
| 5 | El «contado» del corte es el conteo de la cajera | No: en **92.2 %** de los 957 cortes es igual al esperado al centavo. Ya estaba medido que `c25` lo pone Kepler (= `c15` en 85 %) y que el conteo real vive en `reconciliation.blind_counts` (arqueo ciego de la Suite, casi sin uso) |
| 6 | Hay mostradores en Wincaja | Las 8 sucursales cobran en Kepler; la última en migrar fue Morelia Abastos (2026-09-19, `analytics.v_branch_erp_cutover`) |
| 7 | En el mostrador se identifica al cliente | 99.2 % de los tickets van a «CONTADO» |
| 8 | La Suite no tiene un motor de precio como el de Kepler | Lo tiene: `QuotePricingService` replica la precedencia E.22–E.24 arbitrada contra tickets `U-D-10` ([`ERP_KEPLER.md`](../../ERP_KEPLER.md) §2.7). Pero conviven **cuatro** resolvedores que no coinciden (cotización, `v_label_prices`, verificador, `resolvePriceForQty`) |
| 9 | La Suite no puede timbrar | Tiene un emisor CFDI 4.0 por PAC en código (`libs/fiscal/.../emision`), **dormido: 0 timbres**. Despertarlo duplicaría la global que hace Kepler |

---

## 5. La caja de Kepler, leída en su fuente

| Pieza | Lo que hace | Dónde |
|---|---|---|
| Apertura de caja | Sucursal, caja, turno, usuario asignado, **importe inicial**, **monto de aviso de retiro**, **máximo en caja**, autorización del gerente con contraseña. Escribe `kdpv_folio_caja` | `PV_abre_caja.kpl` |
| Captura | Rejilla con F9 buscar, **F10 modificar con PIN** (sin registro), F11 existencia, F12 ficha | `pv_tk.kpl` |
| Grabado | `k_opeIns` + `k_tipos_docto` (folios) + `k_inv` (inventario); después escribe `kdm2.c55`, saldos de promoción y `kdpv_folio_caja.c49` (efectivo acumulado) | `pv_tk.kpl` ~1419–1446, 2615–2645 |
| Retiro de efectivo | Efectivo en gaveta = `c49` + efectivo del ticket − `c48` (retiros); al pasar el aviso **sugiere** y al pasar el máximo **obliga** a retirar | `pv_tk.kpl` ~2631–2653 |
| Promociones | 4 tipos con vigencia, tope por sucursal y saldo: descuento por volumen (`kdpv_descuxq`), por monto (`kdpv_descuxm`), regalo por volumen (`kdpv_gratisxq`) y por monto (`kdpv_gratisxm`) | `PV_descux*.kpl`, `PV_gratisx*.kpl` |
| Ticket impreso | Formato propio con código de barras | `PV_tk_fto.kpl` |
| Límites de Yurécuaro | Aviso **$10,000** · máximo **$15,000** (`analytics.cash_cuts.cash_limit`/`cash_limit_max`) | medido |

⚠️ Se lee de la caché del cliente de desarrollo; el proveedor la cambia sin aviso (BP §4.3) y las
sucursales pueden correr versiones distintas. Lo que se construya debe verificarse contra datos, no contra
el fuente.

---

## 6. Decisiones

| # | Decisión | Opciones | Recomendación (y por qué) | Firma |
|---|---|---|---|---|
| **D0** | ¿La Suite opera la caja de mostrador? | Sí, por compuertas · No, sólo la acompaña | **Sí, por compuertas.** Hoy no: ADR-086 (Dirección: lo operativo «será historia de otro momento»), ADR-110 («cobrar sigue pasando en Kepler») y ADR-092 (sólo se escribe la requisición). Lo que el mostrador no puede tener en Kepler —rastro, conteo ciego, cliente, venta sin el servidor local— sólo llega operando la caja. El gemelo (C0) no depende de esta firma | Dirección General |
| **D1** | ¿Cómo llega el ticket a Kepler? | (a) el proveedor expone su alta de documento como servicio · (b) la Suite clona un ticket real por SQL (patrón KR) · (c) Kepler recibe un resumen por turno | **(a).** `k_opeIns` hace folio, inventario, saldos y gaveta de una vez; replicarlo a mano es el riesgo que trabó el canario KR (no se pudo dar de baja). (b) sólo como respaldo y sólo después de KR.17. (c) se descarta: rompe todo lo que lee el ticket del ODS (tienda en vivo, TK, sell-out, comisiones, global) | Edgar y Dirección (costo y plazo del proveedor: NO MEDIDOS) |
| D2 | Dónde corre la caja | Web servida desde md · app instalable que vende sin red · servidor local por sucursal | **App instalable sin red**: base local, cola persistente con UUID, folio propio. Hoy la caja depende del servidor de Kepler en la LAN; una caja en la nube sin modo sin red agregaría un modo de falla nuevo | Técnica · decidida |
| D3 | Qué aplicación | Módulo de `apps/view` · app nueva | **`apps/caja`** nueva, a pantalla completa, con el patrón offline de `apps/vendor`. La supervisión vive en Suite › Tienda (`/tienda/cajas`), con entrada en el menú | Técnica · decidida |
| D4 | Piloto | — | **Yurécuaro, una caja con serie nueva** creada desde la pantalla de Kepler (nunca por SQL), con la caja de Kepler de respaldo | Edgar (personas) |
| D5 | Hardware | Impresión del navegador · impresora de red con SDK · agente local | **Impresión del navegador en modo kiosco** (ya probada en la reimpresión de TK) con cajón por el driver; lector como teclado con prefijo y Enter; báscula por Web Serial. Agente local sólo si el censo (PDV.6) lo pide. Nunca WebUSB en Windows | Técnica · tras el censo |
| D6 | Factura | Kepler timbra · la Suite timbra | **Kepler sigue timbrando**: factura por ticket en mostrador y global diaria. El emisor de la Suite queda dormido. Autofactura: otra fase | Técnica · decidida |
| D7 | Identificar al cliente | Obligatorio · opcional | **Opcional, una tecla** (teléfono, QR del portal o RFC), con aviso de privacidad simplificado. La meta de identificación la pone Dirección | Dirección (meta) |
| D8 | Precio y promociones | Motor nuevo · el de cotizaciones | **El de cotizaciones**, sacado a funciones puras en `libs/` que corren en la caja y en el servidor: cierra `[VAC.L2]`. Promociones y escalera se siguen configurando en Kepler. El «nivel de precio» por transacción (ERP_KEPLER §2.7) pasa a ser una elección visible, con motivo y autorización | Técnica · decidida |
| D9 | Devoluciones | — | **Primera versión:** cancelar antes del corte, con supervisor. La devolución de otro día sigue en Kepler (factura del ticket + nota) hasta que D1 lo permita | Técnica · decidida |
| D10 | Ruta vecinal cobrada en caja | — | **Fuera de la primera versión** (2,904 tickets en 28 días siguen en Kepler) | Técnica · decidida |

---

## 7. Qué NO incluye

- Reemplazar Kepler: inventario, cartera, contabilidad, compras y la factura global siguen allá.
- Timbrar CFDI en la Suite y el portal de autofactura.
- Terminal bancaria integrada (en la primera versión la cajera teclea el monto en la terminal y captura
  autorización y últimos 4 dígitos).
- Venta a crédito (`U-D-9` tuvo 0 documentos en 28 días), apartados, ruta vecinal, telemarketing y el CEDIS.
- Lealtad por puntos y promociones nuevas.
- Por regla del repo: credenciales de PAC o de terminales, CORS, y cualquier escritura en Kepler sin D1.

---

## 8. El orden

| Orden | Frente | Por qué va ahí |
|---|---|---|
| 1 | **El gemelo y el motor único** (PDV.1–PDV.4, PDV.11–PDV.12) | Dinero que se decide hoy con 4 resolvedores distintos; sirve aunque la caja no se construya; no pide firmas |
| 2 | Censo, conectividad y cronómetro (PDV.6–PDV.8) | Baratos, y sin ellos D5 y la métrica 3 se deciden a ciegas |
| 3 | D0 y D1 (PDV.9) | Bloquean el piloto, no el trabajo de arriba |
| 4 | C1 y C2 restantes | Sólo con G0 |
| 5 | C3 | Sólo con G1 |
| 6 | Piloto y despliegue | Sólo con G2 |

---

## 9. Las capas

### C0 · Dato — 2 semanas

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| PDV.1 | El ticket de mostrador completo en `analytics.erp_sale_tickets` (se extiende la vista; no hay tabla nueva): hora `c62`, usuario `c67`, apertura `c80`, formas de pago `c83`–`c88`, recibido y cambio `c97` | ⬜ | Σ formas de pago = `c16` (hoy 25,582/25,582) |
| PDV.2 | El renglón completo en `analytics.erp_sale_ticket_lines`: presentación capturada (`c55`) y asentada (`c11`), lista (`c66`), IVA (`c17`), IEPS (`c18`), promoción | ⬜ | Σ renglones = `c16` al centavo en los 90,428 |
| PDV.3 | Catálogo de caja por sucursal (vista `derive-no-copy`): presentaciones y factores (`kdii` `c11/c80/c81/c83/c84`), precio por presentación (`c90`–`c92`), escalera (`kdpv_prod_util`), 4 promociones con saldo y vigencia, impuestos (`c18/c19`) y código de barras por presentación | ⬜ | 200 códigos leídos del anaquel de Yurécuaro resuelven a la presentación y precio que cobra Kepler |
| PDV.4 | **El gemelo**: reproducir los 90,428 tickets renglón por renglón (precio, impuestos, promoción, total), extendiendo `scripts/kepler/replay-cotizacion/` | ⬜ | ≥ 99.5 % al centavo; el resto clasificado (nivel de precio, captura manual, promoción) |
| PDV.5 | La gaveta de Kepler decodificada (`kdpv_folio_caja` `c43`–`c49`: fondo, límites, efectivo acumulado, retiros) | ⬜ | `c49` contra Σ efectivo de los tickets del turno |
| PDV.6 | Censo de las 37 cajas: PC, navegador, impresora, cajón, lector (sufijo), báscula y su etiqueta | ⬜ | Ficha con foto por caja, de cada encargado |
| PDV.7 | Cortes de red por sucursal en 30 días, leídos del atraso de la réplica lógica | ⬜ | Si no hay historial, se instrumenta y se declara NO MEDIDO |
| PDV.8 | Línea base de velocidad: 100 tickets cronometrados en hora pico en 2 cajas de Kepler | ⬜ | Segundos por ticket, por renglón y de cobro, con forma de pago |
| PDV.9 | D0 y D1 firmadas | ⬜ | Firmas escritas en §6 con fecha |

**Compuerta G0:** PDV.4 ≥ 99.5 % (o el residuo aceptado por escrito) y PDV.9.

### C1 · Dominio — 3 semanas

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| PDV.11 | Motor de precio único: la precedencia de `QuotePricingService` en funciones puras de `libs/`, mismas en servidor y caja (cierra `[VAC.L2]`) | ⬜ | El gemelo sobre este motor da lo mismo que PDV.4 |
| PDV.12 | Impuestos incluidos en el precio al público, base derivada y redondeo de Kepler | ⬜ | IVA e IEPS de los 90,428 al centavo |
| PDV.13 | Ticket = serie de eventos con UUID y marcas de tiempo (primer escaneo, total, pago, impresión); nada se borra. Se generaliza `commercial.pos_line_voids` (0 filas) en vez de abrir otra bitácora | ⬜ | Borrar o editar un evento lo rechaza la base |
| PDV.14 | Turno = cajero + gaveta: fondo contado, retiros con folio, aviso y máximo, cierre ciego por denominación reusando `reconciliation_blind_counts`, conciliación por supervisor | ⬜ | Un relevo de cajera obliga a contar al entregar |
| PDV.15 | Permiso de tres valores por acción (permitido / pide autorización / negado); autorización con credencial propia | ⬜ | Una cajera no puede autorizarse a sí misma |
| PDV.16 | Folio de caja asignado en el dispositivo y ligado al folio de Kepler | ⬜ | Dos cajas sin red no repiten folio |
| PDV.17 | Matriz de operaciones sin red, como dato | ⬜ | Cada operación bloqueada tiene su prueba |

El núcleo (catálogo local, cola, cobro, corte) vive en `libs/` para que Venta en Ruta
([`FASE_VR`](FASE_VR_VENTA_EN_RUTA.md)) lo use después (ADR-056).

### C2 · API — 2 semanas

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| PDV.20 | `GET /pos/catalog?warehouse=` instantánea + cambios desde versión | ⬜ | no | < 500 ms |
| PDV.21 | `POST /pos/sessions`, `/drops`, `/close` | ⬜ | sí | En el CI, con el payload de las pantallas 1, 11 y 12 |
| PDV.22 | `POST /pos/tickets` por lote, idempotente por UUID; no recalcula lo cobrado (lo verifica y marca la diferencia) | ⬜ | sí | El mismo lote dos veces deja un ticket |
| PDV.23 | `POST /pos/approvals` + aviso al celular por el WebSocket `/store` | ⬜ | sí | Vencida o de otra sucursal → rechazada |
| PDV.24 | Envío a Kepler según D1, ticket por ticket, y conciliador contra el ODS al centavo, con alarma por evento (no nocturno) | ⬜ | sí (Kepler) | En el entorno que fije D1 |
| PDV.25 | Consulta, reimpresión «COPIA» y cancelación, reusando la búsqueda TK | ⬜ | sí | Toda reimpresión queda en bitácora |
| PDV.26 | Claves `STORE_POS_*` en `libs/contracts` y **repartidas** en prod a cajero, auxiliar y encargado | ⬜ | sí (permisos) | Verificado leyendo prod |

**Compuerta G1:** todos los endpoints que escriben ejercidos en el CI; el envío a Kepler probado en el
entorno de D1.

### C3 · UI — 4 semanas

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| PDV.30 | `apps/caja`: instalable, base local, cola persistente | ⬜ | app nueva |
| PDV.31 | Apertura, venta, búsqueda con presentación, cobro y ticket de 80 mm (reusa `ticket-venta.ts`) | ⬜ | sin fallas nuevas |
| PDV.32 | Consulta, reimpresión, cancelación, autorización en caja y en celular | ⬜ | sin fallas nuevas |
| PDV.33 | Retiro, corte ciego y pantalla al cliente | ⬜ | sin fallas nuevas |
| PDV.34 | Hardware según el censo | ⬜ | probado en la caja piloto |
| PDV.35 | `/tienda/cajas`: supervisión por excepción, con menú y permiso | ⬜ | < 500 ms |
| PDV.36 | Observaciones de diseño del plan (§13) convertidas en items | ⬜ | — |

**Compuerta G2:** 3 cajeras de Yurécuaro cobran 30 tickets reales cada una en igual o menos segundos que
la línea base de PDV.8.

### Piloto y despliegue

| # | Item | Estado |
|---|---|---|
| PDV.50 | Piloto: Yurécuaro, una caja con serie nueva en Kepler, 2 semanas, con la caja de Kepler de respaldo | ⬜ |
| PDV.51 | Antes y después de las tres métricas, con la misma consulta | ⬜ |
| PDV.52 | Una sucursal por semana: Zamora Centro, Canindo, La Piedad Abastos, Morelia Madero, Morelia Abastos, Padre Hidalgo, 8 Esquinas | ⬜ |

**Compuerta G3, por sucursal:** 0 tickets sin llegar a Kepler, 100 % de los eventos con rastro y el
corte cuadrado o con su diferencia explicada.

**Semanas estimadas** (un desarrollador; las corrige el dueño): C0 2 · C1 3 · C2 2 · C3 4 · piloto 2 +
2 de holgura · despliegue 7.

---

## 10. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| D0 sin firmar | Dirección General | ADR-086 y ADR-110 dicen que cobrar sigue en Kepler | Firma de D0 y un ADR que acote ADR-110 al mostrador (texto en §15) |
| D1 sin respuesta | Edgar | No hay forma documentada de dar de alta un `U-D-10` desde fuera | Respuesta del proveedor de Kepler, con costo y plazo |
| Cupo | Edgar | 6 🔨 contra 4 | Cerrar o pausar 3 para abrir ésta (el gemelo puede avanzar como `[VAC.L2]` sin abrirla) |
| Escritura a Kepler apagada | Edgar | Canario KR: no se pudo dar de baja el documento escrito | Desplegar KR.17 y un canario que pruebe la baja desde la pantalla de Kepler |
| Nivel de precio por transacción | Comercial | Lo decide quien captura; no es derivable | PDV.4 mide cuánto pesa en mostrador; Comercial fija la regla |
| IEPS de la distribuidora e IVA del agua embotellada (`59000`, `59108` con IVA 0) | Contabilidad | A validar contra LIEPS art. 2 fr. I J / art. 8 y LIVA art. 2-A | Revisión del contador; si algo está mal, se corrige en Kepler y el gemelo lo sigue |
| El proveedor cambia su caja sin aviso | Edgar | Versiones distintas por sucursal | El gemelo corre de continuo y alarma por desviación |
| Hardware y conectividad sin medir | encargados de sucursal · dev de C0 | Nadie lo ha levantado | PDV.6 y PDV.7 |

---

## 11. Benchmark mundial, en corto

Se revisaron Square, Shopify POS, Toast, Lightspeed (X y R), Clover, Odoo (código fuente), Oracle Xstore,
Microsoft Dynamics 365 Commerce, SAP Customer Checkout, Loyverse, NCR Emerald y Toshiba ELERA, y prácticas
de caja de Aldi, Costco, Sam's Club y Apple. Fuentes oficiales o código; NCR y Toshiba sólo publican
marketing (NO VERIFICADO cómo operan sin red). El detalle por patrón, con sus fuentes, está en el lienzo.

**Las 10 lecciones, de mayor a menor impacto para un mostrador de mayoreo:**

1. **Nada se borra:** anular es un evento con autorizador y motivo (ARTS *VoidsLineItem*, Xstore, Toast).
2. **Idempotencia desde la caja:** UUID por ticket + llave única + cola persistente (Odoo, Square).
3. **Teclado primero y la presentación en el código:** `N*código`; el código de la caja agrega una CJA
   (soportar el ITF-14 a propósito); el kilo por báscula o etiqueta con prefijo 2.
4. **Un solo motor de precio determinista y explicado** (no «gana la promoción creada primero»).
5. **Turno = cajero + gaveta,** cierre ciego por denominación y conciliación con umbral (D365, Xstore, Odoo).
6. **Matriz de operaciones sin red** con contador de pendientes; crédito y devoluciones sin ticket, sólo con red.
7. **Excepciones por cajero y por autorizador** (Toast): anulación después del total, cajón sin venta.
8. **Hardware por red o agente local,** no WebUSB en Windows; el cajón por la impresora y como evento.
9. **El resumen del turno se deriva del detalle** (Odoo: un asiento por sesión; D365: cierre por turno).
10. **Menos pantallas al cobrar:** efectivo rápido desde el total (Toast), impresión automática, ticket con
    código, segundos por ticket medidos.

---

## 12. México: lo que la ley le pide a la caja

No sustituye la revisión del contador. Lo marcado NO VERIFICADO no se confirmó en fuente oficial.

| # | Requisito | Fundamento |
|---|---|---|
| R1 | Ticket con RFC y régimen del emisor, domicilio de la sucursal, fecha, folio consecutivo, cantidad, descripción y total | CFF 29-A fr. I y III; RMF 2.7.1.21; LFPC 12 |
| R2 | Precio total con impuestos visible; IEPS incluido en el precio al público | LFPC 7 Bis; LIEPS 19 fr. II |
| R3 | Global por sucursal (CP de la sucursal) a más tardar 24 h después del cierre; un concepto por ticket con su folio; IVA e IEPS desglosados — **hoy la hace Kepler, diaria** | RMF 2.7.1.21; Guía de llenado del CFDI global |
| R4 | Ticket ya incluido en una global que el cliente pide facturar: cancelar la global con motivo 04 y reexpedir, o egreso relacionado. No hay plazo de «mismo mes»; el límite es que la global siga cancelable | FAQ de cancelación SAT 2026; CFF 29-A (reforma 2026) |
| R5 | Facturar en mostrador al momento: el portal no puede ser el único medio | Criterio 01/CFF |
| R6 | No exigir la Constancia de Situación Fiscal | CFF 83 fr. IX (2026) |
| R7 | Devolución = CFDI de egreso; reembolso en la misma forma de pago salvo que el cliente acepte otra | Guía (Apéndice 2); LFPC 92 |
| R8 | IVA 0 % a dulce, chocolate y botana; 16 % a chicle, bebidas distintas de la leche, jarabes y saborizantes. IEPS 8 % a confitería, chocolate y botana ≥ 275 kcal/100 g | LIVA 2-A; LIEPS 2 fr. I J |
| R9 | Aviso de privacidad (simplificado en caja) y consentimiento aparte para fines comerciales | LFPDPPP 2025 |
| R10 | Báscula conforme a NOM-010 y con verificación vigente de PROFECO (periodicidad NO VERIFICADA) | NOM-010-SCFI-1994 |

Pagos: ENIF 2024 reporta **85.2 %** de pago en efectivo en compras de $500 o menos (coincide con el
80.2 % medido). Terminales con API para recibir el monto desde el software: Mercado Pago Point (API de
Orders), Clip Pin Pad (API para punto de venta), NetPay Smart PinPad, Kushki/Billpocket; Getnet y Banorte
NO VERIFICADO. La Ley de Economía Digital (aprobada en octubre de 2026, pendiente de publicarse) deja el
pago digital voluntario salvo en sectores que designe Hacienda.

---

## 13. Observaciones de diseño UI — revisión del plan (las 5 preguntas, `diseno` §0b)

Superficie: **Operations**. Se cargó la skill `diseno` antes de maquetar. Las maquetas usan los tokens de
`libs/design-tokens/tokens.css` (Hanken Grotesk, Geist Mono para cifras, `--action` sólo en la acción
principal, claro y oscuro).

| Pantalla | 1 · Qué ve y en qué orden | 2 · Qué NO ve | 3 · Accesibilidad de la información | 4 · Ligada a | 5 · ¿Le toca? |
|---|---|---|---|---|---|
| Apertura | Quién abre, el fondo que cuenta y los límites | El esperado de otros turnos | PIN personal; conteo por pieza, la caja suma | Gaveta de Kepler (`kdpv_folio_caja`) | Sí: sin turno no hay venta |
| Venta | Campo de captura, el ticket (lo último arriba de la vista), el total enorme | Costos, márgenes, existencias de otras sucursales | Teclado completo con el atajo escrito; escanear suma al renglón; mayoreo y «faltan N» en el renglón | Catálogo derivado del ODS; ticket → Kepler | Sí |
| Buscar | Resultados y la presentación con su precio y escalera | Productos sin precio para la sucursal | Búsqueda sin acentos ni orden; existencia de otras sucursales con la hora del dato | Catálogo de caja (PDV.3) | Sí |
| Cobro | Por cobrar, recibido, cambio; billetes rápidos | Totales del turno | Exacto en una tecla; el ticket sólo cierra en saldo cero | Gaveta del turno; formas de pago `c83`–`c88` | Sí |
| Ticket 80 mm | Lo que la ley pide (R1), ahorro por mayoreo, código | Folio de Kepler (lo ve la consulta) | Código para facturar y devolver | Global del día; factura por ticket en Kepler | Sí |
| Pantalla al cliente | Renglones, total, cambio, el siguiente peldaño | Nada interno | Letra para leerse a 1–2 m | — | Sí |
| Consulta | El ticket, su estado en Kepler y su bitácora | Tickets de otras sucursales | Por código, folio o fecha + total | `U-D-10` del ODS; conciliador | Sí |
| Sin conexión | Que la caja sigue; cuántos tickets en cola; qué no se puede | Detalle técnico | Estado con texto, no sólo color | Cola → Kepler | Sí |
| Autorización | Qué se pide, el efecto en el total, el motivo, la credencial | Historial de la cajera (lo ve el tablero) | Motivos de catálogo; aprobar desde el celular | Bitácora del ticket | Sí |
| Celular del supervisor | La petición y su efecto | Otras sucursales | Aprobar o rechazar en un toque, con huella o PIN | Bitácora; tablero | Sí |
| Retiro | Que hay que retirar, el conteo, quién recibe | Cuánto «debería» haber (conteo ciego) | Conteo por pieza; comprobante en dos copias | Gaveta; corte | Sí |
| Corte | Conteo ciego; después, al supervisor, esperado contra contado | El esperado, antes de entregar el conteo | No cierra con tickets pendientes | Corte `U-D-23` y cobro `U-A-5` (D1); CSU | Sí |
| Tablero `/tienda/cajas` | El veredicto, los turnos, las excepciones por cajera y por autorizador | Venta por producto (vive en Tienda › En vivo) | Cada número abre sus tickets; las cajas de Kepler dicen NO MEDIDO, no 0 | Bitácora; cortes; CSU | Sí: encargado y supervisor |

⛔ Antes del primer item C3 esta tabla se revisa con `auditoria-diseno` §9 y sus 🔴 se vuelven items.

---

## 13b. Auditoría de diseño de `/tienda/caja` construida (`auditoria-diseno`, 2026-11-03)

**Evidencia.** Nivel **A con datos de prueba**: la pantalla viva en el front local, con todo `/api`
contestado por Playwright (el respaldo de precios con 6 h de edad, el precio vivo en 503, un turno de
Kepler que pide retiro). Más nivel **C** (el componente). **Sin nivel B**: no se leyó producción,
por pedido de Edgar. El medidor de contraste arrancó con su control (negro/blanco = 21, blanco/blanco = 1).
Script y capturas: `scratchpad/auditoria-caja.js`, en la sesión del 2026-11-03.

**La frase.** *¿Cuánto cobro y está bien lo que llevo?* Una sola pregunta; la venta no es conflación.
Pero la **cabecera** contesta otra: *¿en qué estado están mi turno, el de Kepler y la gaveta?*
**Jerarquía medida:** primario = el total (56 px/700, domina) · secundario = el ticket (producto e
importe 18 px) · terciario = código, tasa y teclas (13 px). Está bien resuelta.

**Lo que está bien, medido:**
- El color de acción va en **6 elementos**: captura, modo, renglón seleccionado, empujón y Cobrar.
- Contraste ≥ 5:1 en claro y oscuro: texto tenue 5.28 y 5.25; Cobrar en oscuro 5.23.
- La venta se hace completa con teclado; `250 F12` cobra en un gesto.
- A 1024 px no hay desplazamiento horizontal.
- Las compuertas no marcan nada nuevo (`check:pantalla` con 0 nuevas, `estilos`, `templates`, `templates-types`).

| # | Sev | Hallazgo y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| PDV.UI.1 | 🔴 | **La frescura miente.** Con el precio vivo caído, todos los renglones salieron del respaldo de **hace 6 h**, y la píldora dijo **«Precios de Kepler ahora»**. Mide el `datos_al` del ODS de la sucursal, no la fuente de cada precio. `buscar()` sí devuelve `origen` y `snapshotAl`, pero la caja los ignora. Costo: el gemelo midió **125 renglones en un día** con cambio de lista a media jornada; con respaldo viejo se cobran con el precio anterior y nadie lo ve | ADR-056 · DESIGN §9 frescura · Datos añejos §10 | Si algún renglón del ticket salió del respaldo, la píldora dice **«Precios del respaldo de hace 6 h»** en tono de aviso, y el renglón lleva la marca «respaldo». Con todo vivo, dice «en vivo» |
| PDV.UI.2 | 🔴 | **«Cobrado $0.00».** Al cobrar sólo con tarjeta, el rótulo dice «Cobrado» y la cifra grande es el **cambio** (0). Se lee «no se cobró nada», justo en el momento de entregar la mercancía | Cruce 2 (rótulo contra celda) · Q.2 | Sin efectivo, la cifra grande es lo cobrado ($6.55) con su forma de pago. «Cambio» sólo aparece cuando hay efectivo |
| PDV.UI.3 | 🔴 | **El botón «Retiro F8» y la tecla F8 hacen cosas distintas.** Con el turno de Kepler abierto, la tecla abre el **arqueo real** («Mi arqueo · se guarda en Arqueo de Tienda»). El clic abre el **retiro de práctica** («Retiro de efectivo · conteo ciego»), que no llega a ningún lado mientras Kepler pide el retiro. El mismo rótulo hace dos cosas según la mano | Jakob (un rótulo, un efecto) · Cruce 2 | El botón llama al mismo manejador que la tecla |
| PDV.UI.4 | 🔴 | **«Práctica: no guarda ni manda a Kepler» es falso a medias.** El arqueo (F7, F8, Cerrar turno) **sí guarda** en Arqueo de Tienda, y la gaveta **sí abre** de verdad. La cajera cree que nada cuenta y entrega un corte real | Ley 0 del estándar · Cruce 3 (el nombre cubre todo lo que contiene) | El aviso dice **«Práctica: la venta no se guarda ni va a Kepler · el arqueo sí se guarda»**, y el panel de arqueo repite que es real |
| PDV.UI.5 | 🟠 | **En un ticket largo, el último escaneo queda fuera de vista.** Con 23 renglones, el último no se ve en la tabla (medido) y la selección queda abajo, escondida. Lo compensa la caja «Último escaneo», pero la tabla no acompaña al ojo | Doherty (la vista sigue la acción) · Keyboard-first | Al agregar o seleccionar un renglón, la tabla se desplaza hasta él |
| PDV.UI.6 | 🟠 | **La cabecera mezcla dos mundos y crece.** Ocupa 4 textos de estado + 6 botones: **2 renglones (89 px) a 1366 y 3 (124 px) a 1024**, y el trabajo empieza en **y = 213 de 768** (28 % es marco). Junta el turno de práctica («fondo $1,000 · 0 retiros») con el real de Kepler («caja 1 · folio · pide retiro») sin separarlos. Es la raíz de UI.3 | Hick · Gestalt (agrupar por mundo) · Tesler | Lo de Kepler va en un solo grupo rotulado «Kepler». «Pantalla del cliente» y «Conectar gaveta», que se usan una vez al día, van en un solo botón «Preparar caja». A 1366 cabe en un renglón |
| PDV.UI.7 | 🟠 | **«Conectar gaveta» se ofrece donde no puede funcionar.** En la 44Caja1 la Star BSC10 va por USB002, que el navegador no ve (medido el 2026-11-03). El botón abre un selector con sólo COM1 vacío | Poka-yoke · Ley 0 | Mientras no exista el agente local, el botón vive en «Preparar caja» y, si no hay puerto que conteste, dice «Esta caja necesita el agente de gaveta» |
| PDV.UI.8 | 🟠 | **A 1024 px el ticket cabe en 3 renglones**: el nombre del producto se parte en 3 líneas («LEVI / CHAROLA / 855/50») por la columna angosta. **NO MEDIDO** cuántas de las 37 cajas tienen 1024×768 (censo PDV.6) | Fitts/densidad · DESIGN §R | A 1024 el panel derecho baja a su mínimo y la columna Present. se funde en Cantidad («1 PAQ»): el nombre cabe en 2 líneas |
| PDV.UI.9 | 🟠 | **En Alto Contraste, «Cobrar» deja de parecer botón**: con `border: 0` queda como texto suelto (medido con `forced-colors`). Es la acción principal de la pantalla, en una flota de Windows | DESIGN §Ing.UI 3 (el tercer modo) | `.cj-cta` lleva un borde transparente de 2 px que Alto Contraste pinta |
| PDV.UI.10 | 🟡 | **El empujón de mayoreo va en el color de acción** (#C8401A, casi rojo): «Lleva 2 más y queda en $16.68» se lee como error. Hace un papel distinto (información) con el mismo tono que Cobrar | DESIGN §Color (acción sólo en CTA/activo/foco) | Tono neutro fuerte o verde de ahorro, como en la pantalla del cliente |
| PDV.UI.11 | 🟡 | **«mayoreo · antes $6.55» se parte en 3 líneas** dentro de Precio (verde, a 1366) y estira el renglón | Proximidad numérica | Una línea: «$5.97 · antes $6.55» |

**No medido, declarado:**
- Datos y volúmenes reales (sin nivel B), y el peso de `/api/kp/precios-todos` (Cruce 6).
- El INP con un ticket largo.
- Puntero táctil (`coarse`).
- Las resoluciones reales de las 37 cajas (PDV.6).
- La impresora y la gaveta reales dentro de la Suite.

⛔ Las cuatro 🔴 se cierran antes de que la caja deje de ser práctica, y se dan por cerradas con otra
pasada en nivel A, no con esta tabla.

**Segunda pasada en nivel A (2026-11-03, mismo script y mismos datos):**
- **Cerrados:**
  - **UI.1**: el aviso dice «Precios del respaldo de hace 6 h: Kepler no contestó en vivo» y cada renglón lleva «precio de respaldo».
  - **UI.2**: «Cobrado con tarjeta $6.55».
  - **UI.3**: el botón y la tecla F8 abren lo mismo.
  - **UI.4**: «la venta no se guarda ni va a Kepler · el arqueo sí se guarda».
  - **UI.5**: con 23 renglones, el último queda a la vista.
  - **UI.9**: Cobrar conserva su borde en Alto Contraste.
  - **UI.10** y **UI.11**.
- **Siguen abiertos:** UI.6 (la cabecera; con el aviso de respaldo ocupa más), UI.7 y UI.8.
- **Pedido de Edgar en la misma pasada:** «es muy complicado saber cuándo estoy en verificador o pasando un producto».
  - En la caja: el verificador pone la captura con borde punteado, una banda negra «VERIFICADOR DE PRECIOS · Lo que escanees NO entra al ticket · Esc vuelve a la venta» y el ticket apagado al 35 %.
  - En la pantalla del cliente: la consulta con el lenguaje de `/tienda/verificador` (nombre, «Por paquete», precio grande, escalones de mayoreo, de dónde salió el precio y «Esta consulta no se agregó a tu compra»).

---

## 14. Las consultas

Todas de sólo lectura sobre `pg-prod` (identidad verificada por `system_identifier`).

```sql
-- Volumen por sucursal y canal (3–30 oct). Mostrador = no vecinal ni ruta.
SELECT btrim(h.sucursal), canal, count(*) FILTER (WHERE estado<>'C') AS tickets, count(DISTINCT h.c5) AS cajas
FROM (SELECT h.*, coalesce(btrim(h.c43),'') estado,
        CASE WHEN btrim(v.c3) ILIKE 'RUTA VECINAL%' OR btrim(h.c12) ~ '^[0-9]+V[0-9]' THEN 'vecinal'
             WHEN btrim(v.c3) ILIKE 'RUTA %' OR btrim(h.c12) ~ '^1V' THEN 'ruta'
             WHEN btrim(h.sucursal)='06' AND btrim(h.c67) ~ '^500[1-9]$' THEN 'ruta'
             ELSE 'mostrador' END canal
      FROM kepler_ods.kdm1 h LEFT JOIN kepler_ods.kduv v ON v.sucursal=h.sucursal AND btrim(v.c2)=btrim(h.c12)
      WHERE h.c2='U' AND h.c3='D' AND h.c4=10 AND btrim(h.c1)=btrim(h.sucursal)
        AND h.c9::date BETWEEN '2026-10-03' AND '2026-10-30') h
GROUP BY 1, 2;

-- Formas de pago del ticket contra su total (24–30 oct): 25,582 de 25,582 cuadran.
SELECT count(*) FILTER (WHERE abs(efe+tc+td+chq+tr+otro - total) <= 0.01) AS cuadran, count(*) AS tickets
FROM (SELECT c16 total, coalesce(nullif(regexp_replace(c83,'[^0-9.-]','','g'),'')::numeric,0) efe,
             coalesce(nullif(regexp_replace(c84,'[^0-9.-]','','g'),'')::numeric,0) tc,
             coalesce(nullif(regexp_replace(c85,'[^0-9.-]','','g'),'')::numeric,0) td,
             coalesce(nullif(regexp_replace(c86,'[^0-9.-]','','g'),'')::numeric,0) chq,
             coalesce(nullif(regexp_replace(c87,'[^0-9.-]','','g'),'')::numeric,0) tr,
             coalesce(nullif(regexp_replace(c88,'[^0-9.-]','','g'),'')::numeric,0) otro
      FROM kepler_ods.kdm1 WHERE c2='U' AND c3='D' AND c4=10 AND btrim(c1)=btrim(sucursal)
        AND c9::date BETWEEN '2026-10-24' AND '2026-10-30' AND btrim(c12) !~ '^[0-9]+V[0-9]') t;

-- Tickets por caja-hora (hora del ticket en c62, al minuto).
SELECT percentile_disc(ARRAY[.5,.9,.99]) WITHIN GROUP (ORDER BY n)
FROM (SELECT btrim(sucursal), c5, c9::date, split_part(btrim(c62),':',1), count(*) n
      FROM kepler_ods.kdm1 WHERE c2='U' AND c3='D' AND c4=10 AND btrim(c1)=btrim(sucursal)
        AND c9::date BETWEEN '2026-10-03' AND '2026-10-30' AND btrim(c62) ~ '^[0-9]{1,2}:[0-9]{2}'
      GROUP BY 1,2,3,4) ch;   -- (en la medición se excluyeron además vecinal y ruta)

-- «Contado» del corte igual al esperado al centavo: 882 de 957.
SELECT count(*) FILTER (WHERE efectivo_contado = efectivo_esperado), count(*)
FROM analytics.cash_cuts WHERE cerrado AND business_date BETWEEN '2026-10-03' AND '2026-10-30';
```

Renglones y presentación: `kdm1 ⋈ kdm2` por `(btrim(sucursal), btrim(c1), c4::int, c5::int, btrim(c6))`
**con la fecha del renglón `kdm2.c32` = la del ticket** (los folios se reciclan, ERP_KEPLER §2.3), 24–30 oct.

---

## 15. Para registrar cuando se abra

No se tocó `CLAUDE.md` ni `02_DECISIONES_ARQUITECTURA.md`: el 2026-10-31 los dos tenían cambios sin
commitear de otra sesión (fila LE y ADR-112), y una edición aquí viajaría en su commit.

- **Fila del roadmap** (`CLAUDE.md`):
  `| **PDV** | Punto de venta de mostrador: caja de la Suite que vende sin red, deja rastro y manda el mismo ticket a Kepler | ⬜ |`
- **ADR propuesto** (número siguiente libre): *«La caja de mostrador de la Suite vende sin red y Kepler sigue
  siendo el libro»* — acota ADR-110 al mostrador cuando se firme D0; hereda ADR-056, ADR-059, ADR-083
  (mismo motor que cotizaciones) y la propuesta ADR-032 de Venta en Ruta (el dispositivo es la fuente de
  la venta; el servidor acepta y concilia).
- **Tracker:** los items `PDV.N` pasan a `01_TRACKER_PROGRESO.md` cuando la fase se abra; el gemelo puede
  avanzar antes como `[VAC.L2]`.

---

## 16. Definición de Terminado

- [ ] 1. Las tres métricas remedidas, antes/después publicado
- [ ] 2. Cada capa verificada o declarada NO MEDIDA (ADR-056)
- [ ] 3. Todo endpoint que escribe ejercido contra base real con el payload de la pantalla
- [ ] 4. Toda compuerta nueva rota a propósito una vez, rojo verificado
- [ ] 5. El núcleo de venta en `libs/`, compartido con VR, o deuda con nombre
- [ ] 6. Tracker, `03_LOG_REVISIONES.md`, roadmap y ADR al día
- [ ] 7. En prod en las 8 sucursales, o escrito por qué no y qué falta

---

## 17. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-10-31 | Plan, medición de prod, lectura del fuente de la caja de Kepler, benchmark y maquetas. Estado ⬜ por cupo | Claude (pedido de Edgar) |
| 2026-10-31 | Anexo [`FASE_PDV_ANEXO_CAJERO.md`](FASE_PDV_ANEXO_CAJERO.md): qué ve el cajero (psicología y visual), gramática de teclado con las teclas de Kepler (F9/F10/F11), una sola pantalla para vender y cobrar. Reemplaza al §13 en la pantalla de venta | Claude (pedido de Edgar) |
| 2026-10-31 | Anexo [`FASE_PDV_ANEXO_IMPLEMENTACION.md`](FASE_PDV_ANEXO_IMPLEMENTACION.md): plan por capas con tablas, módulos, endpoints y componentes, lo que se reusa del repo y las decisiones D-I1 a D-I4 | Claude (pedido de Edgar) |
| 2026-11-02 | [PDV.4] Gemelo, primera corrida (1 día: 1–2 nov, todas las sucursales): `REPLAY_DOC=UD10` en `scripts/kepler/replay-cotizacion/`. 4,939 tickets · 21,844 renglones · $1,682,767.70: **98.8 % de los renglones al centavo** (meta G1: 99.5 %); 4,713 tickets con todos sus renglones exactos, y en los 4,713 el importe = `c16` y el IVA/IEPS por tasa de producto cuadran. Diferencias: lista distinta 125, sin precio ($0.01) 63, presentación de 500 g 49, promoción que Kepler no aplicó 18, escalón 10. Control del motor re-anclado (02195 quedó viejo por cambio de precio en Kepler) | Claude (pedido de Edgar) |
| 2026-11-02 | [PDV.4] Hallazgos del gemelo: (1) los 125 renglones con lista distinta son TODOS del 1-nov, día en que Kepler cambió precios a media jornada (el motor cotiza con el precio de hoy); medida la lógica sobre los 21,656 renglones con la misma lista: **99.64 % al centavo**. (2) Promoción por cantidad con `saldo = 0` (`saldo_estado = sin_control`): el motor la aplica, el mostrador NO. En tickets U-D-10 de 14 días, reglas de umbral 1: `con_saldo` cobra bajo lista en 93 % (15,892 de 17,084); `sin_control` sólo en 26.5 % (195 de 736). En telemarketing la señal es débil (51 % vs 40 %). El cambio al motor espera el antes/después del replay en U-D-10 **y** U-D-40 | Claude (pedido de Edgar) |
| 2026-11-02 | [PDV.4] Motor: promoción con saldo 0 en tienda que lleva saldo = no se aplica (`motivoPromoSinSaldo`). Antes/después mismo universo: telemarketing idéntico (340/345); mostrador 18 → 1 promo indebida, lógica 99.64 % → 99.74 %. [PDV.31] `/tienda/caja` (modo práctica) y `/tienda/caja/cliente` en la Suite, commit 9c348ee1f | Claude (pedido de Edgar) |
| 2026-11-03 | Auditoría de diseño de `/tienda/caja` en nivel A con datos de prueba (§13b): 4 🔴 (la frescura dice «ahora» con precios del respaldo de 6 h · «Cobrado $0.00» con tarjeta · el botón Retiro y la tecla F8 hacen cosas distintas · «Práctica: no guarda» es falso para el arqueo y la gaveta), 5 🟠 y 2 🟡 | Claude (pedido de Edgar) |
