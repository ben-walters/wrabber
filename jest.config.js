module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  collectCoverage: true,
  coverageProvider: 'v8',
  coverageReporters: ['text', 'lcov'],
  moduleNameMapper: {
    '^~generated-types$': '<rootDir>/tests/mocks/generated-types.ts',
  },
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
};
