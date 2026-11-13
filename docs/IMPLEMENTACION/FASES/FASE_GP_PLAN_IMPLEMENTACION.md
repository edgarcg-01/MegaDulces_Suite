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
| **GP.12.0a** 🔨 | Se sabe qué campos cambia Kepler al capturar *Estatus Surtido*, *Estatus Checado* y *Estatus Embarque*: diff por `xmin` en la réplica de 3 pedidos por pantalla, en la sucursal piloto. Incluye la **unidad de `kdm2.c51` vs `c52`** (pendiente desde GP.0: pedida y surtida vienen en unidades distintas), responsables `c100/c102/c103` y ubicaciones `c59/c60/c61`. **Medido el 2026-11-13 (§2.1).** Por corte transversal: unidad resuelta, recálculo del importe encontrado, Salida por Embarque separada. **Foto antes/después en marcha** (§2.2). Primeros casos reales: el checado recalcula el importe y **borra o renumera renglones**. Falta juntar ≥3 pedidos por transición | C0 | La pantalla de Kepler (captura de la persona que lo hizo) y el `kdm2` antes/después |
| **GP.12.0d** 🧪 | Se sabe **cómo recalcula Kepler el renglón y la cabecera cuando una etapa baja la cantidad**. **Medido el 2026-11-13:**<br>· `c56` es la cantidad vigente y `c9` = `c56 × c58`.<br>· El renglón: `c13` = `round(c9 × c12, 2)` en 47,626 de 47,626 renglones.<br>· La cabecera: `c16` = `round(Σc13 × (1 − c19/100), 2)` en 2,884 de 2,885 pedidos (el otro a 5 centavos, por el kg sin redondear de E.25), incluidos los 508 con diferencia.<br>· `c14`/`c15` (IVA, IEPS) ya los reproduce `armarPedidoTlmk` → `totalesCotizacion` (E.25, 79 de 79), **y se reusa** (ADR-056).<br>Falta verificar `c14`/`c15` con esa función sobre los 508 pedidos con diferencia | C0 | Espejo: el importe que Kepler calculó en esos 508 pedidos, al centavo |
| **GP.12.0b** | ADR que **enmienda ADR-086**: la Suite actualiza en su lugar el estatus y las cantidades de un `U-D-40` existente: interruptor por sucursal apagado al nacer, todo o nada, idempotente, sólo desde `md`. **Ya tiene precedente:** `[PQ.110]` actualiza en su lugar una OC de Kepler (`UPDATE` de cabecera con el estado leído en el `WHERE`, más `DELETE` de renglones; `kepler-oc-cancelacion.ts`). GP.12 sigue ese patrón, no inventa otro | Decisión | Firma del PM |
| **GP.12.0c** 🧪 | Catálogo de motivos de diferencia (falta de existencia, dañado, …): reusar el de preventa (`shared/motivos-preventa`) en vez de inventar otro (ADR-056). **Existe y se reusa:** `MotivoOpcion` y `errorDeMotivo` en `libs/contracts`, `http-motivo.ts`, `motivo-chips.component.ts` (motivo por omisión, «Otro motivo» pide nota). Falta la lista de motivos de almacén | C0 | Lista firmada por el dueño de piso |
| **GP.15.0** 🧪 | Se sabe qué hay en `logistics.vehicles` (ya tiene `capacity_boxes` y `capacity_kg`): unidades reales contra las 33 de prueba (GP.P1), y dónde va el número de estibas (**extender esa tabla, no crear otra**). **Medido:** 57 unidades activas, 28 ligadas a Kepler (`kepler_code`), **1** con capacidad en cajas, ninguna con estibas. Kepler tiene 33 transportes (`kdm_transporte`, el mismo catálogo replicado en las 9 sucursales). Va como columna nueva en `logistics.vehicles` | C0 | Lista de camiones del piloto con Logística |
| **GP.8.0** 🧪 | Sucursal piloto, dueño de piso y META con fecha firmados (P-GP.1, P-GP.8). **Piloto: Padre Hidalgo** (D28). Falta el dueño de piso (P-GP.1); la fecha de la META se fija al cerrar E4 | Decisión | Firma del PM |
| **GP.7.0** 🧪 | Intento de medir el dinero en juego: diferencias pedido→embarcado y devoluciones atribuibles a error de surtido, 90 días, en la sucursal piloto. **Si no hay testigo que separe el error de surtido, se declara NO MEDIDO** y no se infla. **Resultado: NO MEDIDO.** Las diferencias aparecen en el checado (§2.1), pero nada separa un error del surtidor de un faltante de existencia; esto último es de DN/FLT, no de GP | C0 | Notas de crédito / devoluciones de Kepler |

**Meta E0:** 0 campos del diff sin explicar · ADR firmado · piloto y META firmados · dinero en juego
medido o declarado NO MEDIDO.
**HOY (2026-11-13):** unidad resuelta; importe de la cabecera explicado al centavo (falta IVA/IEPS
sobre los pedidos con diferencia); foto antes/después en marcha; piloto elegido sin dueño de piso;
ADR sin firmar; dinero en juego NO MEDIDO.

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
9. **El checado puede borrar o renumerar renglones.** En el primer caso real que capturó la foto
   (§2.2), el checado de un pedido de Morelia Abastos recalculó `c13`–`c16` y `c42` en la cabecera,
   y de sus renglones salieron 26 y entraron 19 llaves (`c7`, `c8`). Escribir CHECADO o EMBARCADO
   con faltantes tendrá que reproducir eso, no sólo cambiar una cantidad.

### 2.2 Foto antes/después (GP.12.0a)

Sin SSH a `md`: se toma una foto completa (`kdm1` + `kdm2`, todas las columnas) de los `U-D-40`
abiertos en `pg-prod`, y después se leen **los mismos pedidos** y se compara, columna por columna y
por transición de estatus. También dice si nació un `U-D-41`.

