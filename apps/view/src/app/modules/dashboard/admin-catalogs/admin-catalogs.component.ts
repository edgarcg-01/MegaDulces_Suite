import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { AdminCatalogsService } from './admin-catalogs.service';

@Component({
  selector: 'app-admin-catalogs',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    SelectModule,
    DialogModule,
    ToastModule,
    TooltipModule,
  ],
  providers: [MessageService],
  templateUrl: './admin-catalogs.component.html',
  styleUrls: ['./admin-catalogs.component.css'],
})
export class AdminCatalogsComponent implements OnInit {
  private catalogsService = inject(AdminCatalogsService);
  private messageService = inject(MessageService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  selectedType = signal<string>('conceptos');
  title = signal<string>('Catálogos');
  items = signal<any[]>([]);
  loading = signal<boolean>(false);

  showAddDialog = false;
  isEditMode = signal<boolean>(false);
  currentEditingId = signal<string | null>(null);

  newItemValue = '';
  newItemOrder = 0;
  newItemScore = 0;
  newItemIcon = '';

  constructor() {
    // Listen to route param changes to switch catalog type
    this.route.params.subscribe((p) => {
      const type = p['type'] || 'conceptos';
      this.selectedType.set(type);
      this.updateTitle(type);
      this.loadCatalog(type);
    });
  }

  ngOnInit() {}

  updateTitle(type: string) {
    const titles: any = {
      conceptos: 'Gestión de Conceptos',
      ubicaciones: 'Ubicaciones en Tienda',
      niveles: 'Niveles de Ejecución',
      zonas: 'Zonas Geográficas',
      roles: 'Roles de Sistema',
    };
    this.title.set(titles[type] || 'Catálogos');
  }

  onTypeChange(event: any) {
    // Ya no se usa por el sidebar, pero mantenemos lógica si fuera necesario
  }

  loadCatalog(type: string) {
    this.loading.set(true);
    this.catalogsService.getCatalog(type).subscribe({
      next: (data) => {
        this.items.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el catálogo' });
        this.loading.set(false);
      },
    });
  }

  openAddDialog() {
    this.isEditMode.set(false);
    this.currentEditingId.set(null);
    this.newItemValue = '';
    this.newItemOrder = this.items().length + 1;
    this.newItemScore = 0;
    this.newItemIcon = '';
    this.showAddDialog = true;
  }

  openEditDialog(item: any) {
    this.isEditMode.set(true);
    this.currentEditingId.set(item.id);
    this.newItemValue = item.value;
    this.newItemOrder = item.orden;
    this.newItemScore = item.puntuacion || 0;
    this.newItemIcon = item.icono || '';
    this.showAddDialog = true;
  }

  saveItem() {
    if (!this.newItemValue.trim()) return;

    const data = {
      value: this.newItemValue,
      orden: this.newItemOrder,
      puntuacion: this.newItemScore,
      icono: this.newItemIcon
    };

    if (this.isEditMode()) {
      this.catalogsService.updateItem(this.selectedType(), this.currentEditingId()!, data).subscribe({
        next: () => {
          this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Ítem actualizado correctamente' });
          this.loadCatalog(this.selectedType());
          this.showAddDialog = false;
        },
        error: (err) => {
          this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar el ítem' });
        }
      });
    } else {
      this.catalogsService.addItem(this.selectedType(), data).subscribe({
        next: () => {
          this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Ítem agregado correctamente' });
          this.loadCatalog(this.selectedType());
          this.showAddDialog = false;
        },
        error: (err) => {
          this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo agregar el ítem' });
        }
      });
    }
  }

  deleteItem(id: string) {
    this.catalogsService.deleteItem(this.selectedType(), id).subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Ítem eliminado correctamente' });
        this.loadCatalog(this.selectedType());
      },
      error: (err) => {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar el ítem' });
      }
    });
  }

  goToPermissions(roleName: string) {
    this.router.navigate(['/dashboard/admin/roles', roleName, 'permissions']);
  }
}
