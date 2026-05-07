// Content-negotiation: serve .md for agents, HTML for browsers.
// This one-line re-export wires the builder's middleware into Astro.
export { onRequest } from '@string-os/astro-sfmd/middleware';