- **Controles hechos:**
  - con respuesta conocida: la foto contra sí misma da vacío;
  - negativo: una copia alterada a propósito sale con exactamente lo alterado.
- **La prueba negativa encontró un hueco:** 117 pedidos abiertos no tienen renglones. Son los
  cancelados del punto 8.
- **Foto del 2026-11-13, 16:28:** 375 pedidos y 2,189 renglones. Se repite el diff hasta juntar
  ≥3 pedidos por transición: CREADO→AUTORIZADO, AUTORIZADO→SURTIDO, SURTIDO→CHECADO y
  CHECADO→EMBARCADO.
- **Los datos no van al repo**, porque es público. El script es de la sesión: se reescribe con
  esta receta si hace falta.
- **Primeros casos reales** (a 4 minutos de la foto):

  | Pedido | Transición | Cabecera (`kdm1`) | Renglones (`kdm2`) | `U-D-41` |
  |---|---|---|---|---|
  | Morelia Abastos | SURTIDO→CHECADO | `c11`, `c13`–`c16`, `c42`, `c63`, `c69`, `c83`, `c84`, `c102` | `c53`; 26 llaves salen, 19 entran | no |
  | Padre Hidalgo | AUTORIZADO→EMBARCADO, en <4 min | `c11`, `c30`, `c42`, `c43`, `c69`, `c83`–`c86`, `c88`, `c100`, `c102`, `c103` | `c24`, `c52`–`c54`, `c62`, `c63` | **sí, en la misma pasada** |

  El de Padre Hidalgo muestra que las cuatro capturas (surtido, checado, embarque y salida) se
  hacen de corrido al final: es la recaptura del papel. EMBARCADO también toca `c43` (estado del
  documento) y `c42` (saldo).


---

## 3. E1 — Consola maestra (GP.10)

**Objetivo:** que quien coordina vea en una sola pantalla todos los pedidos (Kepler y preventa) con
su estado real en Kepler y en el piso, y priorice desde ahí (D1, D2).

| # | Resultado | Capa | Depende | ¿Escribe? |
|---|---|---|---|---|
| **GP.10.0** | **Veracidad, antes que nada:** la consola deja de contar como vivos los pedidos cancelados (`c43 = 'C'`). Se ven aparte, como «cancelado», y no entran a los totales ni al «sin embarcar más antiguo». HOY son 180 en 30 días, y 70 de los 94 que se ven «en SURTIDO» (§2.1 punto 8) | C0/C1 | — | no |
| **GP.10.1** | La «cabecera vigente» del `U-D-40` en `kdm1` se calcula en **un solo lugar**. Hoy está reescrita en 4 servicios (`warehouse-orders`, `kepler-origen`, `picking-captura`, `checado`) | C0/C1 | — | no |
| **GP.10.2** | La **etapa del pedido** se deriva con una sola función (Kepler + olas + `presale_picks` + checado), que reemplaza las dos derivaciones duplicadas de preventa (`etapaDe` y `state`). Cada etapa dice su fuente (Kepler o piso) | C1 | GP.10.1 | no |
| **GP.10.3** | La consola lista `U-D-40` y `PD-` del periodo con filtros por origen, sucursal, etapa y texto, en < 500 ms | C2 | GP.10.2 | no |
| **GP.10.4** | El Tablero absorbe Preventa (como origen) y la Consola de surtido (prioridad, hora de salida, armar, con `ALMACEN_SURTIDO_COORDINAR`); las dos pestañas viejas redirigen | C3 | GP.10.3 | usa las acciones que ya existen |
| **GP.10.5** | Correcciones de la consola: el volumen deja de encimarse sobre el estatus; unidades con leyenda; el importe de venta y el de traspaso se muestran separados en el total (D4) | C3 | GP.10.4 | no |

**Meta E1:**
- Pantallas para seguir un pedido: **HOY 3** (Tablero, Preventa, Consola de surtido) → **1**.
- Pedidos visibles: **100 %** de los `U-D-40` del periodo (cuadre por folio contra `kdm1`) y de los
  `PD-` (cuadre contra `commercial.orders`).
- Nadie pierde acceso: quienes usaron Preventa (9) y Consola (9) en 30 días entran a la consola.
- Carga < 500 ms, medida en prod.

**No incluye:** la regla de «atorado» (D3), Análisis BI (D5), cambios al proceso de preventa (D9).

---

## 4. E2 — Carretas y carritos (GP.11)

**Objetivo:** que cada pedido que se surte en la Suite tenga su carreta o carrito identificado, y
que cualquiera lo encuentre escaneándola (D6, D7, D22).

| # | Resultado | Capa | Depende | ¿Escribe? |
|---|---|---|---|---|
| **GP.11.1** | Carretas y carritos se dan de alta en el catálogo de ubicaciones: la familia `carreta` **ya existe** en `warehouse_bins` (CHECK de UB.1); se distingue carreta/carrito con el `tipo`. Alta por rango y carteles con código desde la captura masiva de UB.2 | C0 | — | sí (alta) |
| **GP.11.2** | La ocupación pedido↔carreta queda registrada: tabla propia (dato de piso, no existe en ningún ERP) con `tenant_id` + auditoría; **una sola asignación abierta por carreta** garantizada por la base (índice único parcial) | C0 | GP.11.1 | sí |
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
| 2026-11-13 | GP.12.0d: fórmula del renglón y de la cabecera al centavo; IVA/IEPS se reusan de E.25. GP.12.0b sigue el precedente de PQ.110. Foto antes/después en marcha (§2.2): su prueba negativa destapó los cancelados que conservan estatus → nuevo GP.10.0 | Claude |
