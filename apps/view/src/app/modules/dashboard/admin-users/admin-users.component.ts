import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { DropdownModule } from 'primeng/dropdown';
import { InputSwitchModule } from 'primeng/inputswitch';

// IMPORTANTE: Asegúrate de que esta ruta apunte a donde guardaste el UsersService
import { UsersService, User } from './users.service'; 

@Component({
  selector: 'app-admin-users',
  standalone: true,
  imports: [
    CommonModule, 
    ReactiveFormsModule,
    TableModule, 
    ButtonModule, 
    TagModule,
    DialogModule,
    InputTextModule,
    DropdownModule,
    InputSwitchModule
  ],
  templateUrl: './admin-users.component.html',
  styleUrls: ['./admin-users.component.css']
})
export class AdminUsersComponent implements OnInit {
  private usersService = inject(UsersService);
  private fb = inject(FormBuilder);

  // Señales de estado
  users = signal<User[]>([]);
  loading = signal<boolean>(true);
  displayDialog = signal<boolean>(false);
  isEditing = signal<boolean>(false);
  currentUserId = signal<string | null>(null);
  
  userForm: FormGroup;

  roles = signal<{label: string, value: string}[]>([]);

  ngOnInit(): void {
    this.loadRoles(); // 2. Llamamos a los roles al iniciar
    this.loadUsers();
  }

  // 3. Agregamos la función que consulta la base de datos
  loadRoles(): void {
    this.usersService.getRoles().subscribe({
      next: (data) => {
        // Mapeamos los datos de la BD al formato que pide PrimeNG: { label, value }
        const mappedRoles = data.map(item => ({
          label: item.role_name.charAt(0).toUpperCase() + item.role_name.slice(1), // Capitaliza la primera letra
          value: item.role_name
        }));
        this.roles.set(mappedRoles);
      },
      error: (err) => console.error('Error al cargar los roles de la BD', err)
    });
  }

  constructor() {
    this.userForm = this.fb.group({
      username: ['', Validators.required],
      password: [''],
      nombre: [''],
      zona: [''],
      role_name: ['', Validators.required],
      activo: [true]
    });
  }


  loadUsers(): void {
    this.loading.set(true);
    this.usersService.findAll().subscribe({
      next: (data) => {
        this.users.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Error al cargar usuarios', err);
        this.loading.set(false);
      }
    });
  }

  openNewDialog(): void {
    this.isEditing.set(false);
    this.currentUserId.set(null);
    this.userForm.reset({ activo: true });
    
    this.userForm.get('username')?.enable();
    // Al crear, la contraseña ES obligatoria
    this.userForm.get('password')?.setValidators([Validators.required, Validators.minLength(6)]);
    this.userForm.get('password')?.updateValueAndValidity();
    
    this.displayDialog.set(true);
  }

  openEditDialog(user: User): void {
    this.isEditing.set(true);
    this.currentUserId.set(null); // Evita parpadeos
    this.currentUserId.set(user.id);
    
    this.userForm.get('username')?.disable();
    // Al editar, la contraseña NO es obligatoria, pero si escribe algo, debe tener al menos 6 caracteres
    this.userForm.get('password')?.clearValidators();
    this.userForm.get('password')?.setValidators([Validators.minLength(6)]);
    this.userForm.get('password')?.updateValueAndValidity();

    this.userForm.patchValue({
      username: user.username,
      password: '', // IMPORTANTE: Siempre lo dejamos en blanco por seguridad
      nombre: user.nombre,
      zona: user.zona,
      role_name: user.role_name,
      activo: user.activo
    });

    this.displayDialog.set(true);
  }

  saveUser(): void {
    if (this.userForm.invalid) return;

    const formData = this.userForm.getRawValue();

    if (this.isEditing() && this.currentUserId()) {
      // Extraemos username (no se edita)
      const { username, ...updateData } = formData;
      
      // Si el campo de password está vacío, lo eliminamos para no borrar la contraseña actual
      if (!updateData.password || updateData.password.trim() === '') {
        delete updateData.password;
      }
      
      this.usersService.update(this.currentUserId()!, updateData).subscribe({
        next: () => {
          this.displayDialog.set(false);
          this.loadUsers();
        },
        error: (err) => console.error('Error actualizando', err)
      });
    } else {
      this.usersService.create(formData).subscribe({
        next: () => {
          this.displayDialog.set(false);
          this.loadUsers();
        },
        error: (err) => console.error('Error creando', err)
      });
    }
  }

  deleteUser(id: string): void {
    if(confirm('¿Estás seguro de eliminar este usuario?')) {
      this.usersService.remove(id).subscribe({
        next: () => this.loadUsers(),
        error: (err) => console.error('Error eliminando', err)
      });
    }
  }
}