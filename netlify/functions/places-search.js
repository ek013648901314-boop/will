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
  'places.reviews', // 最多 5 則 Google 真實評論原文，給前端做「評論優缺點摘要」用（不是我們自己虛構的）
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

// Google Places 的 types 欄位（例如 tourist_attraction、cafe、park...）拿來粗略對應這個 App 原本
// demo 資料手工標註的風格標籤。這是「盡量猜」而非精準分類——Google 不會告訴我們一個景點是不是
// 適合寵物或適合長輩，只能靠地點類型做合理推測，跟 demo 資料的人工標註品質沒辦法比。
const TYPE_TO_TAGS = {
  tourist_attraction: ['igphoto'],
  museum: ['igphoto'],
  art_gallery: ['igphoto', 'couple'],
  park: ['adventure', 'free', 'kid', 'pet'], // 公園通常適合小孩跑跳消耗體力，也多半可以帶寵物散步
  natural_feature: ['adventure', 'free'],
  hiking_area: ['adventure', 'free', 'pet'],
  national_park: ['adventure', 'free'],
  playground: ['kid', 'free'],
  amusement_park: ['kid', 'friends'],
  zoo: ['kid'],
  aquarium: ['kid'],
  spa: ['couple'],
  night_club: ['friends'],
  bar: ['friends'],
  cafe: ['couple', 'igphoto', 'foodie'],
  bakery: ['foodie'],
  dessert_shop: ['foodie', 'couple'],
  restaurant: ['foodie'],
};
function guessTagsFromTypes(types) {
  const tags = new Set();
  (types || []).forEach((t) => (TYPE_TO_TAGS[t] || []).forEach((tag) => tags.add(tag)));
  if (!tags.size) tags.add('friends'); // 完全猜不到就給一個最不會出錯的通用標籤，避免篩選時整個消失
  return [...tags];
}

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

  // Google 最多附 5 則真實評論原文，簡化欄位後帶給前端做「評論優缺點摘要」（交給 Claude 分析，不是我們虛構的）
  const reviewTexts = (raw.reviews || [])
    .map((r) => ({
      author: r?.authorAttribution?.displayName || '匿名旅客',
      rating: typeof r.rating === 'number' ? r.rating : null,
      text: r?.text?.text || r?.originalText?.text || '',
    }))
    .filter((r) => r.text);

  const isRestaurant = kind === 'restaurant';
  return {
    id: 'gp-' + (raw.id || `${kind}-${lat}-${lng}`),
    name,
    type: isRestaurant ? 'restaurant' : 'attraction',
    region,
    lat: Number(lat),
    lng: Number(lng),
    address: raw.formattedAddress || '',
    phone: raw.nationalPhoneNumber || '',
    openNow: raw?.currentOpeningHours?.openNow ?? null,
    openHours: raw?.regularOpeningHours?.weekdayDescriptions || [],
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    reviews: typeof raw.userRatingCount === 'number' ? raw.userRatingCount : null,
    reviewTexts, // 真實評論原文（最多5則），給評論優缺點摘要功能使用
    price: priceLevelToText(raw.priceLevel),
    desc: desc ? String(desc).slice(0, 300) : '（Google Places 目前沒有提供這個地點的簡介文字）',
    picture: pictureUrl,
    tags: guessTagsFromTypes(raw.types), // 粗略猜測，不是人工標註，前端會標示「推測標籤」
    dur: isRestaurant ? 60 : 90, // Google 沒有提供建議停留時間，用跟 demo 資料同樣的合理預設值概算
    meal: isRestaurant ? ['lunch', 'dinner'] : undefined, // 沒有精準營業時段資料，先給一個保守通用預設
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
    const msg = `Google Places 查詢失敗（"${textQuery}"，${res.status}）：${errText.slice(0, 300)}`;
    console.warn(msg);
    return { places: [], error: msg };
  }
  const data = await res.json();
  return { places: Array.isArray(data.places) ? data.places : [], error: null };
}

// 把使用者輸入的任意地名／地址（例如「和美」「彰化縣和美鎮彰新路100號」）即時定位成經緯度座標。
// 這是解決「出發地只能從固定的十幾個火車站/機場清單選」這個限制的關鍵——不管使用者打哪個鄉鎮、街道、
// 甚至地標名稱，都直接問 Google 這個地名實際在哪裡，而不是硬要比對到清單裡最接近的大站。
async function handleGeocode(params, apiKey, headers) {
  const text = (params.text || '').trim();
  if (!text) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 text 參數' }) };
  }
  const r = await searchOneQuery(`台灣 ${text}`, apiKey); // 加「台灣」提高精準度，避免搜到國外同名地名
  if (r.error) {
    return { statusCode: 502, headers, body: JSON.stringify({ found: false, error: r.error }) };
  }
  const top = r.places[0];
  const lat = top?.location?.latitude, lng = top?.location?.longitude;
  if (lat == null || lng == null) {
    return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
  }
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ found: true, name: top?.displayName?.text || text, lat, lng }),
  };
}

