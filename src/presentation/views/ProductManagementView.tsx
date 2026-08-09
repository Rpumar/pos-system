import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  CreateProductUseCase,
  UpdateProductUseCase,
  DeleteProductUseCase,
  ListProductsUseCase,
  ImportProductsCsvUseCase,
  ProductNotFoundError,
  DuplicateSkuError,
  DuplicateBarcodeError,
  ValidationError,
} from '../../application/use-cases/ProductManagementUseCases';
import { ReceiveBatchUseCase } from '../../application/use-cases/ReceiveBatchUseCase';
import { Product } from '../../domain/entities/Product';
import { playSound } from '../utils/audio';
import { NumericKeypad } from '../components/NumericKeypad';

interface ProductManagementViewProps {
  createProduct: CreateProductUseCase;
  updateProduct: UpdateProductUseCase;
  deleteProduct: DeleteProductUseCase;
  listProducts: ListProductsUseCase;
  importProducts: ImportProductsCsvUseCase;
  receiveBatch: ReceiveBatchUseCase;
  onBack: () => void;
}

type ViewMode = 'list' | 'create' | 'edit' | 'import';
type FormErrors = Partial<Record<keyof ProductForm, string>>;

interface ProductForm {
  sku: string;
  barcode: string;
  name: string;
  price: string;
  stock: string;
  active: boolean;
}

const EMPTY_FORM: ProductForm = {
  sku: '',
  barcode: '',
  name: '',
  price: '',
  stock: '0',
  active: true,
};

