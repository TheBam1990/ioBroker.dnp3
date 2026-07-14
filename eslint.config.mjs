import config from '@iobroker/eslint-config';

export default [
  ...config,
  {
    rules: {
      'jsdoc/require-jsdoc': 'off',
    },
  },
  {
    files: ['test/**/*.js'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
];
