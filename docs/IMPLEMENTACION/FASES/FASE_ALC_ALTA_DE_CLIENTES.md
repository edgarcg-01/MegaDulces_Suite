# Fase ALC — Alta de clientes (el embudo que MCP dejó como módulo aparte)

> Plan escrito el 2026-11-04 a pedido de Francisco, con la forma de Kepler «Datos del cliente» del
> concentrador (`md_cat_cli_sc.kpl`) y una Constancia de Situación Fiscal (CSF) real de persona física
> como insumos. ⛔ **La CSF no se versiona** (RFC, CURP y domicilio de una persona; el repo es público):
> las pruebas usan constancias sintéticas.
> Método: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md). Nace de `[MCP]` D7
> ([`FASE_MCP_MESA_CONTROL_PREVENTA.md`](FASE_MCP_MESA_CONTROL_PREVENTA.md) §4 y §7).

```
OBJETIVO: Que dar de alta un cliente se haga UNA vez, desde su constancia o a mano, con los datos
          fiscales validados, sin duplicarlo, y que quede ligado a su clave de Kepler.
MÉTRICA:  Clientes de la Suite sin clave de Kepler — HOY (2026-11-04): 497 (187 con más de 90 días)
          → META: 0 con más de 1 día hábil, para <fecha que pone el PM>.
          Segunda: clientes de la Suite con régimen fiscal — HOY: 0 de 1,894 → META: 100 % de las
          altas hechas por este módulo.
CAPA TOPE: C3
ÁREA:      Comercial (toca Fiscal)
DUEÑO:     Francisco (lo pidió y lo construye; la escritura en Kepler, D1-b, es de Edgar)
ESTADO:    🧪 C0–C3 en código y probados en local el 2026-11-04 — empezada por Francisco POR ENCIMA
           DEL CUPO (7 fases 🔨 contra 4 y Fase 0 en curso): falta que el PM la ratifique en el tablero
```

> ⛔ **Lo que falta para ✅** (§11): la migración aplicada en prod, la prueba con base real corriendo
> en `pruebas-db` (aquí no hay base de pruebas: Docker apagado y `assert-safe-target` impide prod),
> ALC.0.3 (dónde guarda Kepler el régimen del receptor) y la revisión de diseño independiente.

Medido con `pg-prod` en sólo lectura (`system_identifier` 7688376744939610156, usuario `francisco`,
`transaction_read_only = on`) sobre `kepler_ods.kdud`, `kdm1`, `kdfe33*` y `commercial.customers`,
el 2026-11-04.

---

## 1. En una pantalla

Hoy un cliente nuevo se da de alta **tres veces o ninguna**: el vendedor lo crea en su app con un
código provisional `V-…` (nombre y, a veces, teléfono), alguien lo vuelve a capturar en Kepler en la
forma «Datos del cliente», y la sucursal liga una con otra a mano en `/almacen/clientes-nuevos`
(`[MCP.3.8]`). Los datos fiscales (RFC, régimen, CP fiscal) se teclean de la constancia en papel o en
PDF. No hay quién apruebe el crédito, no se guarda la constancia, y nada impide dar de alta dos veces
al mismo RFC.