export function ProductManagementView({
  createProduct,
  updateProduct,
  deleteProduct,
  listProducts,
  importProducts,
  receiveBatch,
  onBack,
}: ProductManagementViewProps) {
  const [mode, setMode] = useState<ViewMode>('list');
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [csvContent, setCsvContent] = useState('');
  const [importResult, setImportResult] = useState<{ created: number; errors: string[] } | null>(null);
  const [showKeypad, setShowKeypad] = useState(false);
  const [keypadTarget, setKeypadTarget] = useState<keyof ProductForm | null>(null);
  const [keypadValue, setKeypadValue] = useState('');
  const [stockTarget, setStockTarget] = useState<Product | null>(null);
  const [stockQty, setStockQty] = useState('');
  const [stockLoading, setStockLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Load products on mount and when filters change
  const loadProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listProducts.execute(showInactive);
      setProducts(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando productos');
      playSound('error');
    } finally {
      setLoading(false);
    }
  }, [listProducts, showInactive]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  // Filter products by search term
  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.barcode.includes(searchTerm)
  );

  // Validation
  const validateForm = useCallback((): FormErrors => {
    const errors: FormErrors = {};
    if (!form.sku.trim()) errors.sku = 'SKU obligatorio';
    if (!form.barcode.trim()) errors.barcode = 'Código de barras obligatorio';
    if (!form.name.trim()) errors.name = 'Nombre obligatorio';
    if (form.price && parseFloat(form.price) < 0) errors.price = 'Precio no puede ser negativo';
    if (form.stock && parseInt(form.stock, 10) < 0) errors.stock = 'Stock no puede ser negativo';
    return errors;
  }, [form]);

  // Handle form field change
  const handleFieldChange = useCallback((field: keyof ProductForm, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFormErrors((prev) => ({ ...prev, [field]: undefined }));
  }, []);

  // Handle keypad input
  const handleKeypadEnter = useCallback(() => {
    if (keypadTarget) {
      handleFieldChange(keypadTarget, keypadValue);
    }
    setShowKeypad(false);
    setKeypadTarget(null);
    setKeypadValue('');
  }, [keypadTarget, keypadValue, handleFieldChange]);

  const handleKeypadEscape = useCallback(() => {
    setShowKeypad(false);
    setKeypadTarget(null);
    setKeypadValue('');
  }, []);

  const handleKeypadBackspace = useCallback(() => {
    setKeypadValue((v) => v.slice(0, -1));
  }, []);

  const openKeypad = useCallback((field: keyof ProductForm) => {
    setKeypadTarget(field);
    setKeypadValue(form[field] as string);
    setShowKeypad(true);
    playSound('keypress');
  }, [form]);

  // Create product
  const handleCreate = useCallback(async () => {
    const errors = validateForm();
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      playSound('error');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await createProduct.execute({
        sku: form.sku.trim().toUpperCase(),
        barcode: form.barcode.trim(),
        name: form.name.trim(),
        price: parseFloat(form.price),
        stock: parseInt(form.stock, 10) || 0,
        active: form.active,
      });
      playSound('success');
      setSuccess('Producto creado correctamente');
      setForm(EMPTY_FORM);
      setMode('list');
      await loadProducts();
    } catch (e) {
      if (e instanceof DuplicateSkuError) setFormErrors({ sku: e.message });
      else if (e instanceof DuplicateBarcodeError) setFormErrors({ barcode: e.message });
      else if (e instanceof ValidationError) setError(e.message);
      else setError(e instanceof Error ? e.message : 'Error creando producto');
      playSound('error');
    } finally {
      setLoading(false);
    }
  }, [form, validateForm, createProduct, loadProducts]);

  // Update product
  const handleUpdate = useCallback(async () => {
    if (!editingId) return;
    const errors = validateForm();
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      playSound('error');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await updateProduct.execute(editingId, {
        sku: form.sku.trim().toUpperCase() || undefined,
        barcode: form.barcode.trim() || undefined,
        name: form.name.trim() || undefined,
        price: form.price ? parseFloat(form.price) : undefined,
        stock: form.stock ? parseInt(form.stock, 10) : undefined,
        active: form.active,
      });
      playSound('success');
      setSuccess('Producto actualizado correctamente');
      setForm(EMPTY_FORM);
      setEditingId(null);
      setMode('list');
      await loadProducts();
    } catch (e) {
      if (e instanceof DuplicateSkuError) setFormErrors({ sku: e.message });
      else if (e instanceof DuplicateBarcodeError) setFormErrors({ barcode: e.message });
      else if (e instanceof ProductNotFoundError) setError('Producto no encontrado');
      else if (e instanceof ValidationError) setError(e.message);
      else setError(e instanceof Error ? e.message : 'Error actualizando producto');
      playSound('error');
    } finally {
      setLoading(false);
    }
  }, [editingId, form, validateForm, updateProduct, loadProducts]);

  // Delete product
  const handleDelete = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      await deleteProduct.execute(id);
      playSound('success');
      setSuccess('Producto eliminado');
      await loadProducts();
    } catch (e) {
      if (e instanceof ProductNotFoundError) setError('Producto no encontrado');
      else setError(e instanceof Error ? e.message : 'Error eliminando producto');
      playSound('error');
    } finally {
      setLoading(false);
    }
  }, [deleteProduct, loadProducts]);

  // Receive stock (lote)
  const handleReceiveStock = useCallback(async () => {
    if (!stockTarget) return;
    const qty = parseInt(stockQty, 10);
    if (isNaN(qty) || qty <= 0) {
      setError('Ingrese una cantidad mayor a cero');
      playSound('error');
      return;
    }
    setStockLoading(true);
    setError(null);
    try {
      const batchCode = `RCV-${Date.now()}`;
      const expiration = new Date(Date.now() + 365 * 24 * 3600 * 1000);
      await receiveBatch.execute(stockTarget.id, batchCode, qty, expiration);
      playSound('success');
      setSuccess(`Stock agregado a ${stockTarget.name}: +${qty}`);
      setStockTarget(null);
      setStockQty('');
      await loadProducts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error agregando stock');
      playSound('error');
    } finally {
      setStockLoading(false);
    }
  }, [stockTarget, stockQty, receiveBatch, loadProducts]);

  // Edit product
  const handleEdit = useCallback((product: Product) => {
    setForm({
      sku: product.sku,
      barcode: product.barcode,
      name: product.name,
      price: String(product.price),
      stock: String(product.stock),
      active: product.active,
    });
    setEditingId(product.id);
    setMode('edit');
    playSound('keypress');
  }, []);

  // Import CSV
  const handleImport = useCallback(async () => {
    if (!csvContent.trim()) {
      setError('Pegue el contenido CSV primero');
      playSound('error');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await importProducts.execute(csvContent);
      setImportResult(result);
      if (result.errors.length > 0) {
        playSound('warning');
        setError(`${result.created} creados, ${result.errors.length} errores`);
      } else {
        playSound('success');
        setSuccess(`${result.created} productos importados correctamente`);
        setCsvContent('');
      }
      await loadProducts();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error importando CSV');
      playSound('error');
    } finally {
      setLoading(false);
    }
  }, [csvContent, importProducts, loadProducts]);

  // Handle file upload
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setCsvContent(ev.target?.result as string);
      playSound('scan');
    };
    reader.readAsText(file);
  }, []);

  // Clear messages
  const clearMessages = useCallback(() => {
    setError(null);
    setSuccess(null);
    setImportResult(null);
  }, []);

  // Responsive
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  return (
    <div style={styles.container} role="application" aria-label="Gestión de productos">
      {/* ── HEADER ── */}
      <header style={styles.header}>
        <button type="button" onClick={onBack} style={styles.backBtn} aria-label="Volver al checkout">
          ← Volver
        </button>
        <h1 style={styles.title}>GESTIÓN DE PRODUCTOS</h1>
        <div style={styles.headerActions}>
          {mode === 'list' && (
            <button type="button" onClick={() => { setForm(EMPTY_FORM); setEditingId(null); setMode('create'); }} style={styles.btnPrimary}>
              + Nuevo
            </button>
          )}
        </div>
      </header>

      {/* ── MESSAGES ── */}
      {(error || success || importResult) && (
        <div style={styles.messages}>
          {error && <div style={styles.errorMsg} onClick={clearMessages} role="alert">{error} <span style={styles.msgClose} onClick={clearMessages}>✕</span></div>}
          {success && <div style={styles.successMsg} onClick={clearMessages} role="status">{success} <span style={styles.msgClose} onClick={clearMessages}>✕</span></div>}
          {importResult && (
            <div style={styles.importMsg} onClick={clearMessages} role="status">
              Importados: {importResult.created} · Errores: {importResult.errors.length}
              {importResult.errors.length > 0 && (
                <details style={styles.errorDetails}>
                  <summary>Ver errores</summary>
                  <ul>{importResult.errors.map((e, i) => <li key={i} style={styles.errorItem}>{e}</li>)}</ul>
                </details>
              )}
              <span style={styles.msgClose} onClick={clearMessages}>✕</span>
            </div>
          )}
        </div>
      )}

      {/* ── LIST VIEW ── */}
      {mode === 'list' && (
        <div style={styles.content}>
          {/* Search & Filters */}
          <div style={styles.toolbar}>
            <input
              ref={searchInputRef}
              type="search"
              placeholder="Buscar por nombre, SKU o código... (F2)"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={styles.searchInput}
              aria-label="Buscar productos"
            />
            <label style={styles.filterLabel}>
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Incluir inactivos
            </label>
            <button type="button" onClick={() => setMode('import')} style={styles.btnSecondary}>
              📥 Importar CSV
            </button>
          </div>

          {/* Table */}
          <div style={styles.tableWrapper} role="region" aria-label="Lista de productos" tabIndex={0}>
            {loading ? (
              <div style={styles.loading}>Cargando...</div>
            ) : filteredProducts.length === 0 ? (
              <div style={styles.emptyState}>
                {products.length === 0 ? 'No hay productos. Pulse + Nuevo para crear el primero.' : 'Sin coincidencias.'}
              </div>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>SKU</th>
                    <th style={styles.th}>Código</th>
                    <th style={styles.th}>Nombre</th>
                    <th style={styles.th}>Precio</th>
                    <th style={styles.th}>Stock</th>
                    <th style={styles.th}>Estado</th>
                    <th style={styles.thActions}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map((product) => (
                    <tr key={product.id} style={styles.row}>
                      <td style={styles.td}>{product.sku}</td>
                      <td style={styles.tdCode}>{product.barcode}</td>
                      <td style={styles.tdName}>{product.name}</td>
                      <td style={styles.tdPrice}>${product.price.toFixed(2)}</td>
                      <td style={{ ...styles.td, ...(product.stock <= 5 && product.stock > 0 ? styles.lowStock : {}), ...(product.stock === 0 ? styles.noStock : {}) }}>
                        {product.stock}
                      </td>
                      <td style={styles.td}>
                        <span style={{ ...styles.badge, ...(product.active ? styles.badgeActive : styles.badgeInactive) }}>
                          {product.active ? 'Activo' : 'Inactivo'}
                        </span>
                      </td>
                      <td style={styles.tdActions}>
                        <button type="button" onClick={() => { setStockTarget(product); setStockQty(''); setError(null); }} style={styles.btnIconStock} aria-label={`Agregar stock a ${product.name}`}>+Stock</button>
                        <button type="button" onClick={() => handleEdit(product)} style={styles.btnIcon} aria-label={`Editar ${product.name}`}>✎</button>
                        <button type="button" onClick={() => setDeleteTarget(product)} style={styles.btnIconDanger} aria-label={`Eliminar ${product.name}`}>🗑</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── CREATE/EDIT FORM ── */}
      {(mode === 'create' || mode === 'edit') && (
        <div style={styles.formContainer}>
          <div style={styles.formHeader}>
            <h2 style={styles.formTitle}>{mode === 'create' ? 'NUEVO PRODUCTO' : 'EDITAR PRODUCTO'}</h2>
            <button type="button" onClick={() => { setMode('list'); setForm(EMPTY_FORM); setEditingId(null); }} style={styles.formClose} aria-label="Cancelar">✕</button>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); mode === 'create' ? handleCreate() : handleUpdate(); }} style={styles.form}>
            <div style={styles.formRow}>
              <label style={styles.label}>SKU *</label>
              <input
                type="text"
                value={form.sku}
                onChange={(e) => handleFieldChange('sku', e.target.value.toUpperCase())}
                style={{ ...styles.input, ...(formErrors.sku ? styles.inputError : {}) }}
                onClick={() => openKeypad('sku')}
                readOnly
                aria-invalid={!!formErrors.sku}
                aria-describedby={formErrors.sku ? 'sku-error' : undefined}
                autoComplete="off"
              />
              {formErrors.sku && <span id="sku-error" style={styles.fieldError}>{formErrors.sku}</span>}
            </div>
            <div style={styles.formRow}>
              <label style={styles.label}>Código de barras *</label>
              <input
                type="text"
                value={form.barcode}
                onChange={(e) => handleFieldChange('barcode', e.target.value)}
                style={{ ...styles.input, ...(formErrors.barcode ? styles.inputError : {}) }}
                onClick={() => openKeypad('barcode')}
                readOnly
                aria-invalid={!!formErrors.barcode}
                aria-describedby={formErrors.barcode ? 'barcode-error' : undefined}
                autoComplete="off"
              />
              {formErrors.barcode && <span id="barcode-error" style={styles.fieldError}>{formErrors.barcode}</span>}
            </div>
            <div style={styles.formRow}>
              <label style={styles.label}>Nombre *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => handleFieldChange('name', e.target.value)}
                style={styles.input}
                aria-invalid={!!formErrors.name}
                aria-describedby={formErrors.name ? 'name-error' : undefined}
                autoComplete="off"
              />
              {formErrors.name && <span id="name-error" style={styles.fieldError}>{formErrors.name}</span>}
            </div>
            <div style={styles.formRow}>
              <label style={styles.label}>Precio *</label>
              <input
                type="text"
                value={form.price}
                onChange={(e) => handleFieldChange('price', e.target.value)}
                style={{ ...styles.input, ...(formErrors.price ? styles.inputError : {}) }}
                onClick={() => openKeypad('price')}
                readOnly
                aria-invalid={!!formErrors.price}
                aria-describedby={formErrors.price ? 'price-error' : undefined}
                autoComplete="off"
              />
              {formErrors.price && <span id="price-error" style={styles.fieldError}>{formErrors.price}</span>}
            </div>
            <div style={styles.formRow}>
              <label style={styles.label}>Stock inicial</label>
              <input
                type="text"
                value={form.stock}
                onChange={(e) => handleFieldChange('stock', e.target.value)}
                style={{ ...styles.input, ...(formErrors.stock ? styles.inputError : {}) }}
                onClick={() => openKeypad('stock')}
                readOnly
                aria-invalid={!!formErrors.stock}
                aria-describedby={formErrors.stock ? 'stock-error' : undefined}
                autoComplete="off"
              />
              {formErrors.stock && <span id="stock-error" style={styles.fieldError}>{formErrors.stock}</span>}
            </div>
            <div style={styles.formRow}>
              <label style={styles.labelCheckbox}>
                <input type="checkbox" checked={form.active} onChange={(e) => handleFieldChange('active', e.target.checked)} />
                Activo
              </label>
            </div>
            <div style={styles.formActions}>
              <button type="button" onClick={() => { setMode('list'); setForm(EMPTY_FORM); setEditingId(null); }} style={styles.btnSecondary} disabled={loading}>
                Cancelar
              </button>
              <button type="submit" style={styles.btnPrimary} disabled={loading}>
                {loading ? 'Guardando...' : mode === 'create' ? 'Crear' : 'Actualizar'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── IMPORT VIEW ── */}
      {mode === 'import' && (
        <div style={styles.formContainer}>
          <div style={styles.formHeader}>
            <h2 style={styles.formTitle}>IMPORTAR DESDE CSV</h2>
            <button type="button" onClick={() => setMode('list')} style={styles.formClose} aria-label="Cancelar">✕</button>
          </div>
          <div style={styles.importContainer}>
            <div style={styles.importInfo}>
              <h3>Formato CSV esperado:</h3>
              <pre style={styles.csvExample}>sku,barcode,name,price,stock,active
COCA-500,7790001,Coca Cola 500ml,150,100,true
AGUA-1L,7790002,Agua Mineral 1L,80,50,true</pre>
              <p>Columnas requeridas: sku, barcode, name, price</p>
              <p>Opcionales: stock (default 0), active (default true)</p>
            </div>
            <div style={styles.importInputWrapper}>
              <label style={styles.importLabel}>Contenido CSV:</label>
              <textarea
                value={csvContent}
                onChange={(e) => setCsvContent(e.target.value)}
                style={styles.csvTextarea}
                placeholder="Pegue aquí el contenido del archivo CSV..."
                rows={12}
                spellCheck={false}
              />
            </div>
            <div style={styles.importFileWrapper}>
              <label style={styles.importLabel}>O seleccione archivo:</label>
              <input type="file" ref={fileInputRef} accept=".csv,text/csv" onChange={handleFileUpload} style={styles.fileInput} />
            </div>
            <div style={styles.formActions}>
              <button type="button" onClick={() => setMode('list')} style={styles.btnSecondary} disabled={loading}>
                Cancelar
              </button>
              <button type="button" onClick={handleImport} style={styles.btnPrimary} disabled={loading}>
                {loading ? 'Importando...' : 'Importar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── RECEIVE STOCK MODAL ── */}
      {stockTarget && (
        <div style={styles.modalOverlay} onClick={() => { if (!stockLoading) setStockTarget(null); }} role="dialog" aria-modal="true" aria-label="Agregar stock">
          <div style={styles.stockModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.stockModalHeader}>
              <span style={styles.stockModalTitle}>AGREGAR STOCK — {stockTarget.name}</span>
              <button type="button" onClick={() => { if (!stockLoading) setStockTarget(null); }} style={styles.modalClose} aria-label="Cerrar">✕</button>
            </div>
            <p style={styles.stockCurrent}>Stock actual: <b style={{ color: '#00ff41' }}>{stockTarget.stock}</b></p>
            <label style={styles.label}>Cantidad a recibir</label>
            <input
              type="text"
              inputMode="numeric"
              value={stockQty}
              onChange={(e) => setStockQty(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && handleReceiveStock()}
              style={styles.input}
              placeholder="0"
              autoFocus={true}
            />
            <div style={styles.formActions}>
              <button type="button" onClick={() => setStockTarget(null)} style={styles.btnSecondary} disabled={stockLoading}>
                Cancelar
              </button>
              <button type="button" onClick={handleReceiveStock} style={styles.btnPrimary} disabled={stockLoading}>
                {stockLoading ? 'Guardando...' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE CONFIRM MODAL ── */}
      {deleteTarget && (
        <div style={styles.modalOverlay} onClick={() => { if (!loading) setDeleteTarget(null); }} role="dialog" aria-modal="true" aria-label={`Eliminar ${deleteTarget.name}`}>
          <div style={{ ...styles.stockModal, borderColor: '#ff4444' }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.stockModalHeader}>
              <span style={{ ...styles.stockModalTitle, color: '#ff4444' }}>ELIMINAR PRODUCTO</span>
              <button type="button" onClick={() => { if (!loading) setDeleteTarget(null); }} style={styles.modalClose} aria-label="Cerrar">✕</button>
            </div>
            <p style={styles.stockCurrent}>
              ¿Eliminar <b style={{ color: '#ff8888' }}>{deleteTarget.name}</b> ({deleteTarget.sku})?<br />
              Esta acción no se puede deshacer.
            </p>
            <div style={styles.formActions}>
              <button type="button" onClick={() => setDeleteTarget(null)} style={styles.btnSecondary} disabled={loading}>
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = deleteTarget.id;
                  setDeleteTarget(null);
                  handleDelete(id);
                }}
                style={{ ...styles.btnPrimary, background: '#3a1a1a', color: '#ff4444', border: '1px solid #ff4444' }}
                disabled={loading}
              >
                {loading ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MOBILE KEYPAD MODAL ── */}
      {isMobile && showKeypad && keypadTarget && (
        <div style={styles.modalOverlay} onClick={handleKeypadEscape} role="dialog" aria-modal="true" aria-label={`Entrada para ${keypadTarget}`}>
          <div style={styles.mobileKeypadModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.mobileKeypadHeader}>
              <span>{keypadTarget === 'price' ? 'Precio' : keypadTarget === 'stock' ? 'Stock' : keypadTarget.toUpperCase()}</span>
              <button type="button" onClick={handleKeypadEscape} style={styles.modalClose} aria-label="Cerrar">✕</button>
            </div>
            <NumericKeypad
              value={keypadValue}
              onChange={setKeypadValue}
              onEnter={handleKeypadEnter}
              onEscape={handleKeypadEscape}
              onBackspace={handleKeypadBackspace}
              placeholder={keypadTarget === 'price' ? '0.00' : '0'}
              autoFocus={true}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#0d0d0d',
    color: '#fff',
    fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    flexWrap: 'wrap',
    gap: '12px',
  },
  backBtn: {
    padding: '8px 16px',
    background: '#1a1a1a',
    border: '1px solid #333',
    color: '#888',
    fontFamily: 'inherit',
    fontSize: '13px',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  title: { color: '#00ff41', fontWeight: 'bold', fontSize: '16px', letterSpacing: '2px', margin: 0 },
  headerActions: { display: 'flex', gap: '8px' },
  messages: { padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: '8px' },
  errorMsg: { padding: '10px 14px', background: '#3a0000', border: '1px solid #ff4444', color: '#ff8888', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' },
  successMsg: { padding: '10px 14px', background: '#1a3a1a', border: '1px solid #00ff41', color: '#00ff41', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', cursor: 'pointer' },
  importMsg: { padding: '10px 14px', background: '#1a3a1a', border: '1px solid #4444ff', color: '#4444ff', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '8px', cursor: 'pointer' },
  errorDetails: { marginTop: '8px', fontSize: '12px' },
  errorItem: { color: '#ff8888', margin: '2px 0' },
  msgClose: { cursor: 'pointer', color: '#888', marginLeft: '8px' },
  content: { flex: 1, overflow: 'auto', padding: '16px' },
  toolbar: { display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' },
  searchInput: { flex: 1, minWidth: '200px', padding: '10px 14px', background: '#111', border: '2px solid #333', color: '#fff', fontFamily: 'inherit', fontSize: '14px', borderRadius: '8px', outline: 'none' },
  filterLabel: { display: 'flex', alignItems: 'center', gap: '6px', color: '#aaa', fontSize: '13px', cursor: 'pointer' },
  btnPrimary: { padding: '10px 20px', background: '#1a3a1a', color: '#00ff41', border: '1px solid #00ff41', borderRadius: '6px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer' },
  btnSecondary: { padding: '10px 20px', background: '#1a1a1a', color: '#aaa', border: '1px solid #333', borderRadius: '6px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer' },
  btnIcon: { padding: '6px 10px', background: '#1a1a3a', color: '#4444ff', border: '1px solid #4444ff', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' },
  btnIconStock: { padding: '6px 10px', background: '#1a3a1a', color: '#00ff41', border: '1px solid #00ff41', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' },
  btnIconDanger: { padding: '6px 10px', background: '#3a1a1a', color: '#ff4444', border: '1px solid #ff4444', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' },
  tableWrapper: { overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', minWidth: '800px' },
  th: { padding: '10px 12px', textAlign: 'left', background: '#1a1a1a', color: '#00ff41', borderBottom: '1px solid #2a2a2a', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', position: 'sticky', top: 0, zIndex: 1 },
  row: { borderBottom: '1px solid #1a1a1a', transition: 'background 0.1s' },
  td: { padding: '10px 12px', fontSize: '13px', fontVariantNumeric: 'tabular-nums' },
  tdCode: { padding: '10px 12px', fontSize: '13px', fontFamily: 'monospace', color: '#888' },
  tdName: { padding: '10px 12px', fontSize: '13px', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tdPrice: { padding: '10px 12px', fontSize: '13px', textAlign: 'right', color: '#00ff41', fontVariantNumeric: 'tabular-nums' },
  tdActions: { padding: '6px 12px', textAlign: 'right', whiteSpace: 'nowrap' },
  lowStock: { color: '#ffaa00', fontWeight: 'bold' },
  noStock: { color: '#ff4444', fontWeight: 'bold' },
  badge: { padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' },
  badgeActive: { background: '#1a3a1a', color: '#00ff41', border: '1px solid #00ff41' },
  badgeInactive: { background: '#3a1a1a', color: '#ff8888', border: '1px solid #ff4444' },
  emptyState: { textAlign: 'center', padding: '48px', color: '#444', fontSize: '14px' },
  loading: { textAlign: 'center', padding: '48px', color: '#00ff41', fontSize: '14px' },
  formContainer: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.95)',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 100,
    overflow: 'auto',
  },
  formHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', background: '#1a1a1a', borderBottom: '1px solid #2a2a2a', position: 'sticky', top: 0, zIndex: 2 },
  formTitle: { margin: 0, color: '#00ff41', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '2px' },
  formClose: { padding: '8px 12px', background: 'transparent', border: '1px solid #333', color: '#888', borderRadius: '4px', cursor: 'pointer', fontSize: '18px' },
  form: { flex: 1, padding: '24px', maxWidth: '500px', margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: '16px' },
  formRow: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '1px' },
  labelCheckbox: { fontSize: '13px', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
  input: { padding: '14px 16px', background: '#111', border: '2px solid #333', color: '#fff', fontFamily: 'inherit', fontSize: '16px', borderRadius: '8px', outline: 'none' },
  inputError: { borderColor: '#ff4444' },
  fieldError: { color: '#ff8888', fontSize: '12px' },
  formActions: { display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px', paddingTop: '16px', borderTop: '1px solid #2a2a2a' },
  importContainer: { flex: 1, padding: '24px', maxWidth: '700px', margin: '0 auto', width: '100%', overflow: 'auto' },
  importInfo: { background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '8px', padding: '16px', marginBottom: '16px' },
  csvExample: { background: '#111', border: '1px solid #333', borderRadius: '4px', padding: '12px', fontSize: '12px', color: '#00ff41', overflow: 'auto', margin: '8px 0' },
  importInputWrapper: { marginBottom: '16px' },
  importLabel: { display: 'block', fontSize: '12px', color: '#888', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '1px' },
  csvTextarea: { width: '100%', padding: '12px', background: '#111', border: '2px solid #333', color: '#fff', fontFamily: 'monospace', fontSize: '13px', borderRadius: '8px', outline: 'none', resize: 'vertical' },
  importFileWrapper: { marginBottom: '16px' },
  fileInput: { display: 'block', width: '100%', padding: '8px', background: '#111', border: '2px dashed #333', borderRadius: '8px', color: '#fff', fontFamily: 'inherit' },
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 200 },
  stockModal: { background: '#1a1a1a', border: '2px solid #00ff41', borderRadius: '12px 12px 0 0', padding: '20px', width: '100%', maxWidth: '440px', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 -4px 20px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', gap: '12px' },
  stockModalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' },
  stockModalTitle: { color: '#00ff41', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 'bold' },
  stockCurrent: { margin: 0, color: '#aaa', fontSize: '13px' },
  mobileKeypadModal: { background: '#111', border: '2px solid #00ff41', borderRadius: '12px 12px 0 0', padding: '16px', width: '100%', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 -4px 20px rgba(0,0,0,0.5)' },
  mobileKeypadHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  modalClose: { padding: '4px 10px', background: 'transparent', border: '1px solid #333', color: '#888', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' },
};