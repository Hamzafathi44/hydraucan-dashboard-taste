import { useMemo, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, LayersControl } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { lambertMarocToWgs84 } from '../utils/lambertMaroc';

// Map of the incomplete Réfection entries (copy, 2026-11-27): one amber
// marker per entry that has a location. Entry locations are stored as
// Lambert Maroc X/Y (TopoX picker), so each point is converted to
// WGS84 with lambertMarocToWgs84 before it can be shown on Leaflet.
// Entries without a convertible location are never given invented
// coordinates — they are counted under the map instead.
// Lazy-loaded by RefectionView (React.lazy), so Leaflet + proj4 are
// only fetched when the "Carte" view is opened, never in the main
// bundle. Tile layers match SrmMapPicker (OSM Normal + Esri Satellite).

const DEFAULT_CENTER = [31.7917, -7.0926]; // Morocco overview

// Amber pin, matching the "Non terminées" theme. A divIcon avoids the
// broken default Leaflet marker images in bundled builds.
const incompleteIcon = L.divIcon({
  html: '<div style="width:16px;height:16px;background:#f59e0b;border:2.5px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>',
  className: '',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
  popupAnchor: [0, -10]
});

// Fits the view to all markers when the map opens or the entry list
// changes; a single marker gets a fixed street-level zoom instead
// (fitBounds on one point would zoom in too far).
function FitMarkers({ positions }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length === 0) return;
    if (positions.length === 1) {
      map.setView(positions[0], 13);
    } else {
      map.fitBounds(L.latLngBounds(positions), { padding: [40, 40] });
    }
  }, [map, positions]);
  return null;
}

export default function RefectionIncompleteMap({ entries }) {
  const { markers, unlocatedCount } = useMemo(() => {
    const list = [];
    let unlocated = 0;
    for (const entry of entries || []) {
      const pts = entry.points || [];
      let pos = null;
      // One marker per entry: the first point that converts wins.
      for (const p of pts) {
        const ll = lambertMarocToWgs84(p?.x, p?.y, p?.zone);
        if (ll) {
          pos = [ll.lat, ll.lng];
          break;
        }
      }
      if (pos) list.push({ entry, position: pos });
      else unlocated += 1;
    }
    return { markers: list, unlocatedCount: unlocated };
  }, [entries]);

  const positions = useMemo(() => markers.map((m) => m.position), [markers]);

  return (
    <div>
      <div
        className="rounded-xl overflow-hidden border border-slate-700"
        style={{ height: '60vh', minHeight: 380 }}
      >
        <MapContainer
          center={DEFAULT_CENTER}
          zoom={6}
          scrollWheelZoom
          className="w-full h-full z-0 font-sans"
        >
          <LayersControl position="topright">
            <LayersControl.BaseLayer checked name="Normal">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
            </LayersControl.BaseLayer>
            <LayersControl.BaseLayer name="Satellite">
              <TileLayer
                attribution='&copy; <a href="https://www.esri.com/">Esri</a>'
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              />
            </LayersControl.BaseLayer>
          </LayersControl>
          <FitMarkers positions={positions} />
          {markers.map(({ entry, position }) => {
            const reste = (entry.remaining || []).filter(
              (rem) => rem.nature && rem.qty !== '' && rem.qty != null
            );
            return (
              <Marker key={entry.id} position={position} icon={incompleteIcon}>
                <Popup>
                  <div style={{ minWidth: 180 }}>
                    <div className="font-bold text-sm text-slate-900">
                      {entry.reference || 'Sans référence'}
                    </div>
                    <div className="text-xs text-slate-500">{entry.date || ''}</div>
                    {entry.address ? (
                      <div className="text-xs text-slate-700 mt-1">{entry.address}</div>
                    ) : null}
                    <div className="text-xs font-bold text-amber-600 mt-2">
                      Reste à faire :
                    </div>
                    {reste.length === 0 ? (
                      <div className="text-xs text-slate-500">Aucun reste renseigné</div>
                    ) : (
                      <ul className="text-xs text-slate-700 list-disc pl-4 mt-0.5">
                        {reste.map((rem, i) => (
                          <li key={i}>
                            {rem.nature} {rem.qty} {rem.unit || 'm²'}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
      </div>
      {markers.length === 0 ? (
        <p className="text-xs text-slate-400 mt-3">
          Aucune entrée localisée sur la carte — ajoutez un point sur la carte dans le formulaire.
        </p>
      ) : unlocatedCount > 0 ? (
        <p className="text-xs text-slate-400 mt-3">
          {unlocatedCount} entrée{unlocatedCount > 1 ? 's' : ''} sans localisation — ajoutez un
          point sur la carte dans le formulaire.
        </p>
      ) : null}
    </div>
  );
}