| Hecho | Medido |
|---|---|
| Fichas en el maestro de Kepler (`kdud`) | **22,423** filas = **2,900 claves** distintas en 9 sucursales (2,353–2,764 por sucursal) |
| ⭐ El maestro es **compartido** | **2,291 de 2,900 claves (79 %) existen en las 9 sucursales**; 379 sólo en una («datos internos de la sucursal», el aviso de la forma) |
| …y no siempre igual | De 2,521 claves en más de una sucursal, **2,222 tienen el mismo nombre y RFC**; **299 difieren** entre sucursales |
| RFC real (no genérico, con formato válido) | **≈ 27 %** por sucursal (25.8 %–30.2 %). Genérico `XAXX…`/`XEXX…`: **15,086 filas (67 %)**; vacío: 682 |
| Correo · teléfono · CURP · CP de 5 dígitos | **3.9 %** · 15.6 % (3,487) · 5.5 % (1,244) · **95.7 %** |
| RFC real **repetido dentro de una sucursal** | 23–91 RFC por sucursal (02: 91 RFC en 191 fichas; 03: 89 en 191) |
| Clave | 5 dígitos numéricos en el 82 % de las fichas; la mayor es **30232**, la misma en las 9. La forma sugiere `00001` |
| Clientes de la Suite sin clave de Kepler | **497** `V-` (111 de 7–30 días · 199 de 30–90 · **187 de más de 90**); **0** creados en los últimos 7 días |
| …con pedidos | **30 clientes, 43 pedidos, $88,221.82** (`commercial.orders.total`) |
| …qué traen | 46 con teléfono · **0 con RFC** · 1 con autor (`created_by` se guarda desde MCP.3.8) |
| Datos fiscales en `commercial.customers` | 73 de 1,894 con RFC · **0 con régimen · 0 con uso de CFDI · 0 con CP fiscal** |
| Catálogos del SAT **ya en el ODS** | régimen `kdfe33satrf` (19 claves, con bandera física/moral) · CP `kdfe33satcp` (**95,748**) · uso de CFDI `kdfe33satuso` |
| La Suite ya escribe en Kepler en prod | requisición `X-A-30` (`compra`) encendida en 00–08 desde el 2026-10-28; `telemarketing` (COT.7) canario en 00, 01, 05, 06, 08 con tope 1/día |

### 1.1 La forma de Kepler, casilla por casilla

Del diccionario de formas ([`KEPLER_DICCIONARIO_FORMAS.json`](../KEPLER_DICCIONARIO_FORMAS.json),
`md_cat_cli_sc.kpl`, idéntico a `md_cat_cli.kpl`). Lo que la CSF trae se marca.

| Casilla | Columna | Tipo · largo | ¿La trae la CSF? |
|---|---|---|---|
| Clave | `kdud.c2` | texto (PK con `sucursal`) | no — la asigna Kepler o la Suite (D2) |
| Nombre | `c3` | texto 100 | ✅ nombre + apellidos, o razón social |
| Dirección (2 renglones) | `c4` · `c5` | texto 40 · 40 | ✅ vialidad, número, colonia, localidad (⚠️ hay que **componer y recortar a 40**) |
| Estado | `c6` | texto 40 | ✅ entidad federativa |
| Código postal | `c27` | número 5 | ✅ |
| Tel 1 · 2 · 3 | `c7` · `c8` · `c9` | texto 14 | no |
| RFC | `c10` | texto | ✅ |
| CURP | `c30` | mayúsculas 20 | ✅ (sólo persona física) |
| Email | `c11` | texto 60 | no |
| Vendedor · Grupo · Zona | `c12` · `c13` · `c14` | catálogo (`kduv` · `kduj` · `kduk`) | no — política comercial |
| Límite de crédito · Plazo | `c15` · `c16` | número | no — **dinero: se aprueba** (D3) |
| Descuentos (1)(2)(3) | `c17` · `c18` · `c19` | número 4 | no — `c17` es el descuento del cliente (`ERP_KEPLER.md` §2.6) |
| Comisiones S/Venta · S/Cobro | `c28` · `c29` | número 7 | no — `0.0000` en el 100 % |
| Dirección de entrega | `kdudent` (`c3` dirección … `c13` ruta asignada) | — | no — otra forma (`md_crmembentpag.kpl`) |
| **Régimen fiscal · CP fiscal** (CFDI 4.0) | ⛔ **no está en `kdud`** | — | ✅ — y es lo que el CFDI exige |

---

## 2. Cómo cambió el pedido

| # | Lo que se pidió | Efecto |
|---|---|---|
| 1 | MCP D7 (Francisco, 2026-10-08): *«embudo de altas de clientes en la Suite (manual o PDF); el pedido no se surte hasta que esté dado de alta. Módulo aparte»* | MCP sólo bloquea y declara el surtido de clientes sin clave |
| 2 | MCP.3.8 (2026-10-21): alta mínima del vendedor con «¿Es este?» + bandeja para ligar la clave | Resuelve la **liga**, no el alta: los datos fiscales y el crédito siguen sin dueño |
| 3 | Francisco, 2026-11-04: *«desarrollar un módulo para alta de clientes en la suite»*, con la forma de Kepler y una CSF | Esta fase. El alcance del PDF se vuelve concreto: **leer la constancia del SAT** |
| 4 | Francisco, 2026-11-04 (respuesta a §7): *«la firme en kepler, desarrollamos ahora la ficha y de la escritura en kepler lo haga edgar»* | D1-a ahora; D1-b (escribir `kdud`) queda para Edgar. Se construye C0–C3 sin esperar el cupo: **excepción al método, escrita aquí y pendiente de que el PM la ratifique** |

