/**
 * Background Service Worker
 *
 * IMPROVEMENTS over v1:
 * 1. Badge count — shows number of products with status changes on the
 *    extension icon (inspired by SQDC extension's badge approach)
 * 2. Better new-color detection — compares color arrays from __NEXT_DATA__
 * 3. Responds to 'productPageChanged' from content script MutationObserver
 * 4. Retry + error handling — retries failed fetches once after a delay,
 *    tracks consecutive failures, and surfaces fetch health in the popup
 * 5. Price history — stores price changes over time per product,
 *    enabling "lowest price ever" display and trend tracking
 * 6. Notification grouping — batches notifications by type, sends summaries
 *    when 3+ of the same type fire at once, with per-product cooldowns
 */

const CHECK_INTERVAL_MINUTES = 60;
const ALARM_NAME = 'lululemon-check';
const RETRY_DELAY_MS = 5000;       // Wait 5s before retrying a failed fetch
const MAX_DISPLAY_FAILURES = 3;    // Show warning in popup after this many consecutive failures
const MAX_PRICE_HISTORY = 90;   // Keep at most 90 price history entries per product
const NOTIFICATION_GROUP_THRESHOLD = 3; // Group into summary if 3+ notifications of same type
const NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h cooldown per product+change type

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

// ── Initialization ───────────────────────────────────────

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

// ── Alarm handler ────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
          console.log('[LuluTracker] Alarm fired. Checking all products...');
          await checkAllProducts();
    }
});

// ══════════════════════════════════════════════════════════
// FEATURE 1: Badge count on extension icon
// ══════════════════════════════════════════════════════════

async function updateBadge() {
    const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');

  const stockAlerts = trackedProducts.filter(p =>
        p.stockStatus === 'low_stock' || p.stockStatus === 'sold_out'
                                               ).length;
    const saleAlerts = trackedProducts.filter(p => p.onSale).length;
    const fetchErrors = trackedProducts.filter(p =>
          (p.consecutiveFailures || 0) >= MAX_DISPLAY_FAILURES
                                                 ).length;

  const alertCount = stockAlerts + saleAlerts + fetchErrors;

  if (alertCount > 0) {
        chrome.action.setBadgeText({ text: alertCount.toString() });
        // Red for stock issues, orange for fetch errors only, blue for sales only
      chrome.action.setBadgeBackgroundColor({
              color: stockAlerts > 0 ? '#d31334'
                        : fetchErrors > 0 ? '#e65100'
                        : '#1565c0'
      });
  } else {
        chrome.action.setBadgeText({ text: '' });
  }
}

// ══════════════════════════════════════════════════════════
// FEATURE 4: Fetch with retry
//
// Wraps a single fetch attempt. On failure (network error or
// non-200 status), waits RETRY_DELAY_MS then tries once more.
// Returns { html, ok, error } so callers can track failures.
// ══════════════════════════════════════════════════════════

async function fetchWithRetry(url) {
    const headers = {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
    };

  for (let attempt = 1; attempt <= 2; attempt++) {
        try {
                const response = await fetch(url, { headers });
                if (response.ok) {
                          const html = await response.text();
                          return { html, ok: true, error: null };
                }
                // Non-200: might be 403 rate-limit or 404 removed product
          const status = response.status;
                console.warn(`[LuluTracker] HTTP ${status} for ${url} (attempt ${attempt}/2)`);
                if (status === 404) {
                          // Don't retry 404s — the product page doesn't exist
                  return { html: null, ok: false, error: `HTTP 404 — product page not found` };
                }
                if (attempt === 1) {
                          console.log(`[LuluTracker] Retrying in ${RETRY_DELAY_MS}ms...`);
                          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                } else {
                          return { html: null, ok: false, error: `HTTP ${status} after retry` };
                }
        } catch (err) {
                console.warn(`[LuluTracker] Fetch error for ${url} (attempt ${attempt}/2):`, err.message);
                if (attempt === 1) {
                          console.log(`[LuluTracker] Retrying in ${RETRY_DELAY_MS}ms...`);
                          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                } else {
                          return { html: null, ok: false, error: `Network error: ${err.message}` };
                }
        }
  }
    // Should not reach here, but just in case
  return { html: null, ok: false, error: 'Unknown fetch failure' };
}


