/**
 * Popup Script
 *
 * Tabs:
 *   1. Products — track individual product pages (stock, price, colors)
 *   2. Collections — save filtered collection URLs as quick shortcuts
 */

document.addEventListener('DOMContentLoaded', init);

// Known Lululemon sort options (key = URL param value, value = display label)
// US site uses Ns param, international sites use srule param
const SORT_OPTIONS_US = {
  '': 'Featured',
  'product.last_SKU_addition_dateTime|1': 'New Arrivals',
  'RATINGS|1': 'Top Rated',
  'price|0': 'Price: Low → High',
  'price|1': 'Price: High → Low',
};

// International srule values by region
const SORT_OPTIONS_HK = {
  'HK-bestseller': 'Default (Bestseller)',
  'Relevance': 'Relevance',
  'HK-C-N-': 'New Arrivals',
  'Top sellers': 'Top Sellers',
  'Price Descending': 'Price: High → Low',
  'Price Ascending': 'Price: Low → High',
};

const SORT_OPTIONS_AU = {
  'aunz-standard-': 'Default',
  'Relevance': 'Featured',
  'Price Descending': 'Price: High → Low',
  'Price Ascending': 'Price: Low → High',
  'A-Z': 'A → Z',
  'Z-A': 'Z → A',
};

/**
 * Detect if a URL belongs to any Lululemon domain.
 * Returns { isLulu: true, region: 'us'|'hk'|'au'|'other', isUS: bool }
 */
function detectLuluDomain(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host === 'shop.lululemon.com') return { isLulu: true, region: 'us', isUS: true };
    if (host === 'www.lululemon.com.hk') return { isLulu: true, region: 'hk', isUS: false };
    if (host === 'www.lululemon.com.au') return { isLulu: true, region: 'au', isUS: false };
    if (host.includes('lululemon.com')) return { isLulu: true, region: 'other', isUS: false };
    return { isLulu: false, region: null, isUS: false };
  } catch { return { isLulu: false, region: null, isUS: false }; }
}

