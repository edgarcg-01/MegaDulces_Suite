# Fase ECA — Estado de cuenta de acreedores

> **Estado:** 🧪 ECA.0–ECA.2 en código, 2026-10-07 · ECA.7 (cancelados) 2026-10-10 · ✅ ECA.8 («programado para…», #521) en prod · ECA.9 (buscar, factura en un clic, «Agendar») 2026-11-20. Pedido de Francisco (Finanzas).
> **Pantalla:** `/finanzas/estado-cuenta-acreedores` (menú Finanzas › Pagos, junto a «Cuadre y deuda»).
> **API:** `GET /finance/creditor-statements` y `GET /finance/creditor-statements/:codigo`.
> **Permiso:** `FINANCE_PAYMENTS_VER` (el mismo del resto de Pagos) → sin migración, sin re-login.

## Qué resuelve

El reporte «Estado de cuenta del proveedor» de Kepler, para **todos** los acreedores y separado
por **tipo**: Mercancía, Servicios y Financieros (deuda). Cada documento que sube la deuda
(«Aplica Orden Entrada», etc.) sale con los pagos y notas de crédito que Kepler le aplicó, y su saldo.

Sólo lectura: los pagos se siguen capturando y aplicando en Kepler. Vista derivada del ODS, sin
importer ni tabla nueva.

## Decode (medido en prod, 2026-10-07)

| Tabla | Qué es | Columnas |
|---|---|---|
| `kdxd` | Catálogo de proveedores (777 en el 00) | `c2` clave · `c3` nombre · `c4–c6` dirección · `c7` teléfono · `c10` RFC · `c12` agente · **`c13` grupo** · `c14` zona · `c15` límite de crédito · `c16` días de crédito · `c24` comentarios |
| `kdxe` | Documentos de cuentas por pagar | `c1` almacén · `c2` acreedor · **`c3` naturaleza** (`A` sube la deuda, `D` la baja) · `c4`/`c5` tipo y subtipo · `c6` folio · `c7` fecha · `c10` vence (1800 = sin fecha) · `c11` importe · `c16` referencia · `c18` concepto |
| `kdxf` | **Casamiento**: qué cargo se aplicó a qué abono | `c2` acreedor · `c3` fecha · `c4/c5/c6` el cargo (pago) · `c7/c8/c9` el abono (factura) · `c10` importe aplicado |
| `kdmm` | Nombre del tipo de documento | `c1='X'` · `c2` naturaleza · `c3` tipo · `c4` subtipo → `c5` (20 = Aplica Orden Entrada, 26 = Transferencia a proveedor, 55 = Nota crédito…) |

- **El casamiento es estructural:** de 30,073 aplicaciones, las 30,073 van de un `D` a un `A`.
  Contra el reporte de Kepler de Mondelez (CM009, 01/08–31/10/2026) cuadran 5 documentos y
  8 aplicaciones al centavo. Es una mejora sobre CXP.8, que casaba factura↔pago por **FIFO estimado**.
- **Réplica cruzada:** la sucursal 03 trae 734 documentos de la 02 → `btrim(c1) = sucursal`.
- **El reporte de Kepler muestra «Clasificaciones» = zona (`c14`) + agente (`c12`)**, no el grupo.
- **Nombres de grupo deducidos.** El catálogo de nombres no llega al ODS; `c13` trae exactamente
  11 códigos, los mismos 11 del combo «Grupo» de Kepler y en el mismo orden, y cada uno cuadra con
  quién lo tiene (001 AMDIVED = Mondelez/Hershey/Effem · 002 Plásticos = Bolsas de los Altos ·
  100 Cómputo = Cyberpuerta · 120 Instituciones financieras = los bancos · 130 Servicios
  especializados = AT&T, contadores · 140 Financiamiento vehicular = STM). Viven en
  `GRUPOS_KEPLER` del motor; un código nuevo se muestra como «Grupo NNN».

## Regla de tipo (decisiones de Francisco, 2026-10-07)

La clave de Kepler ya separa casi todo; el Grupo sólo capturado en 43 de 777 proveedores.

1. `TI*` → **interno** (sucursales dadas de alta como proveedor). No se lista: no es deuda.
2. Grupo 140, o clave `A*` (préstamos), `B.B.*` (factoraje), `TC*` (tarjetas) → **Financieros**.
3. `C*` → **Mercancía**.
4. `G*` → **Servicios**, **incluidos los bancos `GB*`**: lo que se les debe son comisiones
   («IVA SER BANCA», $48), no créditos. *(Decisión 1.)*
5. Lo demás → **Sin clasificar**, visible, no adivinado.

Prueba negativa: si el grupo 120 entra a Financieros, la prueba de los bancos se pone roja (verificado).

## Hallazgos que se declaran en pantalla

- **Kepler dice $138.8M pendientes de mercancía y ContPAQi (2120, sep-2026) $79.4M.** De esos,
  **$59.9M son facturas en el Kepler de una sucursal con fecha anterior al 1-oct-2026**: hasta esa
  fecha el 00 concentraba y muchas se pagaron desde el 00 sin aplicarse en la sucursal (p. ej. la 01
  tiene $28M de jun–ago). La pantalla las suma aparte y lo avisa; **no son deuda segura**.
- **Los créditos bancarios no están en Kepler** (Banorte crédito simple, BBVA crédito, Financiera
  Bajío, línea Bajío: ~$26M sólo en la 2140 de ContPAQi). *(Decisión 2: se darán de alta en Kepler.)*
  Para que caigan en Financieros: clave `A*` o grupo 140. Hasta entonces Financieros muestra sólo
  factoraje, STM, tarjetas y préstamos de personas (12 acreedores, $4.4M).

## Medido (prod, 2026-10-07)

| | Acreedores | Pendiente | Vencido | Pagos sin aplicar | Saldo |
|---|---|---|---|---|---|
| Mercancía | 339 | $138.8M | $108.5M | $4.6M | $129.7M |
| Servicios | 313 | $6.1M | $5.1M | $1.7M | $4.0M |
| Financieros | 12 | $4.6M | $3.3M | $0.16M | $4.4M |
| Sin clasificar | 3 | $6k | $6k | 0 | $6k |
| Interno (no se lista) | 9 | $38.6M | | | |

Resumen de los 676 acreedores: **489 ms**. Estado de cuenta de Mondelez (261 documentos, 184
aplicaciones): **38 ms**.

## Items

- [x] **[ECA.0]** Decode `kdxd/kdxe/kdxf/kdmm` + regla de tipo + contraste contra ContPAQi. ✅ 2026-10-07
- [x] **[ECA.1]** API `libs/finance/creditor-statements` (motor puro + 11 pruebas, 2 negativas) + contrato. 🧪 2026-10-07
- [x] **[ECA.2]** Pantalla con selector de tipo, lista de acreedores y estado de cuenta casado. Validación visual pendiente. 🧪 2026-10-07
- [ ] **[ECA.3]** Imprimir / exportar el estado de cuenta (como el PDF de Kepler).
- [ ] **[ECA.4]** Lente ContPAQi por acreedor (2120 / 2140) junto al saldo de Kepler.
- [ ] **[ECA.5]** Replicar al ODS el catálogo de nombres de grupo (hoy deducidos en código).
- [ ] **[ECA.6]** Revisar con Finanzas las facturas de sucursal anteriores al 1-oct ($59.9M) y decidir si se aplican en Kepler.
- [x] **[ECA.7]** Documentos cancelados en Kepler (`kdm1.c43='C'`): Kepler deja el importe en 0 en `kdxe` pero la aplicación sigue en `kdxf`, así que una nota de crédito cancelada rebajaba doble (caso de Francisco: Distribuidora de la Rosa CD015, NC 0000010 de la 03 cancelada y reemplazada por la 0000011 → entradas "Pagadas de más"). Ahora la aplicación cancelada se muestra tachada con etiqueta **Cancelada** y no cuenta; la factura cancelada sale con estado **Cancelado** y su pago vuelve a "sin aplicar". Medido en prod: **319 aplicaciones de 187 cargos cancelados ($10.99M, 63 acreedores) + 16 sobre facturas canceladas ($133k)**; saldo total $89.76M → $100.75M; CD015 $7,424,917.53 → $9,690,501.64. Resumen 0.54 s (⚠️ con `btrim(c43)` el planificador estima 3 cancelados y tarda 52 s: se compara `c43 = 'C'`, valores limpios medidos). 4 pruebas nuevas (1 negativa, mutación verificada); 49/49; build api+view OK. **Revisado 2026-10-12 por tipo de movimiento:** la cancelación es la misma marca en todos (`c43='C'` + importe 0 en `kdxe`): transferencias 239 apps/$7.92M · cheques 21/$1.19M · notas de crédito 60/$1.89M · devoluciones 2/$3k — todas cubiertas. Tras el arreglo: 0 pagos aplicados por más de su importe, 0 aplicaciones huérfanas, 0 duplicadas (`kdxf.c11` = `c10` en el 100%, no es descuento). La marca `R` (23 entradas, $1.54M) NO es cancelación: el importe sigue vivo. Único sobreaplicado restante: GFS001 0006287, **pago doble real** (transferencias 0015878 y 0015879 del 24-jul, $1,149.47 cada una) — es para recuperar, no un error de datos. Validación visual pendiente. 🧪 2026-10-10
- [ ] **[ECA.9]** 🧪 2026-11-20 — Auditoría de interfaz en uso + evolución (pedido de Francisco): el marco se compacta, **buscador** en los documentos del acreedor, **la factura del proveedor en un clic** (la evidencia de Pagos, PGP.21) y **«Agendar»** al Calendario en el vencimiento —u hoy si ya venció— con la factura ya buscada. Detalle y veredicto en «Auditoría de interfaz en uso — 2026-11-20», al final.

---

## Observaciones de diseño UI — revisión del plan (2026-10-26)

> **Con qué se miró: el plan, no la pantalla** (nivel C). Nada visual se da por medido; lo que
> sólo se comprueba con la pantalla viva va como criterio a verificar. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) (§ = sus secciones) y su
> implementación [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso,
> escondería lo que importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro
> de la fase · 🟡 mejora; si no entra, queda como deuda con nombre.

**La pregunta que contesta (prueba de la frase, §4.0b):** *«¿Cuánto le debo a cada acreedor de
este tipo, y qué parte de eso es deuda segura?»* — una sola pregunta; el estado de cuenta casado es
su evidencia, no otra pregunta. Bien partido.

**Jerarquía propuesta (§3.7 · DESIGN §Q.5):** primario = **saldo del tipo, separado en deuda
segura / por confirmar** · secundario = la lista de acreedores ordenada por saldo · terciario =
folio, referencia y fechas del documento.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| ECA.UI.1 | 🔴 | **«Financieros» afirma que la deuda financiera es $4.4M** y faltan ~$26M de créditos bancarios que sólo viven en la 2140 de ContPAQi. Quien abra el segmento lee «debemos $4.4M a bancos y financieras», que es falso por 6×. | §1.1 · §1.4 · §1.3 | El segmento dice, cerrado y abierto: «No incluye créditos bancarios (~$26M en ContPAQi 2140): aún no están en Kepler (Decisión 2)». El aviso se retira sólo cuando el alta en Kepler esté medida. |
| ECA.UI.2 | 🔴 | **«Pendiente $138.8M» de mercancía no es deuda:** $59.9M son facturas de sucursal anteriores al 1-oct que muy probablemente se pagaron desde el 00. El plan dice que se suman aparte; la cifra primaria tiene que ser la que se puede defender, no la suma. | §1.6 · §3.2 · §4.0c | Primario = deuda segura; el bloque «por confirmar $59.9M» va a la par, con su porqué en llano. Mostrar la comparación derivada, no dos cifras para que alguien las reste: *«Kepler $138.8M − por confirmar $59.9M = $78.9M · ContPAQi 2120 $79.4M → difieren $0.5M»* (cifras del 7-oct, **antes** de ECA.7, que movió el saldo +$11M: el ejemplo ilustra la forma, la cifra se recalcula). |
| ECA.UI.3 | 🔴 | **Vencimiento `1800` = «sin fecha»** (decode de `kdxe.c10`). Si una comparación ingenua lo trata como fecha, cada documento sin vencimiento cuenta como **vencido hace 226 años** e infla «Vencido $108.5M» sin que nadie lo note. | §1.3 | Prueba que demuestre que `c10=1800` no suma a Vencido (con caso negativo). En la celda: «sin vencimiento», nunca `01/01/1800` ni vacío. |
| ECA.UI.4 | 🟠 | **Los 9 acreedores internos ($38.6M) desaparecen sin decirlo.** Quien sume el reporte de Kepler no va a cuadrar con la pantalla y no sabrá por qué. | §1.5 | Una línea fija bajo el selector: «No se listan 9 acreedores internos (sucursales dadas de alta como proveedor), $38.6M: no son deuda». |
| ECA.UI.5 | 🟠 | **El selector de tipo cerrado no dice cuánto hay en cada tipo.** Hay que entrar a cada uno para saber dónde está el dinero, y «Sin clasificar» (3 acreedores, $6k) se ignora porque no pesa. | §2.1 · §4.2 · DESIGN `app-segmented` | `app-segmented` con conteo y saldo por opción. «Sin clasificar» siempre visible aunque sume poco: es la señal de que la regla de tipo dejó algo afuera. |
| ECA.UI.6 | 🟠 | **El pago doble de GFS001 y los «pagados de más» se encuentran sólo si alguien abre al acreedor correcto.** El sistema ya sabe cuáles son; la lista de 676 no lo dice. | §3.3 · §3.4 · §4.0c | Columna o chip de anomalía en la lista (pagado de más · pago sin aplicar · factura anterior al 1-oct) con filtro de un clic. El chip lleva texto, no sólo color (§2.3). |
| ECA.UI.7 | 🟠 | **676 acreedores en una lista: se tiene que poder llegar a los 676** y ordenar como en Excel. Hoy el plan no declara tope ni orden por defecto. | §1.2 · §4.3 · DESIGN D.8 | `p-table` con orden por saldo descendente, búsqueda por clave/nombre/RFC con `coincideBusqueda` (nunca `.includes()`), y si el servidor topa, el aviso de tope a la vista. `npm run check:cifra` en verde. |
| ECA.UI.8 | 🟠 | **El saldo sale del ODS y no declara su edad.** Un pago que Francisco aplicó hace una hora en Kepler puede no verse, y la pantalla lo dibujaría como deuda viva. | §3.6 · DESIGN §9 | `app-freshness-pill` con la edad del ODS de cuentas por pagar, en el encabezado. |
| ECA.UI.9 | 🟠 | **La sucursal del documento sale de `c1`** y la réplica cruzada trae documentos de la 02 en la 03. Si la columna muestra «02», nadie sabe qué sucursal es. | regla PM 2026-10-22 · DESIGN skill §4 | Sucursal por nombre con la pipe `\| sucursal`, en celda, filtro y `aria-label`. |
| ECA.UI.10 | 🟡 | **ECA.3 (imprimir) y ECA.4 (lente ContPAQi) nacerían como segunda y tercera vista del mismo saldo.** Si el PDF no aplica la misma regla de cancelados y la misma separación pre-1-oct, imprime otro universo. | §1.5 · §3.2 | El PDF lleva fecha y hora de corte y los mismos tres bloques que la pantalla. La lente ContPAQi muestra la diferencia leída en llano, no dos columnas para restar. |
| ECA.UI.11 | 🟡 | **ECA.2 y ECA.7 llevan 19 días con «validación visual pendiente».** Lo que cerró ECA.7 —tachado + etiqueta «Cancelada»— es exactamente lo que sólo se comprueba viéndolo, incluido Alto Contraste, donde un tachado puede desaparecer. | método §4 · §2.3 | Ninguno pasa a 🚀 sin una revisión en nivel A con `auditoria-diseno` (claro, oscuro y `forced-colors`). |

**Lo que esta revisión no cubre:** contraste, alto de fila, pliegue, foco y teclado reales (exigen
nivel A), y el texto exacto de los avisos, que se valida con Francisco.

---

## Auditoría de interfaz en uso — 2026-11-20 (ECA.9)

> **Pedido de Francisco (Finanzas), con una captura de la pantalla en uso** (CB005, escritorio
> 1919 × 1029): *«los anuncios, barras, botones e información de saldos que es estática ocupan
> mucho espacio; hay proveedores con hasta 100 notas vigentes o incluyendo las pagadas y buscarlas
> se vuelve un caos; la factura en PDF en un clic; un botón al Calendario de pagos en la fecha de
> vencimiento, o hoy si ya venció, para agendar».*
>
> **Con qué se midió.** **B** = prod en sólo lectura (`francisco`, `transaction_read_only=on`),
> 2026-11-20 12:03, con un control que acertó (CB005 = 160 documentos con saldo, lo que dice la
> captura). **C** = el código. **Captura** = la imagen de Francisco: los píxeles son aproximados.
> **A (pantalla viva): medido el mismo día** en localhost:4200 contra prod en sólo lectura (Playwright
> propio, sesión de Francisco), en 4 tamaños + oscuro + alto contraste: «Revisión visual en nivel A», abajo.

**La pregunta que contesta, en uso (prueba de la frase):** *«¿Qué le debo a este acreedor, factura
por factura?»* — una sola. La de la revisión del plan (*cuánto por tipo, y qué parte es segura*) es
la de la tira de arriba y se conserva; el trabajo diario de Tesorería es ésta.

**Jerarquía:** primario = el renglón del documento (saldo, vencimiento, qué hacer) · secundario =
los totales del acreedor y del tipo · terciario = la ficha del acreedor y los pagos aplicados.

### Lo medido (B, 2026-11-20)

| Qué | Cifra |
|---|---|
| Acreedores con saldo | 384 · mediana **2** documentos con saldo · p90 **18** |
| Con 20+ / 50+ / 100+ documentos con saldo | **35 / 12 / 4** (máx. 179, CL005) |
| Con los pagados de los últimos 3 meses | máx. **497** documentos (GFS001); 11 acreedores con 100+ |
| Toda la historia | máx. **1,314** documentos |
| Factura encontrada sobre la deuda abierta (`analytics.v_payable_evidence`) | **1,035 con PDF** · 517 sólo UUID · 1,627 sin nada (3,179 documentos) |
| CB005: la llave `oblig:suc\|tipo\|sub\|folio` de ECA contra la de Pagos | **160 de 160** casan · 93 con PDF · 2 sólo UUID · 65 sin nada |
| ⛔ Control negativo: facturas **pagadas** de CB005 (90 días) con fila de evidencia | **0 de 2** — el motor sólo mira lo pendiente: se declara, no se pinta como «sin factura» |
| Costo de pedir la evidencia de CB005 (160 llaves) | **2.7 s** → va diferida; la tabla no la espera |

### Hallazgos (cada uno: qué, nivel, costo, regla)

| # | Sev | Qué estaba mal, desde la silla de Tesorería | Nivel | Cuánto cuesta | Regla | En ECA.9 |
|---|---|---|---|---|---|---|
| ECA.UI.12 | 🔴 | **La columna «Saldo» del documento no mostraba el saldo**: pintaba el estado («Parcial») y el saldo vivía en un renglón aparte, «Saldo documento», debajo de los pagos. Un rótulo que dice una cosa y muestra otra (Cruce 2). | C + captura | +1 renglón por documento (160 en CB005), y el saldo —lo que se busca— era lo último del bloque | STD §1.1 · auditoría §3 Cruce 2 | El saldo va en su renglón bajo «Saldo»; el estado, como etiqueta junto al nombre del documento; el renglón aparte se quita |
| ECA.UI.13 | 🟠 | **El marco se comía la pantalla**: subtítulo, pestañas, selector, nota de traspasos, tira de 4 cifras grande, aviso del corte, ficha en dos renglones, interruptor con rótulo apilado y 5 totales, antes del primer documento. | captura | El primer documento empezaba a **~89 % del alto** (y≈918 de 1029): se veía **un** documento de 160 | DS §Ing.UI 1 (Tesler: densidad ordenada) · auditoría §3c «marco contra trabajo» | Selector y cifras en un renglón (tira compacta, sin conteo animado); aviso del corte sin caja; ficha en una línea; buscador, filtro y cuenta en un renglón; totales en una línea; la nota de traspasos al pie de la lista |
| ECA.UI.14 | 🟠 | **No había cómo buscar un documento** dentro del acreedor: sólo desplazarse o el Ctrl+F del navegador. | B | 35 acreedores con 20+ documentos con saldo, 12 con 50+, 4 con 100+; con pagados, hasta 497 | STD §2.5 · DS D.8 | Buscador con el motor compartido (`filtrarPorBusqueda`, misma semántica que el servidor): folio, referencia, importe con o sin formato, fechas, sucursal por nombre, estado y **los folios y referencias de los pagos aplicados** (la transferencia encuentra su factura). Espera 250 ms; `Esc` limpia; la cuenta se dice («12 de 160 documentos con saldo con «…»»); sin resultados ofrece **buscar también en los pagados** |
| ECA.UI.15 | 🟠 | **La factura del proveedor no se alcanzaba desde aquí**, aunque el sistema ya la encuentra para Pagos. | B | 1,035 documentos abiertos con PDF; 93 de 160 en CB005; desde esta pantalla, **0** | `diseno` §0a paso 7 · VALORES §3 «Documento fuente» | «PDF» en el renglón (1 clic; la pestaña nace con el clic y el navegador no la bloquea); sin PDF pero con CFDI, «UUID» lo copia; sin nada, «Sin PDF» con el motivo. Si la búsqueda falla, lo dice con «Reintentar» y ningún renglón afirma «Sin PDF» |
| ECA.UI.16 | 🟠 | **Agendar era capturar dos veces**: ir al Calendario, elegir el día, abrir «Agregar facturas» y **volver a teclear** el folio que ya se estaba viendo. | C | ~5–7 clics + teclear el folio → **2 clics** («Agendar» + «Agregar la factura»), 0 tecleo | WCAG 3.3.7 · STD §4.7 · DS Q.4 | «Agendar 27/11» (su vencimiento) o «Agendar hoy» (vencida o sin fecha) abre el Calendario en ese día con la factura ya buscada (`?buscar=<clave> <folio>`). No aparece si el Calendario ya la cubre completa. Si el día ya se liberó, el Calendario lo dice en vez de abrir un panel vacío |
| ECA.UI.17 | 🟠 | **Sucursal por número**: «Pagos y notas sin aplicar» pintaba el código crudo, y el aviso del corte decía «el 00». | C | cada renglón de esa tabla | PM 2026-10-22 · `diseno` §4 | Pipe `\| sucursal` en la tabla y en el aviso |
| ECA.UI.18 | 🟠 | **Contraste** (claro): la franja «Cubierta» en `--ok-fg` sobre su fondo daba **3.00:1** y la de «día pasado» en `--bad-fg` **3.95:1** (texto de 13 px: AA pide 4.5); el icono del aviso en `--warn-fg`, **2.15:1** (un icono con significado pide 3). | C (script §3c, controles 21.00 y 4.48) | 3 piezas | WCAG 1.4.3 · 1.4.11 | `--ok-soft-fg` (6.49:1), `--bad-soft-fg` y `--warn-soft-fg`. En oscuro ya pasaban (6.04 y 5.15) |
| ECA.UI.19 | 🟠 | **Todo el panel del estado de cuenta era una región `aria-live`**: cada carga le leía al lector de pantalla cientos de renglones. | C | 1 anuncio por renglón, por carga | VALORES §2 «aria-live» | Una sola línea viva: la cuenta de documentos y la de facturas |
| ECA.UI.20 | 🟡 | La definición de «Cancelada» vivía en un `title` (sólo con mouse): advertencia TBL de `check:pantalla`. | C | — | STD §3.8 · DS §P | Al pie del estado de cuenta; la advertencia desapareció |
| ECA.UI.21 | 🟡 | Las cifras de la tira contaban hacia arriba al cargar. | C | — | STD §2.5 | `[instant]` |

### Ficha de carga, comprensión, accesibilidad y retrabajo (auditoría §3c)

- **Carga (captura, antes):** 9 bandas de marco antes del primer documento; el saldo, el pendiente y
  el vencido del acreedor salen **dos veces** (renglón de la lista y totales del detalle). Se
  conservan las dos: con «Sólo con saldo» apagado los totales del detalle son de otro universo (el
  periodo) y la lista no. **Después:** NO MEDIDO en píxeles (nivel A pendiente); por construcción, 4 bandas.
- **Comprensión:** «Cargo» y «Abono» son los del reporte de Kepler (del lado del proveedor: la
  factura *abona*, el pago *carga*) y la pantalla no los define. Se dejan como en Kepler —quien la
  usa viene de ese reporte— y queda como pregunta para Francisco si confunde a alguien más.
- **Accesibilidad:** contraste calculado (arriba); las acciones del renglón son `button` y `a` reales,
  con `aria-label` que dice folio y día; 28 px con mouse y `--tap-min` (44 px) con puntero `coarse`.
  **NO MEDIDO:** `forced-colors`, recorrido con teclado en la pantalla viva, lector de pantalla, 390 px.
- **Retrabajo:** el folio que se pedía dos veces (ECA.UI.16) se quitó. La pantalla no escribe: doble
  clic, lote parcial y cambios sin guardar no aplican.

### Veredicto por capa (VALORES §3d)

| Capa | Antes | Después (C + pruebas + nivel A) |
|---|---|---|
| Veracidad | 🔴 «Saldo» pintaba el estado (ECA.UI.12) | ✓ por código, prueba y pantalla; que la factura no se busca en lo pagado se declara al pie |
| Contraste y accesibilidad | 🟠 3 contrastes, `aria-live` ruidoso, vencida sólo en rojo | ✓ calculado; `forced-colors` visto (ECA.UI.25); 44 px con el dedo |
| Visibilidad | 🟠 documento fuente inalcanzable | ✓ factura a 1 clic donde hay saldo · abrir el archivo NO MEDIDO (503 local) |
| Jerarquía | 🟠 el marco dominaba | ✓ a 1919: 7 documentos a la vista (antes 1) |
| Tablas | 🟠 sin búsqueda, sin salida en teléfono | ✓ búsqueda con el motor compartido; `dt-stack` en teléfono · 🟡 el Fold desplaza de lado (Francisco: así por ahora) |
| Texto | 🟠 sucursal por número | ✓ |
| Carga | 🟠 9 bandas de marco | ✓ 4 bandas; primer documento al 56 % (1919) y 70 % (1440) |

**Deuda que sigue, con nombre:** `check:pantalla` §2 (sin `app-load-state`: la pantalla tiene su
esqueleto y su error propios) y §9 (sin edad del dato: ECA.UI.8) — las dos ya estaban selladas; la
etiqueta de estado en `--fs-nano` (10 px, «último recurso»).

### Pruebas (ECA.9)

- `finanzas-estado-cuenta-acreedores.component.spec.ts` — **13 pruebas** (9 + 4 de la revisión independiente, abajo) montadas desde el DOM: saldo en
  su renglón, evidencia sólo de lo que tiene saldo (negativa: la pagada no se pide), PDF / UUID / sin
  PDF, ⛔ falla de la búsqueda sin «Sin PDF», búsqueda por el folio de la transferencia y por importe
  con y sin comas, «buscar también en los pagados», «Agendar» hoy / en su vencimiento con la factura
  en la URL, ⛔ lo ya cubierto no se agenda, ⛔ una llave del bucket no se abre.
- `calendario-pagos-agendar-desde-deuda.spec.ts` — **3 pruebas** del `?buscar=` del Calendario, con su
  negativa (sin el parámetro nada se abre ni se filtra).
- **Mutantes en rojo, verificados:** «buscar factura también en las pagadas» + «agendar siempre en el
  vencimiento» → 3 rojas; quitar `busqueda.set(buscar)` en el Calendario → 2 rojas.
- 38/38 junto con el spec existente del Calendario (22, sin regresión). `ngc --noEmit` sobre
  `apps/view` con un control (método inexistente → TS2339): el control fue **el único** error.
  `check:pantalla` 0 nuevas en las dos pantallas · `check:templates` · `check:estilos` ·
  `check:tokens` · `check:busqueda` · `check:reactividad` · `check:teclado` · `check:motion` en verde.

### Revisión visual en nivel A (2026-11-20, tarde)

Pantalla viva en localhost:4200 + API :3334 contra prod en sólo lectura, Playwright con Chrome y la
sesión de Francisco. Antes de cada corrida se verificó que :4200 sirviera la última edición (una
corrida midió el código anterior porque la vista no había terminado de recompilar: se descartó).

| Tamaño | Primer documento (y / % del alto) | Documentos completos a la vista | Lado |
|---|---|---|---|
| Monitor de Francisco 1919 × 1029 | 578 px / **56 %** (antes ~918 / 89 %, captura) | **7** (antes 1) | sin desborde |
| Escritorio 1440 × 900 | 628 px / 70 % | 3 | sin desborde; saldo y acciones a la vista |
| Galaxy Z Fold 7 abierto 750 × 832, táctil | 329 px / 40 % | 4 | ⚠️ la tabla mide 905 en una caja de 716: el saldo se ve, **«PDF» y «Agendar» piden desplazar la tabla de lado** |
| Celular 390 × 844, táctil | apilado (`dt-stack`): cada documento es una ficha con rótulos | — | **0** piezas fuera del ancho (antes 39) |

**El recorrido, de punta a punta (escritorio):** buscar el folio de una transferencia → 1 de 160
(su factura) · folio de documento → 1 · el importe de una factura con comas y sin ellas → 1 y 1 · algo inexistente → 0
con «Buscar también en los pagados (12 meses)» → 536 documentos del 01/11/25 al 20/11/26, donde el
folio de la transferencia de diciembre **sí** aparece · `Esc` limpia · «UUID» copia y lo dice ·
«Agendar 24/11» → `/finanzas/calendario-pagos?fecha=2026-11-24&buscar=CB005 0010073` → «Agregar
facturas al mar 24» con **1 factura** y su «Agregar la factura»; en celular, «Agendar hoy» con el dedo
llega igual al vie 20. GFS001 con pagados (415 documentos): de la tecla a la lista filtrada **278–304 ms**,
de los que 250 son la espera a propósito. Oscuro y alto contraste: se ven. Cero errores de página.

**Lo que la revisión en vivo encontró y se corrigió en la misma ECA.9:**

| # | Qué | Corrección |
|---|---|---|
| ECA.UI.22 | A 1440 la tabla se desbordaba y **las acciones nuevas quedaban fuera de la vista**; documentos de ~100 px por renglón partido | Lista : estado de cuenta 1 : 2 (1 : 2.6 hasta 100rem); «Cargo» y «Abono» en una columna **«Importe»** (lo aplicado con signo menos, definido al pie: resuelve la duda de comprensión de arriba); la referencia se parte en sus espacios; «Factura» → «PDF» |
| ECA.UI.23 | Una columna de acciones **fijada a la derecha** (primer intento) **tapaba «Vence» y «Saldo»** a 750 y 390 px | Se quitó el fijado; en teléfono la tabla se apila con el patrón compartido `dt-scope` + `dt-stack` (`data-label`, `role="cell"`), también «Pagos y notas sin aplicar» |
| ECA.UI.24 | «Buscar también en los pagados» abría 3 meses: el folio de un pago de diciembre **desaparecía** al pasar a pagados | Abre 12 meses; en el periodo, sin resultados, ofrece «Ampliar a los últimos 12 meses» |
| ECA.UI.25 | Con alto contraste, **«vencida» sólo era rojo** y se perdía (venía de ECA.2) | Icono + «vencida el» para lector de pantalla; las 121 vencidas de CB005 lo llevan (= las 121 medidas en la base) |
| ECA.UI.26 | La tira de cifras se partía en 2–3 renglones y repetía «340 acreedores» del selector | Sin los subtítulos que repetían o sólo definían el rótulo; si no cabe junto al selector, baja entera a su renglón |

### Revisión independiente del diff (2026-11-20, antes del PR)

Un revisor sin el contexto de esta sesión leyó el diff completo (y del lado del servidor
`creditor-statements.service`, `listEvidenceByRefs` y la búsqueda de `obligations`). No encontró nada
que rompa el flujo principal; lo confirmado se corrigió en la misma ECA.9, cada arreglo con su prueba
y su **mutante en rojo** (revertir el arreglo → falla su prueba, 6 de 6):

| # | Qué | Corrección |
|---|---|---|
| ECA.UI.27 | Un importe redondo escrito con centavos no se encontraba: `String(1000)` da «1000», así que «1000.00» o «2500.50» daban **0** | el texto buscable lleva también el importe con dos decimales |
| ECA.UI.28 | Una fecha con el año completo («27/12/2025», «2025-12-27») daba 0; sólo servía «27/12/25» | las tres formas |
| ECA.UI.29 | ⛔ Con el Calendario **sin leer** (`calendario.medido: false`) cada documento ofrecía «Agendar», afirmando «sin programar» de lo que no se midió | sin Calendario leído no se ofrece, y la línea de totales lo dice |
| ECA.UI.30 | «Agendar» aparecía a quien sólo tiene `FINANCE_PAYMENTS_VER`; agregar al Calendario pide `_GESTIONAR` (el servidor contestaría 403) | sólo con `_GESTIONAR` |
| ECA.UI.31 | «Actualizar» no volvía a pedir las facturas del mismo acreedor: la que se subió mientras tanto seguía en «Sin PDF» hasta cambiar de acreedor o recargar | «Actualizar» vacía lo ya respondido |
| ECA.UI.32 | Alternar rápido «Sólo con saldo» dejaba que la respuesta lenta (12 meses) pisara a la última, con el interruptor diciendo otra cosa | sólo se pinta la última lectura (secuencia) |
| — | El aviso (`role="status"`) nacía ya lleno dentro de un `@if`, y no siempre se anuncia; la tanda de facturas en vuelo seguía al salir de la pantalla | la región viva existe siempre; al salir, la tanda no dispara la siguiente |

**Lo que se dejó, con su razón:** «Agendar hoy» con la pantalla abierta desde antes de medianoche
manda el día anterior (el Calendario lo abre como «Día pasado»); cambiar el filtro con una tanda en
vuelo la vuelve a pedir (~2.7 s); en modo apilado las tablas nativas llevan `role="cell"` sin
`role="row"` (patrón de todo el repo, no de este cambio). Sin prueba todavía: el cambio de acreedor a
mitad de una tanda (`evidSeq`, verificado leyendo el flujo) y el aviso «ya se liberó» del Calendario.

### Lo que falta para pasar a 🚀

1. **«PDF» abriendo el archivo: NO MEDIDO.** La API local no tiene almacén de archivos y contesta
   503; la pantalla lo dice («el servidor no pudo preparar su enlace de lectura… avisa a Sistemas») y
   cierra la pestaña que abrió. Se mide en prod con el primer uso. Es el mismo endpoint que ya abre la
   factura en el Calendario.
2. **El Fold, decidido por Francisco (2026-11-20): se queda así por ahora.** A 750 px «PDF» y
   «Agendar» quedan del otro lado del desplazamiento lateral (sobran 189 px); el saldo sí se ve. Si en
   el uso estorba, se apila también ahí (`dt-stack` hasta el ancho del Fold): es una regla de CSS.
3. **Hallazgo del Calendario, no de esta pantalla:** con el dedo, «Agregar la factura» mide **28 px**
   (el piso táctil es 44). Va a la fase PGP.
4. **NO MEDIDO:** qué hace el Calendario con un vencimiento en sábado o domingo; un día ya liberado
   (el aviso está en el código y tipado, sin un día liberado a mano para verlo).
