import { defineConfig } from 'vite-plus'
import { builtinModules } from 'module'

import packageJson from './package.json'

const externalDeps = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...Object.keys(packageJson.dependencies ?? {}),
]

export default defineConfig((env) => ({
  fmt: { semi: false, singleQuote: true },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ['tests/**', '**/*.spec.ts', '**/*.test.ts', 'examples/**'],
        rules: {
          'no-floating-promises': 'off',
          'no-unused-vars': 'off',
          'no-unused-expressions': 'off',
        },
      },
    ],
  },
  build: {
    outDir: 'build',
    target: 'esnext',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: { index: 'src/index.ts', storage: 'src/storage.ts' },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: (id) => externalDeps.some((dep) => id === dep || id.startsWith(dep + '/')),
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(env.mode),
  },
}))