// Filter code → human-readable name mapping
const FILTER_NAMES = {
  // Categories
  'oxc7': "Men's Clothes", 'h1v9': 'Coats & Jackets', 'w1md': 'Hoodies & Sweatshirts',
  'u9dn': 'Pants', 'f3j9': 'Shirts', 'jn1c': 'Shorts', '49w9': 'Underwear',
  // Product Lines
  'sddx': 'ABC', '6dav': 'License To Train', 'peaw': 'Metal Vent Tech',
  'egx7': 'Pace Breaker', 'yh99': 'Soft Jersey', 'esuu': 'Align',
  'j8y3': 'Always Down', 'pwhl': 'Always In Motion', 'c827': 'BeCalm',
  'k158': 'Beyondfeel', 'kg1k': 'Big Cozy', '06p9': 'Built To Move',
  '237s': 'Chargefeel', 'wq7k': 'Cityverse', '4f60': 'Cross Chill',
  '5g0x': 'Daydrift', '1xjq': 'Down for It All', 'xplg': 'Ease The Day',
  '7ki0': 'EasyFive', '8utp': 'EasySet', 'n5c2': 'Engineered Warmth',
  '3jyo': 'Everywhere', 'b4x4': 'Fast & Free', 'bsxs': 'Featherweight',
  '2fkn': 'Fundamental', 'h4uh': 'Grand Standard', '5t96': 'Navigation Down',
  'cjb2': 'Restfeel', '3s3c': 'Slacker', '1ok8': 'Smooth Spacer',
  '23e2': 'Soft Stretch', 'x8f0': 'Split Shift', 'k0lg': 'Steady State',
  'd6em': 'Textured Spacer', 'rw1e': 'Unrestricted Power', 't5t3': 'Wildfeel',
  'm2yt': 'Wunder Puff', '6lfx': 'Zero Tucks', 'qpwg': 'Zeroed In',
  // Subcategories
  '2my0': 'Hoodies', 'sgwg': 'Athletic Shorts', 'ug19': 'Half Zip',
  'g62m': 'Liner Shorts', 'mnkc': 'Athletic Jackets', 'x0md': 'Athletic Pants',
  'qqnm': 'Boxers', 'ovjw': 'Briefs', 'xv48': 'Crewneck Sweatshirts',
  'oh18': 'Pullover Sweaters', '58ei': 'Quarter Zip', '8182': 'Sweat Shorts',
  'qcjs': 'Track Jackets', 'go1x': 'Track Pants', 'dpfg': 'Track Shorts',
  // Sizes
  '00in': 'XS', 'vibs': 'S', 'qstj': 'M', 'u2m1': 'L',
  'q472': 'XL', 'o64u': 'XXL', 'x79j': 'XXXL',
  // Inseam
  'ldut': '3"', 'p9fe': '5"', 't5wf': '7"', 'lfne': '9"',
  'yyug': '27"', 'u756': '28"', 'kqrx': '29"', 'jehg': '30"',
  '7lsa': '31"', 'g23g': '32"', '4tkd': '34"',
  // Fit
  'ydf5': 'Tight Fit', 'oyr3': 'Slim Fit', '53ml': 'Classic Fit',
  'o9nl': 'Relaxed Fit', 'vc9j': 'Oversized Fit',
  // Colors
  'c1a0': 'Black', '110v': 'White', '6lm0': 'Grey', 'vjcx': 'Brown',
  'yr3d': 'Khaki', 'zrsk3': 'Neutral', 'sn78': 'Red', 'crj8': 'Pink',
  'vqp4': 'Burgundy', 'lls5': 'Orange', 'flnr': 'Yellow', 'w2wh': 'Green',
  'td6f': 'Olive', '0vt3': 'Blue', 'ea52': 'Navy', 'h084': 'Purple',
  'pspv': 'Pastel', '5l40': 'Neon', '2bcn': 'Striped', '9u7a': 'Printed',
  'um4i': 'Leopard Print', 'mtwv': 'Tie Dye',
  // Activity
  'ae4c': 'Workout', 'ynj2': 'Running', 'yk1r': 'Casual', '1m2d': 'Golf',
  'loe8': 'Lounge', 'f38a': 'Tennis', '4anx': 'Travel', 'pofs': 'Yoga',
  'qfse': 'Training',
  // Fabric
  '3wwi': 'Cotton', 'ir5y': 'Fleece', 'csjh': 'Luxtreme', 'by2w': 'Mesh',
  'nua5': 'Ripstop', '8bdf': 'Swift',
  // Features
  '8avr': 'Pocketed', 'n6yq': 'Multipack', 'd7ck': 'Anti Stink',
  '41ke': 'Drawstring', 'a1b7': 'Breathable', 'p21b': 'Lightweight',
  'h591': 'Quick Dry', 'og7t': 'Reflective', 'd5m8': 'Seamless',
  '7xon': 'Sun Protection', 'uoos': 'Water Repellant',
  // Weather/Season
  'fowa': 'Warm Weather', 'gjr2': 'Cold Weather',
  'w6qx': 'Spring', 'mi4u': 'Summer', '9olv': 'Fall', 'inmi': 'Winter',
};

async function init() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Products tab
  await renderProductList();
  await detectCurrentPage();
  document.getElementById('btn-refresh').addEventListener('click', handleRefresh);

  // Collections tab
  await renderCollections();
  await detectCollectionPage();
  document.getElementById('btn-add-collection').addEventListener('click', handleAddCollection);
  document.getElementById('btn-save-collection').addEventListener('click', handleSaveCollectionPage);

  // SPA navigation listener
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'productPageChanged') {
      setTimeout(() => detectCurrentPage(), 500);
    }
  });
}

// ══════════════════════════════════════════════════════════
//  Tab switching
// ══════════════════════════════════════════════════════════

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tabName)
  );
  document.querySelectorAll('.tab-content').forEach(c =>
    c.classList.toggle('active', c.id === `tab-${tabName}`)
  );
}

// ══════════════════════════════════════════════════════════
//  Products tab
// ══════════════════════════════════════════════════════════

