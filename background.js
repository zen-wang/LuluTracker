/**
 * Background Service Worker
 *
 * IMPROVEMENTS over v1:
 *   1. Badge count — shows number of products with status changes on the
 *      extension icon (inspired by SQDC extension's badge approach)
 *   2. Better new-color detection — compares color arrays from __NEXT_DATA__
 *   3. Responds to 'productPageChanged' from content script MutationObserver
 */

const CHECK_INTERVAL_MINUTES = 60;
const ALARM_NAME = 'lululemon-check';

/**
 * Extract color code from a product URL (US or international format).
 * US:   ?color=69702
 * Intl: ?dwvar_prod11710026_color=069299
 */
function getColorCodeFromUrl(url) {
  try {
    const params = new URLSearchParams(new URL(url).search);
    // US format
    const usColor = params.get('color');
    if (usColor) return usColor;
    // International (SFCC dwvar_) format
    for (const [key, val] of params.entries()) {
      if (key.startsWith('dwvar_') && key.endsWith('_color')) return val;
    }
  } catch { /* ignore */ }
  return null;
}

// ── Initialization ─────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: CHECK_INTERVAL_MINUTES,
  });
  // Initialize badge
  updateBadge();
  console.log('[LuluTracker] Extension installed. Alarm set.');
});

chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: CHECK_INTERVAL_MINUTES,
    });
  }
});

// ── Alarm handler ──────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('[LuluTracker] Alarm fired. Checking all products...');
    await checkAllProducts();
  }
});

// ══════════════════════════════════════════════════════════
//  FEATURE 1: Badge count on extension icon
//
//  Shows the number of products that need attention:
//    - low_stock (⚠️ almost sold out)
//    - sold_out  (❌)
//    - onSale    (🏷️ deal available)
//
//  A red badge with "3" means 3 products have noteworthy
//  status. Empty badge = everything is normal / no alerts.
//
//  Inspired by SQDC extension: browser.browserAction.setBadgeText()
// ══════════════════════════════════════════════════════════

