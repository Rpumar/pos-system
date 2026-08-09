import { useState, useRef, useCallback } from 'react';
import { Cart, CartItem } from '../../domain/entities/Cart';
import { AddProductToCartUseCase } from '../../application/use-cases/AddProductToCartUseCase';
import { ProductNotFoundError, InsufficientStockError } from '../../application/errors/ProductErrors';

export type CartError =
  | { type: 'NOT_FOUND'; barcode: string }
  | { type: 'INSUFFICIENT_STOCK'; sku: string; available: number }
  | { type: 'UNKNOWN' };

export interface UseCartReturn {
  items: CartItem[];
  total: number;
  cartRef: React.MutableRefObject<Cart>;
  error: CartError | null;
  scanProduct: (barcode: string) => Promise<void>;
  updateQuantity: (productId: string, delta: number) => void;
  removeItem: (productId: string) => void;
  clearError: () => void;
  clear: () => void;
}

export function useCart(addProductUseCase: AddProductToCartUseCase): UseCartReturn {
  // El Cart mutable vive en un ref: se muta directamente sin clonar
  // en cada escaneo — importante bajo alta frecuencia de lecturas.
  // React solo se entera de cambios cuando llamamos a refresh().
  const cartRef = useRef(new Cart());
  const [items, setItems] = useState<CartItem[]>([]);
  const [error, setError] = useState<CartError | null>(null);

  const refresh = useCallback(() => {
    setItems([...cartRef.current.getItems()]);
  }, []);

  const scanProduct = useCallback(async (barcode: string) => {
    try {
      setError(null);
      await addProductUseCase.execute(cartRef.current, barcode, 1);
      refresh();
    } catch (e) {
      if (e instanceof ProductNotFoundError) {
        setError({ type: 'NOT_FOUND', barcode });
      } else if (e instanceof InsufficientStockError) {
        setError({ type: 'INSUFFICIENT_STOCK', sku: e.sku, available: e.available });
      } else {
        setError({ type: 'UNKNOWN' });
      }
    }
  }, [addProductUseCase, refresh]);

  const updateQuantity = useCallback((productId: string, delta: number) => {
    cartRef.current.updateQuantity(productId, delta);
    refresh();
  }, [refresh]);

  const removeItem = useCallback((productId: string) => {
    cartRef.current.removeItem(productId);
    refresh();
  }, [refresh]);

  const clear = useCallback(() => {
    cartRef.current.clear();
    refresh();
  }, [refresh]);

  return {
    items,
    total: cartRef.current.total,
    cartRef,
    error,
    scanProduct,
    updateQuantity,
    removeItem,
    clearError: useCallback(() => setError(null), []),
    clear,
  };
}
