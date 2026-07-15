# Fase HV — Horus aprende los PRODUCTOS del exhibidor (visión a nivel SKU)

> **Estado:** 🔨 DISEÑADO (planeación) 2026-07-15. Sin código aún.
> **Pedido de Edgar:** "que Horus aprenda mediante las fotos de los exhibidores los productos que se encuentran en el exhibidor".
> **Hereda:** ADR-020/021 (motor decide, LLM fuera del lazo de decisión, ship-collector-before-learner), ADR-011/012 (Voyage embeddings + pgvector de Fase K), H2.2 (PhotoAuditService).

---

## 1. Análisis del pedido (qué se está pidiendo realmente)

La frase tiene **tres capas**, y conviene nombrarlas porque cada una tiene dificultad y valor distintos:

1. **VER los productos** — que la visión deje de responder solo "¿hay anaquel? ¿propio o competencia? ¿hueco?" (lo que hace hoy H2.2) y pase a extraer **qué productos/marcas concretos aparecen** en la foto. Es extracción.
2. **RECONOCERLOS contra el catálogo** — que "Panditas bolsa 100g" visto en la foto se convierta en un `product_id` real de `catalog.products` (1,278 SKUs embebidos en Fase K). Es matching.
3. **APRENDER de ello** — dos sentidos:
   - *Aprender del negocio:* la foto se vuelve **fuente de verdad independiente** del dicho del colaborador. Hoy `productosMarcados` es autodeclarado — la adherencia al planograma (K4), la presencia en PdV que alimenta a Thot (`pdv_presence`) y el share propio/competencia descansan en lo que el colaborador DICE. Con esto, Horus puede **verificar el dicho contra lo visto**, a nivel SKU.
   - *Aprender como sistema:* cada corrección del supervisor ("eso no es Panditas, es Enchiladitas") alimenta un diccionario de alias foto→producto que hace el matching más preciso con el tiempo — mismo patrón de aprendizaje sin fine-tuning del repo (Fase K aliases, Thot few-shot, L2 de Horus).

**Lo que desbloquea** (por qué vale la pena): mismatch de fraude a nivel producto (declaró 10 SKUs, la foto muestra 3), **adherencia al planograma medida por FOTO** (no por declaración), share de anaquel real por marca, whitespace real para Thot ("la zona compra X y este PdV no lo exhibe" — verificado visualmente), y stockout por SKU ("el producto Y desapareció del exhibidor de la tienda Z esta semana").

**Lo que NO es realista prometer** (honestidad técnica): conteo exacto de *facings* y SKU-level perfecto en dulces (bolsas pequeñas, granel, empaques casi idénticos entre presentaciones). La estrategia correcta es **texto visible primero**: Claude vision lee muy bien marcas y nombres impresos en los empaques; distinguir "bolsa 100g vs 150g" a distancia, no. Por eso el plan promete **marca con confianza alta, SKU con confianza media y verificable**, y los facings como estimado ordinal (pocos/medios/muchos), no como conteo.

### Viabilidad medida en prod (2026-07-15)

| Dato | Valor |
|---|---|
| Capturas últimos 60d | 631 (todas con exhibiciones) |
| Fotos de exhibidor | **591** |
| Exhibiciones con `productosMarcados` declarados | 636 (ground truth para comparar) |
| Fotos ya analizadas por la visión H2.2 | 462 (421 anaqueles válidos) |

Hay volumen: cada foto nueva puede procesarse en la MISMA llamada de visión que ya existe (extender el tool, no una segunda pasada → costo marginal casi cero), y hay 636 declaraciones contra las cuales validar el extractor desde el día 1.

---

## 2. Arquitectura (reusa 3 piezas que ya existen)

