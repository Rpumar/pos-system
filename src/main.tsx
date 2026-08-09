import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import type { AppContainer } from './container';

async function boot(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('No se encontró el elemento #root');

  const useMock = import.meta.env.VITE_USE_MOCK === 'true';
  const useServer = import.meta.env.VITE_USE_SERVER === 'true';
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

  let container: AppContainer;
  if (useMock) {
    const { buildMockContainer } = await import('./container.mock');
    container = buildMockContainer({ registerId: import.meta.env.VITE_REGISTER_ID ?? 'CAJA-1' });
  } else if (useServer) {
    const { buildServerContainer } = await import('./container.server');
    container = buildServerContainer({
      apiBaseUrl,
      registerId: import.meta.env.VITE_REGISTER_ID ?? 'CAJA-1',
    });
  } else {
    const { buildContainer } = await import('./container');
    container = buildContainer();
  }

  createRoot(root).render(<App container={container} />);
}

void boot();