async function detectCurrentPage() {
  const trackSection = document.getElementById('track-section');
  const preview = document.getElementById('current-product-preview');
  const btnTrack = document.getElementById('btn-track');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !detectLuluDomain(tab.url).isLulu || !tab.url.includes('/p/')) {
      trackSection.classList.add('hidden');
      return;
    }

    let productData;
    try {
      productData = await sendMessageToTab(tab.id, { action: 'extractProductData' });
    } catch (e) {
      trackSection.classList.add('hidden');
      return;
    }

    if (!productData || !productData.name) {
      trackSection.classList.add('hidden');
      return;
    }

    trackSection.classList.remove('hidden');
    const priceText = productData.currentPrice ? ` · $${productData.currentPrice}` : '';
    const regionTag = productData.region ? `<span class="region-tag">${escapeHtml(productData.region)}</span> ` : '';
    preview.innerHTML = `
      <strong>${escapeHtml(productData.name)}</strong><br>
      <span class="preview-meta">${regionTag}${escapeHtml(productData.color)} · Size: ${escapeHtml(productData.size)}${priceText}</span>
    `;

    const existingProducts = await getProducts();
    const alreadyTracked = existingProducts.some(p =>
      p.productId === productData.productId && p.color === productData.color && p.size === productData.size
    );

    const newBtn = btnTrack.cloneNode(true);
    btnTrack.replaceWith(newBtn);

    if (alreadyTracked) {
      newBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg> Already Tracking`;
      newBtn.disabled = true;
    } else {
      newBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg> Track This Product`;
      newBtn.addEventListener('click', () => handleTrack(productData, newBtn));
    }
  } catch (err) {
    console.error('Error detecting page:', err);
    trackSection.classList.add('hidden');
  }
}

async function renderProductList() {
  const listEl = document.getElementById('product-list');
  const emptyState = document.getElementById('empty-state');
  const products = await getProducts();

  listEl.querySelectorAll('.product-card').forEach(el => el.remove());

  if (products.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  products.forEach((product, index) => {
    const card = document.createElement('div');
    card.className = 'product-card';

    const hasRecentChange = product.lastChange &&
      (Date.now() - product.lastChange.timestamp) < 2 * 60 * 60 * 1000;
    if (hasRecentChange) card.classList.add('has-change');

    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete') || e.target.closest('.toggle')) return;
      chrome.tabs.create({ url: product.url });
    });

    let thumbHtml = product.image
      ? `<img class="product-thumb" src="${escapeHtml(product.image)}" alt="">`
      : `<div class="product-thumb-placeholder">🏷</div>`;

    let priceHtml = '';
    if (product.currentPrice) {
      if (product.onSale && product.originalPrice) {
        priceHtml = `<span class="product-price sale">$${product.currentPrice} <span class="original">$${product.originalPrice}</span></span>`;
      } else {
        priceHtml = `<span class="product-price">$${product.currentPrice}</span>`;
      }
    }

    const statusLabel = getStatusLabel(product.stockStatus);
    const statusClass = product.stockStatus || 'in_stock';
    const saleBadgeHtml = product.onSale ? '<span class="status-badge on_sale">On Sale</span>' : '';
    const changeHtml = hasRecentChange ? '<span class="change-dot" title="Recent change detected"></span>' : '';
    const markdownHtml = product.markdownUrl
      ? `<a class="markdown-link" href="${escapeHtml(product.markdownUrl)}" title="View on We Made Too Much">🏷️ View discount</a>`
      : '';

    card.innerHTML = `
      ${thumbHtml}
      <div class="product-info">
        <div class="product-name" title="${escapeHtml(product.name)}">
          ${changeHtml}${escapeHtml(product.name)}
        </div>
        <div class="product-meta">${product.region ? `<span class="region-tag">${escapeHtml(product.region)}</span> ` : ''}${escapeHtml(product.color)} · ${escapeHtml(product.size)}</div>
        <div class="product-status-row">
          <span class="status-badge ${statusClass}">${statusLabel}</span>
          ${saleBadgeHtml}
          ${priceHtml}
          ${markdownHtml}
        </div>
        <div class="product-settings">
          <label class="toggle" title="Track new colors for this product line">
            <input type="checkbox" ${product.trackNewColors ? 'checked' : ''} data-index="${index}">
            <span class="slider"></span>
          </label>
          <span class="toggle-label">New colors</span>
        </div>
      </div>
      <button class="btn-delete" data-index="${index}" title="Stop tracking">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;

    const mdLink = card.querySelector('.markdown-link');
    if (mdLink) {
      mdLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.tabs.create({ url: mdLink.href });
      });
    }

    card.querySelector('.btn-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(e.currentTarget.dataset.index);
      await chrome.runtime.sendMessage({ action: 'removeProduct', index: idx });
      showMessage('Product removed.', 'info');
      await renderProductList();
    });

    const toggle = card.querySelector('.toggle input');
    toggle.addEventListener('change', async (e) => {
      e.stopPropagation();
      const idx = parseInt(e.target.dataset.index);
      const prods = await getProducts();
      if (prods[idx]) {
        prods[idx].trackNewColors = e.target.checked;
        await chrome.storage.local.set({ trackedProducts: prods });
      }
    });

    listEl.appendChild(card);
  });

  updateFooter(products);
}

async function handleTrack(productData, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = 'Adding...';
  const result = await chrome.runtime.sendMessage({ action: 'addProduct', product: productData });
  if (result.success) {
    showMessage('Product is now being tracked!', 'success');
    btnEl.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg> Already Tracking`;
    await renderProductList();
  } else {
    showMessage(result.reason || 'Failed to add product.', 'error');
    btnEl.disabled = false;
    btnEl.textContent = 'Track This Product';
  }
}