async function updateBadge() {
  const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');

  // Count products that need the user's attention
  const stockAlerts = trackedProducts.filter(p =>
    p.stockStatus === 'low_stock' || p.stockStatus === 'sold_out'
  ).length;
  const saleAlerts = trackedProducts.filter(p => p.onSale).length;
  const alertCount = stockAlerts + saleAlerts;

  if (alertCount > 0) {
    chrome.action.setBadgeText({ text: alertCount.toString() });
    // Red for stock issues (low/sold out), blue for sales only
    chrome.action.setBadgeBackgroundColor({
      color: stockAlerts > 0 ? '#d31334' : '#1565c0'
    });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ── Core: Check all tracked products ───────────────────────

async function checkAllProducts() {
  const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
  if (trackedProducts.length === 0) return;

  const updatedProducts = [];
  const pendingNotifications = [];

  // ── Deduplication ──
  // Cache fetched product data by URL base (without color/size params)
  // so we don't fetch the same page twice for Black M and White M
  const fetchCache = {};

  // Track which productIds already sent a "new color" notification
  // this cycle, so Black M and White M don't both notify
  const newColorNotifiedProductIds = new Set();

  for (const product of trackedProducts) {
    try {
      // Use cached fetch if we already checked this product page
      const baseUrl = product.url.split('?')[0];
      let newData;
      if (fetchCache[baseUrl]) {
        // Re-parse for this specific color/size from cached HTML
        newData = fetchCache[baseUrl];
      } else {
        newData = await fetchProductStatus(product);
        if (newData) fetchCache[baseUrl] = newData;
      }

      if (!newData) {
        updatedProducts.push(product);
        continue;
      }

      let changes = detectChanges(product, newData);

      // ── Deduplicate new_color notifications ──
      // If tracking Black M and White M of the same product (same productId),
      // only the first one sends the "new color" notification
      if (product.productId && newColorNotifiedProductIds.has(product.productId)) {
        changes = changes.filter(c => c.type !== 'new_color');
      }

      // Mark this productId as having sent new_color notifications
      if (changes.some(c => c.type === 'new_color') && product.productId) {
        newColorNotifiedProductIds.add(product.productId);
      }

      // ── Check for normal → discount transition ──
      let markdownTransition = null;
      const hasSoldOutChange = changes.some(c => c.type === 'status_change' && c.to === 'sold_out');

      if (!product.url.includes('-MD/') && !product.url.includes('.html') &&
          (hasSoldOutChange || product.trackNewColors)) {
        markdownTransition = await checkMarkdownTransition(product, newData);
        if (markdownTransition) {
          changes = changes.filter(c => !(c.type === 'status_change' && c.to === 'sold_out'));
          const notif = await sendNotification(product, markdownTransition.change);
          if (notif) {
            notif.url = markdownTransition.discountUrl;
            pendingNotifications.push(notif);
          }
        }
      }

      // Send remaining notifications
      for (const change of changes) {
        const notif = await sendNotification(product, change);
        if (notif) pendingNotifications.push(notif);
      }

      updatedProducts.push({
        ...product,
        currentPrice: newData.currentPrice !== null ? newData.currentPrice : product.currentPrice,
        originalPrice: newData.originalPrice !== null ? newData.originalPrice : product.originalPrice,
        onSale: newData.onSale,
        stockStatus: markdownTransition ? 'in_stock' : newData.stockStatus,
        availableColors: newData.availableColors.length > 0 ? newData.availableColors : product.availableColors,
        lastChecked: Date.now(),
        lastChange: (changes.length > 0 || markdownTransition) ? {
          type: markdownTransition ? 'moved_to_markdown' : changes[0]?.type,
          timestamp: Date.now(),
        } : product.lastChange,
        markdownUrl: markdownTransition ? markdownTransition.discountUrl : product.markdownUrl,
      });
    } catch (err) {
      console.error(`[LuluTracker] Error checking ${product.name}:`, err);
      updatedProducts.push(product);
    }
  }

  // Write all notification URL mappings at once — no race condition
  if (pendingNotifications.length > 0) {
    const { notificationMap = {} } = await chrome.storage.local.get('notificationMap');
    for (const notif of pendingNotifications) {
      notificationMap[notif.id] = notif.url;
    }
    await chrome.storage.local.set({ notificationMap });
  }

  await chrome.storage.local.set({ trackedProducts: updatedProducts });
  await updateBadge();
}

// ── Fetch & parse a product page ───────────────────────────

async function fetchProductStatus(product) {
  try {
    const response = await fetch(product.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      console.warn(`[LuluTracker] HTTP ${response.status} for ${product.url}`);
      return null;
    }

    const html = await response.text();
    return parseProductHtml(html, product);
  } catch (err) {
    console.error(`[LuluTracker] Fetch failed for ${product.url}:`, err);
    return null;
  }
}

/**
 * Parse fetched HTML — uses __NEXT_DATA__ for US, JSON-LD for SFCC.
 * Falls back to regex patterns.
 */
function parseProductHtml(html, product) {
  const result = {
    currentPrice: null,
    originalPrice: null,
    onSale: false,           // Pricing only: is there a sale price?
    stockStatus: 'in_stock', // Availability only: in_stock | low_stock | sold_out
    availableColors: [],
  };

  const isIntl = product.url.includes('.html') ||
                 product.url.includes('lululemon.com.hk') ||
                 product.url.includes('lululemon.com.au');

  // ── Strategy 1: Parse __NEXT_DATA__ (US site) ──
  const nextDataMatch = html.match(
    /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );

  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];

      let queryData = null;
      for (const q of queries) {
        const data = q?.state?.data;
        if (data?.productSummary && data?.skus) {
          queryData = data;
          break;
        }
      }

      if (queryData) {
        if (queryData.productSummary?.isSoldOut) {
          result.stockStatus = 'sold_out';
        }

        if (queryData.colors) {
          result.availableColors = queryData.colors.map(c => ({
            code: c.code,
            name: c.name,
          }));
        }

        const colorCode = getColorCodeFromUrl(product.url);
        console.log(`[LuluTracker] Parsing ${product.name}: colorCode=${colorCode}, size=${product.size}`);

        if (colorCode && queryData.skus) {
          // Find the exact SKU matching this color + size
          const matchingSku = queryData.skus.find(s => {
            const cMatch = s.color?.code === colorCode;
            const sMatch = !product.size || product.size === 'Not selected' || s.size === product.size;
            return cMatch && sMatch;
          });

          if (matchingSku) {
            console.log(`[LuluTracker] Found SKU: available=${matchingSku.available}, onSale=${matchingSku.price?.onSale}`);

            // ── Price ──
            if (matchingSku.price) {
              const listPrice = parseFloat(matchingSku.price.listPrice) || null;
              const salePrice = matchingSku.price.salePrice
                ? parseFloat(matchingSku.price.salePrice)
                : null;

              result.currentPrice = listPrice;

              // Only consider it "on sale" if there's a real price drop
              if (salePrice && listPrice && salePrice < listPrice) {
                result.originalPrice = listPrice;
                result.currentPrice = salePrice;
                result.onSale = true;
              }
            }

            // ── Stock: use the SKU's 'available' field ──
            // This is the most reliable field — it's per color+size
            // NOTE: Lululemon sometimes uses boolean (true/false) and
            // sometimes numeric (1/0) for this field
            if (!matchingSku.available) {
              result.stockStatus = 'sold_out';
            }
          } else {
            console.log(`[LuluTracker] No matching SKU found for color=${colorCode} size=${product.size}`);

            // Fallback: check colorDriver for size availability
            if (product.size && product.size !== 'Not selected') {
              const colorDriver = queryData.colorDriver?.find(cd => cd.color === colorCode);
              if (colorDriver && !colorDriver.sizes.includes(product.size)) {
                result.stockStatus = 'sold_out';
              }
            }
          }
        }

        if (!result.currentPrice && queryData.skus.length > 0) {
          result.currentPrice = parseFloat(queryData.skus[0].price?.listPrice) || null;
        }
      }
    } catch (e) {
      console.warn('[LuluTracker] Failed to parse __NEXT_DATA__:', e);
    }
  }

  // ── Strategy 2: Parse JSON-LD ProductGroup (SFCC intl sites) ──
  if (isIntl || !nextDataMatch) {
    const ldMatches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
    for (const ldMatch of ldMatches) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        if (ld['@type'] !== 'ProductGroup') continue;

        console.log(`[LuluTracker] Found JSON-LD ProductGroup: ${ld.name}, ${(ld.hasVariant || []).length} variants`);

        const variants = ld.hasVariant || [];
        const colorCode = getColorCodeFromUrl(product.url);

        // Build available colors (deduplicated)
        const colorMap = new Map();
        for (const v of variants) {
          if (v.color && !colorMap.has(v.color)) {
            colorMap.set(v.color, {
              code: v.color, // SFCC variants use names, not codes
              name: v.color,
            });
          }
        }
        result.availableColors = [...colorMap.values()];

        // Match variants for tracked color.
        // SFCC variant URLs use SKU IDs, not color codes, so we match by
        // color NAME which is stored on the product when tracked.
        const colorName = product.color;
        const colorVariants = colorName
          ? variants.filter(v => v.color === colorName)
          : [];

        console.log(`[LuluTracker] SFCC matching color="${colorName}": ${colorVariants.length} variants`);

        if (colorVariants.length > 0) {
          // Price from first match
          const price = parseFloat(colorVariants[0].offers?.price);
          if (price > 0) result.currentPrice = price;

          // Stock for specific size
          if (product.size && product.size !== 'Not selected') {
            const sizeMatch = colorVariants.find(v => v.size === product.size);
            if (sizeMatch) {
              const avail = sizeMatch.offers?.availability || '';
              if (avail.includes('OutOfStock')) {
                result.stockStatus = 'sold_out';
              }
            }
          }

          // If ALL sizes of this color are OutOfStock, it's sold out
          const allOut = colorVariants.every(v =>
            (v.offers?.availability || '').includes('OutOfStock')
          );
          if (allOut) {
            result.stockStatus = 'sold_out';
          }
        }

        break; // found ProductGroup, stop
      } catch (e) {
        console.warn('[LuluTracker] Failed to parse JSON-LD:', e);
      }
    }
  }

  // ── Fallback: regex-based stock detection ──
  // For US sites: broad text search works because Next.js server-renders visible state.
  // For SFCC intl sites: only check elements with display:block (hidden templates have display:none).
  if (!isIntl) {
    const htmlLower = html.toLowerCase();

    // LOW STOCK: Lululemon server-renders an element with this specific ID
    if (html.includes('pdp-inventory-low-stock-warning') ||
        htmlLower.includes('hurry, only a few left') ||
        htmlLower.includes('only a few left') ||
        htmlLower.includes('almost gone')) {
      if (result.stockStatus !== 'sold_out') {
        result.stockStatus = 'low_stock';
        console.log('[LuluTracker] Detected low stock warning (server-rendered)');
      }
    }

    if (result.stockStatus !== 'sold_out' && result.stockStatus !== 'low_stock') {
      if (htmlLower.includes('>sold out<') || htmlLower.includes('>out of stock<')) {
        result.stockStatus = 'sold_out';
      }
    }
  } else {
    // SFCC intl: check stock-avail-msg with display:block (visible low stock warning)
    // Template elements have display:none; real warnings have display:block.
    // Works for English ("Only a few left!") and Chinese ("只剩幾件！")
    if (result.stockStatus === 'in_stock') {
      const visibleLowStock = html.match(
        /class="stock-avail-msg[^"]*"[^>]*style="[^"]*display:\s*block[^"]*"/
      );
      if (visibleLowStock) {
        result.stockStatus = 'low_stock';
        console.log('[LuluTracker] Detected visible low stock warning (SFCC)');
      }
    }
  }

  // NOTE: We previously checked for "we made too much" in the HTML, but this
  // text appears in Lululemon's site navigation on EVERY page, not just discount
  // products. The only reliable sale indicator is salePrice < listPrice in SKU data.

  if (!result.currentPrice) {
    // US: data-lll-pl="price" with $78
    // Intl: various formats with HK$, A$, $, etc.
    const priceMatch = html.match(/data-lll-pl="price"[^>]*>.*?(?:HK|A|NZ|CA|NT)?\$(\d+(?:[,.]?\d+)*)/s) ||
                       html.match(/class="[^"]*price[^"]*"[^>]*>.*?(?:HK|A|NZ|CA|NT)?\$(\d+(?:[,.]?\d+)*)/s);
    if (priceMatch) result.currentPrice = parseFloat(priceMatch[1]);
  }

  return result;
}

