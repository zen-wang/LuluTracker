/**
 * Content Script: Runs on Lululemon product pages.
 *
 * Extraction strategy (ordered by reliability):
 *   1. __NEXT_DATA__  — Next.js JSON with full product catalog
 *   2. DOM selectors  — Live state (selected color/size, urgency messages)
 *   3. URL parameters — color code and size as fallback
 *
 * IMPROVEMENT: Uses MutationObserver to detect SPA navigation.
 *   Lululemon is a Next.js SPA — when users click between products or
 *   switch colors, the URL changes without a full page reload. Without
 *   MutationObserver, our content script only runs once on initial load
 *   and would show stale data when the user navigates to a different
 *   product within the same tab.
 *
 *   Learned from: SQDC extension's check-inventory.js, which watches
 *   the price element via MutationObserver to detect product changes.
 *
 * Verified against: Metal Vent Tech Short-Sleeve Shirt (Feb 2026)
 */

(() => {
  // Track the current URL to detect SPA navigation
  let lastUrl = window.location.href;

  // ═══════════════════════════════════════════════════════
  //  Site detection
  // ═══════════════════════════════════════════════════════

  function isUSSite() {
    return window.location.hostname === 'shop.lululemon.com';
  }

  function isIntlSite() {
    const host = window.location.hostname;
    return host.includes('lululemon.com') && host !== 'shop.lululemon.com';
  }

  // ═══════════════════════════════════════════════════════
  //  __NEXT_DATA__ extraction (US site — most reliable)
  // ═══════════════════════════════════════════════════════

  function getNextData() {
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      return JSON.parse(el.textContent);
    } catch (e) {
      console.warn('[LuluTracker] Failed to parse __NEXT_DATA__:', e);
      return null;
    }
  }

  function getProductQueryData(nextData) {
    if (!nextData) return null;
    try {
      const queries = nextData.props.pageProps.dehydratedState.queries;
      for (const q of queries) {
        const data = q?.state?.data;
        if (data?.productSummary && data?.skus) return data;
      }
    } catch (e) { /* structure mismatch */ }
    return null;
  }

  // ═══════════════════════════════════════════════════════
  //  DOM selectors (for live user-selected state)
  //  Works for both US (Next.js) and Intl (SFCC) sites
  // ═══════════════════════════════════════════════════════

  function getProductNameFromDOM() {
    // US: <h1 class="product-title"><div>Name</div></h1>
    const h1 = document.querySelector('h1[class*="product-title"]');
    if (h1) {
      const inner = h1.querySelector('div');
      return (inner || h1).textContent.trim();
    }
    // SFCC: <h1 class="product-name">Name</h1>
    const sfccH1 = document.querySelector('h1.product-name');
    if (sfccH1) return sfccH1.textContent.trim();

    const anyH1 = document.querySelector('h1');
    return anyH1 ? anyH1.textContent.trim() : null;
  }

  function getSelectedColorFromDOM() {
    // US: <span class="color-labels_colorNameValue__...">Color Name</span>
    const usEl = document.querySelector('[class*="colorNameValue"]');
    if (usEl) return usEl.textContent.trim();

    // US fallback
    const details = document.querySelector('[data-testid="colorDetails"]');
    if (details) {
      const spans = details.querySelectorAll('span');
      for (const span of [...spans].reverse()) {
        const text = span.textContent.trim();
        if (text && !text.toLowerCase().includes('colour') && !text.toLowerCase().includes('color') && !text.toLowerCase().includes('trending')) {
          return text;
        }
      }
    }

    // SFCC: selected swatch button has data-color-title
    const sfccSwatch = document.querySelector('button.selected[data-color-title]') ||
                        document.querySelector('button[aria-pressed="true"][data-color-title]');
    if (sfccSwatch) return sfccSwatch.getAttribute('data-color-title');

    return null;
  }

  function getSelectedColorCodeFromDOM() {
    // SFCC: selected swatch has data-attr-value with color code
    const sfccSwatch = document.querySelector('button.selected[data-attr-value][data-color-title]') ||
                        document.querySelector('button[aria-pressed="true"][data-attr-value][data-color-title]');
    if (sfccSwatch) return sfccSwatch.getAttribute('data-attr-value');
    return null;
  }

  function getSelectedSizeFromDOM() {
    // US: <div data-testid="button-tile" aria-checked="true"><span class="sizeTile">M</span></div>
    const sizeContainer = document.querySelector('[data-testid="size-selector"]');
    if (sizeContainer) {
      const tiles = sizeContainer.querySelectorAll('[data-testid="button-tile"]');
      for (const tile of tiles) {
        if (tile.getAttribute('aria-checked') === 'true') {
          const sizeSpan = tile.querySelector('[class*="sizeTile"], [data-lll-pl="size-tile"]');
          return sizeSpan ? sizeSpan.textContent.trim() : tile.textContent.trim();
        }
      }
    }

    // SFCC: various formats across regions:
    //   HK English: "Size: US M"
    //   HK Chinese: "尺寸: US XXL"
    //   AU:         "Size : US  (AU) M"
    const sfccSize = document.querySelector('.selected-size-name');
    if (sfccSize) {
      const text = sfccSize.textContent.trim();
      const match = text.match(/(?:Size|尺寸)\s*:\s*(.+)/i);
      if (match) {
        let raw = match[1].trim();
        raw = raw.replace(/\(.*?\)/g, ''); // remove parenthetical like (AU), (AU M)
        raw = raw.replace(/\bUS\b/g, '');  // remove "US" prefix
        raw = raw.trim();
        if (raw) return raw;
      }
    }

    // SFCC fallback: checked radio in size selector
    const checkedRadio = document.querySelector('input[name="select-size-US"][checked], input[name="select-size"][checked]');
    if (checkedRadio) {
      return checkedRadio.getAttribute('data-attr-value') || null;
    }

    return null;
  }

  function getPriceFromDOM() {
    // US: <span data-lll-pl="price">
    // Intl: may use different selectors but often similar structure
    const priceEl = document.querySelector('[data-lll-pl="price"]') ||
                    document.querySelector('.prices .price') ||
                    document.querySelector('[class*="price-sales"]') ||
                    document.querySelector('.product-price');
    if (!priceEl) return { currentPrice: null, originalPrice: null, onSale: false };

    const allText = priceEl.textContent.trim();
    // Match prices with various currency symbols: $, HK$, A$, NT$, or just numbers
    const prices = allText.match(/(?:(?:HK|A|NZ|CA|NT)?\$|¥|£|€)[\d,.]+/g) ||
                   allText.match(/[\d,.]+/g);

    if (!prices || prices.length === 0) {
      return { currentPrice: null, originalPrice: null, onSale: false };
    }

    const parsed = prices.map(p => parseFloat(p.replace(/[^0-9.]/g, ''))).filter(n => n > 0);

    if (parsed.length >= 2) {
      const sorted = [...parsed].sort((a, b) => a - b);
      return { currentPrice: sorted[0], originalPrice: sorted[1], onSale: true };
    }

    return { currentPrice: parsed[0] || null, originalPrice: null, onSale: false };
  }

  function getStockStatusFromDOM() {
    // ── US site: check visible text and specific elements ──
    if (isUSSite()) {
      const bodyText = document.body.innerText.toLowerCase();

      if (bodyText.includes('hurry, only a few left') ||
          bodyText.includes('only a few left') ||
          bodyText.includes('almost gone') ||
          bodyText.includes('low stock')) {
        return 'low_stock';
      }

      const atbBtn = document.querySelector('[class*="addToBag"], [class*="add-to-bag"]');
      if (atbBtn) {
        const btnText = atbBtn.textContent.toLowerCase();
        if (btnText.includes('sold out') || btnText.includes('join waitlist') || btnText.includes('out of stock')) {
          return 'sold_out';
        }
      }

      const sizeContainer = document.querySelector('[data-testid="size-selector"]');
      if (sizeContainer) {
        const selected = sizeContainer.querySelector('[aria-checked="true"]');
        if (selected) {
          const classes = selected.classList.toString();
          if (classes.includes('unavailable') || classes.includes('soldOut') || classes.includes('disabled') ||
              selected.getAttribute('aria-disabled') === 'true') {
            return 'sold_out';
          }
        }
      }

      return 'in_stock';
    }

    // ── SFCC intl site: check add-to-cart button and JSON-LD ──
    // Don't use body text search — SFCC has hidden template strings
    // like "SizeSoldOut" in aria-labels and modals that cause false positives.

    const sfccAtb = document.querySelector('.add-to-cart, .add-to-cart-global, button[data-action="addToCart"]');
    if (sfccAtb) {
      if (sfccAtb.disabled || sfccAtb.classList.contains('disabled')) {
        return 'sold_out';
      }
      const btnText = sfccAtb.textContent.toLowerCase();
      if (btnText.includes('sold out') || btnText.includes('out of stock') || btnText.includes('join waitlist') ||
          btnText.includes('已售罄') || btnText.includes('缺貨')) {
        return 'sold_out';
      }
    }

    // Check visible low stock warning (display:block means real, display:none means template)
    const stockMsg = document.querySelector('.stock-avail-msg');
    if (stockMsg) {
      const style = window.getComputedStyle(stockMsg);
      if (style.display !== 'none') {
        // Visible low stock warning — could be "Only a few left!" or "只剩幾件！"
        return 'low_stock';
      }
    }

    // Check JSON-LD for the selected variant's availability
    // (this is the most reliable source for SFCC)
    const pgData = getProductGroupData();
    if (pgData?.hasVariant) {
      const colorName = getSelectedColorFromDOM();
      const size = getSelectedSizeFromDOM();

      if (colorName && size && size !== 'Not selected') {
        const match = pgData.hasVariant.find(v =>
          v.color === colorName && v.size === size
        );
        if (match) {
          const avail = match.offers?.availability || '';
          if (avail.includes('OutOfStock')) return 'sold_out';
        }
      }
    }

    return 'in_stock';
  }

  // ═══════════════════════════════════════════════════════
  //  URL parameter extraction (fallback)
  // ═══════════════════════════════════════════════════════

  function getFromURL() {
    const params = new URLSearchParams(window.location.search);

    // US format: ?color=69702&sz=M
    let colorCode = params.get('color') || null;
    let size = params.get('sz') || null;

    // International (SFCC) format: ?dwvar_prod11710026_color=069299
    if (!colorCode) {
      for (const [key, val] of params.entries()) {
        if (key.startsWith('dwvar_') && key.endsWith('_color')) {
          colorCode = val;
        }
        if (key.startsWith('dwvar_') && key.endsWith('_size')) {
          size = val;
        }
      }
    }

    return { colorCode, size };
  }

  // ═══════════════════════════════════════════════════════
  //  JSON-LD ProductGroup extraction (Intl SFCC sites)
  //
  //  International sites embed a JSON-LD ProductGroup with
  //  ALL variants including color, size, price, availability.
  //  This is the primary data source for SFCC sites.
  // ═══════════════════════════════════════════════════════

  function getProductGroupData() {
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        const data = JSON.parse(script.textContent);
        if (data['@type'] === 'ProductGroup') return data;
      }
    } catch (e) {
      console.warn('[LuluTracker] Failed to parse JSON-LD:', e);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════
  //  Main extraction — combines all sources
  // ═══════════════════════════════════════════════════════

  function extractProductData() {
    if (!window.location.pathname.includes('/p/')) return null;

    if (isUSSite()) {
      return extractUSProductData();
    } else {
      return extractIntlProductData();
    }
  }

  /** US site extraction — __NEXT_DATA__ + DOM */
  function extractUSProductData() {
    const nextData = getNextData();
    const queryData = getProductQueryData(nextData);
    const urlParams = getFromURL();

    const name =
      queryData?.productSummary?.displayName ||
      getProductNameFromDOM() ||
      document.title.split('|')[0]?.trim() ||
      'Unknown Product';

    let color = getSelectedColorFromDOM();
    if (!color && urlParams.colorCode && queryData?.colors) {
      const match = queryData.colors.find(c => c.code === urlParams.colorCode);
      if (match) color = match.name;
    }
    color = color || 'Unknown Color';

    let size = getSelectedSizeFromDOM();
    if (!size && urlParams.size) size = urlParams.size;
    size = size || 'Not selected';

    let { currentPrice, originalPrice, onSale } = getPriceFromDOM();

    if (queryData?.skus && urlParams.colorCode) {
      const matchingSku = queryData.skus.find(s => {
        const colorMatch = s.color?.code === urlParams.colorCode;
        const sizeMatch = !size || size === 'Not selected' || s.size === size;
        return colorMatch && sizeMatch;
      });

      if (matchingSku?.price) {
        const skuListPrice = parseFloat(matchingSku.price.listPrice);
        const skuSalePrice = matchingSku.price.salePrice ? parseFloat(matchingSku.price.salePrice) : null;

        if (skuSalePrice && skuListPrice && skuSalePrice < skuListPrice) {
          currentPrice = skuSalePrice;
          originalPrice = skuListPrice;
          onSale = true;
        } else if (!currentPrice) {
          currentPrice = skuListPrice;
        }
      }
    }

    let stockStatus = getStockStatusFromDOM();
    if (queryData?.productSummary?.isSoldOut) stockStatus = 'sold_out';

    const ogImage = document.querySelector('meta[property="og:image"]');
    const carouselImg = document.querySelector('[data-testid="product-media-carousel"] img');
    const image = ogImage?.content || carouselImg?.src || null;

    const productLine = queryData?.productSummary?.displayName || name;
    const productId = queryData?.productSummary?.productId ||
                      window.location.pathname.match(/prod\d+/)?.[0] || null;

    const availableColors = queryData?.colors?.map(c => ({
      code: c.code,
      name: c.name,
    })) || [];

    return {
      name, color, size, currentPrice, originalPrice, onSale,
      stockStatus, url: window.location.href, image,
      productLine, productId, availableColors,
      region: 'US',
      lastChecked: Date.now(),
    };
  }

  /** International (SFCC) site extraction — JSON-LD ProductGroup + DOM */
  function extractIntlProductData() {
    const pgData = getProductGroupData();
    const urlParams = getFromURL();

    const name = pgData?.name ||
      getProductNameFromDOM() ||
      document.title.split('|')[0]?.trim() ||
      'Unknown Product';

    // Color: DOM selected swatch → URL param → first variant
    let color = getSelectedColorFromDOM();
    let colorCode = getSelectedColorCodeFromDOM() || urlParams.colorCode;

    if (!color && pgData?.hasVariant) {
      // Try to find color name from first variant (fallback)
      const firstVariant = pgData.hasVariant[0];
      if (firstVariant?.color) color = firstVariant.color;
    }
    color = color || 'Unknown Color';

    // Size from DOM
    let size = getSelectedSizeFromDOM();
    if (!size && urlParams.size) size = urlParams.size;
    size = size || 'Not selected';

    // Price/stock from JSON-LD variants matching this color+size
    let { currentPrice, originalPrice, onSale } = getPriceFromDOM();
    let stockStatus = getStockStatusFromDOM();

    if (pgData?.hasVariant && colorCode) {
      // SFCC variant URLs use SKU IDs, not color codes.
      // Match by color name instead.
      const colorVariants = pgData.hasVariant.filter(v => v.color === color);

      if (colorVariants.length > 0) {
        // Price from first matching variant
        const first = colorVariants[0];
        if (first.offers?.price && !currentPrice) {
          currentPrice = parseFloat(first.offers.price);
        }

        // Find exact size match for stock status
        if (size && size !== 'Not selected') {
          const sizeMatch = colorVariants.find(v => v.size === size);
          if (sizeMatch) {
            const avail = sizeMatch.offers?.availability || '';
            if (avail.includes('OutOfStock')) stockStatus = 'sold_out';
          }
        }
      }
    }

    // Image
    const ogImage = document.querySelector('meta[property="og:image"]');
    const pdpImg = document.querySelector('.product-detail img.pdp-image, .product-detail img[class*="product"]');
    const image = ogImage?.content || pdpImg?.src || null;

    // Product ID
    const pidEl = document.querySelector('[data-pid]');
    const productId = pgData?.productGroupID ||
                      pidEl?.getAttribute('data-pid') ||
                      window.location.pathname.match(/prod\d+/)?.[0] || null;

    // Available colors from JSON-LD (deduplicated)
    const colorMap = new Map();
    if (pgData?.hasVariant) {
      for (const v of pgData.hasVariant) {
        if (v.color && !colorMap.has(v.color)) {
          colorMap.set(v.color, {
            code: v.color, // SFCC uses names, not codes
            name: v.color,
          });
        }
      }
    }
    // Fallback: get from DOM swatches
    if (colorMap.size === 0) {
      document.querySelectorAll('button[data-attr-value][data-color-title]').forEach(btn => {
        const code = btn.getAttribute('data-attr-value');
        const title = btn.getAttribute('data-color-title');
        if (code && title) colorMap.set(title, { code, name: title });
      });
    }

    return {
      name, color, size, currentPrice, originalPrice, onSale,
      stockStatus, url: window.location.href, image,
      productLine: name, productId, availableColors: [...colorMap.values()],
      region: window.location.hostname.includes('.hk') ? 'HK' :
              window.location.hostname.includes('.au') ? 'AU' : 'INTL',
      lastChecked: Date.now(),
    };
  }

  // ═══════════════════════════════════════════════════════
  //  SPA navigation & color/size change detection
  //
  //  US (Next.js): URL changes on color/size switch
  //  HK/AU (SFCC): URL does NOT change — only DOM updates
  //
  //  We track both URL and selected color+size to detect
  //  any change, then notify the popup to refresh.
  // ═══════════════════════════════════════════════════════

  let lastSelectedColor = getSelectedColorFromDOM();
  let lastSelectedSize = getSelectedSizeFromDOM();

  function onProductChanged() {
    lastUrl = window.location.href;
    lastSelectedColor = getSelectedColorFromDOM();
    lastSelectedSize = getSelectedSizeFromDOM();
    chrome.runtime.sendMessage({ action: 'productPageChanged' }).catch(() => {});
  }

  function checkForChanges() {
    // URL changed (US site color/size switch, or page navigation)
    if (window.location.href !== lastUrl) {
      onProductChanged();
      return;
    }
    // DOM state changed (SFCC site color/size switch without URL change)
    const currentColor = getSelectedColorFromDOM();
    const currentSize = getSelectedSizeFromDOM();
    if (currentColor !== lastSelectedColor || currentSize !== lastSelectedSize) {
      onProductChanged();
    }
  }

  // Method 1: Watch <title> for page navigation
  const titleEl = document.querySelector('title');
  if (titleEl) {
    const titleObserver = new MutationObserver(checkForChanges);
    titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  // Method 2: Watch main content area for DOM changes
  const mainContent = document.querySelector('[data-testid="main-details"]') ||
                      document.querySelector('[data-testid="layout-children"]') ||
                      document.querySelector('.product-detail') ||
                      document.querySelector('main') ||
                      document.body;

  const contentObserver = new MutationObserver(checkForChanges);
  contentObserver.observe(mainContent, { childList: true, subtree: true });

  // Method 3: Listen for clicks on SFCC color swatches and size buttons
  if (isIntlSite()) {
    document.addEventListener('click', (e) => {
      const swatch = e.target.closest('button[data-color-title], button[data-attr-value]');
      if (swatch) {
        // Small delay for DOM to update after click
        setTimeout(checkForChanges, 300);
      }
    });
  }

  // Method 4: Poll as fallback
  setInterval(checkForChanges, 1500);

  // ═══════════════════════════════════════════════════════
  //  Message listener
  // ═══════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'extractProductData') {
      const data = extractProductData();
      sendResponse(data);
    }
    return true;
  });
})();