async function handleRefresh() {
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('spinning');
  showMessage('Checking all products...', 'info');
  await chrome.runtime.sendMessage({ action: 'checkNow' });
  btn.classList.remove('spinning');
  showMessage('All products checked!', 'success');
  await renderProductList();
  setTimeout(() => document.getElementById('message').classList.add('hidden'), 2000);
}

// ══════════════════════════════════════════════════════════
//  Collections tab
// ══════════════════════════════════════════════════════════

/**
 * Parse a Lululemon collection URL (both US and international formats).
 *
 * US format:
 *   https://shop.lululemon.com/c/men-clothes/n1{code1}z{code2}?Ns=sort
 *   → filterCodes: ['oxc7', 'peaw'], sort via Ns param
 *
 * International format:
 *   https://www.lululemon.com.hk/en-hk/c/men?prefn1=collection&prefv1=Metal+Vent+Tech|Pace+Breaker&srule=HK-C-N-
 *   → filterNames: ['Metal Vent Tech', 'Pace Breaker'], sort via srule param
 */
function parseCollectionUrl(url) {
  try {
    const u = new URL(url);
    const { isLulu, isUS, region } = detectLuluDomain(url);
    if (!isLulu) return null;

    // Must contain /c/ in the path
    if (!u.pathname.includes('/c/')) return null;

    if (isUS) {
      return parseUSCollectionUrl(u, url);
    } else {
      return parseIntlCollectionUrl(u, url, region);
    }
  } catch {
    return null;
  }
}

function parseUSCollectionUrl(u, fullUrl) {
  // Match /c/{category}/n1{codes}
  const pathMatch = u.pathname.match(/^(\/c\/[^/]+\/)n1(.+)$/);
  if (pathMatch) {
    return {
      format: 'us',
      basePath: pathMatch[1],
      filterCodes: pathMatch[2].split('z').filter(Boolean),
      filterNames: [], // resolved via FILTER_NAMES lookup
      sort: u.searchParams.get('Ns') || '',
      sortType: 'Ns',
      fullUrl,
      extraParams: {},
    };
  }
  // /c/{category} without filter codes
  const simpleMatch = u.pathname.match(/^(\/c\/[^/]+)\/?$/);
  if (simpleMatch) {
    return {
      format: 'us',
      basePath: simpleMatch[1] + '/',
      filterCodes: [],
      filterNames: [],
      sort: u.searchParams.get('Ns') || '',
      sortType: 'Ns',
      fullUrl,
      extraParams: {},
    };
  }
  return null;
}

