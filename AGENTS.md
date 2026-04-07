# Agent Instructions

Key learnings for working on Tampermonkey userscripts in this repo.

## Testing

- **Run tests:** `npm test` (Jest + jsdom, no install needed after first `npm install`)
- **Test helper:** `tests/helpers/tampermonkey-mock.js` — `TampermonkeyMock` stubs all `GM_*` APIs; call `tm.install()` / `tm.uninstall()` in `beforeEach` / `afterEach`.
- **Pattern:** scripts export all functions via `module.exports` (guarded by `if (typeof module !== 'undefined')`) so Jest can import them directly without a browser environment.

## Kakao Maps GPX Export — key facts

### Tampermonkey sandbox isolation (CRITICAL)

When a userscript declares **any** `@grant` directive (e.g. `@grant GM_download`), Tampermonkey runs it in an **isolated sandbox**. The `window` object inside the script is **not** the page's `window`.

Consequence: patching `window.XMLHttpRequest.prototype` inside the userscript **does not** intercept XHR calls made by the page's own JavaScript.

**Fix:** declare `@grant unsafeWindow`. At runtime, `unsafeWindow` is the real page window. In the entry point, compute:

```js
var pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : root;
```

Pass `pageWindow` to all functions that need the page's globals (network hook, route collection, WCONGNAMUL conversion).

### Kakao Maps internal route API format

Kakao Maps uses **internal** REST endpoints (not the public Kakao Navi API):

| Transport | Endpoint |
|-----------|----------|
| Car       | `GET /route/cars.json?sX=…&sY=…&eX=…&eY=…` |
| Bike      | `GET /route/bikeset.json?sX=…&sY=…&eX=…&eY=…` |
| Walk      | `GET /route/walkset.json?sX=…&sY=…&eX=…&eY=…` |

Parameters `sX`, `sY`, `eX`, `eY` are **WCONGNAMUL** easting/northing (metres), NOT WGS84.

Response shape:

```json
{
  "resultCode": "SUCCESS",
  "directions": [
    {
      "routeMode": "BIKE_ONLY",
      "sections": [
        {
          "guideList": [
            {
              "seq": 1,
              "x": 412510.0,
              "y": 1127275.0,
              "link": {
                "points": "412510.0,1127275.0,8.6|412520.0,1127258.0,8.7|…"
              }
            }
          ]
        }
      ]
    }
  ]
}
```

- `link.points` is a **pipe-delimited** string of `x,y,elevation` triples in **WCONGNAMUL**.
- `x` = easting, `y` = northing, elevation in metres (present but can be 0).
- This is the full route polyline — NOT just turn-by-turn guide points.

### WCONGNAMUL → WGS84 conversion

The `kakao.maps.Coords` class (loaded by `ssl.daumcdn.net/dmaps/map_js_init/v3.js`) converts WCONGNAMUL to WGS84:

```js
var coords = new kakaoMaps.Coords(x, y);   // WCONGNAMUL easting, northing
var latlng  = coords.toLatLng();
var lat = latlng.getLat();
var lng = latlng.getLng();
```

- Access via `unsafeWindow.kakao.maps.Coords` (requires `@grant unsafeWindow`).
- The library is always loaded before any route API call (user must interact with the map first), so it is safe to assume it is available at button-click time.
- **Do the conversion lazily** (at button-click time, not in the XHR load handler) to avoid cross-context issues.

### Network hook strategy

1. Install the hook at `@run-at document-start` on `unsafeWindow.XMLHttpRequest.prototype.open`.
2. In the `load` listener, `JSON.parse(this.responseText)` and check:
   - `Array.isArray(data.routes)` → public Navi API → parse immediately via `parseKakaoNaviRoute`, store WGS84 points in `unsafeWindow.__kakaoGPXRoute`.
   - `Array.isArray(data.directions)` → internal Kakao Maps API → store raw data in `unsafeWindow.__kakaoGPXRawRoute` (convert lazily at click time).
3. Hook `unsafeWindow.fetch` similarly.

### Route collection priority order

`collectRoute(win, url, doc)` tries in this order (first non-null wins):

1. `win.__kakaoGPXRoute` — XHR-captured WGS84 points (public Navi API)
2. `win.__kakaoGPXRawRoute` → `parseKakaoInternalRoute(data, win)` — XHR-captured WCONGNAMUL data, converted at click time
3. `extractRouteFromKakaoMaps(win)` — walks live `kakao.maps.Polyline` overlay objects
4. `extractRouteFromMetaTags(doc, win)` — WCONGNAMUL markers in `og:image` URL
5. `extractWaypointsFromUrl(url)` — `/link/route/Name,lat,lng/…` URL format

### Button visibility

Use `position: fixed; bottom: 80px; right: 16px; z-index: 9999` on the button. Append it to `document.body`. A `static` or `relative` position causes the button to be occluded by the absolutely-positioned map container.

### Download mechanism (CRITICAL)

**Never use `GM_download` for locally-generated content.** `GM_download` delegates to the browser's download API via the extension background page. Both blob URLs and data URIs silently fail in many Tampermonkey versions / browser configurations — the extension background context cannot access sandbox-scoped blob URLs, and data URIs are rejected or silently ignored by `chrome.downloads.download()`.

**Use a temporary `<a download>` element instead:**

```js
var a = document.createElement('a');
a.href = 'data:application/gpx+xml;charset=utf-8,' + encodeURIComponent(content);
a.download = 'kakao-route.gpx';
a.style.display = 'none';
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
```

This works because Tampermonkey shares DOM access — `document.createElement('a')` creates an element in the page's real DOM even from the sandbox. The browser handles the data URI download natively.

### Domain access

The domains `map.kakao.com`, `kko.to`, `t1.kakaocdn.net`, `ssl.daumcdn.net`, and `apis.map.kakao.com` are whitelisted for agent network access. Use `curl -sL` to inspect pages and APIs during investigation.
