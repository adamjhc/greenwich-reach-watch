// The MapLibre map: base style, controls, the tier label and a marker per boat.

import type { IControl, LngLatLike, Map as MapLibreMap, Marker, NavigationControl, Popup } from 'maplibre-gl';

import type { PositionedVessel } from '#shared/types.ts';

import { el, narrow, reduceMotion } from './dom.ts';
import { titleCase } from './format.ts';
import type { MarkerKind } from './vessels.ts';
import { isMoving, isStale, legend, popup, rotation, shape, vesselCategory } from './vessels.ts';

// MapLibre comes from a <script> tag in index.html rather than the bundle.
declare const maplibregl: {
  readonly Map: typeof MapLibreMap;
  readonly Marker: typeof Marker;
  readonly NavigationControl: typeof NavigationControl;
  readonly Popup: typeof Popup;
};

// Plus code 9C3XFXMM+HP (FXMM+HP London), Greenwich Reach.
const TIER_LAT = 51.483937;
const TIER_LON = -0.015688;

const RESET_ICON = `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="5" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="9" cy="9" r="1.75" fill="currentColor"/><path d="M9 1v3M9 14v3M1 9h3M14 9h3" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`;
const TIER_ICON = `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/></svg>`;

interface View {
  readonly center: LngLatLike;
  readonly zoom: number;
}

const dark = matchMedia('(prefers-color-scheme: dark)');
const markers = new Map<number, Marker>();

function styleUrl(): string {
  return `https://tiles.openfreemap.org/styles/${dark.matches ? 'dark' : 'positron'}`;
}

// Centred just north of the tier so both banks are in view.
function homeView(): View {
  return { center: [TIER_LON, TIER_LAT + 0.002], zoom: narrow() ? 13.6 : 14.6 };
}

const map = new maplibregl.Map({
  container: 'map',
  style: styleUrl(),
  ...homeView(),
  // Headings are drawn relative to north, so keep the map north-up.
  dragRotate: false,
  pitchWithRotate: false,
  attributionControl: { compact: true },
});

function moveTo(view: View): void {
  if (reduceMotion) {
    map.jumpTo(view);
  } else {
    map.flyTo({ ...view, duration: 800 });
  }
}

// A map control whose element is built when it's added and removed with it.
function control(build: () => HTMLElement): IControl {
  let element: HTMLElement | null = null;
  return {
    onAdd: () => {
      element = build();
      return element;
    },
    onRemove: () => {
      element?.remove();
      element = null;
    },
  };
}

function resetViewButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reset-view';
  button.title = 'Reset map view';
  button.setAttribute('aria-label', 'Reset map view');
  button.innerHTML = RESET_ICON;
  button.addEventListener('click', () => {
    moveTo(homeView());
  });
  return button;
}

function resetViewControl(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'maplibregl-ctrl maplibregl-ctrl-group';
  div.append(resetViewButton());
  return div;
}

function legendControl(): HTMLElement {
  const details = document.createElement('details');
  details.className = 'legend maplibregl-ctrl';
  details.open = !narrow();
  details.innerHTML = legend();
  return details;
}

function tierLabel(): HTMLElement {
  const label = document.createElement('div');
  label.className = 'tier-label';
  label.innerHTML = `${TIER_ICON}Greenwich Tier`;
  return label;
}

function setUpMap(): void {
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  map.addControl(control(resetViewControl), 'top-left');
  map.addControl(control(legendControl), 'top-right');
  dark.addEventListener('change', () => {
    map.setStyle(styleUrl());
  });
  new maplibregl.Marker({ element: tierLabel(), anchor: 'left', offset: [-7, 0] })
    .setLngLat([TIER_LON, TIER_LAT])
    .addTo(map);
}

function markerFor(v: PositionedVessel): Marker {
  const existing = markers.get(v.mmsi);
  if (existing) {
    return existing.setLngLat([v.lon, v.lat]);
  }
  const element = document.createElement('div');
  element.className = 'boat';
  const marker = new maplibregl.Marker({ element })
    .setLngLat([v.lon, v.lat])
    .setPopup(new maplibregl.Popup({ offset: 14, maxWidth: '280px' }))
    .addTo(map);
  markers.set(v.mmsi, marker);
  return marker;
}

// Ships at the tier stand out most, then moving boats.
function prominence(kind: MarkerKind, moving: boolean): { readonly size: number; readonly layer: number } {
  if (kind === 'tier') {
    return { size: 26, layer: 3 };
  }
  return moving ? { size: 20, layer: 2 } : { size: 14, layer: 1 };
}

function drawVessel(v: PositionedVessel, tierNames: ReadonlySet<string>): void {
  const kind = vesselCategory(v, tierNames);
  const moving = isMoving(v);
  const { size, layer } = prominence(kind, moving);
  const marker = markerFor(v);
  const element = marker.getElement();
  element.innerHTML = shape({ kind, moving, degrees: rotation(v), size });
  element.title = titleCase(v.name) || `MMSI ${v.mmsi}`;
  element.style.zIndex = String(layer);
  element.classList.toggle('stale', isStale(v));
  marker.getPopup().setHTML(popup(v, kind));
}

function renderMarkers(vessels: readonly PositionedVessel[], tierNames: ReadonlySet<string>): void {
  const seen = new Set<number>();
  for (const v of vessels) {
    seen.add(v.mmsi);
    drawVessel(v, tierNames);
  }
  for (const [mmsi, marker] of markers) {
    if (!seen.has(mmsi)) {
      marker.remove();
      markers.delete(mmsi);
    }
  }
}

function focusVessel(mmsi: number): void {
  const marker = markers.get(mmsi);
  if (!marker) {
    return;
  }
  moveTo({ center: marker.getLngLat(), zoom: Math.max(map.getZoom(), 15.5) });
  if (!marker.getPopup().isOpen()) {
    marker.togglePopup();
  }
  if (narrow()) {
    el('map').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  }
}

export { focusVessel, renderMarkers, setUpMap };
