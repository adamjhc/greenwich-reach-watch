// Static files in public/ are served by Workers Static Assets before this
// runs; only /api/* reaches the Worker.

const handler = {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const river = env.RIVER.getByName('greenwich-reach');

    switch (pathname) {
      case '/api/stream': {
        return river.stream();
      }
      case '/api/tier': {
        return Response.json(await river.tierSnapshot());
      }
      case '/api/vessels': {
        return Response.json(await river.vesselSnapshot());
      }
      default: {
        return new Response('Not found', { status: 404 });
      }
    }
  },
} satisfies ExportedHandler<Env>;

export { River } from './river.ts';
export default handler;
