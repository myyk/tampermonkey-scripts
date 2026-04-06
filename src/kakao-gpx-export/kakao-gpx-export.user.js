// ==UserScript==
// @name         Kakao GPX Export
// @namespace    https://github.com/myyk/tampermonkey-scripts
// @version      1.1.0
// @description  Adds an "Export GPX" button to Kakao Maps route pages so you can import the route into Garmin Connect.
// @author       myyk
// @match        https://map.kakao.com/*
// @match        https://m.map.kakao.com/*
// @match        https://place.map.kakao.com/*
// @grant        GM_download
// @run-at       document-start
// ==/UserScript==

/* global kakao, GM_download */

(function (root) {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  const BUTTON_ID = 'kakao-gpx-export-btn';
  const GPX_CREATOR = 'Kakao GPX Export';
  const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1';
  const GPX_SCHEMA = 'http://www.topografix.com/GPX/1/1/gpx.xsd';
  const POLL_INTERVAL_MS = 500;
  const POLL_MAX_MS = 30000;

  // Key under which XHR-captured route data is stored on the window object.
  const CAPTURED_ROUTE_KEY = '__kakaoGPXRoute';

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
   * @param {Window}   win
   * @param {string}   [url]
   * @param {Document} [doc]
   * @returns {Array<{lat:number, lng:number}>|null}
   */
  function collectRoute(win, url, doc) {
    // 1. XHR-intercepted + other global state (most reliable).
    var fromGlobal = extractRouteFromGlobal(win);
    if (fromGlobal) return fromGlobal;

    // 2. Live kakao.maps Polyline objects.
    var fromMaps = extractRouteFromKakaoMaps(win);
    if (fromMaps) return fromMaps;

    // 3. og:image meta tag (start/end points from Kakao share pages).
    var resolvedDoc = doc || (typeof document !== 'undefined' ? document : null);
    var fromMeta = extractRouteFromMetaTags(resolvedDoc, win);
    if (fromMeta) return fromMeta;

    // 4. URL path parsing (only waypoints, but better than nothing).
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
   * Download a GPX string as a file.
   * Uses GM_download when available, falling back to a temporary <a> element.
   *
   * @param {string} gpxContent
   * @param {string} [filename]
   */
  function downloadGPX(gpxContent, filename) {
    var fname = filename || 'kakao-route.gpx';

    if (typeof GM_download === 'function') {
      var blob = new Blob([gpxContent], { type: 'application/gpx+xml' });
      var url = URL.createObjectURL(blob);
      GM_download(url, fname);
      // Revoke after a short delay to let the download start.
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      return;
    }

    // Fallback: create a temporary anchor element.
    var blob2 = new Blob([gpxContent], { type: 'application/gpx+xml' });
    var url2 = URL.createObjectURL(blob2);
    var a = document.createElement('a');
    a.href = url2;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url2); }, 10000);
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
      var points = collectRoute(win, win.location && win.location.href, doc);
      if (!points || points.length === 0) {
        alert(
          'Kakao GPX Export: No route data found on this page.\n' +
            'Please open a route or directions page on Kakao Maps.'
        );
        return;
      }
      var gpx = generateGPX(points, { name: doc.title || 'Kakao Route' });
      downloadGPX(gpx, 'kakao-route.gpx');
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
   * @param {unknown} data
   * @returns {boolean}
   */
  function looksLikeRouteData(data) {
    if (!data || typeof data !== 'object') return false;
    if (Array.isArray(data.routes) && data.routes.length > 0) {
      var r = data.routes[0];
      return r && Array.isArray(r.sections);
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
              var points = parseKakaoNaviRoute(data);
              if (points) win[CAPTURED_ROUTE_KEY] = points;
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
              var points = parseKakaoNaviRoute(data);
              if (points) win[CAPTURED_ROUTE_KEY] = points;
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
  // We install the network hook immediately (document-start) so it is in place
  // before the page makes route API requests, then defer button injection until
  // the DOM is ready.
  // When running under Jest, `module` IS defined and tests control execution.

  if (typeof module === 'undefined') {
    installNetworkHook(root);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { init(); });
    } else {
      init();
    }
  }

  // ── CommonJS exports (for Jest) ────────────────────────────────────────────

  if (typeof module !== 'undefined') {
    module.exports = {
      escapeXml,
      generateGPX,
      parseKakaoNaviRoute,
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
