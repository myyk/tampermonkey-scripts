'use strict';

/**
 * Tests for kakao-gpx-export.user.js
 *
 * The test harness uses:
 *  - Jest + jsdom   (DOM emulation)
 *  - TampermonkeyMock  (GM_* API stubs)
 */

const TampermonkeyMock = require('../helpers/tampermonkey-mock');
const {
  escapeXml,
  generateGPX,
  parseKakaoNaviRoute,
  parseKakaoInternalRoute,
  extractWaypointsFromUrl,
  extractRouteFromGlobal,
  extractRouteFromKakaoMaps,
  extractRouteFromMetaTags,
  collectRoute,
  findButtonContainer,
  createExportButton,
  addExportButton,
  downloadGPX,
  looksLikeRouteData,
  installNetworkHook,
} = require('../../src/kakao-gpx-export/kakao-gpx-export.user.js');

// ── Fixtures ───────────────────────────────────────────────────────────────

const SAMPLE_POINTS = [
  { lat: 37.5665, lng: 126.978 },
  { lat: 37.567, lng: 126.979 },
  { lat: 37.5675, lng: 126.9795 },
];

const SAMPLE_NAVI_RESPONSE = {
  routes: [
    {
      summary: { distance: 1234, duration: 300 },
      sections: [
        {
          roads: [
            {
              name: 'Road A',
              vertexes: [126.978, 37.5665, 126.979, 37.567],
            },
            {
              name: 'Road B',
              vertexes: [126.979, 37.567, 126.9795, 37.5675],
            },
          ],
        },
      ],
    },
  ],
};

// Kakao Maps internal API response (from /route/bikeset.json or /route/cars.json).
// Coordinates are in WCONGNAMUL (easting,northing,elevation pipe-delimited).
const SAMPLE_INTERNAL_RESPONSE = {
  resultCode: 'SUCCESS',
  directions: [
    {
      routeMode: 'BIKE_ONLY',
      routeType: 'BIKE',
      time: 14292,
      length: 73319,
      resultCode: 'SUCCESS',
      sections: [
        {
          resultCode: 'ROUTE_RESULT_SUCCESS',
          guideList: [
            {
              seq: 1,
              guideCode: 'START',
              x: 412510.0,
              y: 1127275.0,
              link: {
                points: '412510.0,1127275.0,8.6|412520.0,1127258.0,8.7|412545.0,1127234.0,8.9',
              },
            },
            {
              seq: 2,
              guideCode: 'NONE',
              x: 412545.0,
              y: 1127234.0,
              link: {
                // Duplicate first point should be de-duplicated
                points: '412545.0,1127234.0,8.9|413119.0,1126678.0,10.4',
              },
            },
          ],
        },
      ],
    },
  ],
};

// ── Shared test helpers ────────────────────────────────────────────────────

/**
 * Build a minimal window mock that provides a kakao.maps.Coords implementation
 * for WCONGNAMUL→WGS84 conversion in tests.
 *
 * @param {{ [key: string]: { lat: number, lng: number } }} [coordMap]
 *   Optional map from "x,y" WCONGNAMUL key to WGS84 {lat, lng}.
 *   When a key is not found the returned coords default to {lat:0, lng:0}.
 * @param {object} [extra]  Extra properties to merge onto the returned window mock.
 */
function makeMockCoordsWin(coordMap, extra) {
  return {
    kakao: {
      maps: {
        Coords: jest.fn().mockImplementation(function (x, y) {
          const key = x + ',' + y;
          const wgs = (coordMap && coordMap[key]) || { lat: 0, lng: 0 };
          return {
            toLatLng: () => ({
              getLat: () => wgs.lat,
              getLng: () => wgs.lng,
            }),
          };
        }),
      },
    },
    ...extra,
  };
}

// ── escapeXml ─────────────────────────────────────────────────────────────

describe('escapeXml', () => {
  it('passes through plain text unchanged', () => {
    expect(escapeXml('Hello World')).toBe('Hello World');
  });

  it('escapes ampersand', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than and greater-than', () => {
    expect(escapeXml('<tag>')).toBe('&lt;tag&gt;');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"quoted"')).toBe('&quot;quoted&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeXml("it's")).toBe('it&apos;s');
  });

  it('handles all special chars combined', () => {
    expect(escapeXml('<a href="x&y">it\'s</a>')).toBe(
      '&lt;a href=&quot;x&amp;y&quot;&gt;it&apos;s&lt;/a&gt;'
    );
  });

  it('converts non-string values to string', () => {
    expect(escapeXml(42)).toBe('42');
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
  });
});

// ── generateGPX ──────────────────────────────────────────────────────────

