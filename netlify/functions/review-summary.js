// netlify/functions/review-summary.js
//
// 伺服器端函式：把 Google Places 真實評論原文交給 Claude，摘要出「優點／缺點」重點條列。
// 這是用真實評論內容做分析，不是原本 demo 那種虛構評論真偽分數——分析結果的品質完全取決於
// Google 附的最多 5 則評論樣本，樣本少時摘要難免不夠全面，這是真實資料的合理限制。
//
// 跟 ai-chat.js 共用同一把 ANTHROPIC_API_KEY。
//
// 用法（前端 fetch，POST）：
//   { placeName: "台北101", reviews: [{author, rating, text}, ...] }
//   回傳：{ pros: string[], cons: string[] }

const TOOL_DEF = {
  name: 'summarize_reviews',
  description: '把真實評論內容歸納成優點與缺點的重點條列（繁體中文，每條盡量在 20 字以內、具體）。',
  input_schema: {
    type: 'object',
    properties: {
      pros: { type: 'array', items: { type: 'string' }, description: '從評論中歸納出的優點，最多 4 條；沒有明顯優點就留空陣列。' },
      cons: { type: 'array', items: { type: 'string' }, description: '從評論中歸納出的缺點／注意事項，最多 4 條；沒有明顯缺點就留空陣列。' },
    },
    required: ['pros', 'cons'],
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
    return { statusCode: 501, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on Netlify' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { placeName, reviews } = payload;
  if (!Array.isArray(reviews) || !reviews.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'reviews（非空陣列）為必填' }) };
  }

  const reviewsText = reviews
    .slice(0, 5)
    .map((r, i) => `評論${i + 1}（${r.rating != null ? r.rating + '星' : '未評分'}）：${String(r.text || '').slice(0, 400)}`)
    .join('\n\n');

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
        max_tokens: 512,
        system: `你是旅遊評論分析助手。使用者會給你「${placeName || '這個地點'}」的真實 Google 評論原文，請你只根據這些評論的實際內容歸納優缺點，不要自己編造評論裡沒提到的事，也不要照抄整句評論，用自己的話濃縮成重點條列。一定要呼叫 summarize_reviews 這個工具回覆。`,
        messages: [{ role: 'user', content: `地點：${placeName || '未提供名稱'}\n\n${reviewsText}` }],
        tools: [TOOL_DEF],
        tool_choice: { type: 'tool', name: 'summarize_reviews' },
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: data.error?.message || 'Claude API error' }) };
    }

    const toolUse = (data.content || []).find((c) => c.type === 'tool_use');
    if (!toolUse) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Claude 沒有回傳預期的結構化資料' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        pros: Array.isArray(toolUse.input.pros) ? toolUse.input.pros : [],
        cons: Array.isArray(toolUse.input.cons) ? toolUse.input.cons : [],
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Claude API 呼叫失敗：' + err.message }) };
  }
};
