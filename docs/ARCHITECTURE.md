# Arquitectura y Diseño (Monolito Modular)

Para garantizar un producto empresarial escalable y seguro capaz de romper barreras (Microservicios):

## Bounded Contexts
Todas las carpetas alojadas bajo `src/modules/*` operan como "silos" independientes. Un controlador (ej. `captures`) **jamás** debe requerir un modelo o servicio desde otro directorio como `auth` para poder procesar información.

## JWT Enriquecido (El Puente)
Para solventar el punto anterior y seguir respetando las relaciones de negocio (Saber quién es el que mandó un "Daily Capture"), se utiliza en su totalidad las *Claims* contenidas en el JWT del Middleware `requireAuth`.

- **Payload Pyme/SSO:** El Token siempre cuenta y debe incluir lo siguiente: `{ user_id (UUID), username, zona, rol }`.

Toda la base de datos se basa de forma rígida en esta filosofía. Los esquemas incluyen un registro inmutable "*Captured\_by\_username*" para subsanar los JOIN faltantes ante cualquier mutación del usuario desde Auth Service mañana. No borres esa columna por ningún motivo.
