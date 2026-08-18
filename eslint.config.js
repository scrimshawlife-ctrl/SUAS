import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message:
            'Read configuration through src/config instead of process.env directly (SUAS-specs ENVIRONMENT.md §3-§5).',
        },
      ],
    },
  },
  {
    // The configuration loader, CLIs, and tests are the authorized readers of the
    // raw environment; everything else must go through the validated config object.
    files: [
      'src/config/**/*.ts',
      'src/provenance/**/*.ts',
      'src/cli/**/*.ts',
      'src/main.ts',
      'tests/**/*.ts',
      '*.config.ts',
    ],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
