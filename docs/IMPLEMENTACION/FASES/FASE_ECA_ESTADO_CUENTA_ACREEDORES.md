# Fase ECA — Estado de cuenta de acreedores

> **Estado:** 🧪 ECA.0–ECA.2 en código, 2026-10-07 · ECA.7 (cancelados) 2026-10-10. Pedido de Francisco (Finanzas).
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
