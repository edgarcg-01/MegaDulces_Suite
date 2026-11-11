# Fase WMS · Anexo CE — Toda entrada con caducidad

> Anexo de [`FASE_WMS_ESTACION_RECEPCION.md`](FASE_WMS_ESTACION_RECEPCION.md) y [`FASE_WMS.md`](FASE_WMS.md).
> **No es un WMS nuevo**: el 80 % de la maquinaria ya está en prod. Es un plan para **aterrizarla,
> cerrar sus huecos y hacer que se use**. Método: [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).

```
OBJETIVO: que cada renglón que entra a un almacén (compra o traspaso) quede con su caducidad —o con
          «no caduca» declarado— el mismo día, para mover el producto por FEFO antes de que haya que
          rematarlo en promoción.
MÉTRICA:  % de renglones de entrada de Kepler con caducidad capturada o «no caduca» declarado
          HOY (2026-11-11): < 1 %  — 12 vales con alguna fecha contra ~2,370 entradas de compra del
          1-sep al 10-nov; 0 capturas desde el 7-oct.
          → META: ≥ 90 % en el piloto (CEDIS + Padre Hidalgo) 4 semanas después de arrancar;
            ≥ 90 % en los 9 almacenes 8 semanas después.
MÉTRICA 2: lotes con existencia que tienen fecha — HOY 148 de ~25,000 (0.6 %).
CAPA TOPE: C3 (las pantallas ya existen; el trabajo nuevo es C0–C2 y la adopción en piso)
ÁREA:      Almacén / Comercial
DUEÑO:     Edgar (PM) · en piso: ⚠️ por asignar (pregunta 1)
ESTADO:    🔨 — abierta por Edgar el 2026-11-11 por encima del cupo (D0: «nosotros ahora, te autorizo todo»)
```

**Cómo se midió:** consultas de sólo lectura a `pg-prod` (`system_identifier` 7688376744939610156),
2026-11-11. Ventanas: capturas y vales desde su inicio (19-ago); entradas de Kepler 1-sep→10-nov
(`analytics.erp_goods_receipts`, sin duplicados); carga diaria con los últimos 60 días.

---

## 1. En una pantalla

El negocio reporta que **mucha mercancía termina en promoción por caducidad** y que **no se le pone
fecha al recibirla**. Lo segundo es cierto y medido. Lo primero no se puede medir hoy: la promoción se
da de alta en Kepler y nada registra que su motivo fue la caducidad (**NO MEDIDO**, item CE.0.4).

La suite **ya tiene** el andén con vale (`VE-`), foto + OCR de la etiqueta, semáforo de vida útil,
trabajo sin red, bandeja «Por fechar», inventario por lotes con FEFO, tablero «Por vencer», alertas y
un motor que sugiere mover / devolver / promover lo que no alcanza a venderse. **Se usó tres semanas
y se dejó de usar.**

| Evidencia (prod, 2026-11-11) | Valor |
|---|---|
| Capturas de caducidad en la entrada, total histórico | 58 (48 aceptadas, 10 caídas por falla técnica) |
| Última captura / último vale | 7-oct-2026 |
| Personas que capturaron | 2 |
| Almacenes con alguna captura | 4 de 9 (CEDIS, Padre Hidalgo, La Piedad Abastos, 8 Esquinas) |
| Vales abiertos que nadie cerró | 26 (el más viejo, 19-ago) |
| Políticas de vida útil cargadas | **0** |
| Capturas aceptadas con fecha ya vencida | 3 (entraron en verde) |
| Capturas con fecha «redonda» (31-dic, 1-ene, 12-dic…) | 30 de 48 — parecen estimadas, no leídas |
| Lecturas del OCR | 0 (de 17 fotos) |
| Renglones de las revisiones de sucursal **ya vencidos al encontrarlos** | 39 de 134 (29 %) |
| SKUs con vida útil en Kepler (`kdii.c101`) | 87 de 9,594 (≈ 1 %) |

---

## 2. El universo y el trabajo

- **Universo:** ~190 renglones de entrada de compra por día en 9 almacenes (11,583 en 60 días),
  3,054 SKUs distintos, 236 proveedores. Más los traspasos CEDIS → sucursal (**NO MEDIDO** por
  renglón/día, item CE.0.3).
- **Trabajo del piloto:** CEDIS (≈ 66 renglones/día) + Padre Hidalgo (≈ 39/día) ≈ **105 renglones/día**.
- **Lo que reduce el trabajo:** una parte de lo que entra **no caduca** (bolsas, desechables). Hoy el
  operario lo declara renglón por renglón; marcarlo una vez por SKU o por departamento lo saca de la
  captura diaria (CE.1.1). El tamaño de esa parte es **NO MEDIDO**: `catalog.products` no tiene la marca.

---

