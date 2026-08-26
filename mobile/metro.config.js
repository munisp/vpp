// Learn more https://docs.expo.io/guides/customizing-metro
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Screens import evidence/copy helpers from the repository's `shared/` directory,
// which lives above this project root and is otherwise outside Metro's watch set.
config.watchFolders = [path.resolve(__dirname, '..', 'shared')];
// Those files must still resolve their imports against this app's dependencies,
// not against whatever the repository root happens to have installed.
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(__dirname, 'node_modules/.pnpm/node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// superjson's `copy-anything` dependency is ESM-only and declares its entry
// point through `exports`, which Metro ignores by default.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
