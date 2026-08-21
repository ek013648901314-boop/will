// netlify/functions/ai-chat.js
//
// 伺服器端函式：把使用者聊天訊息轉送給 Claude API，並強制模型用固定的工具（tool use）
// 回傳結構化 JSON，讓前端可以直接把解析結果丟進既有的路線規劃引擎（planRoute/buildTimetable）。
//
// ANTHROPIC_API_KEY 只存在 Netlify 的環境變數裡，這支函式在 Netlify 的伺服器上執行，
// 金鑰不會出現在瀏覽器可以看到的任何程式碼或網路請求裡。
//
// 需要的環境變數（在 Netlify 後台設定，不要寫死在程式碼裡）：
//   ANTHROPIC_API_KEY = sk-ant-xxxxxxxx

const REGIONS = ['北部', '中部', '南部', '東部', '離島-澎湖', '離島-金門', '離島-小琉球', '離島-其他'];
const TAGS = ['pet', 'kid', 'couple', 'friends', 'elder', 'adventure', 'igphoto', 'foodie', 'free', 'rainy'];

// 這個地區分類是「這個 App 資料庫內部的分法」，不是一般地理常識——一定要跟 index.html 裡的
// REGION_KEYWORDS 保持完全一致，否則 Claude 會用自己的地理判斷（例如把宜蘭歸類成東部）分到
// 資料庫裡根本沒有對應景點的地區，導致整趟行程排到不相干的城市去。修改其中一份時，另一份也要同步改。
const REGION_KEYWORDS = {
  '北部': ['台北', '新北', '基隆', '宜蘭', '淡水', '九份', '陽明山', '礁溪', '101'],
  '中部': ['台中', '南投', '彰化', '雲林', '日月潭', '清境', '阿里山', '嘉義', '埔里'],
  '南部': ['台南', '高雄', '屏東', '墾丁', '旗津', '安平'],
  '東部': ['花蓮', '台東', '太魯閣', '七星潭', '池上'],
  '離島-澎湖': ['澎湖', '馬公', '吉貝'],
  '離島-金門': ['金門'],
  '離島-小琉球': ['小琉球', '琉球嶼'],
  '離島-其他': ['綠島', '蘭嶼'],
};
const REGION_TABLE_TEXT = Object.entries(REGION_KEYWORDS)
  .map(([region, kws]) => `${region}：${kws.join('、')}`)
  .join('\n');

