module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.e2e.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.after-env.ts'],
  globals: {
    'ts-jest': {
      tsconfig: '<rootDir>/tsconfig.jest.json',
      isolatedModules: true,
      diagnostics: true,
    },
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
};