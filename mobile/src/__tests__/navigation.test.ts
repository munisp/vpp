/**
 * Navigation registry test: statically verifies that every screen module
 * imported by AppNavigator (a) exists on disk and (b) is actually registered
 * as a Stack/Tab screen component — and conversely that every registered
 * screen component is imported. Catches both missing files (Metro bundle
 * failure) and dead imports / forgotten registrations.
 */

import * as fs from 'fs';
import * as path from 'path';

const navigatorPath = path.join(__dirname, '..', 'navigation', 'AppNavigator.tsx');
const source = fs.readFileSync(navigatorPath, 'utf8');

const importRe = /import\s+(\w+)\s+from\s+'(\.\.\/screens\/[^']+)'/g;
const importedScreens = [...source.matchAll(importRe)].map((m) => ({
  name: m[1],
  specifier: m[2],
}));

// Everything registered as a screen: component={SomeScreen}
const registeredRe = /component=\{(\w+)\}/g;
const registeredComponents = new Set(
  [...source.matchAll(registeredRe)].map((m) => m[1])
);

describe('AppNavigator screen registry', () => {
  it('imports a substantial set of screens (guard against a bad regex)', () => {
    // AppNavigator currently wires 40+ screens; if this drops to zero the
    // regex broke and the rest of this suite would silently pass.
    expect(importedScreens.length).toBeGreaterThanOrEqual(40);
  });

  it('every imported screen module resolves to a real file', () => {
    for (const { name, specifier } of importedScreens) {
      const base = path.resolve(path.dirname(navigatorPath), specifier);
      const candidates = [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx')];
      const found = candidates.some((candidate) => fs.existsSync(candidate));
      expect({ screen: name, found }).toEqual({ screen: name, found: true });
    }
  });

  it('every imported screen is registered as a navigator component', () => {
    for (const { name } of importedScreens) {
      expect(registeredComponents).toContain(name);
    }
  });

  it('every registered screen component is imported (no undefined components)', () => {
    const importedNames = new Set(importedScreens.map((s) => s.name));
    for (const component of registeredComponents) {
      // MainTabs is defined inside AppNavigator itself, not imported.
      if (component === 'MainTabs') continue;
      expect(importedNames).toContain(component);
    }
  });

  it('no duplicate screen imports (would double-register routes)', () => {
    const specifiers = importedScreens.map((s) => s.specifier);
    expect(new Set(specifiers).size).toBe(specifiers.length);
  });
});
