import 'fastify';

// The auth middleware resolves a team key and attaches its id to the request so
// downstream handlers (proxy route, usage attribution) can read it. Declaring it
// here gives it a real type instead of the `as Record<string, unknown>` casts
// that were used before.
declare module 'fastify' {
  interface FastifyRequest {
    teamKeyId?: string;
  }
}
