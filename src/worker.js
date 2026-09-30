// Static files in public/ are served by Workers Static Assets before this
// runs; only /api/* reaches the Worker.
export { River } from './river.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const river = env.RIVER.getByName('greenwich-reach');

    switch (pathname) {
      case '/api/stream':
        return river.stream();
      case '/api/tier':
        return Response.json(await river.tierSnapshot());
      case '/api/vessels':
        return Response.json(await river.vesselSnapshot());
      default:
        return new Response('Not found', { status: 404 });
    }
  },
};