function parseIntlCollectionUrl(u, fullUrl, region) {
  // Extract the category path: /en-hk/c/men  or  /en-au/c/men  or  /zh-tw/c/men
  const pathMatch = u.pathname.match(/^(\/[^/]+\/c\/[^/?]+)\/?$/);
  const basePath = pathMatch ? pathMatch[1] : u.pathname;

  // Filters: prefn1=collection, prefv1=A|B|C  (pipe-separated, URL-encoded)
  const prefv1 = u.searchParams.get('prefv1') || '';
  const filterNames = prefv1
    ? prefv1.split('|').map(f => f.trim()).filter(Boolean)
    : [];

  // Sort rule
  const srule = u.searchParams.get('srule') || '';

  // Preserve other params (like pmid, prefn1, etc.)
  const extraParams = {};
  for (const [key, val] of u.searchParams.entries()) {
    if (!['prefv1', 'srule'].includes(key)) {
      extraParams[key] = val;
    }
  }

  return {
    format: 'intl',
    region,
    basePath,
    filterCodes: [], // international doesn't use codes
    filterNames,
    sort: srule,
    sortType: 'srule',
    fullUrl,
    extraParams,
  };
}

/**
 * Rebuild a collection URL from parsed parts.
 */
function buildCollectionUrl(parsed, activeFilters) {
  if (parsed.format === 'us') {
    return buildUSCollectionUrl(parsed, activeFilters);
  } else {
    return buildIntlCollectionUrl(parsed, activeFilters);
  }
}

function buildUSCollectionUrl(parsed, activeCodes) {
  let url = `https://shop.lululemon.com${parsed.basePath}`;
  if (activeCodes.length > 0) {
    url += `n1${activeCodes.join('z')}`;
  }
  if (parsed.sort) url += `?Ns=${encodeURIComponent(parsed.sort)}`;
  return url;
}

function buildIntlCollectionUrl(parsed, activeNames) {
  const u = new URL(parsed.fullUrl || parsed.url);

  // Rebuild with only active filters
  if (activeNames.length > 0) {
    u.searchParams.set('prefv1', activeNames.join('|'));
  } else {
    u.searchParams.delete('prefv1');
    u.searchParams.delete('prefn1');
  }

  // Update srule if changed
  if (parsed.sort) {
    u.searchParams.set('srule', parsed.sort);
  } else {
    u.searchParams.delete('srule');
  }

  // searchParams.set() encodes spaces as '+' which is what Lululemon expects
  return u.toString();
}

/**
 * Get a display label for a filter — uses FILTER_NAMES for US codes,
 * returns the name directly for international format.
 */
function getFilterDisplayLabel(code, format) {
  if (format === 'us') return FILTER_NAMES[code] || code;
  return code; // international already stores human-readable names
}

/**
 * Get the available sort options for a parsed collection.
 */
function getSortOptions(parsed) {
  if (parsed.format === 'us') return SORT_OPTIONS_US;
  if (parsed.region === 'hk') return SORT_OPTIONS_HK;
  if (parsed.region === 'au') return SORT_OPTIONS_AU;
  // Fallback: combine known options
  const opts = { ...SORT_OPTIONS_HK, ...SORT_OPTIONS_AU };
  if (parsed.sort && !opts[parsed.sort]) {
    opts[parsed.sort] = parsed.sort; // show raw value if unknown
  }
  return opts;
}

/**
 * Detect if the current tab is a Lululemon collection page (/c/).
 * If so, show a "Save This Collection" button.
 */
