// Empty mock for Node.js built-in modules in browser builds
export const readFileSync = () => '';
export const writeFileSync = () => {};
export const mkdirSync = () => {};
export const existsSync = () => false;
export const join = (...args: string[]) => args.join('/');
export const dirname = (path: string) => path.split('/').slice(0, -1).join('/') || '.';
export const resolve = (...args: string[]) => args.join('/');
export const cwd = () => '/';
export const randomBytes = (size: number) => new Uint8Array(size);
export const createHash = () => ({
  update: () => ({ digest: () => 'mock-hash' }),
});