const SYSTEM_PROMPT = `你是「台灣趣旅行」的旅遊規劃助手，用繁體中文、親切自然的口吻跟使用者對話。
你的工作分兩部分：
1. 自然地回應使用者的訊息（可以聊天、回答一般旅遊問題、追問細節）。
2. 當你已經掌握足夠資訊可以規劃行程時（至少要知道出發時間），把解析出來的結構化資訊透過 respond_to_traveler 這個工具回傳。

地區只能是這些值之一（沒提到就留空陣列）：${REGIONS.join('、')}
判斷地區時「一定要」按照下面這個系統內部的分類表，不要用你自己的地理常識判斷（例如宜蘭在這個系統裡屬於「北部」，不是東部；這是因為系統資料庫裡宜蘭的景點都歸在北部類別下，分錯地區會導致規劃出完全不相干城市的行程）：
${REGION_TABLE_TEXT}
如果使用者提到的地名不在上面任何一類，就把 regions 留空陣列，不要亂猜。

風格標籤只能是這些值（沒提到就留空陣列）：${TAGS.join('、')}（pet=寵物友善, kid=親子友善, couple=情侶約會, friends=三五好友, elder=長輩友善, adventure=戶外探險, igphoto=文青打卡, foodie=美食推薦, free=免門票, rainy=雨天備案）

判斷標籤時要抓使用者話裡的「言外之意」，不是只找字面關鍵字，這樣系統排出來的行程才會真的符合他們的需求：
- 提到帶寵物／毛小孩／貓狗同行 → 一定要加 pet，這樣系統才會優先挑寵物友善的地點，避免排到不能帶寵物進去的地方
- 提到帶小孩／親子出遊 → 加 kid，且這種情況下小孩通常需要能跑跳消耗體力的地方（公園、戶外活動），可以同時考慮加 adventure
- 提到自己是「吃貨」／很愛吃／美食愛好者 → 加 foodie，這種情況下行程可以安排更多間餐廳／甜點／下午茶，不用刻意省成一天只安排一餐
- 單純想出去走走、沒有特別限制、像是「難得放假／特地排時間出遊」這種描述 → 代表這趟是以景點體驗為主，可以不用加太多限制性標籤，讓系統盡量安排豐富的景點行程
- 提到長輩／爸媽同行 → 加 elder，行程步調不要太趕
- 這些推論出來的標籤只是「風格偏好」，不是強制篩選條件，所以合理推論、不用過度保守

如果使用者有提到「從哪裡出發」（例如「從彰化出發」「台北出發」），一定要抓出那個地名放進 departure 欄位——這點很重要，
系統排路線時需要用這個當起點，沒抓到的話系統會亂猜出發地，導致排出來的行程從不相干的城市開始、也沒算回程時間。
如果沒提到出發地，departure 填 null，「絕對不要自己瞎猜一個出發地」——出發地沒問清楚就自己亂猜，
比沒問出發時間還嚴重，因為整條路線、回程時間都是根據出發地算的，猜錯會讓整趟行程從不合理的地方開始。

如果使用者提到「具體的地名/景點」而不只是籠統的地區（例如「墾丁」比「南部」精確、「九份」比「北部」精確），
一定要把那個具體地名放進 destination_hint 欄位——這點也很重要，沒抓到的話系統只會知道大概的地區，
排出來的行程會被同地區其他縣市的地點稀釋掉，變成「說要去墾丁，結果大部分行程在台南、高雄」。
如果使用者只講了籠統的地區（例如單純說「南部」、「想去海邊」），destination_hint 填 null。

trip_ready 設為 true 之前，「出發地（departure）」和「出發時間（start_minutes）」這兩項都一定要問到，缺一不可：
- 如果出發時間還不知道，在 reply 裡自然地追問幾點出發（可以順便建議幾個選項，例如上午9點、中午12點）。
- 如果出發地還不知道，在 reply 裡自然地追問使用者「從哪裡出發」（可以順便舉例，例如台北車站、桃園機場，或直接輸入自己家附近的地名）。
- 如果兩項都還不知道，一次問清楚就好，不要分好幾輪一次只問一項。
只要這兩項有任何一項還沒問到，trip_ready 就是 false。

如果出發地跟出發時間都問到了，trip_ready 設為 true，這時候你「一定要」自己排出具體的每日行程放進 itinerary_plan——
不要只回傳籠統的地區/標籤讓系統用死板的規則亂猜。你受過大量真實台灣旅遊資訊的訓練，知道實際上大家去某個地方
通常會怎麼安排（先去哪、順路去哪、中午在哪一帶吃飯合理、下午安排什麼、晚上在哪吃晚餐），請發揮這個知識來排：

- itinerary_plan.days 是一個陣列，每個元素代表一天，裡面的 stops 依照「你建議實際造訪的順序」排列（不用管地理最佳化，
  你自己排的順序就會被拿去用，系統不會再重新排序，所以你的順序要合理：同一天的地點盡量順路、不要來回亂跳）。
- 每個 stop 要有 name（具體、真實、Google 地圖查得到的正式名稱，例如「駁二藝術特區」「度小月擔仔麵」，
  不要用「附近的咖啡廳」這種模糊描述）跟 type（attraction 景點 或 restaurant 餐廳）。
- 每天的行程要有合理步調：通常安排 2-4 個景點/餐廳，含至少一餐（如果那天有涵蓋到用餐時段的話），
  不要塞超過一個人一天玩得完的量，也不要太空。
- 地點要落在使用者要去的地區/地名範圍內（參考上面判斷出的 regions/destination_hint），
  且如果知道使用者的出發地，第一天第一站應該是從出發地出發合理能到的地方，不要一開始就跳到很遠的地方。
- 如果使用者要求的天數內容明顯塞不下（例如範圍太大、天數太少），可以自行調整成更合理的天數，
  在 reply 裡老實說明你為什麼調整。
- 如果完全沒辦法排出合理行程（例如地區資訊不足），itinerary_plan 可以留 null，系統會用備用方式處理。

一定要呼叫 respond_to_traveler 這個工具來回覆，不要用純文字回答。`;

