import proj4 from 'proj4';

proj4.defs(
  'EPSG:26191',
  '+proj=lcc +lat_1=33.3 +lat_2=32.3 +lat_0=33.3 +lon_0=-5.4 ' +
  '+x_0=500000 +y_0=300000 +a=6378249.2 +b=6356515 +towgs84=31,146,47,0,0,0,0 ' +
  '+units=m +no_defs'
);

// Zones 2-4 follow the same Merchich / Clarke 1880 pattern, one degree
// of latitude apart (lat_0 / lat_1 = 29.7, 26.1, 22.5; lat_2 one degree
// south of lat_1), same central meridian and false origin as Zone 1.
proj4.defs(
  'EPSG:26192',
  '+proj=lcc +lat_1=29.7 +lat_2=28.7 +lat_0=29.7 +lon_0=-5.4 ' +
  '+x_0=500000 +y_0=300000 +a=6378249.2 +b=6356515 +towgs84=31,146,47,0,0,0,0 ' +
  '+units=m +no_defs'
);
proj4.defs(
  'EPSG:26194',
  '+proj=lcc +lat_1=26.1 +lat_2=25.1 +lat_0=26.1 +lon_0=-5.4 ' +
  '+x_0=500000 +y_0=300000 +a=6378249.2 +b=6356515 +towgs84=31,146,47,0,0,0,0 ' +
  '+units=m +no_defs'
);
proj4.defs(
  'EPSG:26195',
  '+proj=lcc +lat_1=22.5 +lat_2=21.5 +lat_0=22.5 +lon_0=-5.4 ' +
  '+x_0=500000 +y_0=300000 +a=6378249.2 +b=6356515 +towgs84=31,146,47,0,0,0,0 ' +
  '+units=m +no_defs'
);

export const wgs84ToLambertMarocZone1 = (lat, lng) => {
  const [x, y] = proj4('EPSG:4326', 'EPSG:26191', [lng, lat]);
  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2))
  };
};

// Lambert zone code from the TopoX picker's zone label
// ('Maroc - Zone 1' … 'Maroc - Zone 4'); Zone 1 is the default when the
// label is missing or unknown.
const zoneCode = (zoneLabel) => {
  const z = String(zoneLabel || '');
  if (/Zone 2/.test(z)) return 'EPSG:26192';
  if (/Zone 3/.test(z)) return 'EPSG:26194';
  if (/Zone 4/.test(z)) return 'EPSG:26195';
  return 'EPSG:26191';
};

// Lambert Maroc (X, Y in metres, as stored by the TopoX picker) ->
// WGS84 { lat, lng } for display on a Leaflet map, or null when the
// point cannot be placed. A converted position outside Morocco is
// rejected rather than shown in the wrong place. As a fallback, raw
// values that already look like lng/lat inside Morocco are used as-is
// (e.g. a point pasted as GPS coordinates).
export const lambertMarocToWgs84 = (x, y, zoneLabel) => {
  const numX = Number(x);
  const numY = Number(y);
  if (!Number.isFinite(numX) || !Number.isFinite(numY)) return null;
  const inMorocco = (lat, lng) => lat >= 20 && lat <= 37 && lng >= -18 && lng <= -0.5;
  try {
    const [lng, lat] = proj4(zoneCode(zoneLabel), 'EPSG:4326', [numX, numY]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && inMorocco(lat, lng)) {
      return { lat, lng };
    }
  } catch {
    // Fall through to the raw-value check below.
  }
  if (inMorocco(numY, numX)) return { lat: numY, lng: numX };
  return null;
};