describe('generateGPX', () => {
  it('produces a valid GPX 1.1 document', () => {
    const gpx = generateGPX(SAMPLE_POINTS);
    expect(gpx).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(gpx).toContain('version="1.1"');
    expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
    expect(gpx).toContain('xsi:schemaLocation=');
  });

  it('includes all track points with correct lat/lon attributes', () => {
    const gpx = generateGPX(SAMPLE_POINTS);
    expect(gpx).toContain('lat="37.5665" lon="126.978"');
    expect(gpx).toContain('lat="37.567" lon="126.979"');
    expect(gpx).toContain('lat="37.5675" lon="126.9795"');
  });

  it('wraps points in <trk><trkseg>', () => {
    const gpx = generateGPX(SAMPLE_POINTS);
    expect(gpx).toContain('<trk>');
    expect(gpx).toContain('<trkseg>');
    expect(gpx).toContain('</trkseg>');
    expect(gpx).toContain('</trk>');
  });

  it('uses the provided metadata name', () => {
    const gpx = generateGPX(SAMPLE_POINTS, { name: 'My Hike' });
    expect(gpx).toContain('<name>My Hike</name>');
  });

  it('defaults name to "Kakao Route"', () => {
    const gpx = generateGPX(SAMPLE_POINTS);
    expect(gpx).toContain('<name>Kakao Route</name>');
  });

  it('escapes XML special characters in the name', () => {
    const gpx = generateGPX(SAMPLE_POINTS, { name: 'Route & "Test" <ok>' });
    expect(gpx).toContain('Route &amp; &quot;Test&quot; &lt;ok&gt;');
    expect(gpx).not.toContain('Route & "Test" <ok>');
  });

  it('includes elevation when provided', () => {
    const pts = [{ lat: 37.5, lng: 126.9, ele: 123.4 }];
    const gpx = generateGPX(pts);
    expect(gpx).toContain('<ele>123.4</ele>');
  });

  it('omits <ele> when elevation is absent', () => {
    const pts = [{ lat: 37.5, lng: 126.9 }];
    const gpx = generateGPX(pts);
    expect(gpx).not.toContain('<ele>');
  });

  it('uses the provided time in <metadata>', () => {
    const time = '2024-01-15T09:00:00.000Z';
    const gpx = generateGPX(SAMPLE_POINTS, { time });
    expect(gpx).toContain('<time>' + time + '</time>');
  });

  it('throws when points array is empty', () => {
    expect(() => generateGPX([])).toThrow();
  });

  it('throws when points is not an array', () => {
    expect(() => generateGPX(null)).toThrow();
    expect(() => generateGPX('bad')).toThrow();
  });

  it('includes the GPX creator attribute', () => {
    const gpx = generateGPX(SAMPLE_POINTS);
    expect(gpx).toContain('creator="Kakao GPX Export"');
  });
});

// ── parseKakaoNaviRoute ───────────────────────────────────────────────────

describe('parseKakaoNaviRoute', () => {
  it('extracts all vertex coordinates from a Navi API response', () => {
    const points = parseKakaoNaviRoute(SAMPLE_NAVI_RESPONSE);
    expect(points).toHaveLength(4);
    expect(points[0]).toEqual({ lat: 37.5665, lng: 126.978 });
    expect(points[1]).toEqual({ lat: 37.567, lng: 126.979 });
    expect(points[2]).toEqual({ lat: 37.567, lng: 126.979 });
    expect(points[3]).toEqual({ lat: 37.5675, lng: 126.9795 });
  });

  it('handles longitude-first vertexes correctly', () => {
    const data = {
      routes: [
        {
          sections: [
            {
              roads: [{ vertexes: [130.0, 35.0, 131.0, 36.0] }],
            },
          ],
        },
      ],
    };
    const points = parseKakaoNaviRoute(data);
    expect(points[0].lng).toBe(130.0);
    expect(points[0].lat).toBe(35.0);
    expect(points[1].lng).toBe(131.0);
    expect(points[1].lat).toBe(36.0);
  });

  it('returns null for null input', () => {
    expect(parseKakaoNaviRoute(null)).toBeNull();
  });

  it('returns null when routes array is missing', () => {
    expect(parseKakaoNaviRoute({})).toBeNull();
  });

  it('returns null when sections are empty', () => {
    const data = { routes: [{ sections: [] }] };
    expect(parseKakaoNaviRoute(data)).toBeNull();
  });

  it('skips roads without vertexes', () => {
    const data = {
      routes: [
        {
          sections: [
            { roads: [{ name: 'empty' }, { vertexes: [126.0, 37.0] }] },
          ],
        },
      ],
    };
    const points = parseKakaoNaviRoute(data);
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({ lat: 37.0, lng: 126.0 });
  });

  it('handles an odd-length vertexes array gracefully', () => {
    const data = {
      routes: [
        {
          sections: [{ roads: [{ vertexes: [126.0, 37.0, 127.0] }] }],
        },
      ],
    };
    // Only the complete pair [126.0, 37.0] should be parsed.
    const points = parseKakaoNaviRoute(data);
    expect(points).toHaveLength(1);
  });
});

