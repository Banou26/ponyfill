import { defineConfig } from 'vite-plus'
import { builtinModules } from 'module'

import packageJson from './package.json'

/**
 * Nothing is bundled that a consumer will resolve for itself.
 *
 * `dependencies` is read through a widened view because this package HAS none: TypeScript infers the
 * manifest's exact shape from the import, so `packageJson.dependencies` is not merely undefined, it
 * is a property that does not exist, and the `?? {}` cannot save an expression that fails to
 * compile. The widening keeps the fallback meaningful if one is ever added.
 */
const manifest = packageJson as { dependencies?: Record<string, string> }

const externalDeps = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...Object.keys(manifest.dependencies ?? {}),
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
      entry: { index: 'src/index.ts', storage: 'src/storage.ts', permissions: 'src/permissions.ts', 'file-system': 'src/file-system.ts' },
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