const TOOL_DEF = {
  name: 'respond_to_traveler',
  description: '回覆旅客訊息，並在資訊足夠時附上結構化的行程需求與具體的每日行程建議，讓系統可以據此產生路線。',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: '要顯示給使用者看的繁體中文回覆內容。' },
      trip_ready: { type: 'boolean', description: '是否已經有足夠資訊（至少含出發時間）可以產生行程方案。' },
      regions: { type: 'array', items: { type: 'string', enum: REGIONS }, description: '使用者提到的地區，沒提到就是空陣列。' },
      tags: { type: 'array', items: { type: 'string', enum: TAGS }, description: '使用者提到的風格標籤，沒提到就是空陣列。' },
      days: { type: 'number', description: '天數，0.5 代表半日遊，預設 1。' },
      people: { type: 'number', description: '同行人數，預設 2。' },
      departure: { type: ['string', 'null'], description: '使用者明講的出發地地名（例如「彰化」「台北車站」），沒提到就是 null，不要自己瞎猜。' },
      destination_hint: { type: ['string', 'null'], description: '使用者提到的具體地名/景點（例如「墾丁」「九份」），比 regions 精確；只講籠統地區就是 null。' },
      start_minutes: {
        type: ['number', 'null'],
        description: '出發時間，用「當天午夜過後的分鐘數」表示，例如 09:30 = 570。還不知道就填 null。',
      },
      itinerary_plan: {
        type: ['object', 'null'],
        description: 'trip_ready=true 時，你根據自己對台灣旅遊的知識排出的具體每日行程；資訊不足時填 null。',
        properties: {
          days: {
            type: 'array',
            description: '每天的行程，依照建議造訪順序排列的每日陣列。',
            items: {
              type: 'object',
              properties: {
                stops: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: '具體真實的地點名稱（景點或餐廳），Google 地圖查得到的正式名稱。' },
                      type: { type: 'string', enum: ['attraction', 'restaurant'] },
                    },
                    required: ['name', 'type'],
                  },
                },
              },
              required: ['stops'],
            },
          },
        },
      },
    },
    required: ['reply', 'trip_ready'],
  },
};

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // 金鑰還沒設定：回傳明確的錯誤代碼，前端會自動退回本機規則式解析，網站不會壞掉。
    return {
      statusCode: 501,
      headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on Netlify' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { message, history } = payload;
  if (!message || typeof message !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'message (string) is required' }) };
  }

  // history：前端傳來的最近幾輪對話（[{role:'user'|'assistant', content:'...'}]），讓 Claude 有上下文
  const messages = Array.isArray(history) ? history.slice(-8) : [];
  messages.push({ role: 'user', content: message });

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages,
        tools: [TOOL_DEF],
        tool_choice: { type: 'tool', name: 'respond_to_traveler' },
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers,
        body: JSON.stringify({ error: data.error?.message || 'Claude API error' }),
      };
    }

    const toolUse = (data.content || []).find((c) => c.type === 'tool_use');
    if (!toolUse) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Claude 沒有回傳預期的結構化資料' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: toolUse.input.reply,
        tripReady: !!toolUse.input.trip_ready,
        regions: toolUse.input.regions || [],
        tags: toolUse.input.tags || [],
        days: typeof toolUse.input.days === 'number' ? toolUse.input.days : 1,
        people: typeof toolUse.input.people === 'number' ? toolUse.input.people : 2,
        startMinutes: typeof toolUse.input.start_minutes === 'number' ? toolUse.input.start_minutes : null,
        departure: toolUse.input.departure || null,
        destinationHint: toolUse.input.destination_hint || null,
        itineraryPlan: toolUse.input.itinerary_plan || null,
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Claude API 呼叫失敗：' + err.message }) };
  }
};