// ── parseKakaoInternalRoute ───────────────────────────────────────────────

describe('parseKakaoInternalRoute', () => {
  it('returns null for null input', () => {
    expect(parseKakaoInternalRoute(null, {})).toBeNull();
  });

  it('returns null when directions array is missing', () => {
    expect(parseKakaoInternalRoute({}, {})).toBeNull();
  });

  it('returns null when directions array is empty', () => {
    expect(parseKakaoInternalRoute({ directions: [] }, {})).toBeNull();
  });

  it('returns null when kakao.maps.Coords is unavailable', () => {
    expect(parseKakaoInternalRoute(SAMPLE_INTERNAL_RESPONSE, {})).toBeNull();
  });

  it('parses link.points and converts WCONGNAMUL to WGS84', () => {
    const coordMap = {
      '412510,1127275': { lat: 37.57, lng: 126.61 },
      '412520,1127258': { lat: 37.56, lng: 126.62 },
      '412545,1127234': { lat: 37.55, lng: 126.63 },
      '413119,1126678': { lat: 37.50, lng: 126.70 },
    };
    const win = makeMockCoordsWin(coordMap);
    const points = parseKakaoInternalRoute(SAMPLE_INTERNAL_RESPONSE, win);

    // 4 unique points (duplicate 412545,1127234 at start of 2nd segment is skipped)
    expect(points).toHaveLength(4);
    expect(points[0]).toMatchObject({ lat: 37.57, lng: 126.61 });
    expect(points[3]).toMatchObject({ lat: 37.50, lng: 126.70 });
  });

  it('includes elevation when provided', () => {
    const win = makeMockCoordsWin({ '412510,1127275': { lat: 37.57, lng: 126.61 } });
    const data = {
      directions: [{
        sections: [{
          guideList: [{
            link: { points: '412510.0,1127275.0,8.6' },
          }],
        }],
      }],
    };
    const points = parseKakaoInternalRoute(data, win);
    expect(points).toHaveLength(1);
    expect(points[0].ele).toBeCloseTo(8.6);
  });

  it('deduplicates consecutive identical WCONGNAMUL coordinates', () => {
    const win = makeMockCoordsWin({
      '412510,1127275': { lat: 37.57, lng: 126.61 },
      '412520,1127258': { lat: 37.56, lng: 126.62 },
    });
    const data = {
      directions: [{
        sections: [{
          guideList: [
            { link: { points: '412510.0,1127275.0,8.6|412520.0,1127258.0,8.7' } },
            // First point of this segment duplicates last of previous — should be skipped
            { link: { points: '412520.0,1127258.0,8.7|412510.0,1127275.0,8.6' } },
          ],
        }],
      }],
    };
    const points = parseKakaoInternalRoute(data, win);
    // 2 unique points from first segment + 1 new (duplicate of first skipped) from second
    // = "412510", "412520", then "412510" is new (not same as previous "412520")
    expect(points).toHaveLength(3);
  });

  it('skips guide items without a link.points string', () => {
    const win = makeMockCoordsWin({ '412510,1127275': { lat: 37.57, lng: 126.61 } });
    const data = {
      directions: [{
        sections: [{
          guideList: [
            { link: null },
            { link: { points: '412510.0,1127275.0,8.6' } },
          ],
        }],
      }],
    };
    const points = parseKakaoInternalRoute(data, win);
    expect(points).toHaveLength(1);
  });
});

// ── extractWaypointsFromUrl ───────────────────────────────────────────────

