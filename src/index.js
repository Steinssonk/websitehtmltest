import headerHtml from './header.html';
import footerHtml from './footer.html';
import homeContent from './home.html';
import programsContent from './programs.html';
import fleetContent from './fleet.html';
import hubsContent from './hubs.html';

// Each page here is a complete, self-contained HTML document (it has its
// own <!DOCTYPE>, <head>, and <body>, and fetches header.html/footer.html
// client-side to fill in the shared nav and footer). The worker's only job
// is to serve the right file for the right path — it should NOT wrap these
// in any extra template.
const routes = {
  '/': homeContent,
  '/index.html': homeContent,
  '/home.html': homeContent,

  '/programs': programsContent,
  '/programs.html': programsContent,

  '/fleet': fleetContent,
  '/fleet.html': fleetContent,

  '/hubs': hubsContent,
  '/hubs.html': hubsContent,

  // These are fetched client-side by the pages above, so they need to be
  // routable too, or the fetch()es resolve to a 404 and inject the words
  // "Not Found" into the header/footer placeholders.
  '/header.html': headerHtml,
  '/footer.html': footerHtml,
};

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname in routes) {
      return new Response(routes[pathname], {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
