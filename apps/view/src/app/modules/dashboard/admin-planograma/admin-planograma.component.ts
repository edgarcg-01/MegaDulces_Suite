import { Component, inject, signal, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
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
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { AdminPlanogramaService } from './admin-planograma.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

interface Product {
  id: string;
  nombre: string;
  brand_id: string;
}

interface Brand {
  id: string;
  nombre: string;
  productos?: Product[];
  _highlight?: boolean;
}

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
    ConfirmDialogModule,
    IconFieldModule,
    InputIconModule
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './admin-planograma.component.html',
  styleUrls: ['./admin-planograma.component.css']
})
export class AdminPlanogramaComponent implements OnInit {
  private planogramaService = inject(AdminPlanogramaService);
  private messageService = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private authService = inject(AuthService);
  private perms = inject(PermissionsService);
  private router = inject(Router);

  brands = signal<Brand[]>([]);
  loading = signal<boolean>(false);
  searchText = signal<string>('');
  expandedRows: { [key: string]: boolean } = {};

  filteredBrands = computed(() => {
    const query = this.searchText().toLowerCase().trim();
    if (!query) return this.brands();

    return this.brands().map(brand => {
      const matchBrand = brand.nombre.toLowerCase().includes(query);
      const filteredProducts = (brand.productos || []).filter((p: Product) => 
        p.nombre.toLowerCase().includes(query)
      );

      if (matchBrand || filteredProducts.length > 0) {
        const result: Brand = {
          ...brand,
          productos: matchBrand ? brand.productos : filteredProducts,
          _highlight: matchBrand
        };
        return result;
      }
      return null;
    }).filter((b): b is Brand => b !== null);
  });

  // Modals
  showAddBrandDialog = false;
  showEditBrandDialog = false;
  showAddProductDialog = false;
  showEditProductDialog = false;

  // Forms
  selectedBrand: Brand | null = null;
  selectedProduct: Product | null = null;
  
  newBrandName = '';
  editBrandName = '';
  
  newProductName = '';
  editProductName = '';

  ngOnInit(): void {
    if (!this.perms.can('read', 'planograms')) {
      if (this.perms.can('read', 'reports_team') || this.perms.can('read', 'reports_global')) {
        this.router.navigate(['/dashboard']);
      } else {
        this.router.navigate(['/dashboard/captures']);
      }
      return;
    }
    
    this.loadBrands();
  }

  loadBrands() {
    this.loading.set(true);
    this.planogramaService.getBrands().subscribe({
      next: (data: Brand[]) => {
        // Ordenar marcas alfabéticamente por nombre
        const sortedBrands = data.sort((a, b) => a.nombre.localeCompare(b.nombre));
        
        // Ordenar productos alfabéticamente dentro de cada marca
        sortedBrands.forEach(brand => {
          if (brand.productos && Array.isArray(brand.productos)) {
            brand.productos.sort((a, b) => a.nombre.localeCompare(b.nombre));
          }
        });
        
        this.brands.set(sortedBrands);
        this.loading.set(false);
      },
      error: () => {
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
      error: () => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo crear la marca' })
    });
  }

  openEditBrand(brand: Brand) {
    this.selectedBrand = brand;
    this.editBrandName = brand.nombre;
    this.showEditBrandDialog = true;
  }

  updateBrand() {
    if (!this.editBrandName.trim() || !this.selectedBrand) return;
    this.planogramaService.updateBrand(this.selectedBrand.id, { nombre: this.editBrandName }).subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Marca actualizada' });
        this.loadBrands();
        this.showEditBrandDialog = false;
      },
      error: () => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar la marca' })
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
          error: () => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar la marca' })
        });
      }
    });
  }

  toggleRowExpansion(brand: Brand) {
    this.expandedRows[brand.id] = !this.expandedRows[brand.id];
  }

  // --- Product Actions ---

  openAddProduct(brand: Brand) {
    this.selectedBrand = brand;
    this.newProductName = '';
    this.showAddProductDialog = true;
  }

  addProduct() {
    if (!this.newProductName.trim() || !this.selectedBrand) return;
    this.planogramaService.addProduct(this.selectedBrand.id, { nombre: this.newProductName }).subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Producto agregado' });
        this.loadBrands();
        this.showAddProductDialog = false;
      },
      error: () => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo agregar el producto' })
    });
  }

  openEditProduct(product: Product) {
    this.selectedProduct = product;
    this.editProductName = product.nombre;
    this.showEditProductDialog = true;
  }

  updateProduct() {
    if (!this.editProductName.trim() || !this.selectedProduct) return;
    this.planogramaService.updateProduct(this.selectedProduct.id, { nombre: this.editProductName }).subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: 'Éxito', detail: 'Producto actualizado' });
        this.loadBrands();
        this.showEditProductDialog = false;
      },
      error: () => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo actualizar el producto' })
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
          error: () => this.messageService.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar el producto' })
        });
      }
    });
  }
}
