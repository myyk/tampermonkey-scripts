// ==UserScript==
// @name         Kakao GPX Export
// @namespace    https://github.com/myyk/tampermonkey-scripts
// @version      1.2.0
// @description  Adds an "Export GPX" button to Kakao Maps route pages so you can import the route into Garmin Connect.
// @author       myyk
// @match        https://map.kakao.com/*
// @match        https://m.map.kakao.com/*
// @match        https://place.map.kakao.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

/* global kakao, unsafeWindow */

(function (root) {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  const BUTTON_ID = 'kakao-gpx-export-btn';
  const GPX_CREATOR = 'Kakao GPX Export';
  const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1';
  const GPX_SCHEMA = 'http://www.topografix.com/GPX/1/1/gpx.xsd';
  const POLL_INTERVAL_MS = 500;
  const POLL_MAX_MS = 30000;

  // Key under which XHR-captured WGS84 route data is stored on the window object.
  const CAPTURED_ROUTE_KEY = '__kakaoGPXRoute';

  // Key under which XHR-captured raw Kakao internal route data is stored.
  // The internal format uses WCONGNAMUL coordinates that are converted lazily
  // at button-click time (when kakao.maps is guaranteed to be loaded).
  const CAPTURED_INTERNAL_KEY = '__kakaoGPXRawRoute';

  // ── Pure helpers ───────────────────────────────────────────────────────────

  /**
   * Escape a string for safe inclusion in XML text or attribute values.
   *
   * @param {unknown} val
   * @returns {string}
   */
  function escapeXml(val) {
    return String(val == null ? '' : val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Build a GPX 1.1 document string from an array of {lat, lng[, ele]} objects.
   * The output is compatible with Garmin Connect.
   *
   * @param {Array<{lat:number, lng:number, ele?:number}>} points
   * @param {{name?:string, time?:string}} [metadata]
   * @returns {string} GPX XML string
   */
  function generateGPX(points, metadata) {
    if (!Array.isArray(points) || points.length === 0) {
      throw new Error('generateGPX requires a non-empty array of points');
    }

    const name = (metadata && metadata.name) ? metadata.name : 'Kakao Route';
    const time = (metadata && metadata.time) ? metadata.time : new Date().toISOString();

    const trkpts = points
      .map(function (p) {
        const ele =
          p.ele != null
            ? '\n        <ele>' + escapeXml(p.ele) + '</ele>'
            : '';
        return (
          '      <trkpt lat="' +
          escapeXml(p.lat) +
          '" lon="' +
          escapeXml(p.lng) +
          '">' +
          ele +
          '\n      </trkpt>'
        );
      })
      .join('\n');

    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1"\n' +
      '     creator="' + GPX_CREATOR + '"\n' +
      '     xmlns="' + GPX_NAMESPACE + '"\n' +
      '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n' +
      '     xsi:schemaLocation="' + GPX_NAMESPACE + ' ' + GPX_SCHEMA + '">\n' +
      '  <metadata>\n' +
      '    <name>' + escapeXml(name) + '</name>\n' +
      '    <time>' + escapeXml(time) + '</time>\n' +
      '  </metadata>\n' +
      '  <trk>\n' +
      '    <name>' + escapeXml(name) + '</name>\n' +
      '    <trkseg>\n' +
      trkpts + '\n' +
      '    </trkseg>\n' +
      '  </trk>\n' +
      '</gpx>'
    );
  }

  /**
   * Parse Kakao Navi / Directions API route response.
   * The `vertexes` field is an interleaved [lng, lat, lng, lat, …] array.
   *
   * @param {object} routeData  Kakao Navi API response object
   * @returns {Array<{lat:number, lng:number}>|null}
   */
  function parseKakaoNaviRoute(routeData) {
    if (!routeData || !Array.isArray(routeData.routes)) return null;

    var points = [];
    var route = routeData.routes[0];
    if (!route || !Array.isArray(route.sections)) return null;

    route.sections.forEach(function (section) {
      if (!Array.isArray(section.roads)) return;
      section.roads.forEach(function (road) {
        var v = road.vertexes;
        if (!Array.isArray(v)) return;
        for (var i = 0; i + 1 < v.length; i += 2) {
          points.push({ lng: v[i], lat: v[i + 1] });
        }
      });
    });

    return points.length > 0 ? points : null;
  }

  /**
   * Parse the Kakao Maps INTERNAL route API format.
   *
   * The internal Kakao Maps route endpoints (/route/bikeset.json,
   * /route/cars.json, etc.) return a payload shaped like:
   *
   *   { resultCode, directions: [{ sections: [{ guideList: [{ link: { points: "x,y,ele|x,y,ele|…" } }] }] }] }
   *
   * Coordinates are in WCONGNAMUL (a Kakao/Daum map projection). Conversion to
   * WGS84 is done via the kakao.maps.Coords SDK already loaded on the page.
   *
   * @param {object} data  Parsed JSON from the internal route API.
   * @param {Window} win   Must be the PAGE window (unsafeWindow in Tampermonkey)
   *                       so that win.kakao.maps.Coords is available.
   * @returns {Array<{lat:number, lng:number, ele?:number}>|null}
   */
  function parseKakaoInternalRoute(data, win) {
    if (!data || !Array.isArray(data.directions) || !data.directions.length) {
      return null;
    }

    var firstDirection = data.directions[0];
    if (!firstDirection || !Array.isArray(firstDirection.sections)) return null;

    var kakaoMaps = win && win.kakao && win.kakao.maps;
    var canConvert = kakaoMaps && typeof kakaoMaps.Coords === 'function';

    var points = [];
    // Deduplicate consecutive identical WCONGNAMUL coordinates before conversion.
    var lastKey = '';

    firstDirection.sections.forEach(function (section) {
      if (!Array.isArray(section.guideList)) return;
      section.guideList.forEach(function (guide) {
        if (!guide || !guide.link || typeof guide.link.points !== 'string') return;

        // "x,y,ele|x,y,ele|…" — WCONGNAMUL easting/northing + elevation in metres
        guide.link.points.split('|').forEach(function (segment) {
          var parts = segment.split(',');
          if (parts.length < 2) return;

          var x = parseFloat(parts[0]); // WCONGNAMUL easting
          var y = parseFloat(parts[1]); // WCONGNAMUL northing
          var ele = parts.length >= 3 ? parseFloat(parts[2]) : null;

          if (!isFinite(x) || !isFinite(y)) return;

          var key = x + ',' + y;
          if (key === lastKey) return; // Skip duplicate consecutive point
          lastKey = key;

          if (canConvert) {
            try {
              var coords = new kakaoMaps.Coords(x, y);
              var latlng = coords.toLatLng();
              var pt = { lat: latlng.getLat(), lng: latlng.getLng() };
              if (ele !== null && isFinite(ele)) pt.ele = ele;
              points.push(pt);
            } catch (e) { /* skip unconvertable points */ }
          }
        });
      });
    });

    return points.length > 0 ? points : null;
  }

  /**
   * Extract named waypoints from a Kakao /link/route/ URL.
   * URL format: /link/route/Name,lat,lng/Name,lat,lng/…
   *
   * @param {string} url
   * @returns {Array<{name:string, lat:number, lng:number}>|null}
   */
  function extractWaypointsFromUrl(url) {
    if (typeof url !== 'string') return null;
    var match = url.match(/\/link\/route\/(.+)/);
    if (!match) return null;

    var parts = match[1].split('/');
    var waypoints = [];
    parts.forEach(function (part) {
      var segments = part.split(',');
      if (segments.length >= 3) {
        var lat = parseFloat(segments[segments.length - 2]);
        var lng = parseFloat(segments[segments.length - 1]);
        var name = segments.slice(0, segments.length - 2).join(',');
        if (isFinite(lat) && isFinite(lng)) {
          waypoints.push({ name: name, lat: lat, lng: lng });
        }
      }
    });

    return waypoints.length > 0 ? waypoints : null;
  }

  /**
   * Try to read route data from well-known global state locations set by the
   * Kakao Maps page (Next.js, plain global variables, etc.) or from XHR
   * responses that were captured by the network hook.
   *
   * @param {Window} win
   * @returns {Array<{lat:number, lng:number}>|null}
   */
  function extractRouteFromGlobal(win) {
    if (!win) return null;

    // XHR-intercepted route data (stored by installNetworkHook).
    if (win[CAPTURED_ROUTE_KEY]) return win[CAPTURED_ROUTE_KEY];

    // Kakao Navi API response stored directly.
    if (win.routeData) {
      var parsed = parseKakaoNaviRoute(win.routeData);
      if (parsed) return parsed;
    }

    // Next.js page props.
    var nextData = win.__NEXT_DATA__;
    if (nextData) {
      var route =
        (nextData.props &&
          nextData.props.pageProps &&
          nextData.props.pageProps.route) ||
        null;
      if (route) {
        var parsed2 = parseKakaoNaviRoute(route);
        if (parsed2) return parsed2;
      }
    }

    // Kakao-specific global namespaces.
    var kakaoGlobal = win.Kakao || win.kakaoNavi;
    if (kakaoGlobal && kakaoGlobal.routeData) {
      var parsed3 = parseKakaoNaviRoute(kakaoGlobal.routeData);
      if (parsed3) return parsed3;
    }

    return null;
  }

  /**
   * Try to extract route path from live kakao.maps Polyline / Marker objects
   * that are already painted on the map.
   *
   * @param {Window} win
   * @returns {Array<{lat:number, lng:number}>|null}
   */
  function extractRouteFromKakaoMaps(win) {
    if (!win) return null;
    var kakaoApi = win.kakao;
    if (!kakaoApi || !kakaoApi.maps) return null;

    // Look for any Polyline objects stored on the map instance.
    var mapObj = win._map || (win.map instanceof kakaoApi.maps.Map && win.map);
    if (!mapObj) return null;

    var overlays =
      (mapObj.overlayMapTypes && mapObj.overlayMapTypes.getArray
        ? mapObj.overlayMapTypes.getArray()
        : []);

    var points = [];
    overlays.forEach(function (overlay) {
      if (typeof overlay.getPath === 'function') {
        var path = overlay.getPath();
        if (Array.isArray(path)) {
          path.forEach(function (latlng) {
            points.push({
              lat: latlng.getLat(),
              lng: latlng.getLng(),
            });
          });
        }
      }
    });

    return points.length > 0 ? points : null;
  }

  /**
   * Extract start/end points from the Open Graph image tag.
   *
   * Kakao Maps share pages embed start and end marker coordinates in
   * the og:image URL using WCONGNAMUL (the Kakao/Daum coordinate system):
   *   …&markers=…|location:412488.07,1127252.97&markers=…|location:548385.01,…
   *
   * If the kakao.maps.Coords API is available those coordinates are converted
   * to WGS84; otherwise only points that can be converted are returned.
   *
   * @param {Document} doc
   * @param {Window}   win
   * @returns {Array<{lat:number, lng:number}>|null}
   */
  function extractRouteFromMetaTags(doc, win) {
    if (!doc) return null;

    var ogImage = doc.querySelector('meta[property="og:image"]');
    if (!ogImage) return null;

    var content = ogImage.getAttribute('content') || '';
    // Each marker segment looks like: markers=…|location:x,y
    var markerRe = /location:([0-9.]+),([0-9.]+)/g;
    var points = [];
    var match;

    while ((match = markerRe.exec(content)) !== null) {
      var x = parseFloat(match[1]);
      var y = parseFloat(match[2]);

      // Convert WCONGNAMUL → WGS84 using the kakao.maps SDK loaded on the page.
      if (win && win.kakao && win.kakao.maps && win.kakao.maps.Coords) {
        try {
          var coords = new win.kakao.maps.Coords(x, y);
          var latlng = coords.toLatLng();
          points.push({ lat: latlng.getLat(), lng: latlng.getLng() });
          continue;
        } catch (e) { /* conversion error – skip this point */ }
      }
      // kakao.maps not available or conversion failed — skip (can't convert without the library).
    }

    return points.length >= 2 ? points : null;
  }

  /**
   * Collect all available route data using every extraction strategy.
   * Returns null when no route could be found.
   *
   * Priority order:
   *  1. XHR-captured WGS84 route (public Navi API, already converted)
   *  2. XHR-captured raw internal Kakao Maps route (converted lazily here)
   *  3. Global state (window.routeData, __NEXT_DATA__, etc.)
   *  4. Live kakao.maps Polyline objects from the map instance
   *  5. og:image meta-tag start/end WCONGNAMUL markers
   *  6. URL /link/route/ waypoints
   *
   * @param {Window}   win  Should be the page window (unsafeWindow in Tampermonkey).
   * @param {string}   [url]
   * @param {Document} [doc]
   * @returns {Array<{lat:number, lng:number}>|null}
   */
  function collectRoute(win, url, doc) {
    // 1. XHR-captured pre-converted WGS84 route (public Navi API).
    var fromGlobal = extractRouteFromGlobal(win);
    if (fromGlobal) return fromGlobal;

    // 2. XHR-captured raw internal Kakao Maps route (needs WCONGNAMUL→WGS84 conversion).
    //    kakao.maps.Coords is available because the map is loaded before any route
    //    API response can be captured.
    if (win && win[CAPTURED_INTERNAL_KEY]) {
      var fromInternal = parseKakaoInternalRoute(win[CAPTURED_INTERNAL_KEY], win);
      if (fromInternal) return fromInternal;
    }

    // 3. Live kakao.maps Polyline objects.
    var fromMaps = extractRouteFromKakaoMaps(win);
    if (fromMaps) return fromMaps;

    // 4. og:image meta tag (start/end points from Kakao share pages).
    var resolvedDoc = doc || (typeof document !== 'undefined' ? document : null);
    var fromMeta = extractRouteFromMetaTags(resolvedDoc, win);
    if (fromMeta) return fromMeta;

    // 5. URL path parsing (only waypoints, but better than nothing).
    var currentUrl = url || (win && win.location && win.location.href) || '';
    var fromUrl = extractWaypointsFromUrl(currentUrl);
    if (fromUrl) return fromUrl;

    return null;
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────

  /**
   * Create and return the export button element.
   * The button is fixed-position so it is always visible on top of the map
   * regardless of where in the DOM it is attached.
   *
   * @param {Document} doc
   * @param {function} onClick
   * @returns {HTMLButtonElement}
   */
  function createExportButton(doc, onClick) {
    var btn = doc.createElement('button');
    btn.id = BUTTON_ID;
    btn.textContent = 'Export GPX';
    btn.title = 'Export route as GPX for Garmin Connect';
    btn.style.cssText = [
      'position:fixed',
      'bottom:80px',
      'right:16px',
      'display:inline-flex',
      'align-items:center',
      'gap:4px',
      'padding:8px 16px',
      'background:#3396f4',
      'color:#fff',
      'border:none',
      'border-radius:4px',
      'font-size:13px',
      'font-weight:600',
      'cursor:pointer',
      'z-index:9999',
      'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
    ].join(';');
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Find a suitable container in the Kakao Maps DOM to host the export button.
   * Tries several known selectors; falls back to appending to <body>.
   *
   * @param {Document} doc
   * @returns {Element}
   */
  function findButtonContainer(doc) {
    var selectors = [
      // Route info panel
      '.route_result',
      '.route_info',
      '.route_wrap',
      // General controls area
      '.map_wrap .bg_controls',
      '.btn_route_area',
      '.info_route_top',
      // Sidebar / panel
      '.aside_content',
      '.search_result',
      // Fallback
      'body',
    ];

    for (var i = 0; i < selectors.length; i++) {
      var el = doc.querySelector(selectors[i]);
      if (el) return el;
    }
    return doc.body;
  }

  /**
   * Download a GPX string as a file via a temporary <a download> element.
   *
   * This is the most reliable mechanism for locally-generated content.
   * GM_download is designed for cross-origin URLs and silently fails with
   * data URIs in many Tampermonkey versions — the browser download API it
   * delegates to either rejects or ignores data-scheme URLs from an
   * extension context.  Blob URLs are equally unreliable because they are
   * scoped to the sandbox context and inaccessible to the browser download
   * manager.
   *
   * The <a download> element is created in the page DOM (Tampermonkey
   * shares DOM access even in its sandbox) and works for any data URI
   * regardless of context.
   *
   * @param {string} gpxContent
   * @param {string} [filename]
   */
  function downloadGPX(gpxContent, filename) {
    var fname = filename || 'kakao-route.gpx';
    var dataUri =
      'data:application/gpx+xml;charset=utf-8,' +
      encodeURIComponent(gpxContent);

    console.log('[Kakao GPX] triggering download via anchor element');
    var a = document.createElement('a');
    a.href = dataUri;
    a.download = fname;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ── Button injection ───────────────────────────────────────────────────────

  /**
   * Inject the "Export GPX" button into the page.
   * Safe to call multiple times; subsequent calls are no-ops.
   *
   * @param {Document} doc
   * @param {Window}   win
   */
  function addExportButton(doc, win) {
    if (doc.getElementById(BUTTON_ID)) return; // already present

    var btn = createExportButton(doc, function handleClick() {
      console.log('[Kakao GPX] Export button clicked');
      try {
        var url = (win.location && win.location.href) || '';
        var points = collectRoute(win, url, doc);
        console.log(
          '[Kakao GPX] collectRoute:',
          points ? points.length + ' point(s) found' : 'no data'
        );
        if (!points || points.length === 0) {
          alert(
            'Kakao GPX Export: No route data found on this page.\n' +
              'Please open a route or directions page on Kakao Maps.'
          );
          return;
        }
        var gpx = generateGPX(points, { name: doc.title || 'Kakao Route' });
        console.log('[Kakao GPX] GPX generated (' + gpx.length + ' chars), downloading...');
        downloadGPX(gpx, 'kakao-route.gpx');
      } catch (err) {
        console.error('[Kakao GPX] Error in export handler:', err);
        alert('Kakao GPX Export: An error occurred – ' + (err && err.message ? err.message : String(err)));
      }
    });

    // The button is position:fixed, so appending to body is correct regardless
    // of where we insert it in the DOM.
    doc.body.appendChild(btn);
  }

  // ── Network hook ───────────────────────────────────────────────────────────

  /**
   * Check whether a parsed JSON object looks like a Kakao route API response
   * with extractable coordinate data.
   *
   * Supports two formats:
   *  - Public Kakao Navi API: { routes: [{ sections: [...] }] }
   *  - Internal Kakao Maps API (bikeset.json / cars.json):
   *      { directions: [{ sections: [...] }] }
   *
   * @param {unknown} data
   * @returns {boolean}
   */
  function looksLikeRouteData(data) {
    if (!data || typeof data !== 'object') return false;
    // Public Kakao Navi API format
    if (Array.isArray(data.routes) && data.routes.length > 0) {
      var r = data.routes[0];
      return r && Array.isArray(r.sections);
    }
    // Internal Kakao Maps API format (bikeset.json, cars.json, walkset.json)
    if (Array.isArray(data.directions) && data.directions.length > 0) {
      var d = data.directions[0];
      return d && Array.isArray(d.sections);
    }
    return false;
  }

  /**
   * Install hooks on XMLHttpRequest and fetch so that any JSON response that
   * looks like a Kakao route API payload is stored on the window object under
   * CAPTURED_ROUTE_KEY.
   *
   * This must be called at document-start (before page scripts run) so that
   * it is in place when the route API request is made.
   *
   * @param {Window} win
   */
  function installNetworkHook(win) {
    if (!win || !win.XMLHttpRequest) return;

    // ── XHR hook ──────────────────────────────────────────────────────────
    var OrigOpen = win.XMLHttpRequest.prototype.open;
    win.XMLHttpRequest.prototype.open = function () {
      this.addEventListener('load', function () {
        if (this.status >= 200 && this.status < 300) {
          try {
            var data = JSON.parse(this.responseText);
            if (looksLikeRouteData(data)) {
              // Public Navi API format: parse and convert immediately to WGS84 points.
              if (Array.isArray(data.routes)) {
                var points = parseKakaoNaviRoute(data);
                if (points) win[CAPTURED_ROUTE_KEY] = points;
              }
              // Internal Kakao Maps API format: store raw data; WCONGNAMUL→WGS84
              // conversion happens lazily at button-click time via kakao.maps.Coords.
              if (Array.isArray(data.directions)) {
                win[CAPTURED_INTERNAL_KEY] = data;
              }
            }
          } catch (e) {
            // Probing ALL XHR responses for route data; non-JSON is expected and normal.
          }
        }
      });
      return OrigOpen.apply(this, arguments);
    };

    // ── Fetch hook ────────────────────────────────────────────────────────
    if (typeof win.fetch === 'function') {
      var origFetch = win.fetch;
      win.fetch = function () {
        var p = origFetch.apply(win, arguments);
        return p.then(function (response) {
          response.clone().json().then(function (data) {
            if (looksLikeRouteData(data)) {
              if (Array.isArray(data.routes)) {
                var points = parseKakaoNaviRoute(data);
                if (points) win[CAPTURED_ROUTE_KEY] = points;
              }
              if (Array.isArray(data.directions)) {
                win[CAPTURED_INTERNAL_KEY] = data;
              }
            }
          }).catch(function () {
            // Probing ALL fetch responses for route data; non-JSON is expected and normal.
          });
          return response;
        });
      };
    }
  }

  // ── Initialisation ─────────────────────────────────────────────────────────

  /**
   * Poll until a suitable container exists, then inject the button.
   *
   * @param {Document} doc
   * @param {Window}   win
   */
  function init(doc, win) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    win = win || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win) return;

    var elapsed = 0;
    var interval = setInterval(function () {
      elapsed += POLL_INTERVAL_MS;
      addExportButton(doc, win);

      if (doc.getElementById(BUTTON_ID) || elapsed >= POLL_MAX_MS) {
        clearInterval(interval);
      }
    }, POLL_INTERVAL_MS);
  }

  // ── Entry point (browser only) ─────────────────────────────────────────────
  // When running under Tampermonkey in a real browser, `module` is not defined.
  //
  // IMPORTANT: Tampermonkey scripts with any @grant directive run in an isolated
  // sandbox whose `window` is NOT the page's window. To intercept the page's
  // XHR/fetch calls we must patch `unsafeWindow.XMLHttpRequest.prototype`, not
  // the sandbox's `window.XMLHttpRequest`. Similarly, `unsafeWindow.kakao.maps`
  // is needed to access the coordinate-conversion API loaded by the page.
  //
  // We install the network hook immediately (document-start) so it is in place
  // before the page makes route API requests, then defer button injection until
  // the DOM is ready.
  // When running under Jest, `module` IS defined and tests control execution.

  if (typeof module === 'undefined') {
    // Use the page's real window when available (Tampermonkey sandbox context).
    var pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : root;
    installNetworkHook(pageWindow);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { init(document, pageWindow); });
    } else {
      init(document, pageWindow);
    }
  }

  // ── CommonJS exports (for Jest) ────────────────────────────────────────────

  if (typeof module !== 'undefined') {
    module.exports = {
      escapeXml,
      generateGPX,
      parseKakaoNaviRoute,
      parseKakaoInternalRoute,
      extractWaypointsFromUrl,
      extractRouteFromGlobal,
      extractRouteFromKakaoMaps,
      extractRouteFromMetaTags,
      collectRoute,
      createExportButton,
      findButtonContainer,
      downloadGPX,
      addExportButton,
      looksLikeRouteData,
      installNetworkHook,
      init,
    };
  }
}(typeof window !== 'undefined' ? window : {}));
