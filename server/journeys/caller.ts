/**
 * A tRPC caller for journey steps.
 *
 * A journey has to exercise the same procedures the apps call — including the
 * role middleware and the ownership checks inside each procedure — so a step
 * calls `appRouter` with a real user row rather than reaching into the database
 * layer directly. What it does not exercise is the HTTP edge: express
 * middleware (rate limiting, session cookies, CORS) is not in the path, so a
 * green journey is evidence about the service layer, not about the edge.
 */

import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import type { User } from '../../drizzle/schema';
import { appRouter } from '../routers';
import { getUserById } from '../db';

export type JourneyCaller = ReturnType<typeof appRouter.createCaller>;

export type JourneyPrincipal = {
  user: User;
  caller: JourneyCaller;
  /**
   * Headers the next call presents. Device-credentialled ingestion is
   * authenticated from headers, so a step that registers a device can present
   * its credential on the following call.
   */
  headers: Record<string, string>;
};

/**
 * Enough of an express request for the procedures that read one. Only headers
 * are populated: a step that needs a cookie or a socket is calling something
 * that belongs at the HTTP edge, and should say so rather than fake one.
 */
function stubRequest(headers: Record<string, string>): CreateExpressContextOptions['req'] {
  return {
    headers,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    ip: '127.0.0.1',
    method: 'POST',
    url: '/trpc/journey',
    body: {},
    query: {},
    cookies: {},
  } as unknown as CreateExpressContextOptions['req'];
}

/**
 * A response that records rather than writes. A procedure that sets a cookie
 * (sign-in, sign-out) is not journey material, but it must not crash either.
 */
function stubResponse(): CreateExpressContextOptions['res'] {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    cookie() {
      return res;
    },
    clearCookie() {
      return res;
    },
    setHeader(name: string, value: unknown) {
      res.headers[name] = value;
      return res;
    },
    getHeader(name: string) {
      return res.headers[name];
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json() {
      return res;
    },
    send() {
      return res;
    },
    end() {
      return res;
    },
  };
  return res as unknown as CreateExpressContextOptions['res'];
}

export class JourneyPrincipalError extends Error {}

/**
 * Build a principal for a user id. The user row is read from the database, so a
 * journey cannot invent a role: an admin step run with a member's id is refused
 * by the same middleware that refuses it over HTTP.
 */
export async function principalFor(userId: number): Promise<JourneyPrincipal> {
  const user = await getUserById(userId);
  if (!user) {
    throw new JourneyPrincipalError(
      `User ${userId} does not exist; a journey needs real accounts to run as.`
    );
  }

  const headers: Record<string, string> = {};
  const caller = appRouter.createCaller({
    req: stubRequest(headers),
    res: stubResponse(),
    user,
  });

  return { user, caller, headers };
}
