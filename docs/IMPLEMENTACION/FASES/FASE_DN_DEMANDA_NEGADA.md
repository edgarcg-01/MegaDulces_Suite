# Fase DN — Demanda negada por agotado, para Compras

```
OBJETIVO: que Compras vea, por producto y canal, lo que el cliente pidió y no se le surtió.
MÉTRICA:  renglones negados visibles para Compras — HOY: 0 visibles. Universo medido el
          2026-10-10 (a re-medir al abrir DN.1): 778 renglones de Kepler con negado en 60 d
          (traspasos 471, telemarketing 304, ruta 3); preventa de la app: ver anexo A.
          → META: 100 % de los negados de Kepler y de la preventa de la app, por canal; la fecha la
          compromete el dueño al pasar a 🔨. Montos: tarjeta DN del Tablero PM (privado).
CAPA TOPE: C3 (pantalla de Compras)
ÁREA:      Compras
DUEÑO:     Francisco
ESTADO:    🔨 sólo el frente 1 del anexo A (DN.6–DN.8 + DN.11a), aprobado por Edgar el 2026-11-07
           por encima del cupo (9 🔨 contra 4); fila DN en el roadmap de CLAUDE.md. DN.0–DN.5 y los
           frentes 2 y 3 del anexo siguen ⬜.
```

> planeada 2026-10-10 · DN.0–DN.5 **⬜ PLAN, sin código** · **Anexo A (2026-11-07):**
> [la preventa de la app captura todo y avisa al agendar](FASE_DN_ANEXO_AVISO_AL_AGENDAR.md)
> (ADR-115 **aceptado** el 2026-11-07; redefine DN.3 y agrega DN.6–DN.15; su frente 1 está en código).
>
> ⚠️ Corrección 2026-11-07: este plan decía «ADR-091 propuesto», pero ADR-091 es otro (comisiones y
> viáticos de logística). La decisión de esta fase que hoy está escrita es ADR-115.
>
> **Tesis:** la venta que no se pudo surtir ya deja huella en tres lugares: Kepler guarda lo
> **pedido originalmente** y lo surtido, checado y embarcado; la Suite congela el pedido al arrancar
> el surtido y el surtidor marca **agotado/dañado**; y el piso de venta reporta faltantes. Nadie lo
> junta. Esta fase lo junta **por producto y por canal** y se lo pone enfrente a **Compras**, junto a
> la lista de faltantes que ya existe (`/compras/faltantes`). Todo derivado (vistas sobre el ODS y
> las tablas de la Suite): **cero importers**.

Pedido de Francisco (2026-10-10), saliendo de la fase GP (surtido y checado):

> *"Acabamos de pasar el tema de venta perdida por agotado. ¿Cómo lo unimos con la lista de faltantes
> para el departamento de Compras? En el tracking que hace Kepler de pedido, surtido, checado, ¿se tiene
> visibilidad, o todos empatan? Me gustaría que le llegaran vistas por **mazapán**: piso de venta 10 PAQ
> negados, pedidos TLMKT 1 CJA negada, traspaso sucursales 5 CJA negadas, pedidos vecinales 2 PAQ
> negados."*

Se separó de la conversación de GP para no desviarla: **esta fase vive en Compras**, no toca las
pantallas de almacén (surtir, checar, consola), y no choca con el PR #355 de GP.

---

## 1. Lo medido antes de planear (prod, sólo lectura, 2026-10-10)

### 1.1 Kepler SÍ conserva lo pedido originalmente

En el pedido `U-D-40` (`kdm1`/`kdm2`), por renglón:

| Columna | Qué es | Cómo se verificó |
|---|---|---|
| `c51` | **Cantidad pedida ORIGINAL**, en la presentación | igual a `c56` (cantidad final en presentación) en **71,508 de 75,393** renglones embarcados (los que nadie tocó); en los demás conserva lo que se pidió antes de corregir |
| `c52` / `c53` / `c54` | Surtida / checada / embarcada | presentación |
| `c55` / `c56` | Presentación (CJA, PAQ, BTO, KG…) y cantidad **final** (ya corregida) | |
| `c9` | Cantidad final en la **unidad base** | `c9 / c56` = factor de la presentación |
| `c13` | Importe del renglón (de la cantidad final) | `c13 / c56` = precio por presentación |
| `c28` | Etapa en que se dio de alta el renglón (`AUTORIZADO`, `CHECADO`, `EMBARCADO`) | |

