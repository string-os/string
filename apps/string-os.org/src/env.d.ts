declare module '@string-os/astro-sfmd/integration' {
  const integration: (options?: unknown) => import('astro').AstroIntegration;
  export default integration;
}

declare module '@string-os/astro-sfmd/middleware' {
  export const onRequest: import('astro').MiddlewareHandler;
}

declare module '@vercel/functions' {
  export function next(options?: { headers?: Record<string, string> }): Response;
  export function rewrite(
    destination: URL | string,
    options?: { headers?: Record<string, string> },
  ): Response;
}
