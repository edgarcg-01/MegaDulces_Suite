---
name: capa-dominio
description: Capa C1 (Dominio) de la suite — la regla de negocio y sus tipos. OBLIGATORIO antes de crear o cambiar un servicio en libs/<dominio>, un cálculo (precio, costo, comisión, existencia, cobro, surtido), un tipo o DTO en libs/contracts, o de mover lógica entre capas. Cubre dónde vive cada regla, cómo se prueba, cómo se recorre a los consumidores de un tipo (plantillas incluidas) y qué hacer con un primitivo inventado (ADR-056). Se invoca con regla de negocio, lógica, cálculo, fórmula, servicio, service, libs, contracts, tipo, interfaz, DTO, enum, refactor, "mover a libs", "dónde va esta lógica", comisión, precio, costo, descuento, mayoreo, promoción, unidad.
---

# C1 · Dominio — la regla, en un solo lugar y con prueba

> El método lo dice en una línea: **C1 está verificada cuando la regla tiene una prueba que la
> ejerce y, si cambiaste un tipo de `contracts`, recorriste todos sus consumidores, plantillas
> incluidas** ([`METODO_DE_TRABAJO.md`](../../../docs/METODO_DE_TRABAJO.md) §1). Esta skill es
> cómo se cumple esa línea en este repo.

## Dónde vive cada cosa

| Qué | Dónde | No va en |
|---|---|---|
| Regla de negocio de un área | `libs/<dominio>/src/lib/<modulo>/<modulo>.service.ts` (comercial, finanzas, logística, RH, fiscal, trade…) | El controller, la pantalla ni el SQL de una pantalla |
| Tipos que cruzan API ↔ pantalla | `libs/contracts` | Copias locales en `apps/*` |
| Permisos (el enum es **uno**) | `libs/contracts/src/authz/permissions.ts` | Los `permissions.ts` de las apps: son re-exports de una línea |
| Primitivos genéricos (búsqueda, teclado, tablas, formatos) | `libs/platform-core`, `libs/ui-web` | Inventados dentro de una fase |
| El número de verdad (existencia, costo, unidad) | El **resolvedor** de C0 (`VERDAD_ABSOLUTA.md` §5) | Recalculado en el servicio |

**El servicio decide, la API transporta, la pantalla muestra.** Si una regla aparece en dos
lugares, uno de los dos va a divergir: ya pasó con el factor de caja (19 % de adopción del
resolvedor, `VERDAD_ABSOLUTA.md` R7). Antes de escribir un cálculo, **busca si ya existe**:

```bash
grep -rn "factor\|uxc\|comision\|mayoreo" libs --include=*.ts | grep -v spec
```

## Antes de cambiar una regla

1. **¿Quién la pidió y con qué número?** Una regla de dinero es decisión de Edgar, no de Claude
   (`CLAUDE.md`, «Notas de operación»). Si el pedido no trae la regla exacta, va como D1 en la
   ficha de [`criterio`](../criterio/SKILL.md), con ejemplos numéricos.
2. **Escribe el caso antes que el código:** entrada → salida esperada, con números reales. Si
   no puedes escribir el caso, todavía no entiendes la regla.
3. **¿Cambia un número publicado?** Entonces es regla 15: medición antes/después, y **optimizar
   va en un commit aparte** de cambiar alcance de negocio.

## Construir

- **Funciones puras para la regla**, el servicio orquesta (lee, llama a la regla, escribe). Una
  regla pura se prueba sin base de datos.
- **Dinero:** `numeric` llega como string; coerciona en el borde (`GOTCHAS.md` §6). Piezas y
  cajas no son dinero.
- **Unidades:** nunca supongas la unidad de una cantidad que viene de otra capa; la trae el
  resolvedor o se declara.
- **Lo que no se puede calcular se declara** (`status: 'unknown'`, `measured: false`), con el
  motivo. Un `catch` que devuelve `0` es un dato inventado (ADR-056).
- **Tipado del boundary:** las líneas nuevas en `.service.ts`/`.controller.ts` no llevan `any` ni
  returns sin tipo — lo cobra `npm run lint:boundary` (ADR-052).
- **Un primitivo genérico inventado en una fase no cierra la fase** (regla 16, ADR-056): se
  mueve a `libs/` compartido o queda como deuda **con nombre** en el tracker.

## Cambiar un tipo de `contracts`

Es el cambio con más radio de impacto del repo, porque lo consumen la API **y** tres apps.

```bash
# 1. todos los que lo importan
grep -rln "NombreDelTipo" apps libs --include=*.ts
# 2. todos los templates que leen sus campos (TypeScript no siempre los revisa)
grep -rn "\.nombreDelCampo" apps --include=*.html --include=*.ts
# 3. las compuertas que lo cobran
npm run check:templates-types
npx tsc --noEmit -p libs/<dominio>/tsconfig.json   # typecheck acotado, no emite nada (skill `entrega` §3)
# ⛔ NO `nx build` ni `nx serve` (regla 3): compila el CI. Y nunca pipear un build a tail/grep (GOTCHAS §8).
```

- Campo **nuevo**: opcional primero si alguna app (sobre todo `vendor`, que guarda datos offline
  en Dexie) puede recibir datos viejos.
- Campo **renombrado o quitado**: es un cambio que rompe. Lista cada consumidor en la ficha y
  recórrelos todos en el mismo commit.

## Verificado cuando

- [ ] La regla vive en **un** servicio de `libs/<dominio>` y nadie más la recalcula.
- [ ] Hay un `.spec.ts` que la ejerce con números reales, incluido **un caso que debe fallar**
      (entrada inválida, unidad desconocida, dato faltante).
- [ ] Si cambió un tipo de `contracts`: consumidores recorridos (lista en el reporte),
      `check:templates-types` y el typecheck acotado en verde.
- [ ] Si cambió un número: antes/después medido con la misma consulta.
- [ ] Ningún primitivo genérico nuevo quedó suelto en una app.

## Lo que se reporta

```text
C1  regla: <una frase> — en libs/<dominio>/…/<archivo>.ts:<línea>
    prueba: <spec> — <n> casos, incluido <caso que falla>
    consumidores del tipo: <n> recorridos (<lista corta>) · NO RECORRIDO: <…>
```
