import { UserWriteDto } from './user-write.dto';

/**
 * `[ID.7]` — Alta de usuario. Todos los campos viven en `UserWriteDto`; acá no
 * se repite ninguno.
 *
 * Lo que hereda como OBLIGATORIO: `username`, `password`, `role_name` y
 * `department_code`. Lo demás es opcional en ambas operaciones.
 */
export class CreateUserDto extends UserWriteDto {}
