'use strict';
/**
 * Local generator: hexo 8 removed the built-in `index_generator`, so the
 * blog home page (post list) is no longer rendered automatically. We
 * restore the equivalent behaviour here.
 *
 * Lives in `blog/scripts/` which hexo auto-loads at boot. Hexo wraps
 * each script in `(async function(exports, require, module, __filename,
 * __dirname, hexo){...})`, so `hexo` is the live Hexo instance and we
 * call `hexo.extend.generator.register(...)` directly.
 *
 * What it does:
 *   • Reads `index_generator` from the merged site config (path,
 *     per_page, order_by). Falls back to hexo's documented defaults.
 *   • Walks `site.posts` in the requested order.
 *   • Paginates into `per_page`-sized chunks.
 *   • Emits one route per page under `index_generator.path` (joined with
 *     `config.root`), each rendered through the `index` layout — which
 *     expects `page.posts` to be the paginated subset.
 *
 * Verified against hexo@8.1.2 + hexo-theme-landscape@1.1.0 with
 * `root: /blog/`: the generator emits `../public/blog/index.html` for
 * page 1 and `../public/blog/page/2/index.html` for the rest.
 */
const { config } = hexo;
const cfg = Object.assign(
  { path: '', per_page: 10, order_by: '-date' },
  config.index_generator || {},
);

hexo.extend.generator.register('blog-index', function (locals) {
  const all = locals.posts.sort((a, b) => {
    if (cfg.order_by === '-date') return b.date.valueOf() - a.date.valueOf();
    if (cfg.order_by === 'date') return a.date.valueOf() - b.date.valueOf();
    return 0;
  });

  const perPage = Number(cfg.per_page) || 10;
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / perPage));

  const out = [];
  // config.root is already a path like "/blog/". join it with index.path.
  // hexo's built-in index_generator used `url.path` (URL.pathname +
  // index.path); we replicate that by string concat so we don't drag
  // in the `url` helper just for one join.
  const root = config.root || '/';
  const basePath =
    cfg.path === ''
      ? root
      : root.replace(/\/$/, '') + (cfg.path.startsWith('/') ? cfg.path : '/' + cfg.path);

  for (let i = 0; i < pages; i++) {
    const slice = all.slice(i * perPage, (i + 1) * perPage);
    const pageObj = {
      __index: true,
      posts: slice,
      base: basePath,
      current: i + 1,
      total: pages,
      prev: i > 0 ? i : '',
      next: i < pages - 1 ? i + 2 : '',
    };
    // Output path is relative to public_dir. With public_dir=../public/blog
    // and basePath=/blog/, hexo will format path "/blog/" relative to
    // public_dir into "blog/index.html". But public_dir already *is* the
    // /blog/ segment, so the correct relative path is just "index.html"
    // for page 1, "page/<n>/index.html" for the rest.
    const urlPath =
      i === 0
        ? '/'
        : '/page/' + (i + 1) + '/';
    const relPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '') + 'index.html';
    pageObj.path = basePath + (i === 0 ? '' : 'page/' + (i + 1) + '/');
    out.push({
      path: relPath,
      layout: ['index', 'post', 'page'],
      data: pageObj,
    });
  }
  return out;
});
