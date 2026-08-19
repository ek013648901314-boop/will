// netlify/functions/directions.js
//
// 伺服器端函式：向 Google Directions API 查詢「真實道路路線」，取代原本前端直接呼叫的
// 公開 OSRM 示範伺服器（router.project-osrm.org，僅供輕量測試，非正式產品應依賴的服務）。
// 跟 places-search.js 共用同一把 GOOGLE_PLACES_API_KEY（該金鑰已同時限制允許 Directions API）。
//
// 需要的環境變數（在 Netlify 後台設定，不要寫死在程式碼裡）：
//   GOOGLE_PLACES_API_KEY = 你的 Google Cloud API 金鑰（需啟用 Directions API）
//
// 用法（前端 fetch）：
//   GET /.netlify/functions/directions?points=25.0478,121.5170;25.0330,121.5654;25.0273,121.5760
//   points 是分號分隔的「lat,lng」清單，第一個是起點、最後一個是終點，中間是途經點

const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';

// Google 的路線幾何是「Encoded Polyline」格式（一段緊湊編碼字串），要解碼成 [lat,lng] 陣列才能畫在 Leaflet 地圖上。
// 這是 Google 官方公開的標準演算法（跟 OSRM 回傳的 GeoJSON 座標陣列不同格式，所以需要這段轉換）。
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

  const origin = points[0];
  const destination = points[points.length - 1];
  const waypoints = points.slice(1, -1);

  const params = new URLSearchParams({
    origin,
    destination,
    mode: 'driving',
    language: 'zh-TW',
    key: apiKey,
  });
  if (waypoints.length) params.set('waypoints', waypoints.join('|'));

  try {
    const res = await fetch(`${DIRECTIONS_URL}?${params.toString()}`);
    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Google Directions HTTP ${res.status}：${errText.slice(0, 300)}` }) };
    }
    const data = await res.json();
    if (data.status !== 'OK' || !data.routes || !data.routes.length) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Google Directions 無可用路線（status: ${data.status}）：${data.error_message || ''}` }) };
    }

    const route = data.routes[0];
    const latlngs = decodePolyline(route.overview_polyline.points);
    const legDistKm = route.legs.map((l) => l.distance.value / 1000);
    const legHours = route.legs.map((l) => l.duration.value / 3600);

    return { statusCode: 200, headers, body: JSON.stringify({ latlngs, legDistKm, legHours }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Google Directions API 呼叫失敗：' + err.message }) };
  }
};
