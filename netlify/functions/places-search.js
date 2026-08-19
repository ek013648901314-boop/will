// netlify/functions/places-search.js
//
// 伺服器端函式：向 Google Places API (New) 查詢「真實」景點／餐廳資料，
// 取代原本寫死在前端的模擬 SPOTS 假資料。跟 TDX 不同，Google Places 有真實的
// 星等評分、評論則數、營業時間、照片，但仍然「沒有」真偽評論分析——那個功能
// 本質上需要真的分析大量原始評論內容做異常偵測，Google 官方 API 本身不提供，
// 前端對「真實資料」的卡片會直接隱藏假造的評論真偽分析區塊。
//
// 需要的環境變數（在 Netlify 後台設定，不要寫死在程式碼裡）：
//   GOOGLE_PLACES_API_KEY = 你的 Google Cloud API 金鑰（需啟用 Places API (New)）
//
// 用法（前端 fetch）：
//   GET /.netlify/functions/places-search?region=北部&type=attraction
//   region 對應到下面 REGION_TO_CITIES 的 key；type 是 attraction 或 restaurant（可省略＝兩者都要）

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.currentOpeningHours.openNow',
  'places.regularOpeningHours.weekdayDescriptions',
  'places.nationalPhoneNumber',
  'places.editorialSummary',
  'places.photos.name',
  'places.types',
].join(',');

// 這個 App 的地區分類（北部/中部/南部...）對應到用來搜尋的代表性縣市中文名稱。
// 一個地區通常橫跨好幾個縣市，所以查一個地區要打好幾支查詢、把結果合併起來。
const REGION_TO_CITIES = {
  '北部': ['台北', '新北', '基隆', '宜蘭', '桃園'],
  '中部': ['台中', '彰化', '南投', '雲林', '苗栗'],
  '南部': ['台南', '高雄', '嘉義', '屏東'],
  '東部': ['花蓮', '台東'],
  '離島-澎湖': ['澎湖'],
  '離島-金門': ['金門'],
  '離島-小琉球': ['小琉球'],
  '離島-其他': ['綠島', '蘭嶼'],
};

function priceLevelToText(level) {
  const map = {
    PRICE_LEVEL_FREE: '免費',
    PRICE_LEVEL_INEXPENSIVE: '$',
    PRICE_LEVEL_MODERATE: '$$',
    PRICE_LEVEL_EXPENSIVE: '$$$',
    PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
  };
  return map[level] || '';
}

// 把 Google Places 原始資料轉成這個 App 卡片/地圖需要的形狀。對每個欄位都做防呆讀取，
// 缺資料就留空，不要讓單一筆格式異常拖垮整批結果。
function normalizeSpot(raw, kind, region, apiKey) {
  const lat = raw?.location?.latitude;
  const lng = raw?.location?.longitude;
  if (lat == null || lng == null) return null; // 沒座標就沒辦法在地圖上顯示，直接跳過

  const name = raw?.displayName?.text || '未命名地點';
  const desc = raw?.editorialSummary?.text || '';
  const photoName = raw?.photos?.[0]?.name || null;
  const pictureUrl = photoName
    ? `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=480&key=${apiKey}`
    : null;

  return {
    id: 'gp-' + (raw.id || `${kind}-${lat}-${lng}`),
    name,
    type: kind === 'restaurant' ? 'restaurant' : 'attraction',
    region,
    lat: Number(lat),
    lng: Number(lng),
    address: raw.formattedAddress || '',
    phone: raw.nationalPhoneNumber || '',
    openNow: raw?.currentOpeningHours?.openNow ?? null,
    openHours: raw?.regularOpeningHours?.weekdayDescriptions || [],
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    reviews: typeof raw.userRatingCount === 'number' ? raw.userRatingCount : null,
    price: priceLevelToText(raw.priceLevel),
    desc: desc ? String(desc).slice(0, 300) : '（Google Places 目前沒有提供這個地點的簡介文字）',
    picture: pictureUrl,
    source: 'google', // 前端用這個欄位分辨「真實資料」跟「demo 模擬資料」，決定要不要顯示評論真偽分析區塊
  };
}

async function searchOneQuery(textQuery, apiKey) {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery, languageCode: 'zh-TW', maxResultCount: 10 }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.warn(`Google Places 查詢失敗（"${textQuery}"，${res.status}）：${errText.slice(0, 200)}`);
    return [];
  }
  const data = await res.json();
  return Array.isArray(data.places) ? data.places : [];
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
    // 金鑰還沒設定：回傳明確的錯誤代碼，前端會自動退回本機模擬資料，網站不會壞掉
    return {
      statusCode: 501,
      headers,
      body: JSON.stringify({ error: 'GOOGLE_PLACES_API_KEY not configured on Netlify' }),
    };
  }

  const params = event.queryStringParameters || {};
  const region = params.region;
  const type = params.type; // 'attraction' | 'restaurant' | undefined(both)
  if (!region || !REGION_TO_CITIES[region]) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少或不支援的 region 參數', validRegions: Object.keys(REGION_TO_CITIES) }) };
  }

  try {
    const cities = REGION_TO_CITIES[region];
    const kinds = type === 'attraction' ? ['attraction'] : type === 'restaurant' ? ['restaurant'] : ['attraction', 'restaurant'];

    // 每個縣市 x 每種類型組一個查詢字串，平行呼叫 Google Places（Promise.all），加快整體回應速度
    const tasks = [];
    for (const city of cities) {
      for (const kind of kinds) {
        const textQuery = kind === 'attraction' ? `${city} 景點` : `${city} 美食 餐廳`;
        tasks.push(
          searchOneQuery(textQuery, apiKey).then((list) => list.map((raw) => normalizeSpot(raw, kind, region, apiKey)).filter(Boolean))
        );
      }
    }
    const merged = (await Promise.all(tasks)).flat();

    // 用 id 去重（不同查詢字串可能搜到同一個地點）
    const seen = new Set();
    const results = merged.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));

    return { statusCode: 200, headers, body: JSON.stringify({ region, count: results.length, spots: results }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Google Places API 呼叫失敗：' + err.message }) };
  }
};