Ejemplos reales: clave **89150** pedida **5 CJA**, surtida 4, checada 4, embarcada 4; clave **70169**
pedida **10 PAQ**, embarcada 6. ⚠️ También hay renglones donde lo final es **mayor** que `c51`
(20123: pedida 1, final 2): `c51` no siempre es "lo máximo", es "lo primero".

**Hipótesis fuerte, todavía sin arbitrar** (regla 0 de `ERP_KEPLER.md` §5): que `c51` sea siempre lo
pedido originalmente. Se arbitra en DN.0 contra el pedido que la Suite **congela** al arrancar el
surtido (`commercial.wave_order_lines`, GP.3). Al 2026-10-10 hay sólo 6 renglones surtidos en la
Suite: el árbitro todavía no tiene volumen. Mientras no esté arbitrado, la pantalla lo **declara
como estimado**.

### 1.2 Lo negado por canal (60 días, pedidos ya EMBARCADOS; negado = `c51 − c54`)

| Canal | Regla (versión vigente de `kdm1`) | Renglones | Con negado |
|---|---|---|---|
| **Traspaso a sucursales** | `c27='SUCURSAL'` y `c10 ~* '^TI'` | 16,484 | **471 (2.9%)** |
| **Telemarketing** | `c27='TELEMARK'` | 21,754 | **304 (1.4%)** |
| Ruta directa | `c27='SUCURSAL'` y `c10 ~* '^(RUTA|RD)'` | 37,140 | 3 (0%) |
| Sucursal, otro | el resto | 15 | 0 |

Valor = negado × (`c13`/`c56`). Ningún renglón negado quedó sin precio. Los montos por canal y por
producto están en la tarjeta DN del Tablero PM (privado): el repo es público (2026-11-07).

**¿En qué etapa se negó?** Sobre todo **al checar**: telemarketing 219 en checado / 53 en surtido /
32 en embarque; traspasos 425 / 19 / 27.

**Top de productos negados (valor, 60 d):** PIÑATA MIX CHOC 1.5KG (70104) 8 CJA telemarketing + 8 CJA
traspasos · COBERTURA 20K LUSSEL (57009) 10 CUB · OBLEA CAJETA MINI (18001) · SKITTLES /10 (88060) ·
CHAROLA TÉRMICA 066 (94156) 29 + 85 CJA. Montos en la tarjeta.

### 1.3 Los tres huecos de Kepler (que cubre la Suite)

1. **No dice por qué** se negó: agotado, error de captura o el cliente cambió de opinión. La Suite sí:
   el surtidor marca cada renglón `surtido` / `faltante` / `agotado` / `danado`
   (`commercial.wave_lines.status`, GP.3) y lo repartido a cada pedido queda en
   `commercial.wave_allocations`.
2. **Un renglón que Facturación borra completo desaparece de Kepler.** La Suite lo conserva en
   `commercial.wave_order_lines` (el pedido congelado al arrancar el surtido).
3. **La preventa vecinal no pasa por el pedido de Kepler.** Es el pedido `PD-` que el vendedor
   levanta en `vendedor.megadulcessuite.com` (`commercial.orders` con `code` `PD-`,
   `requested_delivery_date` y `delivery_type='route'`; ⚠️ la columna `source='suite'` que citaba
   este plan **no existe**, medido 2026-11-07), se surte con el mismo motor (Fase MCP) y se cobra en
   Kepler como ticket `U-D-10`. Lo negado ahí es lo pedido en `PD-` contra lo surtido (y después
   contra lo cobrado).
   ⚠️ **Desde el 2026-10-28** (`[MCP.3.16]`) la app no deja agregar lo que no hay y **no lo
   registra**: lo negado al tomar el pedido nunca llega a ser renglón. Y el `PD-` es ≈ 8 % de los
   documentos del canal vecinal (el resto se levanta directo en Kepler). Ver el
   [anexo A](FASE_DN_ANEXO_AVISO_AL_AGENDAR.md).

### 1.4 Piso de venta (lista de faltantes, FLT)

