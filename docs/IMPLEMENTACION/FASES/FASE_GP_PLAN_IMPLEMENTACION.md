# Fase GP — Plan de implementación (etapas, capas, objetivos y metas)

> Anexo de [`FASE_GP_GESTION_PEDIDOS_ALMACEN.md`](FASE_GP_GESTION_PEDIDOS_ALMACEN.md) (el plan
> reestructurado el 2026-11-13, decisiones D1–D25). Este archivo dice **en qué orden se construye,
> con qué capas, para lograr qué y cómo se sabe que se logró**. Método:
> [`METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md) (C0 dato → C1 dominio → C2 API → C3 UI; una
> etapa no sube de capa hasta que la de abajo está verificada).
>
> **Las cifras «HOY» se midieron el 2026-11-13** en `pg-prod` (sid `7688376744939610156`), sólo
> lectura, ventana de 30 días, salvo que se diga otra cosa. Las **metas son propuesta** y las firma
> el PM al abrir cada etapa, con su fecha.

---

## 0. En una pantalla

| Etapa | Objetivo | Bloques | Esfuerzo | Meta principal (HOY → META) |
|---|---|---|---|---|
| **E0** Preparación | Que nada se construya sobre un supuesto | GP.12.0 · GP.15.0 · GP.8.0 | M | Decode de las 3 capturas de estatus de Kepler: **NO MEDIDO → 0 campos sin explicar** · ADR firmado · piloto con dueño |
| **E1** Consola maestra | Un solo lugar para ver todos los pedidos y su estado real | GP.10 | M | Pantallas para seguir un pedido: **3 → 1** · pedidos del periodo visibles: **100 %**, cuadrados contra Kepler y la Suite |
| **EA** Autorizar pedidos TLMK ([anexo](FASE_GP_ANEXO_AUTORIZACION_PEDIDOS.md)) | Dentro del límite se autoriza solo (avisando a Crédito y cobranza, D-A3 de Edgar); lo demás lo decide Crédito y cobranza con una ficha de crédito y una sugerencia de límite | GP.A.0–GP.A.8 | L | Autorizados solos: **19.8 % (simulado) → ≥ 33 %** con límites revisados · autorizaciones con evidencia: **0 % → 100 %** · dinero en juego: **$3.1 M vencido a más de 45 días** |
| **E2** Carretas | Cada pedido en surtido tiene su carreta y se encuentra escaneándola | GP.11 | M | Surtidos en la Suite con carreta: **0 % → 100 %** |
| **E3** Surtido en Kepler + checado | Lo surtido llega a Kepler sin recaptura, y se checa en la Suite | GP.12 (Surtido, Checado) · GP.13 | L | Surtidos en la Suite que siguen `AUTORIZADO` en Kepler: **16 → 0** · checados en la Suite: **0 → 100 %** de lo surtido en el piloto |
| **E4** Embarque | Saber dónde está cada pedido checado y qué camión lo llevó | GP.14 · GP.15 · GP.12 (Embarcado) | L | Pedidos embarcados con estiba registrada: **~⅓ en Padre Hidalgo, relleno o 0 en el resto (Kepler, oct) → 100 % escaneada** en el piloto |
| **E5** Cierre y piloto | El piloto opera sin papel dos semanas y se mide | GP.16 · GP.7 · GP.8 | M | **Métrica de la fase:** U-D-40 de la sucursal piloto surtidos en la Suite **≈1 % → 90 %** |

**Esfuerzo total: XL** (más de un mes con un dev). **Dinero en juego: NO MEDIDO** — el beneficio
hoy es indirecto (trazabilidad, quitar papel y recaptura). E0 incluye el intento de medirlo (§2).
Con la regla del PM (Bajo × XL = prioridad 4), **sin esa medición la fase compite mal**: es una
razón más para medir antes de comprometer E3–E5.

---

## 1. El orden y por qué

```
E0 Preparación ──────────────┐ (decode + ADR bloquean E3)
E1 Consola maestra ──────────┤ (sólo lectura: arranca ya, sin esperar a E0)
                             ▼
                E2 Carretas ──▶ E3 Surtido en Kepler + checado ──▶ E4 Embarque ──▶ E5 Piloto
Fase UB (pasos 1–2, ubicaciones y censo) ── en paralelo, es trabajo de piso con su propia fase
```

| Orden | Etapa | Por qué va ahí |
|---|---|---|
| 1 | **E1** | Es de lectura, no depende de escribir en Kepler, la usan ya 23 personas al mes y da la vista sobre la que se miden todas las demás etapas |
| 1 (paralelo) | **E0** | Es investigación de sólo lectura y decisiones; sin ella E3 escribiría en Kepler sobre un supuesto (regla 10) |
| 2 (propuesta del 2026-11-19) | **EA** | Primer uso del carril de escritura de E3 con lo mínimo (una columna, `c11`, sin cantidades); comparte sólo el bloqueo GP.12.0e; un pedido sin autorizar no llega al pool de surtido. Si se abre, **reemplaza a E2 como siguiente etapa**, no se suma ([anexo](FASE_GP_ANEXO_AUTORIZACION_PEDIDOS.md) §5) |
| 2 | **E2** | El checado y el embarque se apoyan en la carreta; sin ella no hay forma de encontrar el pedido |
| 3 | **E3** | Es lo que rompió el plan de octubre (nadie recapturaba). Cierra el hueco Surtido→Checado |
| 4 | **E4** | Necesita bultos (E3) y carretas (E2); depende del catálogo de unidades |
| 5 | **E5** | El piloto mide la métrica de la fase con todo el recorrido funcionando |

⛔ **Cupo:** hoy hay **6 fases 🔨 contra un tope de 4** (`tablero.js`, 2026-11-13). GP está en 🧪.
Construir E1–E5 la pasa a 🔨: **el PM tiene que cerrar o pausar dos fases antes**, o decidir
explícitamente por encima del cupo (como pasó con PGP, ALC y DN). E0 es lectura y decisiones.

---

## 2. E0 — Preparación (C0 + decisiones)

**Objetivo:** que E3 y E4 escriban en Kepler sabiendo exactamente qué escribe Kepler cuando la
persona captura cada estatus a mano, y que haya piloto con dueño.

| # | Resultado | Capa | Verificado contra / entrega |
|---|---|---|---|
| **GP.12.0a** 🧪 | Se sabe qué campos cambia Kepler al capturar *Estatus Surtido*, *Estatus Checado* y *Estatus Embarque*: diff por `xmin` en la réplica de 3 pedidos por pantalla, en la sucursal piloto. Incluye la **unidad de `kdm2.c51` vs `c52`** (pendiente desde GP.0: pedida y surtida vienen en unidades distintas), responsables `c100/c102/c103` y ubicaciones `c59/c60/c61`. **Medido el 2026-11-13 (§2.1).** Por corte transversal: unidad resuelta, recálculo del importe encontrado, Salida por Embarque separada. **Foto antes/después hecha el 2026-11-19** (§2.2): 71 cambios de estatus, con 8 a 18 casos de cada etapa suelta. Ya está escrito qué columnas toca cada etapa y con qué valor; esa lista es la de GP.12.0e. Hallazgos: «Estatus Embarque» deja `c43` en `A`, y es la Salida por Embarque la que lo pasa a `F` y deja el saldo en 0; el checado cambia una unidad borrando y volviendo a crear el renglón. Cuatro columnas quedan sin decodificar (se sabe qué hace Kepler con ellas, no qué significan), y se abren P-GP.11 (quién va en «capturó» y «responsable») y P-GP.12 (si la salida queda en Kepler) | C0 | La pantalla de Kepler (captura de la persona que lo hizo) y el `kdm2` antes/después |
| **GP.12.0e** ⬜ | **Permisos por columna para `kepler_push`**, en un archivo propio como `ops/prod/kepler-grants/pq110_cancelar_oc.sql`. Contiene `UPDATE` sólo en las columnas que mide GP.12.0a (ADR-117, tabla). El `DELETE` en `md.kdm2` ya está desde D40 (00, 01, 02, 06, 07 y 08). Lo corre el PM | C0 | El permiso aplicado, verificado como `kepler_push` en sólo lectura (`has_column_privilege`) |
| **GP.12.0d** 🧪 | Se sabe **cómo recalcula Kepler el renglón y la cabecera cuando una etapa baja la cantidad**. **Medido el 2026-11-13:**<br>· `c56` es la cantidad vigente y `c9` = `c56 × c58`.<br>· El renglón: `c13` = `round(c9 × c12, 2)` en 47,626 de 47,626 renglones.<br>· La cabecera: `c16` = `round(Σc13 × (1 − c19/100), 2)` en 2,884 de 2,885 pedidos (el otro a 5 centavos, por el kg sin redondear de E.25), incluidos los 508 con diferencia.<br>· `c14`/`c15` (IVA, IEPS) ya los reproduce `armarPedidoTlmk` → `totalesCotizacion` (E.25, 79 de 79), **y se reusa** (ADR-056).<br>**Verificado el 2026-11-13** con esa misma función: descuento, IVA, IEPS y total al centavo en **2,889 de 2,890** pedidos embarcados y **509 de 509** con diferencia (el otro, a 2¢ por kilos sin redondear). Control negativo: con la cantidad pedida, 6 de 508 | C0 | Espejo: el importe que Kepler calculó en esos 508 pedidos, al centavo |
| **GP.12.0b** ✅ | **[ADR-117](../02_DECISIONES_ARQUITECTURA.md), firmado por Edgar el 2026-11-13.** ADR que **enmienda ADR-086**: la Suite actualiza en su lugar el estatus y las cantidades de un `U-D-40` existente: interruptor por sucursal apagado al nacer, todo o nada, idempotente, sólo desde `md`. **Ya tiene precedente:** `[PQ.110]` actualiza en su lugar una OC de Kepler (`UPDATE` de cabecera con el estado leído en el `WHERE`, más `DELETE` de renglones; `kepler-oc-cancelacion.ts`). GP.12 sigue ese patrón, no inventa otro | Decisión | Firma del PM |
| **GP.12.0c** 🧪 | Catálogo de motivos de diferencia (falta de existencia, dañado, …): reusar el de preventa (`shared/motivos-preventa`) en vez de inventar otro (ADR-056). **Existe y se reusa:** `MotivoOpcion` y `errorDeMotivo` en `libs/contracts`, `http-motivo.ts`, `motivo-chips.component.ts` (motivo por omisión, «Otro motivo» pide nota). **Propuesta del 2026-11-19, para que la firme el dueño de piso:**<br>· **Surtido** (GP.12.1): `MOTIVOS_SURTIDO` tal cual, con «No había en la sucursal» marcado de entrada. En preventa, 60 días: 352 de 368 motivos fueron ése, 12 «el sistema dice que hay, pero no lo encontré» y 4 los demás.<br>· **Checado** (GP.13): `MOTIVOS_CAJA` con la misma clave `no_venia`, rotulada sólo «No venía»: en el almacén hay carretas **y** carritos (aclaró Edgar el 2026-11-19), y cuál traía el pedido ya lo guarda su asignación (GP.11.2), así que el motivo no lo repite. En caja, 60 días: 15 de 15 fueron «No venía».<br>· **Deuda con nombre (ADR-056):** el surtido por olas registra la causa con un vocabulario propio (`agotado`, `danado`, `faltante` en `wave_lines.status`), sin motivo ni nota. En 60 días: 106 renglones, 5 con faltante. Se pasa al catálogo de arriba en GP.12.1, no se crea un tercero | C0 | Lista firmada por el dueño de piso |
| **GP.15.0** 🧪 | Se sabe qué hay en `logistics.vehicles` (ya tiene `capacity_boxes` y `capacity_kg`): unidades reales contra las 33 de prueba (GP.P1), y dónde va el número de estibas (**extender esa tabla, no crear otra**). **Medido:** 57 unidades activas, 28 ligadas a Kepler (`kepler_code`), **1** con capacidad en cajas, ninguna con estibas. Kepler tiene 33 transportes (`kdm_transporte`, el mismo catálogo replicado en las 9 sucursales). Va como columna nueva en `logistics.vehicles` | C0 | Lista de camiones del piloto con Logística |
| **GP.8.0** 🧪 | Sucursal piloto, dueño de piso y META con fecha firmados (P-GP.1, P-GP.8). **Piloto: Padre Hidalgo** (D28). Falta el dueño de piso (P-GP.1); la fecha de la META se fija al cerrar E4 | Decisión | Firma del PM |
| **GP.7.0** 🧪 | Intento de medir el dinero en juego: diferencias pedido→embarcado y devoluciones atribuibles a error de surtido, 90 días, en la sucursal piloto. **Si no hay testigo que separe el error de surtido, se declara NO MEDIDO** y no se infla. **Resultado: NO MEDIDO.** Las diferencias aparecen en el checado (§2.1), pero nada separa un error del surtidor de un faltante de existencia; esto último es de DN/FLT, no de GP | C0 | Notas de crédito / devoluciones de Kepler |

**Meta E0:** 0 campos del diff sin explicar · ADR firmado · piloto y META firmados · dinero en juego
medido o declarado NO MEDIDO.
**HOY (2026-11-19):** unidad resuelta; importe explicado al centavo, IVA e IEPS incluidos
(GP.12.0d); ADR-117 firmado el 2026-11-13; piloto elegido (Padre Hidalgo) sin dueño de piso;
dinero en juego NO MEDIDO; la foto antes/después del 2026-11-19 junta 71 cambios de estatus y dice
qué columnas toca cada etapa (§2.2), con 4 columnas sin decodificar y dos preguntas para el PM
(P-GP.11, P-GP.12). GP.12.0e ya tiene su lista de columnas y lo corre el PM.

### 2.1 Lo que midió E0 (2026-11-13, prod sólo lectura, pedidos `U-D-40` de 30 días)

1. **La unidad no es problema.** `c51` (pedida), `c52` (surtida), `c53` (checada) y `c54`
   (embarcada) están en la unidad de `c55`. En 45,320 de 45,551 renglones embarcados con las dos
   cantidades, la surtida es igual a la pedida. La trampa de GP.0 venía de los **2,022 renglones
   sin `c51`**, que se agregaron después de crear el pedido (`c28`), no de una unidad distinta.
   Los nombres de las otras tres columnas:
   - `c56` es la **cantidad vigente**: sigue a la última etapa;
   - `c9` es `c56 × c58`, en unidad base;
   - `c57` es el precio por presentación.
2. **El surtido de Kepler no registra diferencias.** Sólo 146 de 47,626 renglones tienen una
   surtida menor que la pedida. Las bajas aparecen en el checado (`c53`) o en el embarque
   (`c54`); hay 656 renglones con embarcada menor que pedida.
   - Hoy «Estatus Surtido» copia lo pedido. La primera cifra real de surtido será la de la Suite.
   - **Consecuencia:** escribir SURTIDO con faltantes cambiará en Kepler cifras que hoy cambian
     más tarde.
3. **Bajar una cantidad mueve dinero, y la cuenta ya está explicada.** Kepler recalcula:
   - `c56` (cantidad vigente);
   - `c9` = `c56 × c58`;
   - el renglón: `c13` = `round(c9 × c12, 2)`, con `c12` el precio en unidad base;
   - la cabecera: `c16` = `round(Σc13 × (1 − c19/100), 2)`, con `c19` el descuento del cliente.

   Cuadra al centavo en 2,884 de 2,885 pedidos, incluidos los 508 con alguna diferencia. IVA e
   IEPS (`c14`, `c15`) los reproduce ya `totalesCotizacion` (E.25). Escribir una cantidad distinta
   reusa esa función (GP.12.0d); la escritura sigue en dos tiempos hasta verificarla sobre los 508
   (D27).
4. **EMBARCADO trae un documento que saca inventario.**
   - 2,862 de 2,948 pedidos embarcados tienen exactamente un `U-D-41` (*Salida por Embarque*,
     `c8 = S`) con su guía. Ningún pedido en otro estatus tiene uno.
   - En CEDIS hay 67 embarcados **sin** `U-D-41`. Eso prueba que *Estatus Embarque* y *Salida por
     Embarque* son capturas separadas.
   - La Suite escribe el estatus. La salida (inventario, guía, factura) sigue en Kepler (D26).
5. **El transporte nace con el pedido, por omisión.**
   - Los pedidos en `AUTORIZADO` traen `c83` y `c84` en el 95–100 % con 1–2 valores distintos.
   - En los `EMBARCADO` hay de 4 a 10 transportes distintos, así que el real se asigna después,
     como dice D19.
   - El chofer en el embarque va en 0–5 % en Telemarketing de Padre Hidalgo y Morelia Abastos
     (D21 se cumple ahí) y en 92 % en Canindo.
6. **Responsables:** se capturan en el 77–80 % de los embarcados y en el 45 % de los surtidos. Kepler
   no los exige.
7. **D23 se confirma:** de los 1,318 embarques con factura (`U-D-8`), 1,308 se facturaron con la
   misma fecha. Los traspasos a sucursal no se facturan: CEDIS, 615 embarques, 0 facturas.
8. **Un pedido cancelado conserva su estatus.** Kepler lo marca `c43 = 'C'`, deja el importe en $0
   y borra los renglones, como con la OC (PQ.110), pero **no cambia `c11`**.
   - Son 180 en 30 días (5.4 % de los `U-D-40`).
   - 70 de los 94 que aparecen «en SURTIDO» están cancelados.
   - La consola de hoy (`warehouse-orders.service.ts`) **no lee `c43`**: los cuenta como pedidos
     vivos y los pinta como atorados. Se arregla primero (GP.10.0).
9. **El checado y el embarque borran el renglón que queda en cero y renumeran los demás.**
   Comparado por producto en los dos casos reales que capturó la foto (§2.2):
   - **Morelia Abastos, en el checado:** 7 productos sin checar salieron del pedido y 19 cambiaron
     de número de renglón (`c7`). Se recalcularon `c13`–`c16` y `c42`.
   - **Padre Hidalgo, en el embarque:** salieron 5 productos y **entraron 2 nuevos**.

   Escribir CHECADO o EMBARCADO con faltantes es entonces `DELETE` + renumerar + recalcular, no sólo
   cambiar una cantidad. Hoy Kepler deja agregar productos en piso: el 3.2 % de los renglones nace
   después del pedido (P-GP.10).

### 2.2 Foto antes/después (GP.12.0a)

Se toma una foto completa (`kdm1` + `kdm2`, todas las columnas) de los `U-D-40` abiertos en
`pg-prod` (por `md`, sólo lectura, verificado por `system_identifier`), cada 5 minutos se leen **los
mismos pedidos** y se compara, columna por columna y por transición de estatus, con el valor de
antes y de después. Los renglones se emparejan por producto, porque Kepler los renumera. También
dice si nació el `U-D-41`.

- **Controles hechos:**
  - con respuesta conocida: la foto contra sí misma da vacío;
  - negativo: una copia alterada a propósito sale con exactamente lo alterado.

#### Resultado del 2026-11-19 (71 cambios de estatus, 13:51–16:05, las 9 sucursales)

Hay casos de las cuatro etapas sueltas: CREADO→AUTORIZADO **8**, AUTORIZADO→SURTIDO **15**,
SURTIDO→CHECADO **12**, CHECADO→EMBARCADO **18**. Además, 12 pedidos brincaron dos o tres etapas en
menos de 5 minutos (la recaptura del papel al final) y 5 se cancelaron en SURTIDO.

| Etapa | Cabecera (`kdm1`) | Renglones (`kdm2`) |
|---|---|---|
| **CREADO→AUTORIZADO** | sólo `c11` | nada |
| **AUTORIZADO→SURTIDO** | `c11`; `c69` = hora de esta captura; `c88` `'0'`→vacío y `c30` (texto, p. ej. la condición de pago)→vacío; `c83`/`c84` a `'0'`; `c67` = quien captura; `c100` (responsable) en 3 de 15; `c63` cambia de prefijo en 6 de 10; `c13`–`c16` y `c42` se recalculan si se quitó algo | `c52` (surtida) en todos; **`c62` y `c63` se vacían en todos**; `c59` (ubicación de surtido) en 5 de 29; **renglones en cero salen y los demás se renumeran** (`c7`) |
| **SURTIDO→CHECADO** | `c11`, `c69`; `c83`/`c84` se vacían; `c102` (responsable) en 2 de 5; `c13`–`c16` y `c42` recalculados | `c53` (checada); salen renglones, **entran** otros y se renumeran. Un cambio de unidad es **borrar y volver a crear** el renglón: el nuevo trae `c28 = 'CHECADO'`, otra `c55`, `c62`/`c63` llenos y sin `c51`/`c52` |
| **CHECADO→EMBARCADO** | `c11`, `c69`; **`c43` `N`→`A`**; `c85` de `'0'` a número (domicilio de entrega) en todos; `c103` (responsable) en 2 de 4 | `c54` (embarcada); `c62`/`c63` se vacían |
| **Salida por Embarque** (`U-D-41`, otra captura) | **`c43` `A`→`F`**, **`c42` (saldo) → 0**, `c83` = transporte, `c86` = guía (el mismo número en el pedido y en su `U-D-41`: 2,839 de 2,840 en 30 días) | `c24` → 0 |
| **Cancelar** | `c43` `N`→`C`, `c16` y `c42` → 0, **`c11` no cambia** | se borran todos |

**Lo que confirma el corte de 30 días** (embarcados no cancelados): `c43 = F` en 2,830, todos con
`U-D-41` y saldo 0; `c43 = A` en 73, y 68 de ellos **sin** `U-D-41`. O sea que «Estatus Embarque»
deja el pedido en `A` y es la salida la que lo cierra. **La salida llega después**: de 18 pedidos
vistos pasar a EMBARCADO, sólo 4 tenían su `U-D-41` media hora más tarde (en 3 casos nació en la misma
pasada).

**Qué tendría que escribir la Suite en cada etapa** (es la lista de columnas de GP.12.0e; la salida
sigue en Kepler, D26):
- **SURTIDO:** `kdm1.c11`, `c69`, `c67`, `c100`, `c30`→vacío, `c88`→vacío, `c83`/`c84`→`'0'`, y si
  algo bajó, `c13`–`c16` y `c42` (GP.12.0d). `kdm2.c52`, `c59`, `c62`/`c63`→vacío; `DELETE` de los
  renglones en cero y renumerar `c7`.
- **CHECADO:** `kdm1.c11`, `c69`, `c102`, `c83`/`c84`→vacío, recálculo. `kdm2.c53`, `c60`; `DELETE`,
  renumerar e `INSERT` para un renglón nuevo o un cambio de unidad.
- **EMBARCADO:** `kdm1.c11`, `c69`, `c43`→`'A'`, `c85`, `c103`. `kdm2.c54`, `c61`.

**Sin decodificar**: de estas columnas se conoce lo que Kepler hace con ellas, no qué significan, y
la Suite las imitaría.
- `kdm1.c63`: prefijo `PD-` o `PD26-`, que a veces cambia.
- `kdm1.c88`: vale `'0'` y se vacía al surtir.
- `kdm1.c30`: texto que se vacía al surtir.
- `kdm2.c62` y `c63`: números que se vacían en cada captura (`c62` = `c63` × la cantidad en los
  casos vistos).

**Preguntas que abre (para el PM):**
- **P-GP.11**: ¿qué va en `c67` (quien captura) y en `c100`/`c102`/`c103` (responsables) cuando
  escribe la Suite? Kepler pone ahí claves de sus usuarios y empleados. Falta el puente entre la
  persona de la Suite y su clave de Kepler, o una clave fija «SUITE».
- **P-GP.12**: ¿la Suite deja el EMBARCADO en `A` y la salida sigue en Kepler (D26 tal cual), o
  E4 también la cubre?

**Casos de la primera foto** (2026-11-13, los primeros 22 minutos), que abrieron la pregunta:
- **La prueba negativa encontró un hueco:** 117 pedidos abiertos no tienen renglones. Son los
  cancelados del punto 8.
- **Foto del 2026-11-13, 16:28:** 375 pedidos y 2,189 renglones. Se repite el diff hasta juntar
  ≥3 pedidos por transición: CREADO→AUTORIZADO, AUTORIZADO→SURTIDO, SURTIDO→CHECADO y
  CHECADO→EMBARCADO.
- **Los datos no van al repo**, porque es público. El script es de la sesión: se reescribe con
  esta receta si hace falta.
- **Casos reales**:

  | Pedido | Transición | Cabecera (`kdm1`) | Renglones (`kdm2`) | `U-D-41` |
  |---|---|---|---|---|
  | Morelia Abastos | CREADO→AUTORIZADO | `c11` | — | no |
  | Morelia Abastos | CREADO→SURTIDO | `c11`, `c67`, `c69`, `c83`, `c84`, `c88`, `c100` | `c52`, `c62`, `c63` | no |
  | Morelia Abastos | CREADO→CHECADO | `c11`, `c30`, `c67`, `c69`, `c88`, `c100`, `c102` | `c52`, `c53`, `c62`, `c63` | no |
  | Morelia Abastos | SURTIDO→CHECADO | `c11`, `c13`–`c16`, `c42`, `c63`, `c69`, `c83`, `c84`, `c102` | `c53`; 7 productos salen, 19 renumerados | no |
  | CEDIS | SURTIDO→EMBARCADO | `c11`, `c43`, `c69`, `c83`–`c85`, `c102`, `c103` | `c53`, `c54` | no |
  | Padre Hidalgo | CHECADO→EMBARCADO | `c11`, `c16`, `c42`, `c43`, `c63`, `c69`, `c85`, `c103` | `c54`; 5 productos salen, 2 entran | no (todavía) |
  | Padre Hidalgo | AUTORIZADO→EMBARCADO, en <4 min | `c11`, `c30`, `c42`, `c43`, `c69`, `c83`–`c86`, `c88`, `c100`, `c102`, `c103` | `c24`, `c52`–`c54`, `c62`, `c63` | **sí, en la misma pasada** |

  Ese día faltaban casos de una sola etapa; los juntó la foto del 2026-11-19 (arriba).

  El de Padre Hidalgo muestra que las cuatro capturas (surtido, checado, embarque y salida) se
  hacen de corrido al final: es la recaptura del papel. EMBARCADO también toca `c43` (estado del
  documento) y `c42` (saldo).


---

## 3. E1 — Consola maestra (GP.10)

**Objetivo:** que quien coordina vea en una sola pantalla todos los pedidos (Kepler y preventa) con
su estado real en Kepler y en el piso, y priorice desde ahí (D1, D2).

| # | Resultado | Capa | Depende | ¿Escribe? |
|---|---|---|---|---|
| **GP.10.0** 🧪 | **Veracidad, antes que nada:** la consola deja de contar como vivos los pedidos cancelados (`c43 = 'C'`). Se ven aparte, como «cancelado», y no entran a los totales ni al «sin embarcar más antiguo». Antes eran 180 en 30 días, y 70 de los 94 que se veían «en SURTIDO» (§2.1 punto 8). **Hecho el 2026-11-13** con una sola expresión, `ESTATUS_VIGENTE_SQL`, que usan el Tablero, la cola de Surtir y los atorados: «en SURTIDO» de noviembre pasa de 54 a 20, y la cola de 75 a 60. La cabecera de los pedidos que ya están en una ola sigue en GP.10.1 | C0/C1 | — | no |
| **GP.10.1** 🧪 | **Hecho el 2026-11-13, como continuación del arreglo de GP.10.0** (es el mismo defecto: cancelados vivos en el checado, la captura y las olas), sin abrir E1. La cabecera por llave sale de `cabeceraVigenteSql`, en `kepler-origen.ts`, y la usan las cabeceras de las olas, la captura y el checado. Medido en prod: de 60 pedidos en olas, 53 salen iguales y 7 pasan a CANCELADO (los mismos 7 medidos aparte). La consulta queda de ~200–260 ms a ~50–70 ms con 2,500 llaves, porque usa el índice. Una prueba falla si la captura o el checado vuelven a leer `h.c11` por su cuenta. Fuera: el seguimiento de cotizaciones (GP.10.1b). La definición original sigue: | C0/C1 | — | no |
| **GP.10.1b** 🧪 | El **seguimiento de la cotización** (`quote-tracking`) muestra el pedido cancelado en Kepler como cancelado. Hoy lee `c11` y pinta «Surtido ✔» en un pedido cancelado: 11 de 1,507 pedidos de telemarketing en 30 días. Toca la pantalla de televenta. **Hecho el 2026-11-19** con `ESTATUS_VIGENTE_SQL`: dice «Pedido cancelado en Kepler», sin pasos pendientes y sin «quitados» falsos (Kepler borra los renglones al cancelar). Medido: 6 de 359 cotizaciones en Kepler con el pedido cancelado, 3 decían «Embarcado» sin embarque; los 353 vivos no cambian | C1→C3 | GP.10.1 | no |
| **GP.10.1 (definición original)** | La «cabecera vigente» del `U-D-40` en `kdm1` se calcula en **un solo lugar**. Hoy está reescrita en 4 servicios (`warehouse-orders`, `kepler-origen`, `picking-captura`, `checado`) | C0/C1 | — | no |
| **GP.10.2** 🧪 | **Hecho el 2026-11-13:** `etapaDePedido` (`warehouse-orders/etapa-pedido.ts`). En noviembre, en prod: 1,342 pedidos de Kepler y 591 de preventa, cada uno en una sola etapa. «Piso adelante» 11, igual que el control. «Kepler adelante» 19 de 34 metidos a olas. `etapaDe` y el `state` de la bandeja se quedan por D9 (GP.10.2-deuda); el cruce contra `etapaDe` encontró un defecto que quedó corregido. Definición original: la **etapa del pedido** se deriva con una sola función (Kepler + olas + `presale_picks` + checado), que reemplaza las dos derivaciones duplicadas de preventa (`etapaDe` y `state`). Cada etapa dice su fuente (Kepler o piso) | C1 | GP.10.1 | no |
| **GP.10.3** 🧪 | La consola lista `U-D-40` y `PD-` del periodo con filtros por origen, sucursal, etapa y texto, en < 500 ms. **Hecho el 2026-11-13:** `presale=1` y `stage=` en `GET /warehouse/orders`, con la etapa en cada fila y conteos por etapa. Probado con el servicio real contra prod: noviembre, 1,269 de Kepler y 588 de preventa; 254–362 ms con preventa; la primera llamada en frío tardó 511 ms. **NO MEDIDO:** si salieron 512 pedidos de preventa revisados en caja (la Suite no registra la salida desde el 17-oct) | C2 | GP.10.2 | no |
| **GP.10.4** 🧪 | El Tablero absorbe Preventa (como origen) y la Consola de surtido (prioridad, hora de salida, armar, con `ALMACEN_SURTIDO_COORDINAR`); las dos pestañas viejas redirigen. Se parte en 4a/4b/4c (§3.1) | C3 | GP.10.3 | usa las acciones que ya existen |
| **GP.10.4a** 🧪 | **Hecho el 2026-11-14.** El Tablero lista Kepler **y** preventa. Los botones son por **etapa**. La fila avisa cuando Kepler va atrás de la Suite. Un `PD-` abre su resumen y lleva a la Mesa de Control con el pedido abierto (`?pedido=`). Medido con el servicio real en prod (noviembre): «Todos» 1,901 = lista 1,901 = totales; «autorizados en adelante» 1,867 = lo esperado; 597 `PD-`, todos con su liga; 11 filas con «Kepler aún dice». 200–230 ms en caliente; la primera llamada en frío, 330–603 ms. ⚠️ La respuesta pesa 1.29 MB (905 KB sin preventa), y el tope de 2,000 filas se alcanzará a mediados de mes (octubre completo ya lo topa): los conteos sí cuentan todo y la pantalla lo dice. Va a GP.10.5 | C3 | GP.10.3 | no |
| **GP.10.4b** 🧪 | **Hecho el 2026-11-14.** La fila de surtido es la segunda vista del Tablero (`?vista=fila`), sólo con `ALMACEN_SURTIDO_COORDINAR`. Es el mismo componente de la consola, con su título apagado (`embebida`), no una copia. En esa vista la lista de pedidos no se pide. Acceso medido: los 3 roles con la clave (12 personas) ya ven el Tablero | C3 | GP.10.4a | usa las acciones de la consola |
| **GP.10.4c** 🧪 | **Hecho el 2026-11-14.** Salen las pestañas Preventa y Consola de surtido. `/almacen/surtido-consola` lleva a `/almacen/pedidos?vista=fila`; `/almacen/pedidos/preventa` sin pedido lleva a `?origen=PREVENTA`, y con `?pedido=` abre la Mesa, que ahora tiene «← Tablero de pedidos». La ruta vieja de la consola queda como entrada de aterrizaje de quien sólo coordina (hoy nadie), y el Tablero lo acepta y le abre la fila. La bandeja de pendientes y el árbol de permisos siguen apuntando a la ruta vieja, que redirige | C3 | GP.10.4b | no |
| **GP.10.5** 🧪 | Correcciones de la consola: el volumen deja de encimarse sobre el estatus; unidades con leyenda; el importe de venta y el de traspaso se muestran separados en el total (D4). **Hecho el 2026-11-17, en prod:** lista por páginas (antes 1.40 MB y topada a 2,000 de 2,358, con 348 preventas invisibles), total por destino (D4: $22.1 M de traspasos se leían como venta), leyenda del volumen, y el volumen ya no se encima (36 de 200 → 0, con GP.RF.22). Detalle en la [auditoría de interfaces](FASE_GP_AUDITORIA_INTERFACES.md) §5.5–5.7 | C3 | GP.10.4 | no |

**Meta E1:**
- Pantallas para seguir un pedido: **HOY 3** (Tablero, Preventa, Consola de surtido) → **1**.
- Pedidos visibles: **100 %** de los `U-D-40` del periodo (cuadre por folio contra `kdm1`) y de los
  `PD-` (cuadre contra `commercial.orders`).
- Nadie pierde acceso: quienes usaron Preventa (9) y Consola (9) en 30 días entran a la consola.
- Carga < 500 ms, medida en prod.

**Medido el 2026-11-19, en prod y en sólo lectura** (todo sigue 🧪 hasta el piloto; detalle en la
[auditoría de interfaces](FASE_GP_AUDITORIA_INTERFACES.md) §5d):
- Pantallas: **1**. Preventa y Consola de surtido redirigen al Tablero.
- Visibles: **100 %**. Noviembre, contra un testigo escrito aparte: Kepler **1,737 de 1,737** y
  preventa **1,020 de 1,020**, ninguno de más ni de menos; los 108 cancelados van aparte.
- Nadie perdió acceso: los 3 roles con la clave (12 personas) ven el Tablero (GP.10.4b).
- Carga: **cumple en promedio para todos los puestos** (medido dentro del servidor, 10 días, por
  llamada): quien opera una sucursal 85–127 ms, quien ve varias 155–420 ms. Quedan picos de más de
  un segundo, también en quien opera una sola: son lecturas en frío del disco. ⚠️ La primera
  versión de esta línea decía «no cumple para quien ve varias»; salía de promedios por día de 1 a 3
  llamadas y se corrigió el mismo día. Aun así, leer todas las sucursales bajó de 241 a 184 ms
  (GP.RF.43, 🧪).

**No incluye:** la regla de «atorado» (D3), Análisis BI (D5), cambios al proceso de preventa (D9).

### 3.1 Diseño de GP.10.4 (escrito antes de tocar la pantalla, 2026-11-14)

**Uso medido** (`analytics.ui_usage`, 30 días, sólo lectura):

| Pantalla | Lo que se usa | Lo que no |
|---|---|---|
| Tablero | 665 lecturas en 26 días y 58 detalles, de 11 roles | — |
| Preventa (Mesa de Control) | 69 lecturas en 13 días; 74 detalles; 33 búsquedas de documento | ligar documento: 14 veces, sólo Dirección y sólo en octubre |
| Consola de surtido | 63 aperturas en 13 días; hora de salida 12 veces (2 días); tanda 5 (2 con error); armar 6 (4 con error) | urgente, liberar y cancelar: **0** |

**Se parte en tres, para que nadie se quede sin acceso a medio camino:** primero el Tablero
muestra todo; después se retiran las pestañas.

| # | Resultado |
|---|---|
| **GP.10.4a** | El Tablero lista también la preventa y su etapa de almacén. Los botones de arriba pasan de estatus de Kepler a **etapa**. Un `PD-` abre su resumen y, a un clic, su detalle completo en la Mesa de Control (documento de Kepler, cobro, ligar) |
| **GP.10.4b** | La fila de surtido entra al Tablero como segunda vista, sólo con `ALMACEN_SURTIDO_COORDINAR` |
| **GP.10.4c** | Las pestañas Preventa y Consola de surtido salen; sus rutas redirigen. La Mesa de Control queda como detalle de un `PD-`, sin pestaña |

**Las cinco preguntas (GP.10.4a):**
1. **Qué ve y en qué orden.** Los botones por etapa (Todos, y las etapas con pedidos), los filtros y
   la lista. Un pedido por fila, de cualquier origen, del más nuevo al más viejo. La columna Etapa
   dice la etapa y, si Kepler y la Suite no coinciden, cuál va atrás («Kepler aún dice Autorizado»).
   - Primario: la etapa.
   - Secundario: el cliente y el folio.
   - Terciario: el volumen, la guía y el importe.
2. **Qué no ve.**
   - Los botones por estatus de Kepler: la preventa no tiene estatus de Kepler, así que «Todos»
     no cuadraría con la lista. El estatus de Kepler se sigue viendo en la fila cuando difiere, y
     también en el detalle.
   - Los cancelados no entran a «Todos»; tienen su propio botón.
3. **Accesibilidad.**
   - Un `PD-` se busca por su folio, cliente o vendedor.
   - Con un clic se ve su resumen: etapa, entrega prometida, cliente, vendedor y total.
   - Con dos, su detalle en la Mesa, con el pedido ya abierto.
   - La etapa se lee como texto, no por color.
4. **Ligas.**
   - `PD-` → Mesa de Control: documento de Kepler, cobro, comparación y recorrido.
   - `U-D-40` → sus embarques `U-D-41`, como hasta hoy.
5. **¿Le toca?**
   - Seguir el pedido dentro del almacén, sí.
   - Ligar y cobrar, no: viven en la Mesa, que es el detalle de un `PD-`, y no se copian.
   - El proceso de preventa no cambia (D9).

**Las cinco preguntas (GP.10.4b), con el acceso medido en prod:** tienen `ALMACEN_SURTIDO_COORDINAR`
`coordinador_embarques` (1 persona), `encargado_tienda` (10) y `supervisor` (1). Los tres roles ya ven
el Tablero (`ALMACEN_PEDIDOS_VER`), así que nadie pierde la consola al moverla.
1. **Qué ve y en qué orden.** Arriba del Tablero, dos vistas: «Pedidos», que abre por defecto, y
   «Fila de surtido». La fila se ve igual que en la consola, en el orden en que «Tomar siguiente» la
   va a dar.
   - Por qué «Pedidos» abre por defecto: el Tablero tuvo 665 lecturas y la consola 63 aperturas.
   - La vista va en la dirección (`?vista=fila`): se puede guardar y la ruta vieja podrá caer ahí.
2. **Qué no ve.**
   - En la fila no hay periodo ni rango: la fila es «hoy, por almacén».
   - Sin el permiso de coordinar no aparecen las dos vistas, y la dirección con `?vista=fila` cae en «Pedidos».
3. **Accesibilidad.** Las vistas son ligas con `aria-current`, así que el botón Atrás del navegador
   regresa a la vista anterior. La fila conserva su teclado y sus confirmaciones en la misma fila.
4. **Ligas.** Las de la consola no cambian: hora de salida por destino, armar y tanda.
5. **¿Le toca?** Sí: la decisión D2 funde la consola aquí. Es el mismo componente, con su título
   apagado, no una copia.

**Lo que la interfaz no puede resolver:**
- **512 `PD-` «checados»:** no se sabe si ya salieron (GP.10.3).
- **Volumen de un `PD-`:** sale vacío, porque sus renglones no son de Kepler.
- **Vista del surtidor:** no cambia.

---

## 4. E2 — Carretas y carritos (GP.11)

**Objetivo:** que cada pedido que se surte en la Suite tenga su carreta o carrito identificado, y
que cualquiera lo encuentre escaneándola (D6, D7, D22).

| # | Resultado | Capa | Depende | ¿Escribe? |
|---|---|---|---|---|
| **GP.11.1** 🧪 | **C0 hecho el 2026-11-20** (migración `20261120112959_gp11_1_carretas_en_catalogo`, sin aplicar en prod): el CHECK de `tipo` acepta `carreta` y `carrito`; `ck_wh_bins_carreta` exige código `C01`–`C99`, tipo carreta o carrito y ninguna parte de ubicación; `ck_wh_bins_tipo_familia` impide que una `BA053` quede como carrito. Carretas y carritos comparten numeración porque Kepler guarda la carreta en una sola columna (`kdm2.c59`). En el contrato, `parseCartCode`: la pistola lee `C07` y en el celular se teclea `7`, y los dos dan la misma carreta. Probado con 11 filas de ejemplo en un SELECT de sólo lectura en prod (incluido el tipo NULL) y 0 de las 384 filas reales en contra. Falta el alta por rango y los carteles (C2/C3). Definición original: Carretas y carritos se dan de alta en el catálogo de ubicaciones: la familia `carreta` **ya existe** en `warehouse_bins` (CHECK de UB.1); se distingue carreta/carrito con el `tipo`. Alta por rango y carteles con código desde la captura masiva de UB.2 | C0 | — | sí (alta) |
| **GP.11.2** 🧪 | **C0 hecho el 2026-11-20** (migración `20261120113241_gp11_2_ocupacion_de_carretas`, sin aplicar en prod): `commercial.cart_occupations`, con `source` `suite`/`kepler` y la llave de Kepler derivada con el MISMO CHECK que `wave_orders`. Índice único parcial: una carreta, un pedido a la vez. Un pedido puede tener varias carretas. Trigger: sólo se ocupa una carreta activa del mismo almacén. Liberar exige quién y motivo (`cargado`, `manual` o `deshecho`). Sin DELETE para `app_runtime`. Probado contra Postgres real (`carretas.it.spec.ts`, 9/9, transacción revertida), y la prueba cazó dos defectos de la primera versión: liberar sin motivo pasaba (el NULL que hace pasar un CHECK) y `app_runtime` podía borrar, porque los privilegios por omisión de `commercial` en prod le dan `arwd` y el GRANT solo no lo quita. Quitar el índice único pone la prueba de D7 en rojo. Definición original: La ocupación pedido↔carreta queda registrada: tabla propia (dato de piso, no existe en ningún ERP) con `tenant_id` + auditoría; **una sola asignación abierta por carreta** garantizada por la base (índice único parcial) | C0 | GP.11.1 | sí |
| **GP.11.3** | Reglas: un pedido por carreta (D7); una ocupada no se toma y dice de quién es; «agregar otra carreta»; se libera al cargar (D22). Hasta que exista E4, el coordinador la libera a mano desde la consola (provisional, con nombre) | C1 | GP.11.2 | — |
| **GP.11.4** | Endpoints: asignar al empezar el surtido, agregar otra, liberar | C2 | GP.11.3 | ⛔ sí: prueba contra base real con el payload de la pantalla |
| **GP.11.5** | Surtir pide la carreta **antes del primer renglón** (escaneo, teclado numérico de respaldo); la consola muestra la carreta de cada pedido. Incluye las observaciones de diseño UI.4 (el Enter del escáner no marca un renglón) y UI.5 (un toque que no llegó se ve distinto de uno guardado) | C3 | GP.11.4 · GP.10.4 | — |

**Meta E2:**
- Carretas y carritos dados de alta en el piloto: **HOY 0** → igual al número físico (40–50).
- Pedidos surtidos en la Suite con carreta: **HOY 0 %** → **100 %**.
- Ocupación máxima simultánea de carretas: **HOY NO MEDIBLE** (Kepler no guarda la hora de cada
  etapa) → se mide en vivo y contesta P-GP.6 (¿alcanzan? ¿más de un pedido por carreta?).

---

## 5. E3 — Surtido escrito en Kepler + checado (GP.12 Surtido/Checado, GP.13)

**Objetivo:** que al terminar el surtido Kepler quede en SURTIDO con lo surtido real, sin que nadie
recapture, y que el checado se haga en la Suite escaneando la carreta (D10–D15, D17).

| # | Resultado | Capa | Depende | ¿Escribe? |
|---|---|---|---|---|
| **GP.12.1** | Al cerrar el surtido se arma el cambio: estatus SURTIDO + por renglón la cantidad surtida **en la unidad de `c55`** (GP.12.0a) + motivo de la diferencia + responsable + carreta (`c59`). Todo o nada. **En dos tiempos (D27):** primero sólo los pedidos surtidos completos (no mueven dinero); los que tienen diferencia van a la bandeja (GP.12.3) hasta que GP.12.0d explique el 100 % del recálculo | C1 | GP.12.0a · GP.12.0b · GP.11 · (GP.12.0d para el 2º tiempo) | — |
| **GP.12.2** | La escritura sale por el carril de Kepler desde `md`, con interruptor por sucursal apagado al nacer, idempotente (reintentar no duplica) | C2 | GP.12.1 | ⛔ sí: prueba contra un Kepler de pruebas, nunca contra el vivo desde la laptop |
| **GP.12.3** | La pantalla «Por capturar en Kepler» se convierte en la **bandeja de lo que la Suite no pudo escribir**, con su motivo y «reintentar». Reemplaza al viejo GP.6 (cuadre) | C2/C3 | GP.12.2 | sí (reintento) |
| **GP.13.1** | El checado abre cuando el pedido está en SURTIDO (escrito por la Suite); sigue vigente que quien surtió no checa | C1 | GP.12.2 | — |
| **GP.13.2** | El checador toma de la cola de Surtido o **escanea la carreta** y se le abre el pedido (D10) | C2 | GP.13.1 · GP.11 | ⛔ sí |
| **GP.13.3** | Checar con carreta: todo renglón por renglón (D11) y bultos `CJ`/`P` con etiqueta (D12; ya construidos). Incluye UI.7 (frescura del ODS: «no hay trabajo» no se confunde con «el dato está atrasado») y UI.8 (sonido o vibración al rechazar un escaneo). Prueba de impresión en la TSC real | C3 | GP.13.2 | — |
| **GP.12.4** | Al terminar el checado, la Suite escribe CHECADO (cantidad checada, responsable) | C1/C2 | GP.13.3 · GP.12.2 | ⛔ sí |

**Meta E3:**
- Pedidos surtidos en la Suite que siguen `AUTORIZADO` en Kepler 15 minutos después: **HOY 16**
  (surtidos entre el 27-oct y el 03-nov, nunca pasados) → **0**.
- Bandeja de fallas: **0 pendientes de más de 1 día**.
- Pedidos checados en la Suite: **HOY 0 en toda la historia** → **100 %** de los surtidos en la
  Suite en el piloto.
- Recaptura humana del estatus en Kepler: **0**.

---

## 6. E4 — Embarque: posición, transporte, carga y estiba (GP.14, GP.15, GP.12 Embarcado)

**Objetivo:** saber en qué posición está cada pedido checado y en qué camión y estiba se fue; que
Kepler quede en EMBARCADO sin recaptura y la carreta se libere sola (D16, D18, D19, D22, D24).

| # | Resultado | Capa | Depende | ¿Escribe? |
|---|---|---|---|---|
| **GP.14.1** | Posiciones de embarque dadas de alta con su código: la familia `espera` **ya existe** en el catálogo | C0 | — | sí (alta) |
| **GP.14.2** | Lo checado se asigna a una posición escaneando bulto y posición; una posición puede tener varios pedidos (D16). La consola muestra «En posición» | C1→C3 | GP.14.1 · GP.13 | ⛔ sí |
| **GP.15.1** | `logistics.vehicles` lleva el **número de estibas** de cada unidad (extender, no tabla nueva) y su esquema para elegir la estiba en pantalla (D24) | C0 | GP.15.0 | sí |
| **GP.15.2** | El transporte se asigna al pedido **antes de cargar** (D19) | C1/C2 | GP.15.1 | ⛔ sí |
| **GP.15.3** | Carga: se escanea cada bulto y su estiba; la Suite avisa los que faltan; al subir el último, la carreta se libera sola (D22) | C1→C3 | GP.15.2 · GP.14.2 | ⛔ sí |
| **GP.12.5** | Con el último bulto, la Suite escribe el **estatus** EMBARCADO (cantidad embarcada, responsable, posición `c60`, estiba `c61`, transporte). La *Salida por Embarque* (`U-D-41`, saca inventario, guía y factura) **sigue en Kepler** (D26) | C1/C2 | GP.15.3 · GP.12.2 | ⛔ sí |
| **GP.15.4** | Permiso propio de embarque (p. ej. `ALMACEN_EMBARQUE_GESTIONAR`), **repartido en prod** a los puestos que cargan (regla 20) | C2 | — | sí (reparto) |

**Meta E4:**
- Pedidos embarcados con estiba registrada: **HOY en Kepler `c61`: Padre Hidalgo ~⅓, Canindo
  relleno con `3`, resto 0 (medido oct-2026)** → **100 % escaneada** en el piloto.
- Carretas liberadas sin intervención: **100 %**.
- Pedidos en EMBARCADO en Kepler sin recaptura: **100 %** de los cargados en la Suite.
- ⭐ Efecto lateral para Logística: el camión de cada pedido sale de un escaneo, no de una captura
  que según el GPS no coincide ~1 de cada 3 días (FASE_EMB, 2026-11-09).

**Pendiente que afecta E4:** ¿la *Asignación de Transporte* se hace en la Suite y se escribe a
Kepler, o sigue en Kepler? (nuevo **P-GP.9**). Quién da la Salida por Embarque (P-GP.4).

---

## 7. E5 — Cierre: devolución, indicadores y piloto (GP.16, GP.7, GP.8)

| # | Resultado | Capa | Depende | ¿Escribe? |
|---|---|---|---|---|
| **GP.16** | Un pedido cancelado a medio camino genera su **devolución**: regresar la mercancía a su lugar, retirar etiquetas, liberar la carreta, con firma de quien lo regresó (D25; absorbe GP.4.3). Mientras no exista, la consola muestra «Por regresar» (UI.6) | C1→C3 | E2–E4 | ⛔ sí |
| **GP.7** | Indicadores con la hora que ahora sí registra la Suite: tiempo por etapa, productividad por persona, surtido completo (con la unidad resuelta en GP.12.0a) | C1→C3 | E3 | no |
| **GP.8** | **Piloto de dos semanas** en la sucursal elegida, sin papel, y medición de la métrica de la fase | — | E1–E4 | — |

**Meta E5 (la métrica de la fase):** `U-D-40` de la sucursal piloto surtidos en la Suite.
**HOY:** Padre Hidalgo 12 de 940 (≈1 %); el resto 0 % salvo Zamora Centro (2 de 114) y Canindo
(3 de 664, de pruebas) → **propuesta: 90 % durante las dos semanas del piloto.** La fecha la firma
el PM (GP.8.0).

---

## 8. Reglas que aplican a todas las etapas

- **Toda escritura** (en la Suite o en Kepler) se prueba contra una base real con el payload de la
  pantalla antes de prod (regla 13). Kepler vivo sólo se toca desde `md`, con el interruptor apagado
  al nacer.
- **Tablas nuevas** (ocupación de carretas, posiciones si hiciera falta): `tenant_id` + auditoría;
  todos los caminos que insertan recorridos si una columna es `NOT NULL` (regla 14).
- **C3:** skill `diseno` antes del primer archivo; `check:pantalla` antes y después; las
  observaciones de diseño del anexo (UI.1–UI.13, revisión del 2026-10-26) que siguen vigentes ya
  están repartidas en sus items (UI.4, UI.5, UI.6, UI.7, UI.8).
- **Permisos:** un módulo no está entregado hasta que su permiso está repartido en prod (regla 20).
- **Lo no medido se declara.** La ocupación de carretas y el dinero en juego hoy son NO MEDIDO y
  así se publican.

---

## 9. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Sin cupo para pasar GP a 🔨 | Edgar | 6 🔨 contra tope de 4 | Cerrar o pausar dos fases, o decidir por encima del cupo |
| E3 escribe sobre un supuesto | Claude/dev de E0 | La unidad de `c51` vs `c52` y el efecto de capturar cada estatus no están medidos | GP.12.0a |
| Escribir en Kepler un estatus o cantidad equivocada | Edgar (ADR) | Escritura de tipo nuevo (actualizar en sitio) | GP.12.0b + prueba contra Kepler de pruebas + interruptor por sucursal |
| El piso sigue con papel aunque la Suite funcione | Dueño de piso del piloto | Pasó en octubre | Piloto con dueño (GP.8.0); la Suite ya no depende de una recaptura |
| No alcanzan las carretas | Dueño de piso | La carreta queda ocupada hasta la carga (D22) | Medición en vivo de E2 (P-GP.6) |
| Catálogo de unidades duplicado | Dev de E4 | Ya existe `logistics.vehicles` | GP.15.0: extender esa tabla (regla 2) |
| EA revierte una decisión firmada | Edgar (D-A1) | COT.7 D1 dejó la autorización en Kepler | D-A1 y la ampliación de ADR-117 a `AUTORIZADO` ([anexo EA](FASE_GP_ANEXO_AUTORIZACION_PEDIDOS.md) §6) |
| La Suite muestra un «crédito disponible» que no cuadra con Kepler | Claude/dev de EA | El «Monto por Cobrar» de Kepler no está decodificado (56,702.27 en pantalla contra 111,626.73 de Σ`kdue`) | GP.A.0b; mientras tanto, límite, saldo y vencido por separado, cada uno con su fuente |
| Trabajo tirado en pantallas que E3 rehace | Claude/devs | La auditoría de interfaces pulía Checar y «Por capturar en Kepler», que GP.13 y GP.12.3 rehacen (revisión del 2026-11-19) | Hasta E3 esas dos sólo se miden ([auditoría](FASE_GP_AUDITORIA_INTERFACES.md) §5d) |

---

## 10. Definición de Terminado (por etapa y de la fase)

Cada etapa cierra con: su meta remedida con la misma consulta (antes/después) · capas verificadas o
declaradas NO MEDIDAS · escrituras ejercidas contra base real · compuertas nuevas rotas a propósito
una vez · primitivos en `libs/` o deuda con nombre · tracker y `03_LOG_REVISIONES.md` al día · en
prod, o escrito por qué no. La fase cierra con E5 y la métrica de la cabecera remedida.

---

## 11. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-13 | Plan de implementación por etapas E0–E5 sobre el recorrido D1–D25 | Edgar, Claude |
| 2026-11-13 | E0 arrancado (sólo lectura). GP.12.0a medido por corte transversal: unidad resuelta, recálculo del importe y Salida por Embarque separada (§2.1). Nuevo GP.12.0d. GP.15.0, GP.12.0c y GP.7.0 (NO MEDIDO) hechos. D26–D28 decididas por encargo del PM | Claude |
| 2026-11-13 | GP.12.0d verificado con `totalesCotizacion`: 509 de 509 pedidos con diferencia al centavo. GP.12.0a: siete transiciones reales; el checado y el embarque borran y renumeran renglones, y el embarque agrega productos. Borrador de ADR-117 (GP.12.0b). Nuevo GP.12.0e (permisos por columna) y P-GP.10 | Claude |
| 2026-11-13 | GP.12.0d: fórmula del renglón y de la cabecera al centavo; IVA/IEPS se reusan de E.25. GP.12.0b sigue el precedente de PQ.110. Foto antes/después en marcha (§2.2): su prueba negativa destapó los cancelados que conservan estatus → nuevo GP.10.0 | Claude |
| 2026-11-14 | GP.10.4 diseñado por escrito (§3.1) con el uso medido y partido en 4a/4b/4c. GP.10.4a hecho: el Tablero lista Kepler y preventa por etapa; un `PD-` lleva a la Mesa con el pedido abierto. Hallazgo para GP.10.5: con preventa, el tope de 2,000 filas se alcanza a mediados de mes | Claude |
| 2026-11-14 | GP.10.4b hecho: la fila de surtido es la segunda vista del Tablero (`?vista=fila`) con el mismo componente de la consola. Los 3 roles que coordinan (12 personas) ya ven el Tablero | Claude |
| 2026-11-14 | GP.10.4c hecho: sin pestañas Preventa ni Consola de surtido; sus rutas redirigen al Tablero con la vista o el filtro puestos. Pantallas para seguir un pedido: 3 → 1 (en código, sin soltar) | Claude |
| 2026-11-17 a 19 | La auditoría de interfaces corrigió el Tablero, Surtir, Revisión y Ubicaciones (GP.RF.15–42) y GP.10.5; todo en prod el 19-nov salvo lo del mismo día (detalle en su bitácora) | Claude, a pedido de Edgar |
| 2026-11-19 | Revisión del plan (Edgar: «revisa el plan»; todo sigue en pruebas). Meta de E1 medida en prod: 1 pantalla, 100 % de los pedidos visibles contra un testigo aparte, menos de 500 ms para quien opera una sucursal pero no para quien ve varias (GP.RF.43). GP.10.1b hecho (🧪). Nuevo riesgo: no pulir Checar ni «Por capturar» antes de E3. Siguen bloqueando E3: GP.12.0e (los corre el PM), GP.12.0a y el dueño de piso. E2 no tiene bloqueo técnico: falta abrirla | Claude |
| 2026-11-20 | **E2 abierta** (Edgar: «sigamos entonces», tras la recomendación «E2 si no se firma D-A1»; GP ya estaba 🔨 por encima del cupo). C0 de GP.11.1 y GP.11.2 hecho y probado contra Postgres real; las dos migraciones están escritas, sin aplicar en prod. Sigue C1/C2: reglas y endpoints de asignar, agregar y liberar, y el alta por rango | Claude |
| 2026-11-19 | GP.RF.43 (Edgar: «sigue con la velocidad del tablero»). Corregida la cifra de la mañana: en promedio el Tablero ya abría bajo 500 ms también para quien ve varias sucursales; los picos son lecturas en frío y los tiene también quien opera una. Lo que sí cuesta ver todas, leer los renglones de cada pedido, baja de 241 a 184 ms con las mismas filas (🧪, sin soltar) | Claude |
| 2026-11-19 | Nace el anexo [EA — autorizar pedidos TLMK](FASE_GP_ANEXO_AUTORIZACION_PEDIDOS.md) (Edgar: «agreguemos el apartado de autorizar pedidos de tlmk, audítalo a profundidad»). Autorizar sólo escribe `c11` y Kepler no guarda quién ni cuándo. La captura de Kepler era Zamora Centro: 782 pedidos `CREADO` de la ruta vecinal ($1.37 M, 25-mar a 30-oct), nunca facturados. Telemarketing real: 27 esperando, 17 de más de 7 días. D-A1 a D-A5 para Edgar | Claude |
| 2026-11-14 | Nace el anexo [FASE_GP_AUDITORIA_INTERFACES.md](FASE_GP_AUDITORIA_INTERFACES.md) (pedido de Edgar: menos interfaces, menos clics, máxima visibilidad, Playwright en cada paso). Paso 0: instrumento con control, blindaje contra escrituras en prod, uso medido de las 10 interfaces del recorrido; la línea base por pantalla espera la sesión (P-RF.1) | Claude |
