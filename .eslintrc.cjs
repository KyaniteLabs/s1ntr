/* eslint-env node */
'use strict';

// Fence runs (``` ~~~ or a {3} quantifier on them) and think tags written any
// way a regex or string can spell them.
const MODEL_TEXT_MARKUP = '/```|~~~|`\\{3|~\\{3|<[^>]{0,12}think/i';
const STRING_SCAN = '/^(startsWith|endsWith|includes|indexOf|lastIndexOf|split|replace|replaceAll|match|matchAll|search)$/';

module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-case-declarations': 'off',
    // Async/await enforcement rules
    'prefer-promise-reject-errors': 'error',
    'require-atomic-updates': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/require-await': 'warn',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    'no-console': 'warn',
    // LLM output must only execute through src/guardrails/GeneratedCodeGuard.ts.
    // A disable needs a comment naming the guard (or why the input is trusted).
    'no-eval': ['error', { allowIndirect: false }],
    'no-new-func': 'error',
    'no-implied-eval': 'error',
    // Model output is read only through src/llm/ModelOutput.ts (answerCode,
    // answerJson, splitThinking, fencedBlocks). Each hand-written fence or
    // think regex drifted on a different reply shape and failed correct answers.
    'no-restricted-syntax': ['error',
      {
        selector: `Literal[regex.pattern=${MODEL_TEXT_MARKUP}]`,
        message: 'Read model output through src/llm/ModelOutput.ts, not a fence/think regex.',
      },
      {
        selector: `CallExpression[callee.property.name=${STRING_SCAN}] > Literal.arguments[value=${MODEL_TEXT_MARKUP}]`,
        message: 'Read model output through src/llm/ModelOutput.ts, not a fence/think string match.',
      },
      {
        selector: `CallExpression[callee.property.name=${STRING_SCAN}] > TemplateLiteral.arguments > TemplateElement[value.cooked=${MODEL_TEXT_MARKUP}]`,
        message: 'Read model output through src/llm/ModelOutput.ts, not a fence/think string match.',
      },
      {
        selector: `NewExpression[callee.name="RegExp"] > Literal.arguments[value=${MODEL_TEXT_MARKUP}]`,
        message: 'Read model output through src/llm/ModelOutput.ts, not a fence/think regex.',
      },
      {
        selector: `NewExpression[callee.name="RegExp"] > TemplateLiteral > TemplateElement[value.cooked=${MODEL_TEXT_MARKUP}]`,
        message: 'Read model output through src/llm/ModelOutput.ts, not a fence/think regex.',
      },
      {
        selector: 'VariableDeclarator > Literal.init[value=/^\\s*(?:`{3,}|~{3,}|<\\/?think[^>]*>)\\s*$/i]',
        message: 'A fence or think marker constant is a parser token: use src/llm/ModelOutput.ts.',
      },
    ],
  },
  overrides: [
    {
      files: ['*.ts', '*.tsx'],
      parser: '@typescript-eslint/parser',
    },
    {
      // ModelOutput owns the parsing; StreamParser splits think tags out of a
      // live token stream incrementally, where whole-text parsing cannot run.
      files: ['src/llm/ModelOutput.ts', 'src/llm/StreamParser.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      files: ['src/tui/sanitizeTerminalText.ts'],
      rules: {
        'no-control-regex': 'off',
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', '/gallery/', 'gui/', 'docs/', '*.cjs', 'src/**/archive/'],
};
