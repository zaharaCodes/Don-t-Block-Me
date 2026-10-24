// Puts the creator's name into the page title and the WhatsApp/Instagram link preview.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
module.exports = function withMeta(html, name, url) {
  const title = name ? `${name} is blocking fake friends 🚫📱` : 'Don’t Block Me 💖';
  const desc = name ? `Will ${name} block you? Play for free and find out 👇` : 'Will she block you? Find your fake friends! 🚫📱';
  const tags = `<title>${esc(title)}</title>\n<meta name="description" content="${esc(desc)}">\n<meta property="og:type" content="website">\n<meta property="og:title" content="${esc(title)}">\n<meta property="og:description" content="${esc(desc)}">\n<meta property="og:url" content="${esc(url)}">`;
  return html.replace(/<title>[\s\S]*?<\/title>/, () => tags);
};