```
FOTO (Cloudinary) ──► PhotoAuditService (H2.2, MISMA llamada Haiku vision)
                       tool extendido: + products_seen[]
                       {brand_text, product_text, size_text?, facings_bucket, legibility}
                            │  (extracción CIEGA: NO se le pasa lo declarado,
                            │   para que sirva de verificación independiente)
                            ▼
              commercial.capture_vision_products (raw, por foto)
                            │
                            ▼
                  MATCHING A CATÁLOGO (motor determinista, Fase K)
                  1. exact/normalizado contra catalog.products + brands
                  2. trade.photo_product_aliases (lo APRENDIDO)
                  3. embeddings Voyage + pgvector (thr 0.40, infra Fase K)
                  4. fallback Haiku match-ai (ya existe el endpoint)
                            │ matched_product_id + confidence + method
                            ▼
        ┌───────────────────┼────────────────────────┐
        ▼                   ▼                        ▼
  CRUCE declarado      FEATURES por tienda      FEED a Thot
  vs visto (SKU)       (share real por marca,   (pdv_presence
  → findings           planograma por foto,     source='vision')
                       tendencia por SKU)
                            │
                            ▼
              SUPERVISOR verifica/corrige (bandeja)
                            │
                            ▼
              trade.photo_product_aliases (APRENDE)
              + precisión por regla (L2, auto-supresión)
```

Invariantes: la extracción y el matching son **motor determinista + LLM acotado a extraer/etiquetar** (nunca decide una acción); todo hallazgo pasa por la bandeja del co-piloto existente; el fraude a nivel producto **detecta pero no acusa** (mismo guardarraíl H2.4).

---

## 3. Schema (migraciones nuevas)

**`commercial.capture_vision_products`** — detección cruda + match, 1 fila por producto visto por foto:
- `tenant_id, id`, `capture_id`, `photo_key` (mismo de capture_vision)
- `raw_brand_text, raw_product_text, raw_size_text` (lo que la visión LEYÓ, sin tocar)
- `facings_bucket` CHECK (`'1'|'2-4'|'5+'`), `legibility` CHECK (`'clear'|'partial'|'guessed'`)
- `matched_product_id uuid NULL`, `matched_brand_id uuid NULL`
- `match_confidence numeric`, `match_method` CHECK (`'exact'|'alias'|'embedding'|'llm'|'none'`)
- `verified_by uuid NULL`, `verified_verdict` CHECK (`'correct'|'wrong_product'|'not_visible'`) — el feedback humano
- RLS forzado; UNIQUE `(tenant_id, photo_key, raw_product_text)` para idempotencia del re-scan.

**`trade.photo_product_aliases`** — el diccionario que aprende:
- `normalized_text` (marca+producto normalizado) → `product_id`, `confirmed_count`, `last_confirmed_at`, `created_by`
- Se puebla SOLO desde verificaciones humanas (`correct`/`wrong_product` con corrección). El matcher lo consulta ANTES que embeddings — mismo patrón `catalog_aliases`/`brands-normalization`.

Sin tocar `capture_vision` (aditivo).

---

## 4. Sprints

### HV.0 — Auditoría de viabilidad (ship-collector-before-learner; SIN schema)
Script read-only `horus-vision-products-audit.js`: corre el tool extendido sobre una **muestra de 40-60 fotos reales** (prod, variedad de calidad) y mide contra `productosMarcados` declarado:
- ¿Cuántos productos legibles por foto (clear/partial/guessed)?
- Recall a nivel MARCA vs declarado; recall a nivel SKU.
- Costo real por foto (tokens in/out).
**Gate de decisión:** si marca-level < ~60% de recall en fotos `clear`, el plan se recorta a marca-only y HV.3 cambia de alcance. Los números van al doc antes de escribir schema. (Lección del repo: audit primero — K4, H2.7, HV no es excepción.)

### HV.1 — Extracción en producción
- Extender `audit_exhibition_photo` (tool de H2.2) con `products_seen[]` — **una sola llamada**, mismos presupuestos `HORUS_VISION_*`.
- Migración `capture_vision_products` + persistencia del raw.
- Extracción **ciega**: el prompt NO recibe `productosMarcados` (si lo recibiera, el modelo confirmaría lo declarado y muere el valor de verificación).
- Re-scan del backlog ya analizado (462 fotos) con presupuesto nocturno elevado unos días.