---

## 3. El universo y el trabajo

- **Universo:** 2,900 claves en Kepler y 1,894 clientes en la Suite.
- **Trabajo:** las **altas nuevas** (ritmo **NO MEDIDO**, ver §4) más los **497 `V-` sin clave**, de
  los que **30 tienen pedidos** ($88,221.82). Limpiar los 15,086 RFC genéricos o los 299 que difieren
  entre sucursales **no** es trabajo de esta fase (§6).

---

## 4. Lo que creíamos y cayó

| # | Lo que se suponía | Lo que midió prod |
|---|---|---|
| 1 | «Cada sucursal tiene su catálogo de clientes» | 79 % de las claves está en las 9; la forma es la del **concentrador** («capturados desde la nube»). Cómo se propaga una ficha nueva del concentrador a las sucursales: **NO MEDIDO** |
| 2 | «Las altas por mes se cuentan en Kepler» | `kdud` **no tiene fecha de alta** (`c1`, `c20`–`c23` vacías en las 22,423 filas). El proxy «primer documento en `kdm1`» se contamina con el arranque del ODS por sucursal (07 desde 2026-09-07, 08 desde 2026-09-18, 04 desde 2026-02-18): **NO MEDIDO** |
| 3 | «`kdfe33cedirfis` es la dirección fiscal del cliente» | Tiene **2–3 filas por sucursal**: es la del emisor, no la del receptor |
| 4 | «El régimen del cliente está en el maestro» | Las 31 columnas de `kdud` están decodificadas y ninguna es régimen ni uso de CFDI. Dónde lo guarda Kepler para timbrar: **NO MEDIDO** (ALC.0.3) |

---

## 5. Reglas que no se discuten

- ⛔ **La constancia NO se exige.** Pedirla para facturar es infracción (CFF 83 fr. IX, 2026 —
  [`FASE_PDV`](FASE_PDV_PUNTO_DE_VENTA.md) §12 R6). La CSF **prellena**; la captura a mano de RFC,
  nombre, CP fiscal y régimen está siempre disponible y vale lo mismo.
- ⛔ **Sin importer y sin copia** (regla 1–2): el maestro de Kepler y los catálogos del SAT se **leen**
  del ODS. La solicitud de alta y la constancia son **datos propios** (HITL): eso sí es tabla.
- **Aviso de privacidad** (LFPDPPP 2025, PDV R9): la CSF trae CURP y domicilio; se guarda con acceso
  por permiso y con plazo de resguardo (D5).
- Un endpoint que escribe no está probado hasta ejercerlo contra base real con el payload de la
  pantalla (regla 13). Escribir en Kepler, además, **necesita firma propia** (D1-b).

---

## 6. Qué NO incluye

- Limpiar el maestro de Kepler (RFC genéricos, fichas que difieren entre sucursales, duplicados por
  RFC). La fase **evita duplicados nuevos**; los viejos se **declaran** al dar de alta («este RFC ya
  tiene la clave X en N sucursales»), no se fusionan.
- Fusionar dos fichas de la Suite (ya fuera de MCP.3.8).
- Prospectos del CRM (`kdudp`).
- Facturar: la fase deja la ficha lista para el CFDI; el timbrado sigue en Kepler / Fiscal.
- Portal B2B: que el cliente se dé de alta solo (otra fase si se pide).
- Quitar el bloqueo `[VK.4]` (alta en rutas gobernadas por Kepler): depende de `[VK.7]`.
- Validar contra el SAT en línea, salvo que D4 lo pida.

---

## 7. Decisiones