// ══════════════════════════════════════════════════════════
// FEATURE 5: Price history tracking
//
// Stores a priceHistory array on each product:
//   [{ price, date, wasOnSale }]
// Appends a new entry whenever the effective price changes.
// Capped at MAX_PRICE_HISTORY entries (oldest trimmed).
// ══════════════════════════════════════════════════════════
function appendPriceHistory(product, newPrice, wasOnSale) {
  if (newPrice === null || newPrice === undefined) return;
  if (!product.priceHistory) product.priceHistory = [];

  const last = product.priceHistory[product.priceHistory.length - 1];
  // Only append if price actually changed or this is the first entry
  if (last && last.price === newPrice && last.wasOnSale === wasOnSale) return;

  product.priceHistory.push({
    price: newPrice,
    date: Date.now(),
    wasOnSale: !!wasOnSale,
  });

  // Trim to max length (keep most recent)
  if (product.priceHistory.length > MAX_PRICE_HISTORY) {
    product.priceHistory = product.priceHistory.slice(-MAX_PRICE_HISTORY);
  }
}

// ── Core: Check all tracked products ─────────────────────

async function checkAllProducts() {
    const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
    if (trackedProducts.length === 0) return;

  const updatedProducts = [];
  const notifItems = [];

  // ── Deduplication ──
  const fetchCache = {};
    const newColorNotifiedProductIds = new Set();

  for (const product of trackedProducts) {
        try {
                const baseUrl = product.url.split('?')[0];
                let newData;

          if (fetchCache[baseUrl]) {
                    newData = fetchCache[baseUrl];
          } else {
                    newData = await fetchProductStatus(product);
                    if (newData) fetchCache[baseUrl] = newData;
          }

          if (!newData) {
                    // fetchProductStatus returned null — fetch failed or parse failed
                  // The product's consecutiveFailures was already incremented inside fetchProductStatus
                  updatedProducts.push(product);
                    continue;
          }

          // ── Fetch succeeded — reset failure tracking ──
          product.consecutiveFailures = 0;
                product.lastFetchError = null;


      // ── Track price history ──
      const effectivePrice = newData.currentPrice;
      appendPriceHistory(product, effectivePrice, newData.onSale);

          let changes = detectChanges(product, newData);

          // ── Deduplicate new_color notifications ──
          if (product.productId && newColorNotifiedProductIds.has(product.productId)) {
                    changes = changes.filter(c => c.type !== 'new_color');
          }
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
          // Track markdown sale price in history
          if (markdownTransition.change && typeof markdownTransition.change.salePrice === 'number') {
            appendPriceHistory(product, markdownTransition.change.salePrice, true);
          }
                                      changes = changes.filter(c => !(c.type === 'status_change' && c.to === 'sold_out'));
          if (await shouldNotify(product, markdownTransition.change.type)) {
            notifItems.push({
              product, change: markdownTransition.change, url: markdownTransition.discountUrl,
            });
          }
                          }
                }

        // Collect remaining notifications (with cooldown check)
        for (const change of changes) {
          if (await shouldNotify(product, change.type)) {
            notifItems.push({ product, change, url: product.url });
          }
        }

          updatedProducts.push({
                    ...product,
                    currentPrice: newData.currentPrice !== null ? newData.currentPrice : product.currentPrice,
                    originalPrice: newData.originalPrice !== null ? newData.originalPrice : product.originalPrice,
                    onSale: newData.onSale,
                    stockStatus: markdownTransition ? 'in_stock' : newData.stockStatus,
                    availableColors: newData.availableColors.length > 0
                      ? newData.availableColors : product.availableColors,
                    lastChecked: Date.now(),
                    lastChange: (changes.length > 0 || markdownTransition)
                      ? {
                                      type: markdownTransition ? 'moved_to_markdown' : changes[0]?.type,
                                      timestamp: Date.now(),
                      }
                                : product.lastChange,
                    markdownUrl: markdownTransition
                      ? markdownTransition.discountUrl : product.markdownUrl,
        priceHistory: product.priceHistory || [],
                    // Ensure these fields persist
                    consecutiveFailures: 0,
                    lastFetchError: null,
          });
        } catch (err) {
                console.error(`[LuluTracker] Error checking ${product.name}:`, err);
                updatedProducts.push({
                          ...product,
                          consecutiveFailures: (product.consecutiveFailures || 0) + 1,
                          lastFetchError: err.message || 'Unexpected error during check',
                });
        }
  }

  // ── Dispatch grouped notifications ──
  const sentNotifications = await groupAndSendNotifications(notifItems);

  // Write notification URL mappings for click handling
  if (sentNotifications.length > 0) {
    const { notificationMap = {} } = await chrome.storage.local.get('notificationMap');
    for (const notif of sentNotifications) {
      notificationMap[notif.id] = notif.url;
    }
    await chrome.storage.local.set({ notificationMap });
  }

  await chrome.storage.local.set({ trackedProducts: updatedProducts });
    await updateBadge();
}

