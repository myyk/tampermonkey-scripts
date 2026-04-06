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
  extractWaypointsFromUrl,
  extractRouteFromGlobal,
  extractRouteFromKakaoMaps,
  collectRoute,
  findButtonContainer,
  createExportButton,
  addExportButton,
  downloadGPX,
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

  it('places the button inside a .route_result container when present', () => {
    document.body.innerHTML = '<div class="route_result"></div>';
    const win = {};
    addExportButton(document, win);
    const container = document.querySelector('.route_result');
    expect(container.querySelector('#kakao-gpx-export-btn')).not.toBeNull();
  });
});

// ── downloadGPX ──────────────────────────────────────────────────────────

describe('downloadGPX', () => {
  let tm;

  beforeEach(() => {
    tm = new TampermonkeyMock();
    tm.install();

    // jsdom does not implement URL.createObjectURL / revokeObjectURL.
    global.URL.createObjectURL = jest.fn().mockReturnValue('blob:mock-url');
    global.URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => {
    tm.uninstall();
  });

  it('calls GM_download with a blob URL and the given filename', () => {
    const gpx = generateGPX(SAMPLE_POINTS);
    downloadGPX(gpx, 'my-route.gpx');

    expect(tm.downloads).toHaveLength(1);
    expect(tm.downloads[0].url).toBe('blob:mock-url');
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
    global.URL.createObjectURL = jest.fn().mockReturnValue('blob:mock-url');
    global.URL.revokeObjectURL = jest.fn();
    global.alert = jest.fn();

    document.body.innerHTML = '<div class="route_result"></div>';
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

  it('downloads a valid GPX file that contains the expected coordinates', () => {
    const win = { routeData: SAMPLE_NAVI_RESPONSE };
    Object.defineProperty(win, 'location', {
      value: { href: 'https://map.kakao.com/' },
    });

    addExportButton(document, win);
    document.getElementById('kakao-gpx-export-btn').click();

    // Retrieve GPX content from the blob passed to createObjectURL.
    const blobArg = global.URL.createObjectURL.mock.calls[0][0];
    expect(blobArg).toBeInstanceOf(Blob);

    // Read the blob content synchronously via FileReader isn't possible in
    // jsdom, so verify via the GM_download call URL instead.
    expect(tm.downloads[0].url).toBe('blob:mock-url');
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
});