## 3. Lo que creíamos y cayó

| # | Lo que se decía | Lo que midió prod / el código |
|---|---|---|
| 1 | «No tenemos WMS de entrada» | Existe y está en prod: Andén, vale, OCR, semáforo, sin red, Por fechar, FEFO, Por vencer (inventario en §5) |
| 2 | «Kepler trae la vida útil del producto» | `kdii.c101` («Días de caducidad») está lleno en 87 de 9,594 SKUs, y la unidad no está probada |
| 3 | «El semáforo frena lo vencido» | Sin políticas no se aplica la vida útil mínima: 3 lotes vencidos entraron en verde |
| 4 | «Cerrar el vale exige caducidad» | Sólo la pantalla del Andén lo exige. El servidor cierra y deja lo no fechado en lote `NA`; la estación vieja (`inventory/recepcion-sesiones`) sigue viva y no pide fecha |
| 5 | «El OCR lee la etiqueta» | 0 lecturas en prod. Causa NO MEDIDA (¿falta la llave del proveedor de IA en el pod?) |
| 6 | «Por vencer muestra lo que hay en anaquel» | El trigger `fn_rebalance_stock_lots` descuenta primero el lote `NA`; un lote fechado **no baja con la venta mientras haya `NA`**. Con 99 % de `NA`, Por vencer puede mostrar lotes que ya se vendieron (inferido del código, NO MEDIDO) |
| 7 | «La gente dejó de usarlo» | Puede ser. La última captura (7-oct) es la víspera de la entrega del Andén nuevo (WMS-REC.17–21, 8-oct). **Hay que descartar un defecto antes de culpar a la gente** (CE.0.1) |

---

## 4. Decisiones (✅ D0–D6 firmadas por Edgar el 2026-11-11 con la recomendación → ADR-116)

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D0 | Cupo | (a) aterrizaje dentro de la campaña Fase 0, sin fase nueva; (b) pausar una 🔨 para abrirle lugar | **(a) para CE.0 y el piloto** (es aterrizar WMS-REC.17–22, que están 🧪). Los frentes CE.1–CE.3 sí escriben código y piden cupo: el PM elige qué pasa a ⏸️ |
| D1 | Dónde viven «no caduca» y la vida útil total por SKU | (a) columnas nuevas en `catalog.products`; (b) extender `commercial.expiry_receiving_policy`, que ya resuelve producto → departamento → proveedor | **(b)**: la cascada ya existe y una sola fila por departamento («BOLSAS: no caduca») cubre cientos de SKUs. Se agregan `tracks_expiry` y `shelf_life_days`. Semilla: `kdii.c101` (87 SKUs) + lo capturado |
| D2 | Vida útil mínima aceptable por departamento | La define el negocio, no Sistemas | Regla fija del sistema: **nunca aceptar ya vencido**. El resto (p. ej. «menos de un tercio de vida útil = amarillo») lo firma quien compra (pregunta 2) |
| D3 | ¿El servidor exige fecha para cerrar el vale? | (a) sí, salvo SKU «no caduca»; (b) sí, con «fecha pendiente» autorizada por supervisor; (c) no | **(b)**: no se frena la descarga del camión, pero lo no fechado deja de ser invisible: queda con nombre, motivo y quién lo autorizó |
| D4 | El trigger descuenta `NA` primero | (a) se queda (el `NA` es la existencia más vieja); (b) FEFO entre fechados antes que `NA` | **(a)**: es FIFO-coherente. Lo que lo arregla es la cobertura: cuando toda entrada lleva fecha, el `NA` se vacía solo. Se declara en Por vencer mientras el `NA` sea mayor que lo fechado |
| D5 | Estación vieja `inventory/recepcion-sesiones` | (a) retirarla; (b) dejarla | **(a)**: una sola interfaz por flujo. Es la puerta que cierra vales sin pedir fecha |
| D6 | Piloto | CEDIS + Padre Hidalgo · Morelia Abastos (mayor volumen, 73/día) · todos | **CEDIS + Padre Hidalgo**: CEDIS surte a las sucursales (su fecha viaja en el traspaso, CE.2.3) y Padre Hidalgo ya lo usó |

---

## 5. Qué ya existe y se reutiliza

