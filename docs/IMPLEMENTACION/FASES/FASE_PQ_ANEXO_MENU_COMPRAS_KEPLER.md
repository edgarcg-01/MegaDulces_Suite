# Fase PQ · Anexo K — El menú de Compras de Kepler, completo

> Anexo de [`FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md`](FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md). **Completa y
> reemplaza su §20** (que cubría 7 de los 10 módulos). Agrega **PQ.122–PQ.125** y retoma
> PQ.110–PQ.114 y KR.7, que ya existían. Método: [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Las decisiones de este anexo se numeran **DK1–DK3**, para no confundirlas con las D*n* del plan
> base ni con las DT*n* del anexo T.

```
OBJETIVO: que cada opción del menú Compras de Kepler tenga su destino decidido en la Suite:
          una acción en una pantalla que ya existe, una consulta, o «no se hace», con su porqué.
          Y que la Suite escriba en Kepler sólo lo que se decidió.
MÉTRICA:  HOY (2026-11-12, prod, 90 días):
          · opciones del menú: 10 módulos, 25 opciones (más los reportes, sin contar todavía);
          · opciones con destino firmado: 0 de 25 (el §20 propuso destino para 23; ninguno firmado);
          · la Suite escribe en Kepler 2 de las 25 (alta de requisición y alta de OC);
          · una recepción se captura 3 veces en Kepler (vale, orden de entrada, aplicación);
          · una de cada 8 OC se cancela (360 de 2,993) y la Suite no puede cancelar ninguna.
          MÉTRICA PRINCIPAL (el acto, no el papel): OC canceladas desde la Suite / OC canceladas
          en Kepler, 90 días, por sucursal. HOY: 0 de 360.
          → META (fijada con PQ.124, §3b): a 90 días de encender PQ.110, ≥ 80 % de las OC SIN VALE
          que se cancelan salen de la Suite (hoy 0 de 249); la anulación de una recepción completa
          (112 de 361) va por PQ.112, no por PQ.110. 25 de 25 opciones con destino firmado; los
          reportes, inventariados.
CAPA TOPE: C3 (acciones en pantallas que ya existen; cero pantallas nuevas)
ÁREA:      Compras · Almacén (recepción) · Finanzas (cuentas por pagar)
ESTADO:    ⬜ plan — no abre fase (Fase 0, cupo lleno): todo entra como items de PQ
```

## 1. El pedido, literal

> «Hay que documentar un plan abarcando todos estos módulos, con sus respectivos submódulos.»
> — PM, 2026-11-12, sobre la captura del menú **Compras** de Kepler.

**Cómo cambió:** el §20 del plan base (2026-11-09) ya había resuelto los siete módulos de documentos.
La captura nueva agrega tres: **Reportes**, **Autorización de documentos** y **Consulta de
documentos**. Este anexo cubre los diez y corrige lo que el §20 suponía de «Saldar documento» (§3).

La regla del §20 sigue en pie: los siete documentos son **un solo flujo físico** (pedir → ordenar →
recibir → registrar la deuda → a veces devolver) que Kepler obliga a capturar por separado. La Suite
modela el **acto**, no el formulario de cada documento.

## 2. El árbol completo

| Módulo | Submódulos | Documento en Kepler (`kdmm`) | ¿Mueve inventario? |
|---|---|---|---|
| Requisición de compra | Alta · Baja · Consulta | `X-A-30` «Requisición de compra» | no |
| Órdenes de compra | Alta · **Modifica** · Baja · Consulta | `X-A-35` «Orden de compra» | no |
| Vale de entrada | Alta · Baja · Consulta | `X-A-37` «Vale de entrada» | no |
| Órdenes de entrada | Alta · Baja · Consulta | `X-A-40` «Orden de entrada» | **sí, entra** |
| Aplicación de orden de entrada | Alta · Baja · Consulta | `X-A-20` «Aplica Orden Entrada» (crea la cuenta por pagar y la póliza) | no |
| Devolución directa | Alta · Baja · Consulta | `X-D-40` «Devolución compra crédito» | **sí, sale** |
| Saldar documento | Alta · **Masivamente** · Baja · Consulta | `X-A-90` «Saldar documento CxP» | no |
| Reportes | ⚠️ **NO MEDIDO**: la captura llega plegada | — | — |
| Autorización de documentos | (sin submódulos) | cambia el estado `c43` de un documento | — |
| Consulta de documentos | (sin submódulos) | lee cualquier documento | — |

Los submódulos de los siete primeros salen de la captura desplegada del 2026-11-09 (§20). Los de
**Reportes** no se han visto: es lo primero que pide PQ.122.

## 3. Lo medido (2026-11-12)

`pg-prod`, `system_identifier` 7688376744939610156, sólo lectura. 90 días por fecha de captura
(`kdm1.c68`), las 9 sucursales. El estado sale de `c43`: **N** nueva · **A** autorizada · **R**
parcial · **F** terminada · **C** cancelada.

| Documento | Capturados | Cancelados (uso de «Baja») | Autorizados (A) |
|---|---:|---:|---:|
| Requisición `X-A-30` | 600 | 23 (4 %) | 20 |
| Orden de compra `X-A-35` | 2,993 | **360 (12 %)** | 10 |
| Vale de entrada `X-A-37` | 3,456 | 192 (6 %) | 7 |
| Orden de entrada `X-A-40` | 3,340 | 109 (3 %) | 36 |
| Aplicación `X-A-20` | 3,344 | 168 (5 %) | 0 |
| Devolución directa `X-D-40` | 125 | 14 (11 %) | 0 |
| Saldar `X-A-90` | 0 (1 en toda la historia) | — | — |

Lo que eso dice:

- ⭐ **«Baja» se usa todos los días.** Son 866 cancelaciones en 90 días entre los seis documentos, y la
  más frecuente es la de la OC: unas 4 por día. Por qué se cancelan (¿error de captura que se vuelve a
  capturar, o pedido que el proveedor no surtió?) **no está medido**, y cambia el diseño de PQ.110.
- ⭐ **«Autorización de documentos» no es una compuerta en Compras.** Sólo 10 de 2,993 OC están
  autorizadas, y **154 OC que siguen en N ya tienen su vale de entrada**: Kepler recibe contra una OC sin
  autorizar. La liga OC → vale (`c37='35'`, `c39` = folio de la OC, misma sucursal) casa con 2,311 de las
  2,311 OC parciales o terminadas. ⚠️ **Ese es sólo el control positivo, y es casi circular**: Kepler
  marca la OC como R o F justamente porque recibió un vale. Falta el control negativo (folio desplazado
  ±1 y sucursal equivocada deben dar ~0; las 360 canceladas, 0 —el 2026-11-09 PQ.110 midió «ninguna OC
  con vale cancelada», que va en esa dirección pero no descarta que la liga case de más). **Cerrado
  en §3b (2026-11-13):** la liga pasa su control; con proveedor y fecha coherentes son **143**, no 154. La OC que escribe la Suite también nace en N
  (`kepler-requisition-sink.adapter.ts`), igual que las que se capturan a mano.
- **Las 312 OC en N se reparten así:** 154 con vale + 158 sin vale. El §7 habla de **145**: son las de
  esas 154 cuyo vale tiene de 31 a 90 días (subconjunto, no otra cifra).
- **Las OC parciales (R) viejas no están medidas.** Son la necesidad real de «saldar»: una OC que
  recibió una parte y el resto nunca va a llegar se queda abierta para siempre, porque en 90 días nadie
  usó `X-A-90`. PQ.125 las cuenta antes de construir nada.
- **Hay 166 OC sin ningún vale** (158 en N y 8 en A); 39 de ellas tienen más de 30 días. Son las
  candidatas a cancelar o saldar.
- ⛔ **Corrección al §20:** `kdmm` llama a `X-A-90` «Saldar documento **CxP**». Es un documento de
  **cuentas por pagar**, no el cierre de una OC. El §20.5 infería que «saldar» cierra la OC (`c43`→F,
  `c42`→0). Puede que el menú haga las dos cosas, pero no se sabe hasta ver un saldado real en el Kepler
  vivo. PQ.111 empieza por ese testigo.
- Sin uso en toda la historia: la devolución en dos pasos (`X-D-30`/`X-D-35`), la compra directa
  (`X-A-5`/`X-A-6`) y `X-A-60` (§20.1).

## 3b. Medido en PQ.124 y PQ.125 (2026-11-13)

`pg-prod` (`system_identifier` 7688376744939610156), sólo lectura, OC `X-A-35` con captura (`c68`) en
los últimos 90 días, filtro anti-réplica `btrim(c1)=sucursal`: **3,009 OC** (F 2,129 · R 204 · N 306 ·
A 9 · C 361). Script: `pq124.js` / `pq124b.js` de la sesión (no versionados; las consultas van aquí
resumidas). Proveedor = `c10`, monto = `c16`, capturista = `c67`. ⚠️ `c68` es **fecha sin hora**: no se
puede medir nada más fino que el día.

**1. La liga OC → vale pasa su control negativo.** Se mide qué fracción de los vales ligados comparte
proveedor con la OC; si la liga casara al azar, la fracción sería la de un vale cualquiera.

| Liga | Pares OC–vale | Mismo proveedor |
|---|---:|---:|
| Real (`c37='35'`, `c39` = folio, misma sucursal) | 2,854 | **98.4 %** |
| Placebo: folio + 1 | 2,905 | 18.1 % |
| Placebo: mismo folio, otra sucursal | 8,353 | 3.2 % |

El 18 % del folio + 1 no es ruido: un proveedor suele recibir OC consecutivas. Con la liga coherente
(mismo proveedor y vale no anterior a la OC), las **OC en N con vale son 143** (156 sin exigir
coherencia). Las OC en R o F casan 2,320 de 2,333.

**2. ¿Las cancelaciones son recapturas? No se puede saber con estos datos.** ⚠️ Corregido el mismo día
con el testigo de §3c: al cancelar, Kepler **sobrescribe la fecha de captura con la de cancelación**,
así que la fecha original de una OC cancelada se pierde. Regla: otra OC viva del mismo proveedor y
sucursal cerca de esa fecha. El mismo día: **29.9 %** de las canceladas contra **32.7 %** de las no
canceladas (azar); ±2 días: 51.8 % contra 46.6 %. Con folio mayor da 48.5 % contra 33.0 %, pero esa
comparación está sesgada (la fecha de cancelación es posterior a la captura, así que sus vecinas
tienden a tener folio mayor). **No concluyente**: el motivo se le pregunta a quien cancela (punto 3). Lo
que sí se ve es el tipo:

| Tipo de cancelación | OC | Qué pasa en Kepler |
|---|---:|---|
| **OC sin vale** | 249 (69 %) | se cancela la OC sola: pedido que no se surtió o que ya no se quiere |
| **Recepción anulada entera** | 112 (31 %) | la OC **y** su vale están cancelados (114 de 114 vales en C); 50 de ellos ya tenían orden de entrada. Es deshacer una recepción, no cancelar un pedido |

⛔ Esto corrige al tracker de PQ.110 (2026-11-09, «ninguna OC con vale cancelada»): sí las hay, pero
siempre con el vale también cancelado. Cancelar deja los importes en 0 (`c16` = 0 en las 361).

**3. Dónde y quién.** La sucursal **01 cancela el 27 %** de sus OC (175 de 649); el CEDIS 00 el 10 %; el
resto entre 2 % y 8 %. En una OC cancelada, `c67` es **quien la canceló** (Kepler lo sobrescribe, §3c):
cancela `COMPRAS` 184, `9EMG` 76, `42YAGL` 27, `30APL` 25. **NO MEDIDO:** días entre captura y
cancelación (la fecha original se pierde; el único caso visto en un respaldo, 4 días).

**4. Autorizaciones (DK1).** OC en A: 9, **una por capturista** en 9 personas distintas: nadie usa la
autorización como regla. Requisiciones en A: 20, **las 20 escritas por la Suite** (`c67='SUITE'`, 19 en
la 08): es el estado en que la Suite deja algunas, no una autorización humana. Órdenes de entrada en A:
36, con `0GRC` en 12 (00 y 03). **DK1 se sostiene para las OC**; lo de `0GRC` en órdenes de entrada se le
pregunta a esa persona antes de PQ.112.

**5. Dónde escribe hoy la Suite.** En 90 días, `c67='SUITE'`: **195 requisiciones `X-A-30`** y **169 OC
`X-A-35`** (5.6 % de todas), en las sucursales **00, 01, 02, 06, 07 y 08**; **ninguna en 03, 04 ni 05**.
⛔ **Pero `c67` no cuenta las canceladas** (se sobrescribe). Por la liga requisición de la Suite
(`purchase_requisitions.kepler_folio`) → OC (`c37='30'`, `c39`): **195 OC de la Suite**, de las cuales
169 de las 175 vivas conservan `c67='SUITE'` (la liga se sostiene) y **20 (10 %) las canceló una persona
a mano en Kepler** —18 en la 08 (`30APL` 11, `61` 5, `30BRC` 2)—. La Suite **no se entera**: es el
primer cliente de PQ.110. ⚠️ El `CLAUDE.md` dice que la escritura Suite→Kepler «está
apagada»: para requisiciones y OC, **ya no es cierto**.

**6. PQ.125 — la necesidad de «saldar».** Saldo = monto de la OC − monto de sus vales vivos (nominal: el
precio del vale puede diferir del de la OC). Antigüedad = días desde el último vale vivo, o desde la
captura si no hay vale.

| Estado | Cadena | > 30 días: OC | > 30 días: saldo nominal |
|---|---|---:|---:|
| R parcial | con vale | **74** | **≈ $10.9 M** |
| N nueva | con vale | 110 | ≈ $0.8 M |
| N nueva | sin vale | 45 | ≈ $4.3 M |
| A | sin vale | 6 | ≈ $1.3 M |

**Segundo testigo: `c42` es el saldo pendiente en pesos que lleva Kepler** (§3c: baja con cada recepción,
queda en 0 al terminar). Contra monto − vales:

| Grupo (> 30 días) | OC | `c42` | monto − vales | Lectura |
|---|---:|---:|---:|---|
| R con vale | 74 | ≈ $10.2 M (17 negativos fuera) | ≈ $10.9 M | **coinciden**: saldo real sin cerrar |
| N con vale | 110 | **≈ $11.1 M** | ≈ $0.8 M | **discrepan**: Kepler nunca descontó esos vales de la OC. Recibidas en la práctica, abiertas en papel: **las primeras candidatas a saldar** |

⚠️ `c42` sale negativo en 66 de 123 OC parciales recientes (suma −$106 M): probablemente unidades
mezcladas al recibir (caja contra pieza). Ahí no sirve de testigo, y es un hallazgo aparte.

**Material, pero no por donde se suponía.** ~$11 M de pedido parcial que nadie ha cerrado. Se verificó
(2026-11-13, en el código) si eso **frena el sugerido** de `/compras/pedido`: **no**. Desde el
2026-10-09 la política de tránsito es `'ignorar'` (`commercial-replenishment/transito.ts`,
`POLITICA_TRANSITO`, pedido de Edgar: *«hay muchas ordenes que no cumplen o se ignoran»*): el
tránsito no se resta, sólo se muestra en «En camino». El costo de las OC sin cerrar es otro, y es el
que justifica PQ.111:

- **La columna «En camino» muestra papel.** Las OC que nunca van a llegar aparecen como mercancía que
  viene; el comprador decide a ojo con ese dato.
- **La compra doble conocida.** `transito.ts` documenta que, al ignorar el tránsito, el motor vuelve a
  sugerir lo que sí llega esa semana (38 OC de menos de 7 días, $6.6 M al medirlo). Se aceptó **porque
  el papel estaba sucio**. Con las OC viejas saldadas, se puede volver a restar el tránsito reciente
  (política `'curva'` o una ventana corta, como hace `ya-pedido-sucursal.ts` con 7 días para los
  traspasos) sin quedarse corto. Esa es la ganancia de PQ.111, y se mide antes y después.

**Qué decide esto:**
- **PQ.110 es un botón «Cancelar OC» para OC sin vale**, no «reemplazar OC» (no hay recapturas que
  reemplazar). Universo: 249 en 90 días, unas 3 por día.
- **La recepción anulada entera (112) es «Baja» del vale y de la orden de entrada** → va con PQ.112, desde
  el Andén. PQ.110 **se niega** a cancelar una OC con vale vivo y dice por qué.
- **PQ.111 sigue** (criterio de PQ.125 cumplido): el siguiente paso es el testigo de un saldado real en el
  Kepler vivo. El tránsito del pedido **no** cuenta esas OC hoy (política `'ignorar'`); el objetivo de
  saldar es limpiar el papel para poder volver a restar el tránsito reciente.
- **Preguntar** (como parámetro, no por WhatsApp) a la 01, a `COMPRAS` y a `42YAGL` el motivo de sus
  cancelaciones: el motivo se vuelve el catálogo de razones del botón de PQ.110.

## 3c. El testigo: qué escribe Kepler al cancelar una OC (2026-11-13)

Imagen ANTES = respaldo nocturno de `md` (`trade_marketing_2026-11-1{1,2}_2200.dump`, `kepler_ods.kdm1`
y `kdm2` filtrados a `X-A-35`); DESPUÉS = `pg-prod` hoy. Diferencia columna por columna, sólo lectura.
Script `pq110diff.js` de la sesión. Casos: 1 cancelación completa vista en las dos imágenes
(`08|0000362`, **una OC escrita por la Suite** y cancelada a mano por `30APL`), 3 canceladas cuyos
renglones desaparecieron después, 1 que terminó (N→F) y 2 que pasaron a parcial (N→R).

| Transición | Cabecera (`kdm1`) | Renglones (`kdm2`) |
|---|---|---|
| **Cancelar** (N→C) | `c43` N→**C** · `c15`, `c16`, `c42` → **0** · `c67` → **usuario que cancela** · `c68`/`c69` → **fecha y hora de la cancelación** | **se borran** (4 → 0) |
| Recibir parcial (N→R) | `c43` → R · `c42` baja (puede quedar negativo) | sin cambio |
| Recibir todo (N→F) | `c43` → F · `c42` → 0 | sin cambio |
| **Cancelar la OC: su requisición** (`c37=30`) | `c43` F→**A** · `c42` 0→`c16` · `c67`–`c69` **sin cambio** | `c24` 0→`c9` (vuelve a pendiente) |

Lo que eso significa para construir PQ.110:
- **Cancelar = UPDATE de cabecera + DELETE de renglones.** Para que la Suite cancele igual que Kepler
  necesita **`DELETE` en `md.kdm2`** para el rol de escritura → **D40 deja de ser opcional para PQ.110**
  (o la Suite cancela sólo la cabecera y lo declara distinto de Kepler).
- **La Suite debe escribir su propio usuario en `c67` y la fecha en `c68`/`c69`**, como hace Kepler; y
  guardar la fecha original de captura en su lado, porque Kepler la pierde.
- ⚠️ En 3 casos (`02|0001194`, `08|0000274`, `08|0000298`) la imagen de la noche ya decía C **con
  renglones**, y hoy no los tienen: el borrado llegó al ODS **después** de la cancelación. ¿Kepler borra
  en un segundo paso, o la réplica llegó tarde? **No medido**; se ve en el Kepler vivo antes de escribir.
- **«Saldar» sigue sin testigo:** no hay ningún `X-A-90` reciente que comparar. Lo que sí se vio es que la
  recepción mueve `c42`; un saldado debería dejarlo en 0 y el estado en F, **pero es inferencia**.
- **Cancelar una OC REABRE su requisición** (medido el 2026-11-13, ODS a 90 días + respaldo): de 45 OC
  canceladas que salieron de una requisición, 25 dejaron la requisición en A con `c42` = `c16` y sus 169
  renglones con `c24` = `c9` (25 de 25); 17 la dejaron cancelada (un segundo acto de la persona) y 1 en F.
  Ninguna tenía otra OC viva. Caso `08|0000362` en el respaldo: requisición `0000064` F→A, `c42` 0→12,560.76,
  4 renglones con `c24` 0→`c9`; `c67`/`c68`/`c69` de la requisición, intactos. ⇒ La Suite también la reabre,
  y para eso `kepler_push` necesita **`UPDATE (c24)` en `md.kdm2`** (firmado por Edgar y aplicado en los 6 el 2026-11-13).
- **Ensayo contra el Kepler vivo de la 08** (2026-11-13, [`ops/prod/ensayo-cancelar-oc/`](../../../ops/prod/ensayo-cancelar-oc/README.md), sin
  escribir): las sentencias del adaptador dejan la OC y la requisición como Kepler; una OC con vale sale
  rechazada; las 3 OC reales quedaron intactas. Repetido tras aplicar `c24`: los 11 permisos en true, sin fallas.

## 3d. PQ.110 C3 — el botón, antes de la plantilla (2026-11-13)

> Las cinco preguntas de [`diseno` §0b](../../../.claude/skills/diseno/SKILL.md), por escrito y con
> datos de prod, **antes** de escribir código. C3 se construye cuando C2 esté verificado (migración
> aplicada, `pruebas-db` y `boot-api` en verde); esto es sólo el diseño.

**Lo medido (prod, sólo lectura, 2026-11-13):**
- **Quién entra:** en 30 días, `GET open-purchase-orders` 1,150 veces en 25 días (gerente_compras,
  compras_operaciones, auxiliar_compras, encargado_tienda, facturación, dirección); el detalle 517;
  el seguimiento se cambia 277 veces (compras_operaciones, facturación, gerente_compras).
- ⭐ **Compras ya decidió cancelar, y Kepler no se enteró.** De las 160 OC marcadas «No surtida /
  cancelada» en el seguimiento: **53 siguen en N en Kepler sin vale vivo (≈ $4.0 M en papel)**. Son
  justo las que el botón cierra. 49 son de CEDIS, 2 de Morelia Madero, 1 de la 03 y 1 de la 04. Las
  marcaron gerente_compras (50) y compras_operaciones (3); los dos roles tienen la llave.
  82 ya están en C (alguien las canceló a mano en Kepler); 21 tienen vale vivo (van por el Andén);
  4 están en A.
- ⛔ **El aviso de hoy afirma algo falso** (`[PQ.29]`, sobre la tabla): «En Kepler siguen vivas: su
  vale de entrada (X-A-37) está abierto y hay que cancelarlo allá». Sólo **21 de 160** tienen vale
  vivo. Las 53 de arriba no tienen vale: lo que sigue vivo es la OC. Se corrige con C3.

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | ¿Qué ve al entrar, y en qué orden? | Lo mismo que hoy. El botón vive en el **side-peek** de la orden, en sus acciones, no en la fila (`[PQ.28]` sacó los botones de las filas: 2 × 149). El aviso de arriba pasa a decir la verdad y a ser la entrada: «53 marcadas No surtida / cancelada siguen pendientes en Kepler» y lleva al chip de ese seguimiento, donde ya están filtradas. |
| 2 | ¿Qué NO ve? | El botón no aparece si la persona no tiene `COMPRAS_OC_CANCELAR`. Tampoco si la OC no está en N, ni si está apagado para su sucursal. Si tiene vale vivo, en lugar del botón se dice por qué no: «tiene el vale 0000533: se cancela en el Andén». Nada técnico (`kdm2`, `c43`) en pantalla. |
| 3 | ¿Qué accesibilidad necesita? | Fila → side-peek (1) → «Cancelar en Kepler» (2) → confirmación con el motivo (3). El motivo **llega lleno** con la nota del seguimiento «No surtida / cancelada» cuando la hay (las 53 la tienen: es el mismo acto, no se teclea dos veces). Foco en el motivo; el envío se deshabilita en el primer clic. Es una acción destructiva: va en `--bad-fg`, separada de «Cambiar seguimiento». |
| 4 | ¿Está ligada a otro proceso? | Sí, a la requisición de la que salió. La confirmación dice **antes** de cancelar qué pasa: «la OC queda cancelada y la requisición 0000087 vuelve a pendiente en Kepler». Después lo repite, con liga a la requisición. Y al seguimiento: cancelar desde aquí cierra el «No surtida / cancelada» de verdad. |
| 5 | ¿Le toca a esta pantalla? | Sí. `oc-abiertas` es la bandeja «para cerrarlas o cancelarlas» (`[RA-PRO.45]`), y ahí ya se decide cancelar. No hay pantalla nueva. Lo que tiene vale vivo es del Andén (`[PQ.112]`), no de aquí. |

**Con la pantalla terminada (2026-11-13), las cinco otra vez:** (1) igual que hoy; el botón vive en el
detalle, en su propio renglón bajo las acciones diarias, y el aviso lleva con «Verlas» al filtro de las
marcadas. (2) Sin la llave no hay bloque; sin «disponible» del servidor no hay botón, hay su porqué (apagado,
tope, vale, estado). (3) Fila → detalle → «Cancelar en Kepler» → confirmar: 3 clics; motivo lleno con la nota;
el envío se bloquea en el mismo clic; el diálogo no se cierra mientras envía. (4) El diálogo dice antes qué
requisición vuelve a pendiente en Kepler y lo repite después; y la ficha de la requisición en la Suite (D41)
dice que su OC se canceló (cuándo, quién, motivo) sin cambiar de estado. (5) Sin pantalla nueva. **Sin validación visual**
(sin backend local por regla; se ve en prod al soltar).

**Lo que C3 NO puede resolver sin tocar C2** (se dice primero porque cambia el orden):
1. **Saber si está apagado antes de ofrecer el botón.** Hoy sólo el `POST` lo dice (503). Mostrar
   un botón que en 8 de 9 sucursales siempre falla es afirmar algo falso. Hace falta que el detalle
   de la orden diga si se puede y por qué no, en C2. **En código el 2026-11-13:** `GET …/:sucursal/:folio/cancelacion`
   (`OcCancelacionDisponibleDto`: `disponible`, `porque`, `reabriria_requisicion`, `ultima`), con la regla de Kepler
   contra la réplica (≈ 22 ms en prod; para 0000393 y 0000338 dice lo mismo que el ensayo contra Kepler vivo).
2. **El desfase del ODS.** **Medido el 2026-11-13:** la réplica va casi en vivo (el documento más nuevo de
   cada sucursal, de 1 a 16 minutos, por falta de movimiento) y `analytics.erp_purchase_orders` es una vista,
   sin caché. Se resuelve en la pantalla: la fila cancelada aquí dice «Cancelada desde la Suite · Kepler todavía
   no lo refleja» mientras siga en N, y quien la abra después ve «ya se canceló» por el `GET`. Texto original: Después de cancelar, la réplica tarda en ver la OC en C, y mientras tanto la
   lista la seguiría dando por abierta. La lista tiene que leer `purchase_order_cancellations` y decir
   «cancelada desde la Suite, Kepler todavía no lo refleja», no esconderla ni dibujarla abierta.
3. **La 03 y la 04.** Hay una OC cancelable en cada una, y sus bases no están entre los 6 servidores
   con permiso. El adaptador las rechaza con «Kepler todavía no le da a la Suite el permiso».
   **Medido el 2026-11-13** (como `kepler_push`, sólo lectura): la 03 (`192.168.40.40`), la 04 (`192.168.44.44`)
   y la 05 (`192.168.54.54`) son servidores propios; `kepler_push` tiene ahí `UPDATE (c43)` pero **no** el
   resto de D40 ni `DELETE` en `kdm2`. **Extendido el mismo día** (§6, D40): los 9 servidores tienen
   ya los 11 permisos. El interruptor de cada sucursal sigue apagado.
4. **La requisición de la Suite.** Kepler reabre su requisición `X-A-30`, pero el renglón de
   `/compras/requisiciones` sigue en «ordered». **Resuelto por D41 (§6):** se queda así, y su ficha dice
   que su OC se canceló (con motivo y quién), leyendo `purchase_order_cancellations`. Va con C3.

## 4. Opción por opción: a dónde va cada una

| Módulo | Opción | Hoy en la Suite | Destino | Item |
|---|---|---|---|---|
| Requisición | Alta | `/compras/pedido` → `/compras/requisiciones`; aprobar escribe `X-A-30` | ya está | — |
| | Baja | sólo se puede rechazar antes de aprobar | botón «Cancelar en Kepler» en `/compras/requisiciones/:id` | `[KR.7]` |
| | Consulta | ficha de la requisición y «Lo pedido» (PQ.108/109) | ya está | — |
| Orden de compra | Alta | sale con la requisición aprobada (PQ.22) | ya está; el 80 % sigue naciendo a mano en Kepler, sin requisición (§20.1), y cerrar esa brecha es el trabajo de PQ, no de este anexo | — |
| | Modifica | no existe | **no se hace**: se cancela y se reemite, que deja rastro (D39) | — |
| | Baja | la pantalla dice «ciérrala en Kepler a mano» | acción en el side-peek de la orden en `/compras/oc-abiertas` (§3d) | `[PQ.110]` |
| | Consulta | `/compras/oc-abiertas` y `/compras/ordenes/:id` (sólo lectura) | ya está | — |
| Vale de entrada | Alta | el Andén coteja lo que ya se capturó en Kepler | que **cerrar la recepción** en `/almacen/anden` lo escriba | `[PQ.112]` (D37) |
| | Baja | no existe | la baja de la recepción, desde el Andén, **antes** que la alta | `[PQ.112]` |
| | Consulta | Control de entradas | ya está | — |
| Orden de entrada | Alta / Baja | igual que el vale: se capturan juntos el mismo día | van en el mismo acto que el vale | `[PQ.112]` (D37) |
| | Consulta | `/compras/entradas/control/ordenes` (PQ.81) | ya está | — |
| Aplicación | Alta / Baja | `/compras/entradas` valida la factura | **no por ahora**: crea la cuenta por pagar y la póliza; ContPAQi sigue siendo el sistema contable (ADR-040) | `[PQ.114]` (D38) |
| | Consulta | Control de entradas | ya está | — |
| Devolución directa | Alta / Baja | sólo se ve en `/compras/descuentos` | que el reclamo resuelto como «devolver al proveedor» la genere, en `/compras/reclamos` | `[PQ.113]` (D37) |
| | Consulta | `/compras/descuentos` | ya está | — |
| Saldar documento | Alta / Masivamente | no existe | **condicionado a PQ.125**: si hay OC parciales o sin vale que nunca se van a completar, se cierran en `oc-abiertas` (una por fila y en lote); si no, se declara «no se hace». Antes, ver qué escribe de verdad (§3) | `[PQ.125]` → `[PQ.111]` |
| | Baja / Consulta | — | **no se hace**: deshacer un saldado no tiene caso de uso (las cuatro opciones de «Saldar» tienen el mismo uso, 1 en la historia; lo que justifica Alta es la necesidad que mida PQ.125, no el uso del menú) | — |
| Reportes | (sin inventariar) | — | cada reporte va a una pantalla que ya lo contesta, o se declara sin uso; **ninguno se copia tal cual** | `[PQ.122]` (DK3) |
| Autorización de documentos | — | la aprobación de `/compras/requisiciones` | **no se replica**: la aprobación de la Suite ya es la autorización, con dueño, firma y bitácora | — (DK1) |
| Consulta de documentos | — | cada documento se ve en una pantalla distinta; ninguna muestra la cadena completa | **una ficha por folio** con la cadena: requisición → OC → vale → orden de entrada → aplicación → pago, que se abre desde el buscador | `[PQ.123]` (DK2) |

**Resultado:** cero pantallas nuevas. Las 25 opciones caben en ocho pantallas que ya existen, más la
ficha de la cadena (PQ.123), que reutiliza la pieza del anexo T y no inventa otra (ADR-056).

## 5. El orden: dinero en juego × esfuerzo

Cada item sube de capa sólo cuando la de abajo está verificada (C0 dato → C1 dominio → C2 API → C3
pantalla).

0. ✅ **`[PQ.124]` + `[PQ.125]` (C0, medidos el 2026-11-13, §3b).** La liga pasa su control; las
   cancelaciones no son recapturas; hay ~$11 M en OC parciales viejas.
1. **`[PQ.110]` + `[PQ.111]` cancelar y saldar la OC desde `oc-abiertas`.** Es la «Baja» más usada
   (unas 3 por día de OC sin vale) y el esfuerzo es bajo. Su C0 restante: ver en el Kepler vivo qué
   cambia en una cancelación y un saldado reales (§20.6). PQ.110 es **«Cancelar OC» sólo para OC sin
   vale vivo**, con motivo obligatorio; la recepción anulada entera va a PQ.112.
2. **`[KR.7]` la baja de la requisición.** La Suite ya las crea; un documento que no se puede cancelar es
   peor que uno que no se puede crear.
3. **`[PQ.123]` la ficha de la cadena de compra.** Sólo lee, no escribe en Kepler, y contesta todos los
   días «¿dónde va mi compra?». Riesgo bajo.
4. **`[PQ.122]` el inventario de Reportes.** Barato, pero espera la captura desplegada.
5. **`[PQ.112]` la recepción desde el Andén.** El mayor ahorro (dos de tres capturas por recepción) y lo
   más delicado: **la orden de entrada mete inventario**. Espera D37.
6. **`[PQ.113]` la devolución desde Reclamos.** Poco volumen; también saca inventario. Espera D37.
7. **`[PQ.114]` la aplicación.** Al final, o nunca (D38).

## 6. Decisiones (sin firma)

- **DK1 — «Autorización de documentos» no se replica en la Suite.** En Compras no frena nada: 10 OC
  autorizadas en 90 días y 154 recibidas sin autorizar (cifra provisional hasta PQ.124). ⚠️ Antes de
  firmar: ver si las pocas autorizadas (10 OC, 20 requisiciones, 36 órdenes de entrada) se concentran en
  una sucursal o un usuario; si sí, esa sucursal sí usa la autorización y hay que preguntarle por qué
  (va en PQ.124). La autorización que sí importa es la aprobación
  de la requisición en la Suite. **Recomendación: sí.** Si alguna sucursal resulta usar una regla (por
  ejemplo, de monto), se pone en la aprobación de la Suite, no en Kepler.
- **DK2 — «Consulta de documentos» es una ficha por folio con la cadena completa**, la misma pieza que el
  anexo T construye para los traspasos. **Recomendación: sí.** Dos fichas distintas para dos cadenas
  serían el primitivo duplicado que prohíbe ADR-056.
- **DK3 — Ningún reporte de Kepler se copia tal cual.** Cada uno se lleva a la pantalla que ya contesta
  su pregunta, o se declara sin uso. **Recomendación: sí.** Un reporte sin una decisión detrás es carga,
  no información.
- ✅ **D40 — firmada por Edgar el 2026-11-13: (a) sí se le da `DELETE` en `md.kdm2` a `kepler_push`**,
  para que la Suite cancele una OC igual que Kepler (§3c). Con él, `UPDATE` de las columnas que toca la
  cancelación (`c13`–`c16`, `c42`, `c43`, `c67`, `c68`, `c69`). Archivo:
  `ops/prod/kepler-grants/pq110_cancelar_oc.sql`; lo corre el PM con `kepler-sql-todos.js` (pide la
  contraseña de superusuario y no la guarda), primero en 00 y luego en 01, 02, 06, 07 y 08. El permiso
  no enciende nada: el `DELETE` lo acota el adaptador de PQ.110 a una OC sin vale vivo.
  **Aplicado el 2026-11-13 en los 6 servidores donde la Suite escribe OC (00, 01, 02, 06, 07 y 08)**
  (01/06/07 como `sa` desde la PC; 00 y 08 como `postgres` y 02 como `sa` desde `md`; una transacción
  por servidor, `verificar` después = true; en 08 ya daba true antes). La 02 y la 08 se abrieron ese día:
  el PM agregó en su `pg_hba` una línea para `md`, así que los permisos que vengan se aplican desde `md`.
  **`UPDATE (c24)` en `md.kdm2`** (reabrir la requisición): firmado por Edgar y aplicado el 2026-11-13 en
  los 6, desde `md` (una transacción por servidor; antes false, `verificar` completo después = true).
  **03, 04 y 05 (Edgar, 2026-11-13: «hay que dárselo»):** el PM abrió su `pg_hba` para `md` y se aplicó
  el archivo completo como `postgres` (una transacción por servidor, antes false, después true).
  **Verificado como `kepler_push` en los 9: los 11 permisos.**
- ✅ **D41 — firmada por Edgar el 2026-11-13: «se cancela sólo la OC».** En la **Suite**, la requisición de
  `/compras/requisiciones` **no cambia** de estado al cancelar su OC (no vuelve a pendiente): sólo dice que
  su OC se canceló, con el motivo y quién. En **Kepler**, la Suite hace lo mismo que Kepler a mano (§3c):
  la requisición `X-A-30` vuelve a pendiente. El adaptador ya lo hace así; no cambia.
- Siguen sin firma, del plan base: **D37** (¿la Suite escribe documentos que mueven inventario?),
  **D38** (¿escribe la aplicación?) y **D39** (Modifica = cancelar y reemitir).

## 7. Lo que NO se sabe todavía

- **Los submódulos de Reportes**: la captura llega plegada. Pide la captura desplegada (PQ.122).
- **Qué escribe «Saldar»**: `X-A-90` es un documento de cuentas por pagar; que además cierre la OC es
  una inferencia (§3).
- **Por qué se cancela una de cada 8 OC.** Si casi todas son errores de captura que se vuelven a
  capturar, el arreglo está antes de la cancelación. Se mide en PQ.124.
- **Por qué 145 OC (de las 154 en N con vale) tienen un vale de hace 31 a 90 días.** Una hipótesis: las
  captura oficinas y las recibe la sucursal en su propio Kepler (la doble captura de `ERP_KEPLER.md`).
  Sin medir; depende de que la liga pase su control negativo (PQ.124).
- **Las ligas de la cadena después del vale** (vale → orden de entrada → aplicación → pago): sólo
  OC → vale está medida. PQ.123 mide cada una antes de prometer la ficha.
- **En cuántas sucursales escribe hoy la Suite en Kepler.** El sink sólo escribe donde el servidor
  está encendido por variable de entorno (`servidoresEncendidos`); el «2 de 25» vale por opción, no por
  sucursal. Se mide en PQ.124.
- **Cuánto se usa cada opción del menú.** Kepler registra conexiones por clave de opción
  (`kepler_ods.orglogtbl_26`, tabla `sysConnect_26`). Si esa clave corresponde a las opciones del menú,
  se puede contar el uso real de cada una. Sin verificar.
- **Cuánto se usa «Modifica OC».** No deja un documento propio en el ODS, pero Kepler edita en su
  lugar y el cambio se puede fechar por `xmin` en la réplica (una OC con `xmin` posterior a su captura
  fue tocada). Sin medir; no es imposible.

## 8. Items nuevos

- **`[PQ.122]`** ⬜ **C0 — Inventario de «Reportes» de Compras de Kepler.** Con la captura desplegada:
  nombre de cada reporte, quién lo abre (si `orglogtbl` lo permite), qué decisión se toma con él y qué
  pantalla de la Suite ya la contesta. Sale una tabla con destino por reporte (DK3).
- **`[PQ.123]`** ⬜ **C0→C3 — La ficha de la cadena de compra por folio.** Requisición → OC → vale →
  orden de entrada → aplicación → pago, leída del ODS (sin importer, sin copiar tablas). Reutiliza la
  pieza de la ficha del anexo T (DK2). Se abre desde el buscador y desde cada pantalla que ya muestra
  un folio.
  - **C0 (antes de cualquier código): medir cada liga por separado** —vale → orden de entrada, orden
    de entrada → aplicación, aplicación → pago— con su columna, su cobertura (cuántos casan de cuántos)
    y su control negativo (folio desplazado y sucursal equivocada ≈ 0). Una liga que no pasa se dibuja
    como «sin liga medida», nunca como un eslabón vacío.
  - **Criterio de cierre:** una OC terminada con su cadena completa, una OC sin vale y una OC
    cancelada se ven bien en la ficha; cada eslabón dice de dónde salió.
- **`[PQ.124]`** ✅ 2026-11-13 (resultado en §3b) **C0 — Las cancelaciones de OC, medidas (sólo lectura en `pg-prod`).** Decide el diseño
  de PQ.110. Entrega una tabla en este anexo con:
  1. **Control negativo de la liga OC → vale:** folio desplazado ±1 y misma liga contra otra sucursal
     deben casar ≈ 0; las 360 canceladas, 0. Si no pasa, se corrige la liga y se re-miden 154, 166 y 145.
  2. **Clasificación de las 360 cancelaciones (90 días):** *recaptura* (misma sucursal y proveedor,
     otra OC capturada dentro de 48 h con importe ±5 %) · *no surtido* (sin OC de reemplazo) · *otro*.
     Con control: la misma regla aplicada a OC **no** canceladas da la tasa de coincidencia por azar.
  3. **Quién y dónde cancela:** por sucursal y por usuario, y cuántos días después de capturar.
  4. **Autorizaciones (DK1):** las 10 OC, 20 requisiciones y 36 órdenes de entrada en A, por sucursal y
     usuario.
  5. **Dónde escribe hoy la Suite:** sucursales con el servidor encendido para `X-A-30`/`X-A-35`, y
     cuántas OC escritas por la Suite hay en 90 días.
  - **Criterio de cierre:** la tabla publicada aquí, la META de cancelación fijada con número, y una
    línea de decisión para PQ.110: «botón cancelar» o «reemplazar OC».
- **`[PQ.125]`** ✅ 2026-11-13 (resultado en §3b.6: 74 OC parciales de más de 30 días, ≈ $10.9 M; PQ.111 sigue) **C0 — La necesidad real de «saldar».** Contar las OC en **R** (parciales) sin vale
  nuevo en 30, 60 y 90 días, con su saldo pendiente en pesos, y las OC en N/A sin vale con más de 30
  días (hoy 39). Por sucursal.
  - **Criterio de cierre:** si el saldo pendiente viejo es material, PQ.111 sigue (primero el testigo
    de un saldado real en el Kepler vivo); si no, PQ.111 se cierra como ❌ «no se hace» con la cifra.

## 9. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-12 | Anexo K: los 10 módulos del menú Compras de Kepler con sus submódulos (25 opciones). Medido: una de cada 8 OC se cancela; la autorización no frena nada (154 OC recibidas sin autorizar); «Saldar» es un documento de cuentas por pagar (corrige el §20). Nacen PQ.122–PQ.123 y DK1–DK3, sin firma | Claude |
| 2026-11-13 | Revisión crítica, el anexo se vuelve implementable: la métrica principal pasa a ser el acto (OC canceladas desde la Suite, hoy 0 de 360); la liga OC → vale queda provisional hasta su control negativo; «saldar» se condiciona a medir la necesidad; PQ.123 mide cada liga antes de prometer la ficha. Nacen **PQ.124** (cancelaciones medidas) y **PQ.125** (necesidad de saldar), ambos C0 y primeros en el orden | PM + Claude |
| 2026-11-13 | **PQ.124 y PQ.125 ✅** (§3b): la liga OC → vale pasa su placebo (98.4 % contra 18.1 % y 3.2 %); en N con vale son 143, no 154; las cancelaciones no son recapturas (15.2 % contra 16.6 % de azar): 249 OC sin vale y 112 recepciones anuladas enteras; la 01 cancela el 27 %; la autorización no es regla para nadie; la Suite ya escribe requisiciones y OC en 6 sucursales; 74 OC parciales viejas con ≈ $10.9 M. PQ.110 queda como «Cancelar OC sin vale» con motivo | Claude |
| 2026-11-13 | **PQ.110 D41 en pantalla:** la ficha `/compras/requisiciones/:id` dice «su orden de compra … se canceló en Kepler desde la Suite» con cuándo, quién y motivo, sin cambiar de estado; el detalle de la requisición trae `oc_cancelada` (llave sucursal + folio de Kepler: 225 de 227 requisiciones con folio casan así con su OC en la réplica). `check:pantalla` idéntico a la línea base; specs 61/61; `check:templates-types` verde. Sin validación visual | Claude |
| 2026-11-13 | **PQ.110 C3 en código:** «Cancelar en Kepler» en el detalle de la orden (sólo si el `GET …/cancelacion` dice que se puede; si no, su porqué), confirmación con motivo lleno desde la nota de «No surtida / cancelada» y la requisición que vuelve a pendiente, bloqueo en el mismo clic, la fila no afirma «Pendiente» mientras la réplica se pone al día. El aviso de `[PQ.29]` deja de afirmar que todas tienen vale. Los rechazos dejan de decir «va por el Andén» (el Andén aún no cancela: PQ.112). Pruebas: spec nuevo 10/10 con negativa vista en rojo (sin el bloqueo síncrono: 2 rojas); `check:pantalla` igual antes y después (0 fallas nuevas en oc-abiertas); `check:templates` y `check:templates-types` verdes. **Sin validación visual.** Falta: la ficha de la requisición diga que su OC se canceló (D41) | Claude |
| 2026-11-13 | **PQ.110 C2 VERIFICADO.** Empujado sólo PQ.110 sobre `origin/main` (`3e65d9759`, 10 commits rearmados; lo de otras sesiones quedó local). Migración `20261113142557` aplicada en prod (ledger 1177, 0.2 s; tabla con RLS forzado y 0 filas, 9 interruptores apagados con tope 1, llave en 6 roles). CI: `pruebas-db` corrió `test-newdb-pq110-cancelar-oc.js` **25 ✓ · 0 ✗ · 0 no medido** (incluye el SQL de la réplica contra base real); `boot-api` verde (el API arranca y escucha); `ci-green` selló el commit. `landing-guards` se puso rojo por la llave nueva (sola mandaba a una ruta que exige `COMPRAS_PEDIDO_VER`): declarada como llave de acción, igual que `FINANCE_CAJA_VENTANILLA`; los 6 roles con la llave tienen la de ver (medido en prod) | Claude |
| 2026-11-13 | **D40 extendida a 03, 04 y 05** (Edgar): `pg_hba` abierto para `md`, permisos aplicados como `postgres`; verificado como `kepler_push` en los **9** servidores: 11 de 11 | Claude |
| 2026-11-13 | **Hueco 3 de §3d medido:** la 03, la 04 y la 05 tienen servidor propio y `kepler_push` no tiene ahí los permisos de D40 (sólo `UPDATE (c43)`). Extenderlos espera a Edgar | Claude |
| 2026-11-13 | **D41 firmada** (Edgar): «se cancela sólo la OC» — la requisición de la Suite no cambia de estado y sólo dice que su OC se canceló; en Kepler, igual que Kepler (reabre la `X-A-30`, como ya hace el adaptador) | Claude |
| 2026-11-13 | **PQ.110 C2, hueco 1 de §3d en código:** `GET …/cancelacion` dice si se puede ofrecer el botón y por qué no (interruptor, tope, ya cancelada, regla de Kepler contra la réplica: ≈ 22 ms en prod). Los mensajes nombran la sucursal en vez de su código. Prueba de base real extendida (7b–7c), NO MEDIDA | Claude |
| 2026-11-13 | **PQ.110 C3, diseño** (§3d): las 5 preguntas con datos de prod. 53 OC marcadas «No surtida / cancelada» siguen en N sin vale (≈ $4.0 M): son las que el botón cierra. El aviso de `[PQ.29]` dice algo falso (sólo 21 de 160 tienen vale vivo). Cuatro huecos antes de C3; el primero (saber si está apagado antes de ofrecer el botón) es de C2 | Claude |
| 2026-11-13 | **PQ.110: `UPDATE (c24)` en `kdm2` aplicado en los 6** (firma de Edgar). Ensayo repetido en la 08 como `kepler_push`: 11 de 11 permisos, sin fallas, las 3 OC intactas. La migración de C2 sigue sin aplicar: el envoltorio exige que esté en `origin/main` (falta push) | Claude |
| 2026-11-13 | **PQ.110 C2** (`3b0dcb360`): tabla `purchase_order_cancellations` (cada intento, con capturista/fecha/hora originales), interruptor `cancela_oc` apagado con tope 1/día, llave `COMPRAS_OC_CANCELAR` (5 roles, no GESTIONAR: lo tienen marketing, finanzas y tesorería) y el endpoint. Migración sin aplicar; prueba de base real y arranque sin medir | Claude |
| 2026-11-13 | **PQ.110 C1** (§3c): cancelar una OC reabre su requisición (25 de 25); regla + sentencias en `kepler-oc-cancelacion.ts` (14 pruebas, prueba negativa vista en rojo) y `KeplerOcCancelAdapter`; ensayo en la 08 sin escribir: verde salvo el permiso `UPDATE (c24)` en `kdm2`, que espera firma | Claude |
| 2026-11-13 | **Testigo de la cancelación** (§3c, respaldos de `md` contra prod): cancelar pone `c43`=C, importes y `c42` en 0, **sobrescribe `c67` con quien cancela y `c68`/`c69` con la fecha de cancelación**, y borra los renglones → PQ.110 necesita `DELETE` en `kdm2` (D40). Corrige §3b: la recaptura queda **no concluyente** (la fecha original se pierde) y `c67` en las canceladas es quien canceló. **20 de las 195 OC de la Suite las canceló una persona a mano en Kepler** (18 en la 08) sin que la Suite se entere. `c42` = saldo en pesos: 110 OC en N con vale tienen $11.1 M en papel contra $0.8 M por vales | Claude |