| # | Decisión | Opciones | Recomendación · ✅ firma |
|---|---|---|---|
| **D1** | ¿Quién escribe la ficha en Kepler? | **a)** la Suite arma la ficha en el orden de la forma y la persona la captura en Kepler con un «copiar» por casilla; la Suite **encuentra sola** la clave nueva en el ODS (mismo RFC o nombre) y la liga · **b)** la Suite escribe `kdud` en Kepler, detrás de `kepler_push_switch` tipo `cliente`, canario 1/día | **a) primero, b) después.** (a) no pide firma de escritura y ya quita la doble captura de datos fiscales. (b) es el **tercer documento** que la Suite escribiría en Kepler (ADR-092 firmó uno; COT.7 pidió su firma aparte), y antes hay que medir cómo propaga el concentrador (§4.1): escribir en una sucursal puede no llegar a las otras 8, o pisar una clave local (el aviso de la propia forma). ✅ **Francisco, 2026-11-04: D1-a ahora; D1-b lo hace Edgar** |
| **D2** | ¿Quién asigna la clave? | Kepler (con D1-a) · la Suite, siguiente libre revisando las 9 · la Suite, en un rango reservado | Con D1-a, **Kepler** (✅ sale de D1). Con D1-b, **rango reservado**: es lo que la forma recomienda («una nomenclatura particular para los clientes capturados desde la nube») y evita chocar con las 379 claves locales — lo decide Edgar con D1-b |
| **D3** | ¿Quién da de alta y quién aprueba el crédito? | Alta: caja / encargado de sucursal · vendedor · telemarketing · crédito y cobranza. Crédito, plazo, descuento y comisión: ¿quién firma? | ✅ **Francisco, 2026-11-04:** da de alta *«cajero, encargado, auxiliar, vendedor (todos), gerente, dirección»*; aprueba **Crédito y Cobranza** y, en su ausencia, la **Gerencia Administrativa y Financiera** y **Dirección General**. En roles de prod (medido): alta → `cajero`, `encargado_tienda`, `encargado_bodega`, `auxiliar_tienda`, `vendedor_ruta`, `vendedor_telemarketing`, `telemarketing`, `supervisor_ventas`, `promotor_ruta` y `facturacion` (✅ Francisco, segunda respuesta), `gerente_compras`, `direccion`. ✅ Segunda respuesta: *«la persona que autoriza es Perla de Crédito y Cobranza, Paulina es gestora»* → crédito **por persona** a `perla_garcia` (su rol `finanzas_operativo` lo comparten 8) y, en su ausencia, roles `finanzas` (puesto `jefe_finanzas`) y `direccion`. El rol `credito_cobranza` (Paula Alanis y Gloria Vera) **no** autoriza. ⚠️ Inferido: «Paulina» = Paula Lissett Alanis (no hay ninguna Paulina en Crédito y Cobranza). Fuera: `auxiliar_compras` (5), `piso_tienda` (7) |
| **D4** | ¿Se valida contra el SAT en línea? | No (formato, dígito verificador, catálogos del ODS) · servicio del PAC · página del QR (`idCIF`) | **No en esta fase.** Lo fuera de línea atrapa los errores de captura; lo en línea es un servicio externo (ADR-040: integrar) que se decide aparte |
| **D5** | ¿Se guarda la constancia y por cuánto? | No guardar · guardar en el almacén de objetos con permiso y plazo | **Guardar**, con el `object-storage` que ya existe en `libs/platform-core`, visible sólo con el permiso del módulo, con fecha de emisión a la vista (una CSF vieja puede tener otro domicilio). Construido así (carpeta `alta-clientes/`, liga de 10 min). ⚠️ **Plazo de resguardo: sin firmar, lo fija Dirección** |

Lo que **no** depende de ninguna decisión: el lector de la CSF y las validaciones (C1) se pueden
construir con cualquier respuesta.

---

## 8. El orden