| Pieza | Dónde | Estado | Uso en este plan |
|---|---|---|---|
| Vale `VE-` desde orden de entrada o traspaso, menú por sucursal | `commercial-receiving/receiving-session.service.ts` | prod | Tal cual |
| Captura lote + caducidad, semáforo `computeVerdict`, autorizar rojo | `receiving-auditor.service.ts` | prod | Se le cargan políticas (D1/D2) y la regla «ya vencido = rojo» |
| Política producto → departamento → proveedor | `commercial.expiry_receiving_policy` | prod, 0 filas | Se extiende (D1) y se siembra |
| OCR de la etiqueta | `platform-core/ai/llm-extractor.service.ts` `extractExpiryLabel` | prod, 0 lecturas | Se diagnostica (CE.0.2) |
| «Sin caducidad», fecha masiva por vale | `anden-caducidad.component.ts` | prod | «No caduca» pasa de decisión por renglón a dato del catálogo |
| Trabajo sin red + idempotencia `client_uuid` | `anden-offline.service.ts`, mig `20261007213847` | prod (mig aplicada) | Validarlo en un andén sin señal |
| Bandeja «Por fechar» | `pendingExpiry` | prod | Pasa a ser la cola de excepciones, no la vía normal |
| Llegadas (camiones que nadie abrió) | `receiving-arrivals.ts`, `ALMACEN_LLEGADAS_VER` | prod, sólo modo god | Se reparte al jefe de almacén (CE.3.2) |
| Inventario por lote + FEFO + vencido al final | `commercial.stock_lots`, trigger | prod | Tal cual (D4) |
| Por vencer + valor en riesgo | `GET /commercial/inventory/expiring` | prod | Tal cual, con la declaración de D4 |
| Alertas `expiring_lots` | `alerts-scanner.service.ts` | apagadas salvo `ENABLE_COMMERCIAL_ALERTS` (NO MEDIDO en prod) | Se encienden en el frente CE.3 |
| Revisión de caducidades de sucursal | `commercial-expiry-reviews` | prod, 16 revisiones | Testigo independiente de la fecha capturada en la entrada |
| Juicio por lote: caducado / no alcanza / a tiempo, sugiere mover, devolver o promover | `commercial-products/product-flow.ts` `juzgarLotes` | prod, sólo texto | Puente a la decisión (CE.3.1) |
| Reclamos al proveedor al cerrar el vale | `receiving-claims.service.ts` (`faltante`, `dañado`, `producto_incorrecto`) | 🧪 | Se agrega `caducidad_corta` (CE.2.4) |

---

## 6. Qué NO incluye

- **Escribir lote o caducidad en Kepler.** Kepler no maneja lotes; la suite es dueña de la fecha (ADR-044).
- **Dar de alta la promoción.** Se sigue dando de alta en Kepler. Este plan llega hasta **avisar a
  tiempo y proponer la acción**, no a rebajar el precio solo.
- FEFO en vendedor y portal (P2.5), conteo físico por lote (P2.4), ubicaciones (Fase UB), citas de
  andén / ASN (B.8) y devoluciones físicas a proveedor (B.9).
- Ningún importer ni cron nuevo: la semilla de `kdii.c101` es una lectura del ODS; todo lo demás es por evento.

---

## 7. El orden

| Orden | Frente | Por qué va ahí |
|---|---|---|
| 1 | **CE.0 Medir y reparar lo roto** | Sin saber si el Andén funciona en prod no se puede pedir que se use. Poco esfuerzo, destraba todo |
| 2 | **CE.1 El catálogo dice qué caduca y cuánto dura** | Quita del piso la mitad de las decisiones y le da al semáforo con qué juzgar |
| 3 | **CE.2 El servidor exige la fecha; el traspaso la hereda** | Cierra las puertas por donde entra mercancía sin fecha. La herencia CEDIS → sucursal hace que una captura sirva 8 veces |
| 4 | **Piloto CEDIS + Padre Hidalgo (4 semanas)** | Adopción medida a diario; con eso se decide extender |
| 5 | **CE.3 De la fecha a la decisión** | Es lo que ataca la promoción: avisar a los 60–90 días, mover entre sucursales o reclamar al proveedor antes de rematar |

---

## 8. Las capas

### C0 · Dato
| # | Item | Estado | Verificado contra |
|---|---|---|---|
| CE.0.1 | Descartar un defecto: abrir un vale de prueba en el Andén de prod en CEDIS y revisar los logs de `/commercial/receiving/*` desde el 7-oct. Preguntar en almacén por qué se dejó de usar | ⬜ | Logs de la API + un vale real |
| CE.0.2 | Diagnosticar el OCR (0 lecturas): llave del proveedor de IA en el pod y una foto de control con fecha conocida | ⬜ | Foto de control |
| CE.0.3 | Medir los traspasos CEDIS → sucursal por renglón y día, y qué parte de la entrada de cada sucursal llega por traspaso | ⬜ | `analytics.erp_shipment_lines` contra la entrada física |
| CE.0.4 | Medir el costo HOY de la promoción por caducidad: dónde lo registra Comercial (Kepler, hoja, nada) | ⬜ | Testigo que dé Comercial (pregunta 3) |
| CE.0.5 | Limpiar el pasado: corregir la doble captura de VOLT DARK (2,112 piezas dos veces, 18-sep), cerrar o cancelar los 26 vales abiertos, revisar los 3 lotes vencidos aceptados | ⬜ | Conteo físico del lote |
| CE.0.6 | Probar la unidad de `kdii.c101` (¿días?) contra una etiqueta física de 5 SKUs | ⬜ | Etiqueta |

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| CE.1.1 | `expiry_receiving_policy` + `tracks_expiry` y `shelf_life_days` (D1); semilla por departamento + `kdii.c101` | 🧪 | Migración idempotente, generada; cascada probada con base real |
| CE.1.2 | Regla fija: fecha ya vencida = rojo, haya o no política (el margen de días lo firma el negocio, D2) | 🧪 | Prueba de `computeVerdict` + prueba negativa |
| CE.1.3 | Fecha que no cabe en 1.5× la vida útil del producto = amarillo `beyond_shelf_life` (la heurística de «fecha redonda» se descartó: 12-dic o 31-dic pueden ser reales) | 🧪 | Prueba con las 48 capturas reales |
| CE.1.4 | Por vencer declara cuando el `NA` del producto supera lo fechado (D4) | ⬜ | Caso con `NA` > fechado |