describe('extractWaypointsFromUrl', () => {
  it('extracts two waypoints from a standard /link/route/ URL', () => {
    const url =
      'https://map.kakao.com/link/route/Seoul Station,37.5547,126.9707/Gyeongbokgung,37.5796,126.977';
    const wps = extractWaypointsFromUrl(url);
    expect(wps).toHaveLength(2);
    expect(wps[0]).toEqual({
      name: 'Seoul Station',
      lat: 37.5547,
      lng: 126.9707,
    });
    expect(wps[1]).toEqual({
      name: 'Gyeongbokgung',
      lat: 37.5796,
      lng: 126.977,
    });
  });

  it('extracts three waypoints (with intermediate stop)', () => {
    const url =
      'https://map.kakao.com/link/route/A,1.0,2.0/B,3.0,4.0/C,5.0,6.0';
    const wps = extractWaypointsFromUrl(url);
    expect(wps).toHaveLength(3);
    expect(wps[2]).toEqual({ name: 'C', lat: 5.0, lng: 6.0 });
  });

  it('returns null for a non-route URL', () => {
    expect(
      extractWaypointsFromUrl('https://map.kakao.com/link/map/Seoul,37.5,126.9')
    ).toBeNull();
  });

  it('returns null for null / undefined input', () => {
    expect(extractWaypointsFromUrl(null)).toBeNull();
    expect(extractWaypointsFromUrl(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractWaypointsFromUrl('')).toBeNull();
  });

  it('skips segments with non-numeric coordinates', () => {
    const url = 'https://map.kakao.com/link/route/A,bad,bad/B,37.0,127.0';
    const wps = extractWaypointsFromUrl(url);
    expect(wps).toHaveLength(1);
    expect(wps[0].name).toBe('B');
  });

  it('handles place names that contain commas', () => {
    const url =
      'https://map.kakao.com/link/route/Seoul,Korea,37.5547,126.9707/Busan,Korea,35.1796,129.0756';
    const wps = extractWaypointsFromUrl(url);
    expect(wps).toHaveLength(2);
    expect(wps[0].name).toBe('Seoul,Korea');
    expect(wps[0].lat).toBe(37.5547);
    expect(wps[0].lng).toBe(126.9707);
  });
});

// ── extractRouteFromGlobal ───────────────────────────────────────────────

describe('extractRouteFromGlobal', () => {
  it('reads XHR-captured route from window.__kakaoGPXRoute', () => {
    const win = { __kakaoGPXRoute: SAMPLE_POINTS };
    const points = extractRouteFromGlobal(win);
    expect(points).toBe(SAMPLE_POINTS);
  });

  it('reads routeData from window.routeData', () => {
    const win = { routeData: SAMPLE_NAVI_RESPONSE };
    const points = extractRouteFromGlobal(win);
    expect(points).not.toBeNull();
    expect(points.length).toBeGreaterThan(0);
  });

  it('reads route from window.__NEXT_DATA__.props.pageProps.route', () => {
    const win = {
      __NEXT_DATA__: {
        props: { pageProps: { route: SAMPLE_NAVI_RESPONSE } },
      },
    };
    const points = extractRouteFromGlobal(win);
    expect(points).not.toBeNull();
    expect(points.length).toBeGreaterThan(0);
  });

  it('reads routeData from window.Kakao.routeData', () => {
    const win = { Kakao: { routeData: SAMPLE_NAVI_RESPONSE } };
    const points = extractRouteFromGlobal(win);
    expect(points).not.toBeNull();
  });

  it('reads routeData from window.kakaoNavi.routeData', () => {
    const win = { kakaoNavi: { routeData: SAMPLE_NAVI_RESPONSE } };
    const points = extractRouteFromGlobal(win);
    expect(points).not.toBeNull();
  });

  it('returns null when no recognisable global data exists', () => {
    expect(extractRouteFromGlobal({})).toBeNull();
  });

  it('returns null for null window', () => {
    expect(extractRouteFromGlobal(null)).toBeNull();
  });
});

// ── extractRouteFromKakaoMaps ─────────────────────────────────────────────

describe('extractRouteFromKakaoMaps', () => {
  it('returns null when kakao global is absent', () => {
    expect(extractRouteFromKakaoMaps({})).toBeNull();
  });

  it('returns null when kakao.maps is absent', () => {
    expect(extractRouteFromKakaoMaps({ kakao: {} })).toBeNull();
  });

  it('extracts path from a polyline stored in map overlays', () => {
    const mockLatLngs = [
      { getLat: () => 37.5, getLng: () => 126.9 },
      { getLat: () => 37.6, getLng: () => 127.0 },
    ];
    const mockPolyline = {
      getPath: jest.fn().mockReturnValue(mockLatLngs),
    };
    const mockMap = {
      overlayMapTypes: {
        getArray: () => [mockPolyline],
      },
    };
    const win = {
      kakao: { maps: { Map: class {} } },
      _map: mockMap,
    };

    const points = extractRouteFromKakaoMaps(win);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ lat: 37.5, lng: 126.9 });
    expect(points[1]).toEqual({ lat: 37.6, lng: 127.0 });
  });
});

// ── collectRoute ──────────────────────────────────────────────────────────