| Orden | Frente | Por qué ahí |
|---|---|---|
| 1 | **C0.3** — dónde guarda Kepler régimen y CP fiscal del receptor | Sin eso, «lista para Kepler» miente: la ficha quedaría sin el dato que el CFDI 4.0 exige |
| 2 | **C1** — lector de la CSF + validaciones + armado de la ficha | No depende de D1–D5; es lo que quita los errores de tecleo |
| 3 | **C2/C3 con D1-a** — solicitud, aprobación, bandeja, liga automática | Reusa la bandeja de MCP.3.8 (ADR-056: no otra bandeja) |
| 4 | **D1-b** — escribir `kdud` en Kepler | Sólo con firma y con la propagación del concentrador medida |

⚠️ **Cómo se hizo de verdad (2026-11-04):** 2 y 3 se construyeron **antes** que 1, a pedido de
Francisco. Mientras ALC.0.3 no se cierre, la Suite guarda el régimen y el CP fiscal en su propia ficha
(`commercial.customers`), pero **no sabe si Kepler los tiene** para timbrar: la pantalla no lo afirma.

Prioridad con la regla de Edgar: **dinero Bajo–Medio** (beneficio sobre todo indirecto: facturación
correcta, crédito con firma; directo, los $88,221.82 de pedidos de clientes sin clave) × **esfuerzo L**
(2–4 semanas para 1–3, estimado) → **prioridad 3–4**. El frente 2 solo es **M** y es el que más
fricción quita en caja.

---

## 9. Las capas

### C0 · Dato
| # | Item | Estado | Verificado contra |
|---|---|---|---|
| ALC.0.1 | Duplicados y liga leídos **directo de `kepler_ods.kdud`** (RFC `c10`, nombre `c3`, crédito `c15`/`c16`/`c17`). Cambió: **no** se toca `analytics.v_customer_master` (la usan otras pantallas; `vk_cartera_datos_kepler` ya hizo lo mismo) | 🧪 | Prueba con base real (fichas ficticias en la transacción) |
| ALC.0.2 | Catálogos del SAT leídos del ODS, sin copia: régimen `kdfe33satrf` (19 claves en prod; `c3` = física, `c4` = moral, `c6` = fin de vigencia), CP `kdfe33satcp` (95,748). `app_runtime` los lee (medido) | 🧪 | La CSF de prueba de persona física da 612 y 605; la de moral, 601 |
| ALC.0.3 | **Decodificar dónde guarda Kepler el régimen y el CP fiscal del receptor** | ⬜ | El XML de un CFDI timbrado por Kepler a un cliente con RFC real (`RegimenFiscalReceptor`, `DomicilioFiscalReceptor`) contra la columna candidata. Si la tabla no se replica al ODS, se declara |
| ALC.0.4 | `commercial.customer_onboarding_requests` (mig `20261104235236`): dato propio con `tenant_id`, auditoría, RLS `FORCE`, sin `DELETE` para `app_runtime`, `CHECK` de estados y montos, **un RFC propio con una sola solicitud abierta** (índice parcial). La ficha de la Suite sigue en `commercial.customers`: al ligar se llenan `rfc`, `legal_name`, `regimen_fiscal`, `billing_address.zip` (columnas que ya existían; **ningún `NOT NULL` nuevo**) | 🧪 | `up()` **NO EJECUTADO** aquí (sin base de pruebas): lo corre el CI al levantar la base (`dev-bootstrap-empty-db.js`) y la prueba de base real. ⚠️ Antes de prod, aplicarla una por una |
| ALC.0.5 | Las dos llaves repartidas en la misma migración (D3): `COMMERCIAL_ALTA_CLIENTES` a 10 roles y `COMMERCIAL_ALTA_CLIENTES_CREDITO` a 3 (+ `superadmin`). Falla si ninguna queda repartida (regla 20) | 🧪 | Se verifica en prod al aplicarla: el log dice qué roles quedaron en `true` |

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| ALC.1.1 | **Lector de la CSF** en `libs/platform-core/src/lib/sat/` (compartido: Fiscal, Compras y RH también reciben constancias). `pdf-texto.ts` lee el texto con su posición usando `pdf-lib`, **sin dependencia nueva** (la constancia la genera Oracle XML Publisher con Helvetica estándar en WinAnsi: medido); `constancia-situacion-fiscal.ts` lee por rótulo, une la segunda línea de un valor largo y la de un régimen largo, y separa el recuadro de emisión del de la cédula. Sin texto → `sin_texto`; fuente compuesta → `fuente_no_soportada`; nunca un campo inventado | 🧪 | 12 pruebas con constancias **sintéticas** (física con 3 regímenes y uno vencido, «Y Calle» en la página 2; moral con razón social en dos líneas y régimen largo; no-PDF, sin texto, no-constancia, sin RFC, estatus SUSPENDIDO). Las **dos constancias reales** se leyeron completas fuera del repo. Negativa: el umbral de segunda línea roto → rojo verificado |
| ALC.1.2 | `identidad-fiscal.ts`: RFC (forma, fecha, **dígito verificador**), CURP (forma, fecha, entidad, dígito), RFC↔CURP. Reglas de la solicitud en `alta-clientes.rules.ts` (régimen compatible con el tipo de persona, CP en el catálogo, catálogos de Kepler, montos, correo, «SA de CV» pegado al nombre) | 🧪 | 10 pruebas de identidad con anclas públicas (RFC de prueba del SAT, CURP de ejemplo de RENAPO) + 11 de reglas. **Testigo independiente:** de 760 RFC bien formados del maestro de Kepler, 736 (96.8 %) cuadran con el verificador; los 24 que no son capturas con un carácter cambiado. Negativa: la regla del RFC de la ficha rota → rojo verificado |
| ALC.1.3 | `ficha-kepler.ts`: la constancia → la forma de Kepler con la convención **medida** del maestro (estado corto `MICHOACAN`, razón social sin régimen de capital, `AV.`, `INT 6`). Lo que no cabe se reporta, no se corta | 🧪 | La constancia de prueba da exactamente la ficha de la captura de pantalla (`AV. FRANCISCO I MADERO PONIENTE 3600` · `VICENTE GUERRERO MORELIA` · `MICHOACAN`). ⚠️ La captura real dice `AV` sin punto: la convención mayoritaria del maestro es `AV.` (45 contra 9) |
| ALC.1.4 | Duplicados: RFC propio en cualquiera de las 9 → la clave y sus sucursales; RFC genérico → nombre parecido con el motor de MCP.3.8 | 🧪 | Prueba con base real |
| ALC.1.5 | `diferenciaDeCredito`: al ligar, si Kepler tiene otro límite, plazo o descuento que lo aprobado, queda escrito en la solicitud (Kepler manda; la Suite no lo corrige) | 🧪 | 3 pruebas |