// ── Detect changes ─────────────────────────────────────────

// ══════════════════════════════════════════════════════════
//  Normal → Discount ("We Made Too Much") transition
//
//  Lululemon uses two separate product pages for the same item:
//    Normal:   /p/men-ss-tops/Metal-Vent-Tech-Short-Sleeve-Shirt-3/_/prod11710026
//    Discount: /p/men-ss-tops/Metal-Vent-Tech-Short-Sleeve-Shirt-3-MD/_/prod11720682
//
//  When a color gets marked down, it disappears from the normal
//  page and appears on the -MD page with a sale price. We detect
//  this by checking: did a tracked color vanish from the normal
//  page? If so, check the -MD version for that color.
// ══════════════════════════════════════════════════════════

async function checkMarkdownTransition(product, newData) {
  // Only applies if the tracked color has disappeared from the normal product
  const trackedColorCode = getColorCodeFromUrl(product.url);
  if (!trackedColorCode) return null;

  // Is the tracked color still present on the normal page?
  const colorStillExists = newData.availableColors.some(c => c.code === trackedColorCode);
  if (colorStillExists) return null;

  // Color is gone from normal page — check the -MD version
  console.log(`[LuluTracker] Color ${trackedColorCode} disappeared from normal page. Checking markdown...`);

  // Build the -MD URL: insert -MD before /_/ in the path
  //   /p/men-ss-tops/Metal-Vent-Tech-Short-Sleeve-Shirt-3/_/prod11710026?color=74134
  //   → /p/men-ss-tops/Metal-Vent-Tech-Short-Sleeve-Shirt-3-MD/_/...
  const mdUrl = product.url.replace(/(\/_\/)/, '-MD$1');
  // The product ID will be different on the -MD page, but we don't need to know it —
  // we just fetch the page and look for our color code in its __NEXT_DATA__

  try {
    const response = await fetch(mdUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      console.log(`[LuluTracker] Markdown page returned HTTP ${response.status}`);
      return null;
    }

    const html = await response.text();
    const ndMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!ndMatch) return null;

    const nextData = JSON.parse(ndMatch[1]);
    const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];
    let mdQueryData = null;
    for (const q of queries) {
      const d = q?.state?.data;
      if (d?.productSummary && d?.skus) { mdQueryData = d; break; }
    }

    if (!mdQueryData) return null;

    // Does our tracked color exist on the markdown page?
    const mdColor = mdQueryData.colors?.find(c => c.code === trackedColorCode);
    if (!mdColor) return null;

    // Found it! Get the sale price
    const mdSku = mdQueryData.skus.find(s =>
      s.color?.code === trackedColorCode &&
      (!product.size || product.size === 'Not selected' || s.size === product.size)
    );

    const salePrice = mdSku?.price?.salePrice
      ? parseFloat(mdSku.price.salePrice)
      : null;
    const listPrice = mdSku?.price?.listPrice
      ? parseFloat(mdSku.price.listPrice)
      : product.currentPrice;

    // Build the actual discount page URL with the correct product ID
    const mdProductId = mdQueryData.productSummary?.productId || '';
    const mdSlug = mdQueryData.productSummary?.unifiedId || '';
    const parentCat = mdQueryData.productSummary?.parentCategoryUnifiedId || '';
    const discountUrl = `https://shop.lululemon.com/p/${parentCat}/${mdSlug}/_/${mdProductId}?color=${trackedColorCode}${product.size && product.size !== 'Not selected' ? '&sz=' + product.size : ''}`;

    console.log(`[LuluTracker] Found color on markdown page! Sale price: $${salePrice} (was $${listPrice})`);
    console.log(`[LuluTracker] Discount URL: ${discountUrl}`);

    return {
      discountUrl,
      change: {
        type: 'moved_to_markdown',
        salePrice: salePrice || '?',
        listPrice: listPrice || '?',
      },
    };
  } catch (err) {
    console.warn(`[LuluTracker] Error checking markdown page:`, err);
    return null;
  }
}

