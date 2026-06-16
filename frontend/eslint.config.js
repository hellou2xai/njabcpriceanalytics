import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Browser globals (size, name, length, status, top, …) silently shadow an
      // intended local, so a typo like `size.edition` (meaning a local `size`)
      // type-checks against window.size and crashes at runtime. Forbid bare use
      // of the collision-prone ones — a declared local of the same name still
      // shadows the global and is NOT flagged.
      'no-restricted-globals': ['error',
        'size', 'name', 'length', 'status', 'top', 'parent',
        'origin', 'closed', 'event', 'external', 'frames',
      ],
    },
  },
])