describe('collectRoute', () => {
  it('prefers XHR-captured route (__kakaoGPXRoute) over everything else', () => {
    const win = {
      __kakaoGPXRoute: SAMPLE_POINTS,
      routeData: SAMPLE_NAVI_RESPONSE,
    };
    const points = collectRoute(win, 'https://map.kakao.com/link/route/A,37.1,127.1/B,37.2,127.2');
    expect(points).toBe(SAMPLE_POINTS);
  });

  it('prefers global state over URL', () => {
    const win = { routeData: SAMPLE_NAVI_RESPONSE };
    const url =
      'https://map.kakao.com/link/route/A,37.1,127.1/B,37.2,127.2';
    const points = collectRoute(win, url);
    // Should have 4 points from the Navi response, not 2 from the URL.
    expect(points.length).toBe(4);
  });

  it('falls back to URL parsing when no global data', () => {
    const win = {};
    const url =
      'https://map.kakao.com/link/route/A,37.5547,126.9707/B,37.5796,126.977';
    const points = collectRoute(win, url);
    expect(points).toHaveLength(2);
    expect(points[0].lat).toBe(37.5547);
  });

  it('returns null when nothing is available', () => {
    const points = collectRoute({}, 'https://map.kakao.com/');
    expect(points).toBeNull();
  });

  it('uses internal Kakao route data (CAPTURED_INTERNAL_KEY) when available', () => {
    const win = makeMockCoordsWin(null, {
      __kakaoGPXRawRoute: SAMPLE_INTERNAL_RESPONSE,
    });
    const points = collectRoute(win, 'https://map.kakao.com/');
    expect(points).not.toBeNull();
    expect(points.length).toBeGreaterThan(0);
  });
});

// ── looksLikeRouteData ────────────────────────────────────────────────────

describe('looksLikeRouteData', () => {
  it('returns true for a valid Kakao Navi API response', () => {
    expect(looksLikeRouteData(SAMPLE_NAVI_RESPONSE)).toBe(true);
  });

  it('returns true for a valid Kakao internal API response (directions format)', () => {
    expect(looksLikeRouteData(SAMPLE_INTERNAL_RESPONSE)).toBe(true);
  });

  it('returns false for non-object values', () => {
    expect(looksLikeRouteData(null)).toBe(false);
    expect(looksLikeRouteData('string')).toBe(false);
    expect(looksLikeRouteData(42)).toBe(false);
  });

  it('returns false when routes is missing and directions is missing', () => {
    expect(looksLikeRouteData({})).toBe(false);
  });

  it('returns false when routes is empty', () => {
    expect(looksLikeRouteData({ routes: [] })).toBe(false);
  });

  it('returns false when directions is empty', () => {
    expect(looksLikeRouteData({ directions: [] })).toBe(false);
  });

  it('returns false when first route has no sections', () => {
    expect(looksLikeRouteData({ routes: [{}] })).toBe(false);
  });

  it('returns false when first direction has no sections', () => {
    expect(looksLikeRouteData({ directions: [{}] })).toBe(false);
  });
});

// ── installNetworkHook ────────────────────────────────────────────────────