### C2 · API
| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| CE.2.1 | `close` exige fecha por renglón salvo `tracks_expiry=false` o «fecha pendiente» autorizada (D3) | 🧪 | sí | ⛔ obligatoria, con el payload del Andén |
| CE.2.2 | Retirar la estación vieja `recepcion-sesiones` (D5) | 🧪 | — | Ruta 404 + menú |
| CE.2.3 | El vale de traspaso en la sucursal **propone** la fecha del lote que el CEDIS despachó por FEFO; el operario confirma | ⬜ | sí | ⛔ obligatoria |
| CE.2.4 | Reclamo `caducidad_corta` al proveedor desde un rojo rechazado | ⬜ | sí | ⛔ obligatoria |

### C3 · UI
| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| CE.3.1 | Por vencer con la acción de `juzgarLotes`: mover a otra sucursal, devolver, promover — con dueño y fecha | ⬜ | — |
| CE.3.2 | Llegadas repartida al jefe de almacén: el camión que Kepler recibió y nadie abrió es la bandeja del día | 🧪 permiso repartido a almacenista y supervisor en la mig (falta validación visual) | — |
| CE.3.3 | Tablero de adopción por almacén y día (la métrica de la cabecera) | ⬜ | — |

⛔ Cargar la skill `diseno` antes del primer item C3, y la sección de observaciones de diseño al final de este doc.

---

## 9. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Nadie en piso es dueño de fechar | ⚠️ por asignar | Se usó tres semanas y se dejó | Un responsable por almacén y la métrica diaria (CE.3.3) |
| Fechas inventadas | Almacén | Fechar 100 renglones a mano cansa | OCR funcionando (CE.0.2) + «no caduca» por catálogo + aviso de fecha sospechosa |
| Vida útil mínima sin número | Compras / Comercial | Es una regla de negocio | Pregunta 2 |
| Costo de la promoción por caducidad sin medir | Comercial | Se decide fuera de la suite | Pregunta 3 |
| Andén sin señal no probado en campo | Desarrollo | Nadie lo ha usado así | Prueba en el piloto |

---

## 10. Preguntas para el PM

1. ¿Quién es el dueño de la fase y quién responde por fechar en cada almacén del piloto?
2. ¿Quién firma la vida útil mínima aceptable por departamento (o por proveedor)?
3. ¿Dónde se registra hoy una promoción por caducidad y cuánto costó el último trimestre?
4. D0: ¿qué fase 🔨 pasa a ⏸️ para que CE.1–CE.3 tengan lugar?

---

## 11. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Toda compuerta nueva **rota a propósito una vez**, rojo verificado
- [ ] 5. Todo primitivo genérico en `libs/` compartido **o** deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta

---

## 12. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-11 | Plan escrito con el inventario de lo existente y la medición de prod (sólo lectura). Estado ⬜ por cupo | Claude (pedido de Edgar) |
| 2026-11-11 | Edgar firma D0–D6 («nosotros ahora»). En código: CE.1.1–1.3, CE.2.1–2.2, CE.3.2 (mig `20261111132543`, ADR-116). Hallazgos al construir: `catalog.products.department` vacía en los 14,945 productos (el departamento se deriva de Kepler `kdii.c4`→`kdie`); el aterrizaje del almacenista era la estación vieja que no pide fecha; sólo 9 personas (rol almacenista) + 1 supervisor tienen el permiso de recibir en `true`; 1 sola persona real fechó. Pruebas: 116 vitest de recepción (rojo verificado), 145 del Andén, `check:templates-types` verde. **Falta:** aplicar la mig en prod, desplegar api+view, validación visual, CE.0.x, CE.2.3–2.4, CE.3.1, CE.3.3 | Claude |