// 查詢某個座標附近的真實景點／餐廳（Google Places Nearby Search，New API），
// 用在使用者排好行程之後，「沿途還有什麼順路的地方可以去」這個功能。
async function handleNearby(params, apiKey, headers) {
  const lat = Number(params.lat), lng = Number(params.lng);
  if (!lat || !lng) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少或不合法的 lat/lng 參數' }) };
  }
  const radius = Math.min(Math.max(Number(params.radius) || 700, 100), 5000); // 100m ~ 5km 之間，預設 700m
  const region = params.region || '';
  const exclude = new Set((params.exclude || '').split(',').filter(Boolean));

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        includedTypes: ['tourist_attraction', 'restaurant', 'cafe', 'museum', 'park'],
        maxResultCount: 8,
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
        languageCode: 'zh-TW',
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Nearby Search HTTP ${res.status}：${errText.slice(0, 300)}` }) };
    }
    const data = await res.json();
    const spots = (data.places || [])
      .map((raw) => {
        const isRestaurant = (raw.types || []).some((t) => ['restaurant', 'cafe'].includes(t));
        return normalizeSpot(raw, isRestaurant ? 'restaurant' : 'attraction', region, apiKey);
      })
      .filter(Boolean)
      .filter((s) => !exclude.has(s.id));
    return { statusCode: 200, headers, body: JSON.stringify({ spots }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Nearby Search 呼叫失敗：' + err.message }) };
  }
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

  // mode=nearby：查詢某個座標「附近」的真實景點／餐廳（用在行程排好之後，找沿途順路的地方），
  // 跟原本依地區搜尋的邏輯分開處理，但共用同一支 normalizeSpot() 轉換格式。
  if (params.mode === 'nearby') {
    return handleNearby(params, apiKey, headers);
  }
  // mode=geocode：把使用者輸入的任意地名/地址即時定位成經緯度座標（用在「出發地」支援任意地址）。
  if (params.mode === 'geocode') {
    return handleGeocode(params, apiKey, headers);
  }

  const region = params.region;
  const type = params.type; // 'attraction' | 'restaurant' | undefined(both)
  if (!region || !REGION_TO_CITIES[region]) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少或不支援的 region 參數', validRegions: Object.keys(REGION_TO_CITIES) }) };
  }

  try {
    const cities = REGION_TO_CITIES[region];
    const kinds = type === 'attraction' ? ['attraction'] : type === 'restaurant' ? ['restaurant'] : ['attraction', 'restaurant'];

    // 每個縣市 x 每種類型，除了原本廣泛的「景點／美食」查詢，額外加一組偏「在地／私房」的查詢字樣，
    // 讓結果不會只有 Google 排名最前面那幾個人人都知道的網紅大地標，混進一些比較在地、沒那麼主流的選項。
    const QUERY_VARIANTS = {
      attraction: (city) => [`${city} 景點`, `${city} 私房景點 秘境`],
      restaurant: (city) => [`${city} 美食 餐廳`, `${city} 在地小吃 巷弄美食 在地人推薦`],
    };

    // 每個縣市 x 每種類型 x 每個查詢變體，平行呼叫 Google Places（Promise.all），加快整體回應速度
    const tasks = [];
    for (const city of cities) {
      for (const kind of kinds) {
        for (const textQuery of QUERY_VARIANTS[kind](city)) {
          tasks.push(
            searchOneQuery(textQuery, apiKey).then((r) => ({
              spots: r.places.map((raw) => normalizeSpot(raw, kind, region, apiKey)).filter(Boolean),
              error: r.error,
            }))
          );
        }
      }
    }
    const taskResults = await Promise.all(tasks);
    const merged = taskResults.flatMap((r) => r.spots);
    const errors = taskResults.map((r) => r.error).filter(Boolean);

    // 用 id 去重（不同查詢字串可能搜到同一個地點）
    const seen = new Set();
    const results = merged.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));

    // 沒有任何一個查詢成功、結果又是空的：這代表整批都出錯了（金鑰/帳單/權限問題），
    // 把第一則錯誤原文一起回傳，方便直接在瀏覽器 fetch 看到真正原因，不用去 Netlify 後台翻 log
    const debugError = results.length === 0 && errors.length ? errors[0] : null;

    return { statusCode: 200, headers, body: JSON.stringify({ region, count: results.length, spots: results, debugError }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Google Places API 呼叫失敗：' + err.message }) };
  }
};