// ──────────────────────────────────────────────────────────

function detectChanges(oldProduct, newData) {
  const changes = [];

  // ── Stock availability changes ──
  // stockStatus is ONLY: in_stock | low_stock | sold_out
  if (oldProduct.stockStatus !== newData.stockStatus) {
    changes.push({
      type: 'status_change',
      from: oldProduct.stockStatus,
      to: newData.stockStatus,
    });
  }

  // ── Price changes ──
  if (oldProduct.currentPrice && newData.currentPrice &&
      oldProduct.currentPrice !== newData.currentPrice) {
    changes.push({
      type: 'price_change',
      from: oldProduct.currentPrice,
      to: newData.currentPrice,
    });
  }

  // ── Sale status change (separate from stock) ──
  if (!oldProduct.onSale && newData.onSale) {
    changes.push({ type: 'went_on_sale' });
  }

  // ── New colors detected ──
  if (oldProduct.trackNewColors && oldProduct.availableColors && newData.availableColors) {
    const oldCodes = new Set(oldProduct.availableColors.map(c => c.code));
    for (const newColor of newData.availableColors) {
      if (!oldCodes.has(newColor.code)) {
        changes.push({ type: 'new_color', color: newColor.name });
      }
    }
  }

  return changes;
}

// ── Send OS notification ───────────────────────────────────
// Returns { id, url } so the caller can batch-write to notificationMap