### HV.2 — Matching a catálogo (motor, cero números del LLM en el camino)
- `PhotoProductMatcherService`: cascada exact-normalizado → `photo_product_aliases` → pgvector/Voyage (reusar `match-ai` de Fase K, threshold 0.40) → fallback Haiku → `none`.
- Corre en el mismo cron de visión, incremental sobre filas sin match.
- Gotcha conocido: pgvector vive en Docker local (ADR-012) — para prod, el matching por embeddings corre en el feed on-prem o se difiere a `alias+exact+llm` hasta resolver pgvector en Railway (decisión abierta #3).

### HV.3 — El cruce (el valor de negocio)
Reglas nuevas del motor (todas pasan por calibración L2 y la bandeja existente):
- `vision_product_mismatch` — declaró N SKUs propios, la foto legible muestra <N×factor (evidencia: lista declarada vs vista). Severidad por magnitud; agregado por colaborador (semilla de fraude a nivel producto, NO acusa).
- `vision_planogram_gap` — adherencia al planograma **medida por foto** (productos del planograma ∩ vistos), reemplaza gradualmente la K4 declarativa (correrán en paralelo un ciclo para comparar).
- `vision_sku_stockout` — producto que aparecía en las fotos de una tienda y desapareció ≥2 visitas seguidas.
- **Share real por marca** en `execution_360` (`photo_own_share_pct` junto al declarado) + tool de chat `horus_photo_products` ("¿qué productos se vieron en la tienda X?").
- Feed a Thot: filas `source='vision'` en `intelligence.pdv_presence` (whitespace verificado visualmente — mejora directa del score de Thot sin tocar su motor).

### HV.4 — El loop de aprendizaje
- Bandeja de verificación en `/dashboard/supervisor-ai` (sección "Productos vistos"): thumbnail + detecciones + match propuesto → confirmar / corregir producto / "no se ve".
- Confirmación → UPSERT en `photo_product_aliases` (el matcher mejora); corrección de regla → `discrepancy_feedback` estilo L2 (precisión por regla `vision_product_*`, auto-supresión si ruidosa).
- Métrica visible en "Lo que Horus aprendió": % de matches auto vs corregidos, curva de aliases.

### HV.5 — Diferido con gate (no construir hasta necesitarlo)
- **Embeddings visuales de referencia** por producto (foto de catálogo → multimodal) si el texto no alcanza para SKUs sin marca impresa. Gate: HV.0/HV.3 muestran >30% de productos `guessed`.
- Conteo real de facings (bounding boxes) — gate: alguien lo pida con un caso de uso de dinero.
- Detección de SKUs de COMPETENCIA contra un catálogo de competidores (hoy no existe ese catálogo — solo se guardaría el raw text de marcas rivales, que ya es valioso para el mapa comercial).

---

## 5. Costos y gates

- **Costo por foto**: la extracción va en la MISMA llamada Haiku de H2.2 → costo marginal ≈ solo output extra (~200-400 tokens/foto). Backlog 591 fotos ≈ centavos de dólar. Presupuesto ya gobernado por `HORUS_VISION_*`.
- **Gate de datos #1 (el real):** las capturas del flujo vendor recientes traen `photo_coverage 0%` en ventanas actuales — **sin fotos nuevas no hay aprendizaje nuevo**. El track de calidad de datos de HIQ (subir cobertura de foto) es prerequisito operativo, no técnico.
- **Gate de datos #2:** el catálogo embebido es de productos PROPIOS → el nivel SKU solo aplica a Mega Dulces; competencia queda a nivel marca/texto (suficiente para dominancia).

## 6. Decisiones abiertas para Edgar

1. **Alcance del match**: ¿SKU-level (con verificación humana) o arrancar marca-level y subir? (HV.0 lo responde con números; recomendación: dejar que el audit decida.)
2. ¿La bandeja de verificación HV.4 la trabaja el supervisor o un rol admin de catálogo?
3. **pgvector en prod** para HV.2: ¿feed on-prem (como Fase K hoy) o instalar pgvector en Railway? (Railway Postgres soporta pgvector — sería la primera vez que lo activamos allá.)
4. ¿`vision_planogram_gap` por foto REEMPLAZA a la K4 declarativa tras un ciclo en paralelo, o conviven?
