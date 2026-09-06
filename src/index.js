import headerHtml from './header.html';
import footerHtml from './footer.html';
import programsContent from './programs.html';
import homeContent from './home.html';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const renderPage = (title, content, extraStyles = '') => `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title} - The Airline of Udyanapura</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Raleway:wght@400;600;700&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            }
            body {
                background-color: #ffffff;
                color: #333;
                line-height: 1.5;
            }
            h1, h2, h3, .logo {
                font-family: 'Raleway', sans-serif;
                font-weight: 700;
            }
            nav {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 1rem 5%;
                background-color: #ffffff;
                position: sticky;
                top: 0;
                z-index: 100;
                border-bottom: 1px solid #f0f0f0;
            }
            .logo { font-size: 1.8rem; color: #002A5C; letter-spacing: 0.5px; }
            .nav-links { display: flex; gap: 2rem; list-style: none; }
            .nav-links a { text-decoration: none; color: #555; font-weight: 500; font-size: 0.95rem; transition: color 0.2s ease; }
            .nav-links a:hover { color: #002A5C; }
            .btn {
                background-color: #002A5C; color: white; border: none; padding: 0.6rem 1.5rem;
                border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.95rem; transition: all 0.2s ease;
            }
            .btn:hover { background-color: #001b3d; }
            
            footer { background-color: #002A5C; color: #ffffff; padding: 3rem 5% 1.5rem; }
            .footer-content { max-width: 1400px; margin: 0 auto; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2.5rem; margin-bottom: 2.5rem; }
            .footer-col { flex: 1; min-width: 220px; }
            .footer-col h3, .footer-col h4 { color: #ffffff; margin-bottom: 0.75rem; font-size: 1.1rem; }
            .footer-col p, .footer-col a { color: #cbd5e1; font-size: 0.9rem; text-decoration: none; }
            .footer-col ul { list-style: none; display: flex; flex-direction: column; gap: 0.5rem; }
            .footer-bottom { max-width: 1400px; margin: 0 auto; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 1.25rem; text-align: center; }
            .footer-bottom p { font-size: 0.8rem; color: #94a3b8; }

            ${extraStyles}
        </style>
    </head>
    <body>
        ${headerHtml}
        ${content}
        ${footerHtml}
    </body>
    </html>`;

    // Route: Homepage
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(renderPage('Home', homeContent), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // Route: Programs Page
    if (url.pathname === '/programs' || url.pathname === '/programs.html') {
      const programsExtraCSS = `
        .overlap-section { margin-top: -50px; position: relative; z-index: 20; padding-bottom: 5rem; }
        .page-section { max-width: 1400px; margin: 0 auto; padding: 0 5%; }
        .section-wrapper { padding: 5rem 0; }
        .section-header { margin-bottom: 3rem; text-align: left; }
        .section-header h2 { font-size: 2.2rem; color: #111; margin-bottom: 0.5rem; }
        .section-header p { color: #555; font-size: 1.05rem; font-weight: 300; }
        .card { background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 12px 30px rgba(0, 42, 92, 0.08); display: flex; flex-direction: column; justify-content: space-between; border: 1px solid rgba(0, 42, 92, 0.06); }
        .card-content { padding: 2rem 1.75rem 1rem 1.75rem; flex-grow: 1; display: flex; flex-direction: column; }
        .card-tag { font-size: 0.75rem; color: #002A5C; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 0.5rem; }
        .card-title { font-size: 1.6rem; color: #111; margin-bottom: 0.75rem; }
        .card-text { font-size: 0.9rem; color: #555; line-height: 1.5; }
        .pay-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1.25rem; }
        .programs-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.75rem; }
        .dev-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.75rem; }
        .flight-programs-bg { background: linear-gradient(rgba(0, 10, 25, 0.82), rgba(0, 10, 25, 0.82)), url('https://imgur.com/m2bcxBM.png'); background-repeat: repeat; background-size: 450px; background-position: center; background-attachment: fixed; }
        .flight-programs-bg .section-header h2, .flight-programs-bg .section-header p { color: #ffffff; }
      `;

      return new Response(renderPage('Programs', programsContent, programsExtraCSS), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