async function sendNotification(product, change) {
  let title = '';
  let message = '';
  const productLabel = `${product.name} — ${product.color}`;

  switch (change.type) {
    case 'status_change':
      title = getStatusTitle(change.to);
      message = `${productLabel}\n${getStatusMessage(change.from, change.to, product.size)}`;
      break;
    case 'price_change':
      title = change.to < change.from ? '📉 Price Drop!' : '📈 Price Increased';
      message = `${productLabel}\n$${change.from} → $${change.to}`;
      break;
    case 'went_on_sale':
      title = '🏷️ Now On Sale!';
      message = productLabel;
      break;
    case 'new_color':
      title = '🎨 New Color Available!';
      message = `${product.productLine}\nNew color: ${change.color}`;
      break;
    case 'moved_to_markdown':
      title = '🏷️ Moved to We Made Too Much!';
      message = `${productLabel}\nNow $${change.salePrice} (was $${change.listPrice})`;
      break;
    default:
      return null;
  }

  const notifId = `lulu-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  await chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2,
    requireInteraction: true,
  });

  return { id: notifId, url: product.url };
}

function getStatusTitle(status) {
  switch (status) {
    case 'low_stock':  return '⚠️ Almost Sold Out!';
    case 'sold_out':   return '❌ Sold Out';
    case 'in_stock':   return '🎉 Back in Stock!';
    default:           return '🔔 Status Changed';
  }
}

function getStatusMessage(from, to, size) {
  const sizeLabel = size && size !== 'Not selected' ? ` (Size: ${size})` : '';
  const labels = { in_stock: 'In Stock', low_stock: 'Low Stock', sold_out: 'Sold Out' };
  const fromLabel = labels[from] || from;
  const toLabel = labels[to] || to;
  return `Status: ${fromLabel} → ${toLabel}${sizeLabel}`;
}

// ── Notification click → open product page ─────────────────

chrome.notifications.onClicked.addListener(async (notifId) => {
  const { notificationMap = {} } = await chrome.storage.local.get('notificationMap');
  const url = notificationMap[notifId];
  if (url) {
    chrome.tabs.create({ url });
    delete notificationMap[notifId];
    await chrome.storage.local.set({ notificationMap });
  }
  chrome.notifications.clear(notifId);
});

// ── Message handler ────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'addProduct') {
    addProduct(message.product).then(async (result) => {
      await updateBadge();
      sendResponse(result);
    });
    return true;
  }
  if (message.action === 'removeProduct') {
    removeProduct(message.index).then(async (result) => {
      await updateBadge();
      sendResponse(result);
    });
    return true;
  }
  if (message.action === 'getProducts') {
    chrome.storage.local.get('trackedProducts', (data) => {
      sendResponse(data.trackedProducts || []);
    });
    return true;
  }
  if (message.action === 'checkNow') {
    checkAllProducts().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.action === 'clearChangeBadge') {
    // User has seen the alerts — clear the "lastChange" markers
    clearChangeMarkers().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.action === 'productPageChanged') {
    // Content script detected SPA navigation — no action needed
    // in background, but we acknowledge it
    sendResponse({ ok: true });
    return true;
  }
});

async function addProduct(product) {
  const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');

  const exists = trackedProducts.some(p =>
    p.productId === product.productId && p.color === product.color && p.size === product.size
  );
  if (exists) return { success: false, reason: 'Already tracking this product.' };

  const newProduct = {
    ...product,
    addedAt: Date.now(),
    trackNewColors: true,
    lastChange: null,
  };

  // Immediately fetch the live page to establish the correct baseline.
  // This ensures availableColors matches reality so the first scheduled
  // check won't see every existing color as "new."
  try {
    const liveData = await fetchProductStatus(newProduct);
    if (liveData) {
      if (liveData.availableColors.length > 0) {
        newProduct.availableColors = liveData.availableColors;
      }
      // Also sync price/stock so stored data is fresh from the start
      if (liveData.currentPrice !== null) newProduct.currentPrice = liveData.currentPrice;
      if (liveData.originalPrice !== null) newProduct.originalPrice = liveData.originalPrice;
      newProduct.onSale = liveData.onSale;
      newProduct.stockStatus = liveData.stockStatus;
      newProduct.lastChecked = Date.now();
      console.log(`[LuluTracker] Baseline fetch: ${liveData.availableColors.length} colors stored`);
    }
  } catch (err) {
    console.warn('[LuluTracker] Baseline fetch failed, using content script data:', err);
    // Not critical — the content script data is usually good enough
  }

  trackedProducts.push(newProduct);
  await chrome.storage.local.set({ trackedProducts });
  return { success: true };
}

async function removeProduct(index) {
  const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
  if (index >= 0 && index < trackedProducts.length) {
    trackedProducts.splice(index, 1);
    await chrome.storage.local.set({ trackedProducts });
    return { success: true };
  }
  return { success: false };
}

async function clearChangeMarkers() {
  const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
  for (const p of trackedProducts) {
    p.lastChange = null;
  }
  await chrome.storage.local.set({ trackedProducts });
  await updateBadge();
}
