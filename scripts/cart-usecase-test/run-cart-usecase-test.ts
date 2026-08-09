/**
 * Repositorio en memoria que implementa IProductRepository, usado solo
 * para aislar AddProductToCartUseCase de SQLite. La lógica de negocio
 * que se prueba acá (qué pasa con stock insuficiente, productos
 * inactivos, acumulación en el carrito) es independiente de dónde
 * vivan los datos.
 */
import { Cart } from '../../src/domain/entities/Cart';
import { Product } from '../../src/domain/entities/Product';
import { IProductRepository } from '../../src/application/ports/IProductRepository';
import { AddProductToCartUseCase } from '../../src/application/use-cases/AddProductToCartUseCase';
import { ProductNotFoundError, InsufficientStockError } from '../../src/application/errors/ProductErrors';

class InMemoryProductRepository implements IProductRepository {
  constructor(private readonly products: Product[]) {}
  async findByBarcode(barcode: string): Promise<Product | null> {
    return this.products.find((p) => p.barcode === barcode) ?? null;
  }
  async findAllActive(): Promise<Product[]> {
    return this.products.filter((p) => p.active);
  }
}

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
  } else {
    console.log(`  ❌ ${message}`);
    failures++;
  }
}

async function run(): Promise<void> {
  console.log('=== Verificación de AddProductToCartUseCase ===');

  const repo = new InMemoryProductRepository([
    new Product('1', 'COCA-500', '7790001', 'Coca Cola 500ml', 150, 10, true),
    new Product('2', 'AGUA-1L', '7790002', 'Agua Mineral 1L', 80, 2, true),
    new Product('3', 'DISCONT', '7790003', 'Producto Discontinuado', 50, 100, false),
  ]);
  const useCase = new AddProductToCartUseCase(repo);

  console.log('\nTest 1: escanear un producto válido lo agrega al carrito');
  {
    const cart = new Cart();
    const item = await useCase.execute(cart, '7790001', 1);
    assert(item.sku === 'COCA-500', `el item devuelto es el correcto (fue: ${item.sku})`);
    assert(cart.getItems().length === 1, `el carrito tiene 1 línea (tiene ${cart.getItems().length})`);
    assert(cart.total === 150, `el total del carrito es 150 (fue: ${cart.total})`);
  }

  console.log('\nTest 2: escanear el mismo producto dos veces acumula cantidad, no duplica la línea');
  {
    const cart = new Cart();
    await useCase.execute(cart, '7790001', 1);
    await useCase.execute(cart, '7790001', 1);
    assert(cart.getItems().length === 1, `sigue habiendo 1 sola línea (hay ${cart.getItems().length})`);
    assert(cart.getItems()[0].quantity === 2, `la cantidad acumulada es 2 (fue: ${cart.getItems()[0].quantity})`);
  }

  console.log('\nTest 3: código de barras inexistente lanza ProductNotFoundError');
  {
    const cart = new Cart();
    let caught: unknown = null;
    try {
      await useCase.execute(cart, '0000000000', 1);
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof ProductNotFoundError, `se lanzó ProductNotFoundError (fue: ${caught?.constructor.name})`);
    assert(cart.getItems().length === 0, 'el carrito quedó vacío, sin efectos secundarios');
  }

  console.log('\nTest 4: producto inactivo (discontinuado) se trata como no encontrado');
  {
    const cart = new Cart();
    let caught: unknown = null;
    try {
      await useCase.execute(cart, '7790003', 1);
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof ProductNotFoundError, `producto inactivo lanza ProductNotFoundError (fue: ${caught?.constructor.name})`);
  }

  console.log('\nTest 5: pedir más cantidad de la que hay en stock lanza InsufficientStockError');
  {
    const cart = new Cart();
    let caught: unknown = null;
    try {
      await useCase.execute(cart, '7790002', 5); // stock real es 2
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof InsufficientStockError, `se lanzó InsufficientStockError (fue: ${caught?.constructor.name})`);
    assert(cart.getItems().length === 0, 'el carrito no quedó con una línea inválida');
  }

  console.log('\nTest 6: dos escaneos que en conjunto exceden el stock, aunque cada uno por separado no lo haría');
  {
    const cart = new Cart();
    await useCase.execute(cart, '7790002', 1); // queda 1 en el carrito, stock real sigue en 2 (no se descontó)
    let caught: unknown = null;
    try {
      await useCase.execute(cart, '7790002', 2); // 1 (ya en carrito) + 2 = 3, excede el stock de 2
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof InsufficientStockError,
      `detecta el exceso considerando lo YA agregado al carrito (fue: ${caught?.constructor.name})`
    );
    assert(cart.getItems()[0].quantity === 1, 'el carrito conserva solo la cantidad previa válida (1)');
  }

  console.log(`\n${failures === 0 ? '✅ TODOS LOS CHECKS PASARON' : `❌ ${failures} CHECK(S) FALLARON`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
