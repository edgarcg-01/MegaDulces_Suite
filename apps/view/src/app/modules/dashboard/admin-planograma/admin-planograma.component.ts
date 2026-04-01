import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { TagModule } from 'primeng/tag';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { AdminPlanogramaService } from './admin-planograma.service';

@Component({
  selector: 'app-admin-planograma',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    DialogModule,
    ToastModule,
    TagModule,
    ConfirmDialogModule
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-planograma.component.html',
  styleUrls: ['./admin-planograma.component.css']
})
export class AdminPlanogramaComponent implements OnInit {
  private planogramaService = inject(AdminPlanogramaService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);

  brands = signal<any[]>([]);
  loading = signal<boolean>(false);
  expandedRows: { [key: string]: boolean } = {};

  // Modals
  showAddBrandDialog = false;
  showEditBrandDialog = false;
  showAddProductDialog = false;
  showEditProductDialog = false;

  // Forms
  selectedBrand: any = null;
  selectedProduct: any = null;
  
  newBrandName = '';
  editBrandName = '';
  
  newProductName = '';
  editProductName = '';

  ngOnInit() {
    this.loadBrands();
  }

  loadBrands() {
    this.loading.set(true);
    this.planogramaService.getBrands().subscribe({
      next: (data) => {
        this.brands.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las marcas' });
        this.loading.set(false);
      }
    });
  }

  // --- Brand Actions ---
  
  createBrand() {
    if (!this.newBrandName.trim()) return;
    this.planogramaService.createBrand({ nombre: this.newBrandName }).subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Marca creada correctamente' });
        this.loadBrands();
        this.showAddBrandDialog = false;
        this.newBrandName = '';
      },
      error: (err) => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo crear la marca' })
    });
  }

  openEditBrand(brand: any) {
    this.selectedBrand = brand;
    this.editBrandName = brand.nombre;
    this.showEditBrandDialog = true;
  }

  updateBrand() {
    if (!this.editBrandName.trim()) return;
    this.planogramaService.updateBrand(this.selectedBrand.id, { nombre: this.editBrandName }).subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Marca actualizada' });
        this.loadBrands();
        this.showEditBrandDialog = false;
      },
      error: (err) => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar la marca' })
    });
  }

  deleteBrand(id: string) {
    this.confirmationService.confirm({
      message: '¿Estás seguro de eliminar esta marca? Se borrarán todos sus productos asociados.',
      header: 'Confirmar Eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Rechazar',
      accept: () => {
        this.planogramaService.deleteBrand(id).subscribe({
          next: () => {
            this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Marca eliminada correctamente' });
            this.loadBrands();
          },
          error: (err) => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar la marca' })
        });
      }
    });
  }

  // --- Product Actions ---

  openAddProduct(brandId: string) {
    this.selectedBrand = { id: brandId };
    this.newProductName = '';
    this.showAddProductDialog = true;
  }

  addProduct() {
    if (!this.newProductName.trim()) return;
    this.planogramaService.addProduct(this.selectedBrand.id, { nombre: this.newProductName }).subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Producto agregado' });
        this.loadBrands();
        this.showAddProductDialog = false;
      },
      error: (err) => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo agregar el producto' })
    });
  }

  openEditProduct(product: any) {
    this.selectedProduct = product;
    this.editProductName = product.nombre;
    this.showEditProductDialog = true;
  }

  updateProduct() {
    if (!this.editProductName.trim()) return;
    this.planogramaService.updateProduct(this.selectedProduct.id, { nombre: this.editProductName }).subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Producto actualizado' });
        this.loadBrands();
        this.showEditProductDialog = false;
      },
      error: (err) => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar el producto' })
    });
  }

  deleteProduct(id: string) {
    this.confirmationService.confirm({
      message: '¿Estás seguro de eliminar este producto?',
      header: 'Confirmar Eliminación',
      icon: 'pi pi-info-circle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Rechazar',
      accept: () => {
        this.planogramaService.deleteProduct(id).subscribe({
          next: () => {
            this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Producto eliminado' });
            this.loadBrands();
          },
          error: (err) => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar el producto' })
        });
      }
    });
  }
}
