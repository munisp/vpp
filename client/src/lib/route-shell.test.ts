/**
 * Every navigable route has to render inside the dashboard shell, and every
 * admin route has to refuse a member in the client as well as the server.
 *
 * Both were untrue before this suite existed: 26 routes rendered with no
 * sidebar, and the admin pages among them rendered their console for any
 * signed-in member. These are static checks against App.tsx so that a route
 * added without a shell or without a guard fails here, not in a browser.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NAV_GROUPS } from './nav';

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

/** component name -> source file, from App.tsx's own imports. */
function importedPages(): Map<string, string> {
  const pages = new Map<string, string>();
  // Pages are route-level code-split: most arrive as
  // `const X = lazy(() => import(".../pages/Y"))`, a few stay eagerly
  // imported (`import X from ".../pages/Y"`). Both declare the same binding.
  for (const match of appSource.matchAll(
    /(?:import\s+(\w+)\s+from|const\s+(\w+)\s*=\s*lazy\(\(\)\s*=>\s*import\()\s*["'](?:@\/|\.\/)(pages\/[^"']+)["']/g
  )) {
    pages.set(match[1] ?? match[2], `client/src/${match[3]}.tsx`);
  }
  return pages;
}

type RouteRender = {
  path: string;
  component?: string;
  shell?: { adminOnly: boolean; chrome: boolean };
};

/** Reads how each route renders: bare component, or wrapped in a RouteShell. */
function routeRenders(): Map<string, RouteRender> {
  const renders = new Map<string, RouteRender>();

  for (const match of appSource.matchAll(
    /<Route\s+path=\{?"([^"]+)"\}?\s+component=\{(\w+)\}/g
  )) {
    renders.set(match[1], { path: match[1], component: match[2] });
  }

  for (const match of appSource.matchAll(
    /<Route\s+path=\{?"([^"]+)"\}?\s*>\s*<RouteShell([^>]*)>\s*<(\w+)\s*\/>/g
  )) {
    const attributes = match[2];
    renders.set(match[1], {
      path: match[1],
      component: match[3],
      shell: {
        adminOnly: /\badminOnly\b/.test(attributes),
        chrome: !/chrome=\{false\}/.test(attributes),
      },
    });
  }

  return renders;
}

const pages = importedPages();
const renders = routeRenders();
const navItems = NAV_GROUPS.flatMap(group =>
  group.items.map(item => ({ ...item, adminOnly: item.adminOnly || group.adminOnly }))
);

function pageSource(component: string): string {
  const file = pages.get(component);
  if (!file) throw new Error(`App.tsx does not import a page named ${component}`);
  return readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
}

describe('route shell', () => {
  it('resolves a component for every navigable path', () => {
    const unresolved = navItems
      .filter(item => !renders.get(item.path)?.component)
      .map(item => item.path);
    expect(unresolved).toEqual([]);
  });

  it('renders every navigable page inside the sidebar shell', () => {
    const bare = navItems.filter(item => {
      const render = renders.get(item.path);
      if (!render?.component) return false;
      // A wall board owns the viewport and opts out deliberately.
      if (render.shell && !render.shell.chrome && item.path === '/grid/operations-wall') {
        return false;
      }
      if (render.shell?.chrome) return false;
      return !pageSource(render.component).includes('DashboardLayout');
    });
    expect(bare.map(item => item.path)).toEqual([]);
  });

  it('guards every admin-only route against a member in the client', () => {
    const unguarded = navItems
      .filter(item => item.adminOnly)
      .filter(item => {
        const render = renders.get(item.path);
        if (!render?.component) return false;
        if (render.shell?.adminOnly) return false;
        // A page may guard by redirecting a member away, or by rendering a
        // member-scoped view of its own; either way it reads the role.
        const source = pageSource(render.component);
        return !/role\s*[!=]==\s*['"]admin['"]/.test(source);
      });
    expect(unguarded.map(item => item.path)).toEqual([]);
  });

  it('does not wrap a page that already renders the layout in a second one', () => {
    const doubled = [...renders.values()].filter(
      render =>
        render.component &&
        render.shell?.chrome &&
        pageSource(render.component).includes('DashboardLayout')
    );
    expect(doubled.map(render => render.path)).toEqual([]);
  });
});