### C2 · API (`/commercial/customer-onboarding`)
| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| ALC.2.1 | `POST constancia` → lectura + prellenado + hallazgos + duplicados + `regimenes_vigentes`; guarda el PDF (D5). `GET :id/constancia` → liga de 10 min | 🧪 | sí (almacén) | ⚠️ **NO MEDIDO** el almacén (la prueba lo simula apagado) |
| ALC.2.2 | `POST validate` (sin guardar) y `POST` (crear). Al crear, la lectura que se guarda es la del **PDF guardado**, no la que manda el navegador, y su RFC debe ser el capturado | 🧪 | sí | `test-newdb-alc-alta-clientes.js` — **corre en `pruebas-db`; aquí NO MEDIDO** |
| ALC.2.3 | `GET catalogs?branch=`: sucursales del alcance, vendedores `kduv`, grupos `kduj`, zonas `kduk`, regímenes | 🧪 | no | — |
| ALC.2.4 | `POST :id/credit` (sólo con la llave de crédito, motivo obligatorio; queda quién, con qué rol y cuándo) | 🧪 | sí | ídem |
| ALC.2.5 | `POST :id/link`: la clave debe existir en Kepler (su sucursal) y traer el **mismo RFC**; tres casos — ya hay ficha en la Suite (ancla de VK.4) · completa un `V-` (la liga es la de MCP.3.8, reusada) · ficha nueva `K<sucursal>-<clave>`. La bandeja muestra la ficha de Kepler con el mismo RFC para ligar en un clic, **sin ligar sola** (un GET no escribe) | 🧪 | sí | ídem; ⚠️ el caso `V-` NO se ejerce en la prueba |
| ALC.2.6 | `POST :id/cancel` con motivo | 🧪 | sí | ídem |
| ALC.2.7 | *(D1-b, de Edgar)* Escribir `kdud` en Kepler, clonando una ficha plantilla como hace KR con `kdm1` | ⬜ | **en Kepler** | ⛔ ensayo en una sucursal, visto en la pantalla de Kepler, como KR.1 |