async function detectCollectionPage() {
  const section = document.getElementById('collection-save-section');
  const preview = document.getElementById('collection-page-preview');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) { section.classList.add('hidden'); return; }

    const { isLulu } = detectLuluDomain(tab.url);
    if (!isLulu || !tab.url.includes('/c/')) {
      section.classList.add('hidden');
      return;
    }

    const parsed = parseCollectionUrl(tab.url);
    if (!parsed) {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');

    // Derive a name from the tab title
    const pageTitle = tab.title
      ?.replace(/\s*\|.*$/, '')
      .replace(/lululemon/i, '')
      .trim() || 'Collection';

    // Get filter list based on format
    const filters = parsed.format === 'us'
      ? parsed.filterCodes.map(c => FILTER_NAMES[c] || c)
      : parsed.filterNames;
    const filterText = filters.length > 0
      ? filters.join(', ')
      : 'No filters';

    const sortOpts = getSortOptions(parsed);
    const sortLabel = sortOpts[parsed.sort] || parsed.sort || 'Default';
    const regionTag = parsed.region && parsed.region !== 'us'
      ? ` <span class="region-tag">${parsed.region.toUpperCase()}</span>`
      : '';

    preview.innerHTML = `
      <strong>${escapeHtml(pageTitle)}${regionTag}</strong><br>
      <span class="preview-meta">${escapeHtml(filterText)} · Sort: ${escapeHtml(sortLabel)}</span>
    `;

    // Check if already saved
    const collections = await getCollections();
    const alreadySaved = collections.some(c => c.url === tab.url);

    const btn = document.getElementById('btn-save-collection');
    if (alreadySaved) {
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Already Saved`;
      btn.disabled = true;
    } else {
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Save This Collection`;
      btn.disabled = false;
      btn.dataset.url = tab.url;
      btn.dataset.name = pageTitle;
    }
  } catch (err) {
    console.error('Error detecting collection page:', err);
    section.classList.add('hidden');
  }
}

