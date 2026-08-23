/**
 * The shell a route renders inside.
 *
 * Most pages import `DashboardLayout` themselves, and the admin ones among them
 * redirect a non-admin away. The pages that do neither used to render bare: no
 * sidebar to navigate back with, and — for the admin ones — the full admin page
 * for any signed-in member. Server procedures are the authority on access, so
 * this is not the only guard, but a member must not be shown an admin console.
 *
 * `chrome={false}` is for a page that owns the whole viewport (a wall board),
 * which still needs the role check.
 */

import type { ReactNode } from 'react';
import { Redirect } from 'wouter';

import { useAuth } from '@/_core/hooks/useAuth';
import DashboardLayout from './DashboardLayout';

export type RouteShellProps = {
  children: ReactNode;
  adminOnly?: boolean;
  chrome?: boolean;
};

export function RouteShell({ children, adminOnly = false, chrome = true }: RouteShellProps) {
  const { user, loading } = useAuth();

  // While the session is still loading the role is unknown, so nothing is
  // decided yet; DashboardLayout renders its own loading state.
  if (adminOnly && !loading && user?.role !== 'admin') {
    return <Redirect to="/" />;
  }

  if (!chrome) {
    // Nothing to render a loading state into, and an admin page must not flash
    // before the role is known.
    if (adminOnly && loading) return null;
    return <>{children}</>;
  }

  return <DashboardLayout>{children}</DashboardLayout>;
}

export default RouteShell;
