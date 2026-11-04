const https = require('https');
const http = require('http');

const ENDPOINT = process.env.AI_BASE_URL || 'https://11434-001m6k0e8ar6257cbjeybmp5d0v.sbx.sandboxes-cloud.docker.com/v1';
const MODEL = process.env.AI_MODEL || 'qwen2.5:7b';

const TEST_UTTERANCES = [
  'vừa mua 2 chai nước mắm 45k để ở tủ bếp',
  'nhớ mua 5 gói mì tôm hảo hảo',
  'tháng này tiêu hết bao nhiêu tiền',
  'trong nhà còn gì không',
  'tuần này có gì sắp hết hạn'
];

async function measureInference(text) {
  const url = ENDPOINT.endsWith('/v1') ? `${ENDPOINT}/chat/completions` : `${ENDPOINT}/v1/chat/completions`;
  const body = JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: 'Bạn là bộ định tuyến nghiệp vụ HomeMind. Trả về đúng định dạng JSON: {"toolId": string, "arguments": object}.' },
      { role: 'user', content: text }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1
  });

  const parsedUrl = new URL(url);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  const start = Date.now();
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'HomeMind-Benchmark/1.0'
      },
      timeout: 35000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        try {
          const json = JSON.parse(data);
          resolve({
            text,
            latencyMs,
            statusCode: res.statusCode,
            content: json.choices?.[0]?.message?.content || '',
            usage: json.usage || {}
          });
        } catch {
          resolve({ text, latencyMs, statusCode: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Benchmark request timed out'));
    });
    req.write(body);
    req.end();
  });
}

async function runBenchmark() {
  console.log(`=== HomeMind AI Inference Benchmark (${MODEL}) ===`);
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log(`Testing ${TEST_UTTERANCES.length} scenarios...\n`);

  const results = [];
  for (const text of TEST_UTTERANCES) {
    try {
      const res = await measureInference(text);
      console.log(`[${res.latencyMs}ms] "${text}" -> status ${res.statusCode}`);
      results.push(res);
    } catch (err) {
      console.error(`[FAIL] "${text}":`, err.message);
    }
  }

  if (results.length > 0) {
    const avgLatency = Math.round(results.reduce((acc, r) => acc + r.latencyMs, 0) / results.length);
    console.log(`\nBenchmark Completed. Average Latency: ${avgLatency} ms`);
  }
}

if (require.main === module) {
  runBenchmark().catch(console.error);
}

module.exports = { measureInference, runBenchmark };
