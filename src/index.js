import { headerHtml } from './header.js';
import { footerHtml } from './footer.js';
import { programsContent } from './programs.js'; // Your main page sections

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route for the programs page
    if (url.pathname === '/' || url.pathname === '/programs' || url.pathname === '/programs.html') {
      
      const completeHTML = `<!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Programs - The Airline of Udyanapura</title>
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Raleway:wght@400;600;700&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
          <style>
              /* Paste your CSS styles here or link an external stylesheet */
          </style>
      </head>
      <body>
          ${headerHtml}
          ${programsContent}
          ${footerHtml}
      </body>
      </html>`;

      return new Response(completeHTML, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