describe('installNetworkHook', () => {
  it('does nothing when win is null', () => {
    expect(() => installNetworkHook(null)).not.toThrow();
  });

  it('does nothing when XMLHttpRequest is absent', () => {
    expect(() => installNetworkHook({})).not.toThrow();
  });

  it('stores parsed route in win.__kakaoGPXRoute on XHR load', () => {
    // Build a minimal fake XHR that synchronously fires a load event.
    const listeners = [];
    function FakeXHR() {}
    FakeXHR.prototype.open = function () {};
    FakeXHR.prototype.addEventListener = function (type, fn) {
      if (type === 'load') listeners.push(fn);
    };
    FakeXHR.prototype.send = function () {};

    const win = { XMLHttpRequest: FakeXHR };
    installNetworkHook(win);

    // Simulate an XHR instance opening a request.
    const xhr = new FakeXHR();
    xhr.open('GET', 'https://apis-navi.kakaomobility.com/v1/directions');

    // Simulate a successful response with route data.
    xhr.status = 200;
    xhr.responseText = JSON.stringify(SAMPLE_NAVI_RESPONSE);

    // Fire all registered load listeners.
    listeners.forEach((fn) => fn.call(xhr));

    expect(win.__kakaoGPXRoute).toBeDefined();
    expect(win.__kakaoGPXRoute.length).toBeGreaterThan(0);
  });

  it('stores raw internal-format response in win.__kakaoGPXRawRoute on XHR load', () => {
    const listeners = [];
    function FakeXHR3() {}
    FakeXHR3.prototype.open = function () {};
    FakeXHR3.prototype.addEventListener = function (type, fn) {
      if (type === 'load') listeners.push(fn);
    };

    const win = { XMLHttpRequest: FakeXHR3 };
    installNetworkHook(win);

    const xhr = new FakeXHR3();
    xhr.open('GET', 'https://map.kakao.com/route/bikeset.json');
    xhr.status = 200;
    xhr.responseText = JSON.stringify(SAMPLE_INTERNAL_RESPONSE);
    listeners.forEach((fn) => fn.call(xhr));

    // The hook re-parses the JSON string, so it's a new object with the same shape.
    expect(win.__kakaoGPXRawRoute).toStrictEqual(SAMPLE_INTERNAL_RESPONSE);
    // __kakaoGPXRoute should NOT be set (internal format is not pre-converted)
    expect(win.__kakaoGPXRoute).toBeUndefined();
  });

  it('does not overwrite win.__kakaoGPXRoute for non-route responses', () => {
    const listeners = [];
    function FakeXHR2() {}
    FakeXHR2.prototype.open = function () {};
    FakeXHR2.prototype.addEventListener = function (type, fn) {
      if (type === 'load') listeners.push(fn);
    };

    const win = { XMLHttpRequest: FakeXHR2, __kakaoGPXRoute: SAMPLE_POINTS };
    installNetworkHook(win);

    const xhr = new FakeXHR2();
    xhr.open('GET', 'https://example.com/api/other');
    xhr.status = 200;
    xhr.responseText = JSON.stringify({ data: 'not a route' });
    listeners.forEach((fn) => fn.call(xhr));

    // Should remain unchanged.
    expect(win.__kakaoGPXRoute).toBe(SAMPLE_POINTS);
  });

  it('stores parsed route from fetch response', async () => {
    const win = {
      XMLHttpRequest: class {
        open() {}
        addEventListener() {}
      },
    };

    // Provide a fake fetch that resolves with the route response.
    win.fetch = jest.fn().mockResolvedValue({
      clone: () => ({
        json: () => Promise.resolve(SAMPLE_NAVI_RESPONSE),
      }),
    });

    installNetworkHook(win);

    // Trigger the hooked fetch.
    await win.fetch('https://apis-navi.kakaomobility.com/v1/directions');

    // Give the .then() chain a tick to resolve.
    await Promise.resolve();

    expect(win.__kakaoGPXRoute).toBeDefined();
    expect(win.__kakaoGPXRoute.length).toBeGreaterThan(0);
  });

  it('stores internal format response in __kakaoGPXRawRoute via fetch hook', async () => {
    const win = {
      XMLHttpRequest: class {
        open() {}
        addEventListener() {}
      },
    };

    win.fetch = jest.fn().mockResolvedValue({
      clone: () => ({
        json: () => Promise.resolve(SAMPLE_INTERNAL_RESPONSE),
      }),
    });

    installNetworkHook(win);
    await win.fetch('https://map.kakao.com/route/bikeset.json');
    await Promise.resolve();

    expect(win.__kakaoGPXRawRoute).toBe(SAMPLE_INTERNAL_RESPONSE); // fetch gives the object directly (no re-parse)
  });
});

// ── extractRouteFromMetaTags ──────────────────────────────────────────────

describe('extractRouteFromMetaTags', () => {
  const OG_IMAGE_WITH_MARKERS =
    'http://ssl.daumcdn.net/map3/staticmap/image?srs=WCONGNAMUL' +
    '&markers=symbol:route_start_marker%7Clocation:412488.07,1127252.97' +
    '&markers=symbol:route_end_marker%7Clocation:548385.01,1124839.94';

  it('returns null when doc is null', () => {
    expect(extractRouteFromMetaTags(null, {})).toBeNull();
  });

  it('returns null when og:image meta tag is absent', () => {
    document.body.innerHTML = '';
    expect(extractRouteFromMetaTags(document, {})).toBeNull();
  });

  it('returns null when og:image has no location markers', () => {
    document.head.innerHTML =
      '<meta property="og:image" content="http://example.com/image.png">';
    expect(extractRouteFromMetaTags(document, {})).toBeNull();
  });

  it('returns null when only one marker is present (need ≥ 2)', () => {
    document.head.innerHTML =
      '<meta property="og:image" content="http://example.com/?location:1.0,2.0">';
    expect(extractRouteFromMetaTags(document, {})).toBeNull();
  });

  it('returns converted points when kakao.maps.Coords is available', () => {
    document.head.innerHTML =
      `<meta property="og:image" content="${OG_IMAGE_WITH_MARKERS}">`;

    const mockToLatLng = jest
      .fn()
      .mockReturnValueOnce({ getLat: () => 37.57, getLng: () => 126.61 })
      .mockReturnValueOnce({ getLat: () => 37.45, getLng: () => 127.14 });

    const mockCoordsConstructor = jest.fn().mockImplementation(() => ({
      toLatLng: mockToLatLng,
    }));

    const win = {
      kakao: { maps: { Coords: mockCoordsConstructor } },
    };

    const points = extractRouteFromMetaTags(document, win);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ lat: 37.57, lng: 126.61 });
    expect(points[1]).toEqual({ lat: 37.45, lng: 127.14 });
    expect(mockCoordsConstructor).toHaveBeenCalledWith(412488.07, 1127252.97);
    expect(mockCoordsConstructor).toHaveBeenCalledWith(548385.01, 1124839.94);
  });

  it('returns null when kakao.maps.Coords is unavailable', () => {
    document.head.innerHTML =
      `<meta property="og:image" content="${OG_IMAGE_WITH_MARKERS}">`;
    // No kakao.maps available → can't convert WCONGNAMUL → WGS84
    expect(extractRouteFromMetaTags(document, {})).toBeNull();
  });
});

