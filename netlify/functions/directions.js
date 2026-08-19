// netlify/functions/directions.js
//
// 伺服器端函式：向 Google Routes API（新版，取代舊版 Directions API）查詢「真實道路路線」，
// 取代原本前端直接呼叫的公開 OSRM 示範伺服器（router.project-osrm.org，僅供輕量測試用）。
// 跟 places-search.js 共用同一把 GOOGLE_PLACES_API_KEY（該金鑰需額外啟用「Routes API」，
// 光啟用舊版「Directions API」不夠——Google 已經不開放新專案使用舊版 API 了）。
//
// 需要的環境變數（在 Netlify 後台設定，不要寫死在程式碼裡）：
//   GOOGLE_PLACES_API_KEY = 你的 Google Cloud API 金鑰（需啟用 Routes API）
//
// 用法（前端 fetch）：
//   GET /.netlify/functions/directions?points=25.0478,121.5170;25.0330,121.5654;25.0273,121.5760
//   points 是分號分隔的「lat,lng」清單，第一個是起點、最後一個是終點，中間是途經點

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELD_MASK = [
  'routes.polyline.encodedPolyline',
  'routes.legs.distanceMeters',
  'routes.legs.duration',
].join(',');

// Google 的路線幾何是「Encoded Polyline」格式（一段緊湊編碼字串），要解碼成 [lat,lng] 陣列才能畫在 Leaflet 地圖上。
// 這是 Google 公開的標準演算法（Routes API 跟舊版 Directions API 用同一種編碼格式）。
function decodePolyline(encoded) {
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
}

function toLatLngWaypoint(pointStr) {
  const [lat, lng] = pointStr.split(',').map(Number);
  return { location: { latLng: { latitude: lat, longitude: lng } } };
}

// Routes API 回傳的 duration 是像 "1234s" 這種字串（秒數加 s），轉成數字秒數
function parseDurationSeconds(durationStr) {
  if (!durationStr) return 0;
  return parseFloat(String(durationStr).replace('s', '')) || 0;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    // 金鑰還沒設定：回傳明確的錯誤代碼，前端會自動退回 OSRM，路線功能不會壞掉
    return { statusCode: 501, headers, body: JSON.stringify({ error: 'GOOGLE_PLACES_API_KEY not configured on Netlify' }) };
  }

  const pointsParam = (event.queryStringParameters || {}).points;
  if (!pointsParam) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 points 參數' }) };
  }

  const points = pointsParam.split(';').map((p) => p.trim()).filter(Boolean);
  if (points.length < 2) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '至少需要兩個點（起點與終點）' }) };
  }

  const origin = toLatLngWaypoint(points[0]);
  const destination = toLatLngWaypoint(points[points.length - 1]);
  const intermediates = points.slice(1, -1).map(toLatLngWaypoint);

  try {
    const res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        origin,
        destination,
        intermediates,
        travelMode: 'DRIVE',
        polylineQuality: 'OVERVIEW',
        languageCode: 'zh-TW',
        units: 'METRIC',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Google Routes API HTTP ${res.status}：${errText.slice(0, 300)}` }) };
    }
    const data = await res.json();
    if (!data.routes || !data.routes.length) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Google Routes API 沒有回傳可用路線' }) };
    }

    const route = data.routes[0];
    const latlngs = decodePolyline(route.polyline.encodedPolyline);
    const legDistKm = route.legs.map((l) => (l.distanceMeters || 0) / 1000);
    const legHours = route.legs.map((l) => parseDurationSeconds(l.duration) / 3600);

    return { statusCode: 200, headers, body: JSON.stringify({ latlngs, legDistKm, legHours }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Google Routes API 呼叫失敗：' + err.message }) };
  }
};
