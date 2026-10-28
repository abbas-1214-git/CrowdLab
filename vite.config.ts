import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const portValue = loadEnv(mode, process.cwd(), '').VITE_PORT;
  const port = portValue ? Number(portValue) : 5173;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('VITE_PORT must be an integer between 1 and 65535.');
  return { plugins: [react()], server: { host: '127.0.0.1', port, strictPort: true } };
});