// ── Fetch & parse a product page ─────────────────────────

async function fetchProductStatus(product) {
    const { html, ok, error } = await fetchWithRetry(product.url);

  if (!ok) {
        // Track the failure on the product object (mutates in place)
      product.consecutiveFailures = (product.consecutiveFailures || 0) + 1;
        product.lastFetchError = error;
        console.warn(`[LuluTracker] Failed to fetch ${product.name}: ${error} (failures: ${product.consecutiveFailures})`);
        return null;
  }

  return parseProductHtml(html, product);
}

/**
 * Parse fetched HTML — uses __NEXT_DATA__ for US, JSON-LD for SFCC.
 * Falls back to regex patterns.
 */
function parseProductHtml(html, product) {
    const result = {
          currentPrice: null,
          originalPrice: null,
          onSale: false,
          stockStatus: 'in_stock',
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
                                const matchingSku = queryData.skus.find(s => {
                                              const cMatch = s.color?.code === colorCode;
                                              const sMatch = !product.size || product.size === 'Not selected' ||
                                                              s.size === product.size;
                                              return cMatch && sMatch;
                                });

                              if (matchingSku) {
                                            console.log(`[LuluTracker] Found SKU: available=${matchingSku.available}, onSale=${matchingSku.price?.onSale}`);
                                            if (matchingSku.price) {
                                                            const listPrice = parseFloat(matchingSku.price.listPrice) || null;
                                                            const salePrice = matchingSku.price.salePrice
                                                              ? parseFloat(matchingSku.price.salePrice) : null;
                                                            result.currentPrice = listPrice;
                                                            if (salePrice && listPrice && salePrice < listPrice) {
                                                                              result.originalPrice = listPrice;
                                                                              result.currentPrice = salePrice;
                                                                              result.onSale = true;
                                                            }
                                            }
                                            if (!matchingSku.available) {
                                                            result.stockStatus = 'sold_out';
                                            }
                              } else {
                                            console.log(`[LuluTracker] No matching SKU found for color=${colorCode} size=${product.size}`);
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
        const ldMatches = html.matchAll(
                /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
              );
        for (const ldMatch of ldMatches) {
                try {
                          const ld = JSON.parse(ldMatch[1]);
                          if (ld['@type'] !== 'ProductGroup') continue;
                          console.log(`[LuluTracker] Found JSON-LD ProductGroup: ${ld.name}, ${(ld.hasVariant || []).length} variants`);

                  const variants = ld.hasVariant || [];
                          const colorCode = getColorCodeFromUrl(product.url);

                  const colorMap = new Map();
                          for (const v of variants) {
                                      if (v.color && !colorMap.has(v.color)) {
                                                    colorMap.set(v.color, { code: v.color, name: v.color });
                                      }
                          }
                          result.availableColors = [...colorMap.values()];

                  const colorName = product.color;
                          const colorVariants = colorName
                            ? variants.filter(v => v.color === colorName) : [];
                          console.log(`[LuluTracker] SFCC matching color="${colorName}": ${colorVariants.length} variants`);

                  if (colorVariants.length > 0) {
                              const price = parseFloat(colorVariants[0].offers?.price);
                              if (price > 0) result.currentPrice = price;

                            if (product.size && product.size !== 'Not selected') {
                                          const sizeMatch = colorVariants.find(v => v.size === product.size);
                                          if (sizeMatch) {
                                                          const avail = sizeMatch.offers?.availability || '';
                                                          if (avail.includes('OutOfStock')) {
                                                                            result.stockStatus = 'sold_out';
                                                          }
                                          }
                            }

                            const allOut = colorVariants.every(v =>
                                          (v.offers?.availability || '').includes('OutOfStock')
                                                                         );
                              if (allOut) result.stockStatus = 'sold_out';
                  }
                          break;
                } catch (e) {
                          console.warn('[LuluTracker] Failed to parse JSON-LD:', e);
                }
        }
  }

  // ── Fallback: regex-based stock detection ──
  if (!isIntl) {
        const htmlLower = html.toLowerCase();
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

  if (!result.currentPrice) {
        const priceMatch = html.match(
                /data-lll-pl="price"[^>]*>.*?(?:HK|A|NZ|CA|NT)?\$(\d+(?:[,.]?\d+)*)/s
              ) || html.match(
                /class="[^"]*price[^"]*"[^>]*>.*?(?:HK|A|NZ|CA|NT)?\$(\d+(?:[,.]?\d+)*)/s
              );
        if (priceMatch) result.currentPrice = parseFloat(priceMatch[1]);
  }

  return result;
}

// ── Detect changes ───────────────────────────────────────

async function checkMarkdownTransition(product, newData) {
    const trackedColorCode = getColorCodeFromUrl(product.url);
    if (!trackedColorCode) return null;

  const colorStillExists = newData.availableColors.some(c => c.code === trackedColorCode);
    if (colorStillExists) return null;

  console.log(`[LuluTracker] Color ${trackedColorCode} disappeared from normal page. Checking markdown...`);

  const mdUrl = product.url.replace(/(\/_\/)/, '-MD$1');

  try {
        const { html, ok } = await fetchWithRetry(mdUrl);
        if (!ok) {
                console.log(`[LuluTracker] Markdown page fetch failed`);
                return null;
        }

      const ndMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (!ndMatch) return null;

      const nextData = JSON.parse(ndMatch[1]);
        const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];
        let mdQueryData = null;
        for (const q of queries) {
                const d = q?.state?.data;
                if (d?.productSummary && d?.skus) {
                          mdQueryData = d;
                          break;
                }
        }
        if (!mdQueryData) return null;

      const mdColor = mdQueryData.colors?.find(c => c.code === trackedColorCode);
        if (!mdColor) return null;

      const mdSku = mdQueryData.skus.find(s =>
              s.color?.code === trackedColorCode &&
              (!product.size || product.size === 'Not selected' || s.size === product.size)
                                              );

      const salePrice = mdSku?.price?.salePrice
          ? parseFloat(mdSku.price.salePrice) : null;
        const listPrice = mdSku?.price?.listPrice
          ? parseFloat(mdSku.price.listPrice) : product.currentPrice;

      const mdProductId = mdQueryData.productSummary?.productId || '';
        const mdSlug = mdQueryData.productSummary?.unifiedId || '';
        const parentCat = mdQueryData.productSummary?.parentCategoryUnifiedId || '';
        const discountUrl = `https://shop.lululemon.com/p/${parentCat}/${mdSlug}/_/${mdProductId}?color=${trackedColorCode}${product.size && product.size !== 'Not selected' ? '&sz=' + product.size : ''}`;

      console.log(`[LuluTracker] Found color on markdown page! Sale price: $${salePrice} (was $${listPrice})`);

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

function detectChanges(oldProduct, newData) {
    const changes = [];

  if (oldProduct.stockStatus !== newData.stockStatus) {
        changes.push({
                type: 'status_change',
                from: oldProduct.stockStatus,
                to: newData.stockStatus,
        });
  }

  if (oldProduct.currentPrice && newData.currentPrice &&
            oldProduct.currentPrice !== newData.currentPrice) {
        changes.push({
                type: 'price_change',
                from: oldProduct.currentPrice,
                to: newData.currentPrice,
        });
  }

  if (!oldProduct.onSale && newData.onSale) {
        changes.push({ type: 'went_on_sale' });
  }

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

// ══════════════════════════════════════════════════════════
// FEATURE 6: Smarter notification grouping
//
// Instead of firing one OS notification per change, we:
//   1. Check a per-product cooldown (4h) to avoid re-alerting
//   2. Collect all notifications from a check cycle
//   3. If 3+ share the same type, send a single summary
//   4. Otherwise send individual notifications as before
// ══════════════════════════════════════════════════════════

/**
 * Check whether a notification should fire for this product + change type.
 * Uses notificationCooldowns in storage: { "productId:color:changeType": timestamp }
 */
async function shouldNotify(product, changeType) {
  const { notificationCooldowns = {} } = await chrome.storage.local.get('notificationCooldowns');
  const key = `${product.productId}:${product.color}:${changeType}`;
  const lastNotified = notificationCooldowns[key] || 0;
  return (Date.now() - lastNotified) > NOTIFICATION_COOLDOWN_MS;
}

/**
 * Record that we just notified for this product + change type.
 */
async function recordNotification(product, changeType) {
  const { notificationCooldowns = {} } = await chrome.storage.local.get('notificationCooldowns');
  const key = `${product.productId}:${product.color}:${changeType}`;
  notificationCooldowns[key] = Date.now();

  // Prune old entries (older than 24h) to prevent unbounded growth
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, ts] of Object.entries(notificationCooldowns)) {
    if (ts < cutoff) delete notificationCooldowns[k];
  }

  await chrome.storage.local.set({ notificationCooldowns });
}

/**
 * Group collected notification items by type and dispatch.
 * If 3+ items share the same type, send a summary notification.
 * Otherwise send individual notifications.
 * Returns array of { id, url } for notification-click mapping.
 */
async function groupAndSendNotifications(notifItems) {
  if (notifItems.length === 0) return [];

  // Group by change type
  const byType = {};
  for (const item of notifItems) {
    const t = item.change.type;
    if (!byType[t]) byType[t] = [];
    byType[t].push(item);
  }

  const results = [];

  for (const [type, items] of Object.entries(byType)) {
    if (items.length >= NOTIFICATION_GROUP_THRESHOLD) {
      // Send a summary notification
      const notif = await sendSummaryNotification(type, items);
      if (notif) results.push(notif);
    } else {
      // Send individual notifications
      for (const item of items) {
        const notif = await sendNotification(item.product, item.change);
        if (notif) {
          if (item.url) notif.url = item.url;
          results.push(notif);
        }
        await recordNotification(item.product, type);
      }
    }
  }

  return results;
}

/**
 * Send a single summary notification for multiple items of the same type.
 */
async function sendSummaryNotification(type, items) {
  let title = '';
  let message = '';
  const count = items.length;
  const names = items.slice(0, 4).map(i => i.product.name);
  const nameList = count > 4
    ? names.join(', ') + ` + ${count - 4} more`
    : names.join(', ');

  switch (type) {
    case 'status_change': {
      const soldOut = items.filter(i => i.change.to === 'sold_out');
      const backIn = items.filter(i => i.change.to === 'in_stock');
      if (soldOut.length >= backIn.length) {
        title = `\u274C ${count} Products Sold Out`;
      } else {
        title = `\u{1F389} ${count} Products Back in Stock!`;
      }
      message = nameList;
      break;
    }
    case 'price_change': {
      const drops = items.filter(i => i.change.to < i.change.from);
      if (drops.length >= items.length / 2) {
        title = `\u{1F4C9} ${count} Price Drops!`;
      } else {
        title = `\u{1F4B0} ${count} Price Changes`;
      }
      message = nameList;
      break;
    }
    case 'went_on_sale':
      title = `\u{1F3F7}\uFE0F ${count} Products Now On Sale!`;
      message = nameList;
      break;
    case 'new_color':
      title = `\u{1F3A8} New Colors for ${count} Products`;
      message = nameList;
      break;
    case 'moved_to_markdown':
      title = `\u{1F3F7}\uFE0F ${count} Products Moved to WMTM!`;
      message = nameList;
      break;
    default:
      title = `\u{1F514} ${count} Product Updates`;
      message = nameList;
  }

  const notifId = `lulu-batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2,
    requireInteraction: true,
  });

  // Record cooldown for all items in the batch
  for (const item of items) {
    await recordNotification(item.product, type);
  }

  // Link notification click to the first product in batch
  return { id: notifId, url: items[0].url || items[0].product.url };
}

// ── Send OS notification ─────────────────────────────────

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
      case 'low_stock': return '⚠️ Almost Sold Out!';
      case 'sold_out':  return '❌ Sold Out';
      case 'in_stock':  return '🎉 Back in Stock!';
      default:          return '🔔 Status Changed';
    }
}

function getStatusMessage(from, to, size) {
    const sizeLabel = size && size !== 'Not selected' ? ` (Size: ${size})` : '';
    const labels = { in_stock: 'In Stock', low_stock: 'Low Stock', sold_out: 'Sold Out' };
    const fromLabel = labels[from] || from;
    const toLabel = labels[to] || to;
    return `Status: ${fromLabel} → ${toLabel}${sizeLabel}`;
}

// ── Notification click → open product page ───────────────

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

// ── Message handler ──────────────────────────────────────

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
          clearChangeMarkers().then(() => sendResponse({ success: true }));
          return true;
    }
    if (message.action === 'productPageChanged') {
          sendResponse({ ok: true });
          return true;
    }
});

async function addProduct(product) {
    const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
    const exists = trackedProducts.some(p =>
          p.productId === product.productId &&
          p.color === product.color &&
          p.size === product.size
                                          );
    if (exists) return { success: false, reason: 'Already tracking this product.' };

  const newProduct = {
        ...product,
        addedAt: Date.now(),
        trackNewColors: true,
        lastChange: null,
        consecutiveFailures: 0,
        lastFetchError: null,
    priceHistory: [],
  };

  // Immediately fetch the live page to establish the correct baseline
  try {
        const liveData = await fetchProductStatus(newProduct);
        if (liveData) {
                if (liveData.availableColors.length > 0) {
                          newProduct.availableColors = liveData.availableColors;
                }
                if (liveData.currentPrice !== null) newProduct.currentPrice = liveData.currentPrice;
                if (liveData.originalPrice !== null) newProduct.originalPrice = liveData.originalPrice;
                newProduct.onSale = liveData.onSale;
                newProduct.stockStatus = liveData.stockStatus;
                newProduct.lastChecked = Date.now();
                newProduct.consecutiveFailures = 0;
                newProduct.lastFetchError = null;
                console.log(`[LuluTracker] Baseline fetch: ${liveData.availableColors.length} colors stored`);

      // Initialize price history with the baseline price
      if (newProduct.currentPrice) {
        appendPriceHistory(newProduct, newProduct.currentPrice, newProduct.onSale);
      }
        }
  } catch (err) {
        console.warn('[LuluTracker] Baseline fetch failed, using content script data:', err);
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
