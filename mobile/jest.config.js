// Keep babel-preset-expo from inlining EXPO_PUBLIC_* env reads at transform
// time: with NODE_ENV=test it treats files as a production Metro bundle and
// compiles process.env.EXPO_PUBLIC_API_URL away, which makes env-dependent
// module behavior untestable. BABEL_ENV=development marks the caller as dev,
// which the preset honors by preserving runtime env reads.
process.env.BABEL_ENV = 'development';

module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.@(ts|tsx|js)'],
  // jest-expo's default allowlist does not cover superjson, which ships ESM
  // (`main: dist/index.js` uses `import`), nor superjson's own ESM
  // dependencies (copy-anything, is-what). Without this, any test importing
  // the tRPC client dies with "Cannot use import statement outside a module".
  // This list is the jest-expo default plus those packages — overriding the
  // option replaces the preset's value, so the defaults must be repeated here.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|superjson|copy-anything|is-what/)',
  ],
};
