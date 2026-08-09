// Shim mínimo — reemplazado por @types/react en producción (npm install).

declare module 'react' {
  export function useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void];
  export function useRef<T>(initial: T): MutableRefObject<T>;
  export interface MutableRefObject<T> { current: T; }
  export function useRef<T>(initial: null): { current: T | null };
  export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]): T;
  export function useEffect(fn: () => void | (() => void), deps?: unknown[]): void;
  const _default: unknown;
  export default _default;
}

// Namespaces globales: el compilador los busca aquí al transformar JSX clásico.
declare namespace React {
  interface MutableRefObject<T> { current: T; }
  interface CSSProperties { [key: string]: string | number | undefined; }
  interface ChangeEvent<T> { target: T; currentTarget: T; }
  interface KeyboardEvent { key: string; preventDefault(): void; }
}

declare namespace JSX {
  interface Element {}
  interface IntrinsicElements { [tag: string]: { [k: string]: unknown }; }
}

declare module 'react-dom/client' {
  export function createRoot(container: Element): { render(el: unknown): void };
}