async function handleSaveCollectionPage() {
  const btn = document.getElementById('btn-save-collection');
  const url = btn.dataset.url;
  const name = btn.dataset.name || 'My Collection';
  if (!url) return;

  await saveCollection(name, url);
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Saved!`;
  btn.disabled = true;
  await renderCollections();
}

async function handleAddCollection() {
  const nameInput = document.getElementById('collection-name-input');
  const urlInput = document.getElementById('collection-url-input');
  const url = urlInput.value.trim();
  const name = nameInput.value.trim();

  if (!url) {
    showMessage('Please enter a URL.', 'error');
    return;
  }
  const { isLulu } = detectLuluDomain(url);
  if (!isLulu || !url.includes('/c/')) {
    showMessage('Must be a Lululemon collection page (/c/).', 'error');
    return;
  }

  await saveCollection(name || 'My Collection', url);
  nameInput.value = '';
  urlInput.value = '';
  showMessage('Collection saved!', 'success');
  setTimeout(() => document.getElementById('message').classList.add('hidden'), 1500);
  await renderCollections();
}

async function saveCollection(name, url) {
  const collections = await getCollections();
  if (collections.some(c => c.url === url)) return;

  const parsed = parseCollectionUrl(url);
  collections.push({
    name,
    url,
    format: parsed?.format || 'us',
    region: parsed?.region || 'us',
    basePath: parsed?.basePath || '',
    filterCodes: parsed?.filterCodes || [],
    filterNames: parsed?.filterNames || [],
    sort: parsed?.sort || '',
    sortType: parsed?.sortType || 'Ns',
    extraParams: parsed?.extraParams || {},
    addedAt: Date.now(),
  });
  await chrome.storage.local.set({ savedCollections: collections });
}

async function renderCollections() {
  const listEl = document.getElementById('collection-list');
  const emptyState = document.getElementById('collection-empty');
  const collections = await getCollections();

  listEl.querySelectorAll('.collection-card').forEach(el => el.remove());

  if (collections.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  collections.forEach((col, index) => {
    const card = document.createElement('div');
    card.className = 'collection-card';
    card.dataset.format = col.format || 'us';

    // Determine filters to display: use codes for US, names for intl
    const isUS = (col.format || 'us') === 'us';
    const filterItems = isUS
      ? (col.filterCodes || [])
      : (col.filterNames || []);

    // Filter chips — clickable to toggle on/off
    const chipsHtml = filterItems.map(item => {
      const label = isUS ? (FILTER_NAMES[item] || item) : item;
      return `<span class="filter-chip active" data-code="${escapeHtml(item)}" title="${escapeHtml(item)}">${escapeHtml(label)}</span>`;
    }).join('');

    // Sort dropdown — different options per format
    const sortOpts = getSortOptions(col);
    const sortOptionsHtml = Object.entries(sortOpts).map(([val, label]) =>
      `<option value="${escapeHtml(val)}" ${col.sort === val ? 'selected' : ''}>${escapeHtml(label)}</option>`
    ).join('');

    // Region badge
    const regionBadge = col.region && col.region !== 'us'
      ? `<span class="region-tag">${col.region.toUpperCase()}</span>`
      : '';

    card.innerHTML = `
      <div class="collection-main">
        <div class="collection-name-row">
          <span class="collection-name">${escapeHtml(col.name)} ${regionBadge}</span>
          <div class="collection-actions">
            <button class="icon-btn-sm btn-edit" data-index="${index}" title="Edit name">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button class="icon-btn-sm btn-delete-col" data-index="${index}" title="Delete">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="collection-meta-row">
          <select class="sort-select" data-index="${index}">${sortOptionsHtml}</select>
          <button class="btn-open" title="Open in new tab">Open →</button>
        </div>
        ${filterItems.length > 0 ? `<div class="collection-chips">${chipsHtml}</div>` : ''}
      </div>
    `;

    // Open button — builds URL from active filters + selected sort
    card.querySelector('.btn-open').addEventListener('click', () => {
      const activeFilters = getActiveFilters(card);
      const sort = card.querySelector('.sort-select').value;

      // Build a parsed-like object to pass to buildCollectionUrl
      const buildData = { ...col, sort };
      const url = buildCollectionUrl(buildData, activeFilters);
      chrome.tabs.create({ url });
    });

    // Sort change → update stored sort
    card.querySelector('.sort-select').addEventListener('change', async (e) => {
      const idx = parseInt(e.target.dataset.index);
      const allCollections = await getCollections();
      allCollections[idx].sort = e.target.value;
      // Rebuild the full URL with new sort
      const activeFilters = isUS
        ? allCollections[idx].filterCodes
        : allCollections[idx].filterNames;
      allCollections[idx].url = buildCollectionUrl(allCollections[idx], activeFilters);
      await chrome.storage.local.set({ savedCollections: allCollections });
    });

    // Filter chips — click to toggle active/disabled
    card.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        chip.classList.toggle('disabled');
      });
    });

    // Edit name
    card.querySelector('.btn-edit').addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(e.currentTarget.dataset.index);
      const nameEl = card.querySelector('.collection-name');
      const currentName = collections[idx].name;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'edit-name-input';
      input.value = currentName;
      input.maxLength = 60;
      nameEl.replaceWith(input);
      input.focus();
      input.select();

      const save = async () => {
        const newName = input.value.trim() || currentName;
        collections[idx].name = newName;
        await chrome.storage.local.set({ savedCollections: collections });
        await renderCollections();
      };

      input.addEventListener('blur', save);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') save();
        if (ev.key === 'Escape') renderCollections();
      });
    });

    // Delete
    card.querySelector('.btn-delete-col').addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(e.currentTarget.dataset.index);
      collections.splice(idx, 1);
      await chrome.storage.local.set({ savedCollections: collections });
      await renderCollections();
    });

    listEl.appendChild(card);
  });
}

/**
 * Read currently active (non-disabled) filter chips from a card element.
 */
function getActiveFilters(cardEl) {
  const filters = [];
  cardEl.querySelectorAll('.filter-chip.active').forEach(c => {
    filters.push(c.dataset.code);
  });
  return filters;
}

// ══════════════════════════════════════════════════════════
//  Shared helpers
// ══════════════════════════════════════════════════════════

function getProducts() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getProducts' }, (p) => resolve(p || []));
  });
}

function getCollections() {
  return new Promise((resolve) => {
    chrome.storage.local.get('savedCollections', (d) => resolve(d.savedCollections || []));
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(response);
    });
  });
}

function showMessage(text, type = 'info') {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = `message ${type}`;
  el.classList.remove('hidden');
}

function getStatusLabel(status) {
  switch (status) {
    case 'low_stock': return '⚠ Low Stock';
    case 'sold_out': return 'Sold Out';
    case 'in_stock':
    default: return 'In Stock';
  }
}

function updateFooter(products) {
  const el = document.getElementById('last-check');
  if (products.length === 0) { el.textContent = ''; return; }
  const latest = Math.max(...products.map(p => p.lastChecked || 0));
  if (latest > 0) el.textContent = `Last check: ${timeAgo(latest)}`;
}

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
