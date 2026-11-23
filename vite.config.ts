/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Only this one variable is read from the environment; avoids pulling in @types/node for it.
declare const process: { env: Record<string, string | undefined> }

export default defineConfig({
  // Local dev stays at '/'. The Pages workflow sets VITE_BASE=/<repo-name>/ for the build.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
