/**
 * One rule, on purpose: no `any`, no `as any`. A rule only a reader enforces is
 * a convention; this makes it a gate. Add rules when somebody is prepared to fix
 * what they find.
 */
import tseslint from 'typescript-eslint';

export default [
  {
    // `.claude/` holds agent worktrees nested inside a checkout: other branches'
    // whole trees, which are not this tree and must not judge it.
    ignores: ['node_modules/**', '.claude/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