// ── DOM helpers ───────────────────────────────────────────────────────────

describe('findButtonContainer', () => {
  it('returns the route_result element when present', () => {
    document.body.innerHTML = '<div class="route_result"></div>';
    const container = findButtonContainer(document);
    expect(container.className).toBe('route_result');
  });

  it('falls back to body when no known selector matches', () => {
    document.body.innerHTML = '<div class="unknown"></div>';
    const container = findButtonContainer(document);
    expect(container).toBe(document.body);
  });
});

describe('createExportButton', () => {
  it('creates a button with id "kakao-gpx-export-btn"', () => {
    const btn = createExportButton(document, () => {});
    expect(btn.id).toBe('kakao-gpx-export-btn');
  });

  it('has text "Export GPX"', () => {
    const btn = createExportButton(document, () => {});
    expect(btn.textContent).toBe('Export GPX');
  });

  it('uses position:fixed so it is always visible above map layers', () => {
    const btn = createExportButton(document, () => {});
    expect(btn.style.position).toBe('fixed');
  });

  it('fires the onClick callback when clicked', () => {
    const onClick = jest.fn();
    const btn = createExportButton(document, onClick);
    document.body.appendChild(btn);
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

// ── addExportButton ───────────────────────────────────────────────────────

describe('addExportButton', () => {
  it('inserts the button into the DOM', () => {
    document.body.innerHTML = '';
    const win = {};
    addExportButton(document, win);
    expect(document.getElementById('kakao-gpx-export-btn')).not.toBeNull();
  });

  it('is idempotent (does not add duplicate buttons)', () => {
    document.body.innerHTML = '';
    const win = {};
    addExportButton(document, win);
    addExportButton(document, win);
    const buttons = document.querySelectorAll('#kakao-gpx-export-btn');
    expect(buttons.length).toBe(1);
  });

  it('appends the button to body (position:fixed so DOM location does not matter)', () => {
    document.body.innerHTML = '';
    const win = {};
    addExportButton(document, win);
    expect(document.body.querySelector('#kakao-gpx-export-btn')).not.toBeNull();
  });
});

// ── downloadGPX ──────────────────────────────────────────────────────────

describe('downloadGPX', () => {
  let tm;

  beforeEach(() => {
    tm = new TampermonkeyMock();
    tm.install();
  });

  afterEach(() => {
    tm.uninstall();
  });

  it('calls GM_download with a data URI and the given filename', () => {
    const gpx = generateGPX(SAMPLE_POINTS);
    downloadGPX(gpx, 'my-route.gpx');

    expect(tm.downloads).toHaveLength(1);
    expect(tm.downloads[0].url).toMatch(/^data:application\/gpx\+xml;charset=utf-8,/);
    expect(tm.downloads[0].filename).toBe('my-route.gpx');
  });

  it('defaults filename to "kakao-route.gpx"', () => {
    downloadGPX(generateGPX(SAMPLE_POINTS));
    expect(tm.downloads[0].filename).toBe('kakao-route.gpx');
  });

  it('falls back to an <a> element when GM_download is unavailable', () => {
    tm.uninstall();
    delete global.GM_download;

    const appendSpy = jest.spyOn(document.body, 'appendChild');
    const removeSpy = jest.spyOn(document.body, 'removeChild');

    downloadGPX(generateGPX(SAMPLE_POINTS), 'route.gpx');

    expect(appendSpy).toHaveBeenCalled();
    const anchorArg = appendSpy.mock.calls[0][0];
    expect(anchorArg.tagName).toBe('A');
    expect(anchorArg.download).toBe('route.gpx');
    expect(anchorArg.href).toMatch(/^data:application\/gpx\+xml;charset=utf-8,/);
    expect(removeSpy).toHaveBeenCalled();

    appendSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

// ── Full integration: button click triggers GPX download ──────────────────

describe('Integration: Export GPX button click', () => {
  let tm;

  beforeEach(() => {
    tm = new TampermonkeyMock();
    tm.install();
    global.alert = jest.fn();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    tm.uninstall();
  });

  it('downloads a GPX file when route data is available in global state', () => {
    const win = { routeData: SAMPLE_NAVI_RESPONSE };
    Object.defineProperty(win, 'location', {
      value: { href: 'https://map.kakao.com/' },
    });

    addExportButton(document, win);
    document.getElementById('kakao-gpx-export-btn').click();

    expect(tm.downloads).toHaveLength(1);
    expect(tm.downloads[0].filename).toBe('kakao-route.gpx');
  });

  it('downloads a GPX file when route is captured via XHR hook', () => {
    const win = { __kakaoGPXRoute: SAMPLE_POINTS };
    Object.defineProperty(win, 'location', {
      value: { href: 'https://map.kakao.com/' },
    });

    addExportButton(document, win);
    document.getElementById('kakao-gpx-export-btn').click();

    expect(tm.downloads).toHaveLength(1);
    expect(tm.downloads[0].filename).toBe('kakao-route.gpx');
  });

  it('downloads a valid GPX file that contains the expected coordinates', () => {
    const win = { routeData: SAMPLE_NAVI_RESPONSE };
    Object.defineProperty(win, 'location', {
      value: { href: 'https://map.kakao.com/' },
    });

    addExportButton(document, win);
    document.getElementById('kakao-gpx-export-btn').click();

    // GM_download should have been called with a data URI.
    expect(tm.downloads).toHaveLength(1);
    const dataUri = tm.downloads[0].url;
    expect(dataUri).toMatch(/^data:application\/gpx\+xml;charset=utf-8,/);

    // Decode the data URI and verify it contains GPX track points.
    const gpxContent = decodeURIComponent(dataUri.replace(/^data:[^,]+,/, ''));
    expect(gpxContent).toContain('<trkpt');
    expect(gpxContent).toContain('lat="37.5665"');
  });

  it('shows an alert when no route data is available', () => {
    const win = {};
    Object.defineProperty(win, 'location', {
      value: { href: 'https://map.kakao.com/' },
    });

    addExportButton(document, win);
    document.getElementById('kakao-gpx-export-btn').click();

    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('No route data found')
    );
    expect(tm.downloads).toHaveLength(0);
  });

  it('downloads GPX when internal Kakao route is captured via XHR hook then button is clicked', () => {
    // This is the key real-world scenario:
    //   1. Page loads and the Tampermonkey network hook intercepts /route/bikeset.json
    //   2. User opens the route page, which triggers the XHR, populating __kakaoGPXRawRoute
    //   3. User clicks "Export GPX" — collectRoute converts WCONGNAMUL via kakao.maps.Coords
    //      and generateGPX/downloadGPX produce the output

    // Build a fake XHR harness.
    const xhrListeners = [];
    function FakeXHR() {}
    FakeXHR.prototype.open = function () {};
    FakeXHR.prototype.addEventListener = function (type, fn) {
      if (type === 'load') xhrListeners.push(fn);
    };

    // Mock window that has both XHR (for the hook) and kakao.maps.Coords
    // (for WCONGNAMUL→WGS84 conversion at click time).
    const coordMap = {
      '412510,1127275': { lat: 37.57, lng: 126.61 },
      '412520,1127258': { lat: 37.56, lng: 126.62 },
      '412545,1127234': { lat: 37.55, lng: 126.63 },
      '413119,1126678': { lat: 37.50, lng: 126.70 },
    };
    const win = makeMockCoordsWin(coordMap, { XMLHttpRequest: FakeXHR });
    Object.defineProperty(win, 'location', { value: { href: 'https://map.kakao.com/' } });

    // Step 1 – install hook at document-start.
    installNetworkHook(win);

    // Step 2 – simulate the page's XHR fetching /route/bikeset.json.
    const xhr = new FakeXHR();
    xhr.open('GET', '/route/bikeset.json');
    xhr.status = 200;
    xhr.responseText = JSON.stringify(SAMPLE_INTERNAL_RESPONSE);
    xhrListeners.forEach((fn) => fn.call(xhr));

    // The raw route data must now be stored on win.
    expect(win.__kakaoGPXRawRoute).toBeDefined();

    // Step 3 – inject button and click it.
    addExportButton(document, win);
    document.getElementById('kakao-gpx-export-btn').click();

    // The download should have been triggered (no alert, one download entry).
    expect(global.alert).not.toHaveBeenCalled();
    expect(tm.downloads).toHaveLength(1);
    expect(tm.downloads[0].filename).toBe('kakao-route.gpx');

    // The URL should be a data URI containing valid GPX.
    const dataUri = tm.downloads[0].url;
    expect(dataUri).toMatch(/^data:application\/gpx\+xml;charset=utf-8,/);
    const gpxContent = decodeURIComponent(dataUri.replace(/^data:[^,]+,/, ''));
    expect(gpxContent).toContain('<trkpt');
    // Check one of the converted WGS84 coordinates appears in the output.
    expect(gpxContent).toContain('lat="37.57"');
    expect(gpxContent).toContain('lon="126.61"');
  });
});