### C3 · UI (`/comercial/alta-clientes`, menú «Venta y clientes»)
| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| ALC.3.1 | Alta en `p-dialog`: «Subir su constancia» o «Capturar a mano» (lado a lado: la constancia no se exige) → datos fiscales · ficha de Kepler en su orden con contador de caracteres · sucursal y cartera · crédito. Hallazgo junto a su casilla; RFC/CURP/CP de la ficha siguen a los fiscales; cancelar con algo capturado pregunta | 🧪 | pantalla nueva → **0 fallas, cumple las 10 reglas** |
| ALC.3.2 | Bandeja: lo pendiente contado arriba (crédito por aprobar · por capturar en Kepler, cuántas ya tienen su clave allá · ligadas), filtro segmentado con conteos, búsqueda por nombre/RFC/folio, `p-table`; detalle en `app-side-peek` con la ficha **para copiar casilla por casilla**, la decisión de crédito, ligar y cancelar (separado y en rojo). Frescura del maestro de Kepler desde `kepler_ods._sync_status` | 🧪 | ídem |

Las cinco preguntas de `diseno` §0b se contestaron antes de la plantilla y viven en el encabezado de
`comercial-alta-clientes.component.ts`. ⚠️ **Sin validación visual**: la pantalla no se ha visto en un
navegador. ⚠️ La revisión de diseño independiente (`auditoria-diseno` §9) **no se hizo**: queda como
deuda antes de soltar.

---

## 10. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Se construyó por encima del cupo | Edgar | 7 fases 🔨 contra un tope de 4; Fase 0 en curso. Francisco pidió construirla ya | Que el PM la ratifique en el tablero (y diga cuál pasa a ⏸️) |
| D1-b (escribir `kdud`) y D2 con D1-b | Edgar | Tercer documento que la Suite escribiría en Kepler | Su firma, con la propagación del concentrador medida |
| D4 (SAT en línea) y plazo de resguardo de D5 | Edgar (D4) · Dirección (D5) | Servicio externo · dato personal | §7 |
| Régimen del receptor en Kepler sin ubicar | quien tome ALC.0.3 | No está en `kdud` ni en las tablas `kdfe33*` del ODS | ALC.0.3 contra un CFDI timbrado |
| Propagación del concentrador sin medir | Edgar (con D1-b) | La forma escribe «en la nube»; no sabemos cómo baja a las sucursales | Medir antes de cualquier escritura |
| ~~Constancia de persona moral para pruebas~~ | — | ✅ Francisco la dio el 2026-11-04; se usó para armar la sintética y no se versiona | — |

---

## 11. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida**, antes/después publicado — después de soltar
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056) — falta ALC.0.3
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla — escrita
      (`test-newdb-alc-alta-clientes.js`), falta verla verde en `pruebas-db`; el caso `V-` y el almacén, NO MEDIDOS
- [x] 4. Toda prueba nueva **rota a propósito una vez**, rojo verificado (lector y regla, 2026-11-04)
- [x] 5. El lector de la CSF y las validaciones de RFC/CURP en `libs/platform-core` (compartido) — las
      cinco regex sueltas de RFC que ya había quedan como deuda: `[ALC.9]`
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día — tracker y roadmap sí
- [ ] 7. **En prod**, o escrito por qué no y qué falta — falta aplicar la migración y soltar

---

## 12. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-04 | Plan escrito con prod medido en sólo lectura. Queda ⬜: sin cupo | Francisco + Claude |
| 2026-11-04 | Francisco firma D1-a, D3 y da la constancia de persona moral; pide construir ya. C0–C3 en código: 39 pruebas unitarias en verde, prueba con base real escrita (corre en CI), `check:pantalla` 0 fallas. Sin commit: había una fusión ajena a medias en el árbol compartido | Francisco + Claude |