`commercial.floor_stockouts`: kiosco `/tienda/faltantes` + bandeja `/compras/faltantes`. Al
2026-10-10: **8 reportes de `agotado`, todos `dismissed`**; 4 `no_en_catalogo`, 4 `codigo_no_pasa`.
⚠️ Registra **cuántas veces** se reportó (`times_reported`), **no cuántas piezas pidió el cliente**: no
puede decir "10 PAQ negados". Columnas: `kind`, `week_start`, `times_reported`, `on_hand_at_report`,
`unit_price`, `est_lost_revenue`, `status`, `decision`…

---

## 2. Lo que vería Compras

Por producto, cada canal **en la unidad en que se pidió**, más un total equivalente en cajas:

```
MAZAPÁN …                               Existencia hoy: …   En camino (OC): …   ≈ $… negados (30 d)
  Piso de venta ........ 10 PAQ  (reportado en mostrador)
  Telemarketing ........  1 CJA  (se negó al checar · motivo desconocido, viene de Kepler)
  Traspaso a sucursales   5 CJA  (agotado, marcado por el surtidor)
  Ruta directa ......... —
  Vecinales (preventa) .  2 PAQ
  ≈ total: 6.4 CJA equivalentes
  → al tocar un canal: pedidos, fecha, sucursal, etapa en que se negó y motivo
```

Reglas de presentación:
- **Lo que no se puede medir se declara** (ADR-056): "motivo desconocido (Kepler)", "estimado: `c51`
  sin arbitrar", "sin precio". Nunca un cero dibujado.
- **Unidades**: cada canal suma en su presentación; el total se convierte a cajas con el factor del
  propio renglón (`c9/c56`) o el resolvedor canónico (`UNIDADES_DE_MEDIDA.md`). No sumar PAQ con CJA.
- Ventana por defecto 30 días, seleccionable; filtro por sucursal (alcance con `ScopeService`).

---

## 3. Diseño

- **Una vista por fuente**, todas `derive-no-copy` (regla principal del proyecto):
  - `analytics.v_denied_demand_kepler`: renglones `U-D-40` con `c51 > c54` (y la etapa: surtido /
    checado / embarque), canal por la regla de §1.2, sucursal, cliente/destino, fecha, precio.
    Filtro canónico `btrim(c1) = btrim(sucursal)` (las réplicas traen copias de otras sucursales) y
    versión vigente del pedido (`DISTINCT ON … ORDER BY c9 DESC`). Debe usar los índices
    `ix_kdm1_venta_doc` / `ix_kdm2_venta_doc` (medido en GP: 2,510 pedidos en 42 ms / 404 ms).
  - `analytics.v_denied_demand_suite`: pedido congelado (`wave_order_lines`) contra lo repartido
    (`wave_allocations`), con el **motivo** del surtidor (`wave_lines.status`); incluye renglones que
    Kepler ya no trae.
  - `analytics.v_denied_demand_preventa`: `PD-` (`commercial.order_lines`) contra lo surtido.
  - Piso de venta: `commercial.floor_stockouts` (`kind='agotado'`).
  - `analytics.v_denied_demand`: la unión, una fila por (producto, canal, documento), con `fuente`,
    `motivo`, `etapa`, `estimado` (bool) y la unidad.
- **Sin doble conteo**: un pedido de Kepler surtido en la Suite aparece en las dos fuentes; gana la
  Suite (trae motivo) y Kepler aporta sólo lo que la Suite no vio (borrados después, etapas
  posteriores). La llave es `order_id` = md5 de la llave Kepler (`keplerOrderId`, GP.2).
- **Pantalla**: pestaña nueva en Compras junto a `/compras/faltantes` ("Demanda negada"), tabla
  densa por producto con las columnas por canal y master-detail con los documentos (Operations,
  `DESIGN.md`). Permiso: reusar el de la bandeja de faltantes (`COMPRAS_HALLAZGOS_*`) o uno propio
  (decisión D3).
- **Frescura** declarada (`provenance.contract.ts`): la del ODS (`kdm1`).

---

## 4. Sprints

