import { Cart, CartItem } from '../../domain/entities/Cart';
import { IProductRepository } from '../ports/IProductRepository';
import { ProductNotFoundError, InsufficientStockError } from '../errors/ProductErrors';

/**
 * Agrega una unidad escaneada al carrito. Consulta SIEMPRE el
 * repositorio local (caché en RAM o SQLite local, nunca un servidor
 * remoto) — es lo que hace que el escaneo se sienta instantáneo.
 *
 * La validación de stock acá es OPTIMISTA: solo avisa al cajero. El
 * descuento real y definitivo ocurre en CommitSaleUseCase al confirmar
 * el pago (Módulo 3). Así, si el cliente se arrepiente antes de pagar,
 * nunca se le bloqueó stock a otra caja por nada.
 */
export class AddProductToCartUseCase {
  constructor(private readonly productRepository: IProductRepository) {}

  async execute(cart: Cart, barcode: string, quantity = 1): Promise<CartItem> {
    const product = await this.productRepository.findByBarcode(barcode);
    if (!product || !product.active) {
      throw new ProductNotFoundError(barcode);
    }

    const alreadyInCart = cart.getItems().find((i) => i.productId === product.id)?.quantity ?? 0;
    const totalRequested = alreadyInCart + quantity;

    if (!product.hasStockFor(totalRequested)) {
      throw new InsufficientStockError(product.sku, product.stock, totalRequested);
    }

    const item = new CartItem(product.id, product.sku, product.name, product.price, quantity);
    cart.addItem(item);
    return item;
  }
}