| Sprint | Qué | Depende |
|---|---|---|
| **DN.0** | Arbitrar `c51`: cotejar contra `wave_order_lines` en cuanto haya volumen (o contra una muestra impresa de pedidos que Facturación corrigió). Documentar en `ERP_KEPLER.md` | volumen de GP en prod |
| **DN.1** | `v_denied_demand_kepler` + endpoint + pantalla por producto/canal (telemarketing, traspasos, ruta). **Mayor valor inmediato** (778 renglones negados en 60 d hoy invisibles; monto en la tarjeta) | — |
| **DN.2** | `v_denied_demand_suite`: motivo del surtidor + renglones borrados; regla de no doble conteo | GP en uso |
| **DN.3** | ~~Preventa vecinal (`PD-` contra surtido; después contra ticket `U-D-10`)~~ → **redefinido 2026-11-07** ([anexo A](FASE_DN_ANEXO_AVISO_AL_AGENDAR.md) §8): lo pedido sin existencia y su decisión + lo que faltó al surtir + lo que completó la caja, una etapa por renglón, declarando la cobertura (≈ 8 % del canal) | DN.6–DN.8 |
| **DN.4** | Piso de venta con **cantidad**: el kiosco de faltantes pregunta "¿cuántos pidió el cliente?" (opcional, en su unidad) | decisión D1 |
| **DN.5** | Que la demanda negada **alimente el sugerido de compra** (Fase RA) | decisión D2 · cambio de negocio, aparte |
| **DN.6–DN.15** | Anexo A: captura libre en la app del vendedor, registro de lo negado en el servidor, aviso al agendar con sustituto condicional, un solo motor de sustitutos, y el camino medido hacia un modelo | ADR-115 firmado · cupo |

---

## 5. Decisiones abiertas (Francisco)

- **D1** — ¿La cajera / anaquelista captura **cuánto** pidió el cliente al reportar un faltante?
- **D2** — ¿La demanda negada entra al cálculo del sugerido de compra, o sólo se muestra?
- **D3** — ¿Permiso propio para la pantalla o el mismo de la bandeja de faltantes?
- **D4** — ¿"Ruta directa" se muestra como canal aunque hoy casi no niega (3 renglones en 60 d)?
- **D5** — Ventana por defecto (30 días propuesto).

## 6. Riesgos

- **`c51` sin arbitrar** (§1.1). Se publica como estimado hasta DN.0.
- **Lo negado al checar puede no ser agotado** (el cliente cambió el pedido, error de surtido
  corregido al checar). Sin motivo, Kepler no distingue: se muestra la etapa, no se afirma "agotado".
- **Unidades mezcladas** dentro de un producto (248 pares sucursal×clave con más de una unidad,
  medido en GP.2): nunca sumar presentaciones distintas sin factor.
- **Volumen**: la vista sobre `kdm2` de 60 días son ~75 mil renglones: medir el plan antes de
  publicar (gate de 1 s); si no alcanza, materializar con refresco y umbral en `CRON_JOBS`.

## 7. Para arrancar en otra sesión

Prompt sugerido:

> *"Arranca la Fase DN (demanda negada para Compras). Lee `docs/IMPLEMENTACION/FASES/FASE_DN_DEMANDA_NEGADA.md`
> completo y empieza por DN.1: la vista `analytics.v_denied_demand_kepler` sobre `kepler_ods` y la
> pantalla en Compras junto a `/compras/faltantes`. Trabaja en `main` local de
> `C:\DEV\MegaDulces_Suite`, sin ramas ni worktrees. Mide contra prod (sólo lectura, usuario
> `francisco`) antes de publicar cifras."*

Código de referencia ya existente:
- Decode del pedido y llaves Kepler: `libs/commercial/src/lib/commercial-picking/kepler-origen.ts`
  (`POOL_KEPLER_SQL`, `keplerOrderId`), `warehouse-orders/warehouse-orders.service.ts` (`LINES_SQL`).
- Lectura de Kepler por pedido con los índices: `picking-captura.service.ts` (`evaluarFilas`).
- Lista de faltantes: `commercial.floor_stockouts`, `/tienda/faltantes`, `/compras/faltantes`.
- Unidad pedida en texto ("2 BOL + 5 PZA"): `cantidadEnUnidad` en `checado.service.ts` (GP.4, PR #355).
- Preventa: `FASE_MCP_MESA_CONTROL_PREVENTA.md`.
